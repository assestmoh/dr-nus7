// server.js — Dalil Alafiyah API (LOW token usage + stable conversations)
// ✅ هذه النسخة تصلّح تكرار البطاقات عند الضغط على الأزرار (Quick Choices + مسارات إرشادية)
// ✅ تقلّل استهلاك التوكنز: Knowledge Base محلي + Cache + AI محدود + max_tokens منخفض
//
// لا تغيّر واجهة /chat ولا شكل الرد (يرجع نفس JSON الذي يتوقعه app.js)

import "dotenv/config";
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

const app = express();

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MODEL_ID = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const PORT = process.env.PORT || 3000;

// CORS allowlist (comma-separated)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ---- cost controls (env optional) ----
const AI_FALLBACK_ENABLED = (process.env.AI_FALLBACK_ENABLED || "1") === "1"; // 1=يسمح باستدعاء Groq عند عدم وجود جواب محلي
const AI_AFTER_MESSAGES = Number(process.env.AI_AFTER_MESSAGES || 3); // تشغيل Groq فقط بعد N رسائل (للأسئلة غير المغطاة محليًا)
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 1500); // تبريد لكل مستخدم (مخفف حتى ما يضايق المستخدم)
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT || 180); // حد يومي لكل مستخدم
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 6 * 60 * 60 * 1000); // 6 ساعات
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 220);
const TEMP = Number(process.env.TEMPERATURE || 0.25);

if (AI_FALLBACK_ENABLED && !GROQ_API_KEY) {
  console.error("❌ GROQ_API_KEY غير مضبوط (وأنت مفعّل AI_FALLBACK_ENABLED=1)");
  process.exit(1);
}

app.use(helmet());
app.set("trust proxy", 1);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.length === 0) return cb(null, true);
      return ALLOWED_ORIGINS.includes(origin) ? cb(null, true) : cb(new Error("CORS blocked"), false);
    },
    methods: ["POST", "GET"],
  })
);

app.use(bodyParser.json({ limit: "2mb" }));

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_PER_MIN || 25),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.headers["x-user-id"] || req.ip),
});

// ---------- helpers ----------
async function fetchWithTimeout(url, options = {}, ms = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

function cleanJsonish(s) {
  let t = String(s || "").trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```[a-zA-Z]*\s*/m, "").replace(/```$/m, "").trim();
  }
  t = t.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  t = t.replace(/,\s*([}\]])/g, "$1");
  return t;
}

function extractJson(text) {
  const s0 = String(text || "");
  let s = cleanJsonish(s0);

  try {
    const first = JSON.parse(s);
    if (first && typeof first === "object") return first;
    if (typeof first === "string") {
      const second = JSON.parse(cleanJsonish(first));
      if (second && typeof second === "object") return second;
    }
  } catch {}

  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a === -1 || b === -1 || b <= a) return null;

  const chunk = cleanJsonish(s.slice(a, b + 1));
  try {
    return JSON.parse(chunk);
  } catch {
    return null;
  }
}

function extractVerdictLoosely(raw) {
  const s = String(raw || "");
  const m = s.match(/"verdict"\s*:\s*"([^"]+)"/);
  return m?.[1]?.replace(/\\"/g, '"').trim() || "";
}

function recoverPartialCard(raw) {
  const s = String(raw || "");
  const pick = (re) => {
    const m = s.match(re);
    return m?.[1] ? m[1].replace(/\\"/g, '"').trim() : "";
  };

  const category = pick(/"category"\s*:\s*"([^"]+)"/) || "general";
  const title = pick(/"title"\s*:\s*"([^"]+)"/) || "دليل العافية";
  const verdict = pick(/"verdict"\s*:\s*"([^"]+)"/) || "";
  const next_question = pick(/"next_question"\s*:\s*"([^"]*)"/) || "";
  const when_to_seek_help = pick(/"when_to_seek_help"\s*:\s*"([^"]*)"/) || "";

  const arrPick = (key, limit) => {
    const m = s.match(new RegExp(`"${key}"\\s*:\\s*\\[([\\s\\S]*?)\\]`));
    const inner = m?.[1] || "";
    if (!inner) return [];
    return inner
      .split(",")
      .map((x) => x.trim())
      .map((x) => x.replace(/^"+|"+$/g, "").replace(/\\"/g, '"'))
      .filter(Boolean)
      .slice(0, limit);
  };

  const quick_choices = arrPick("quick_choices", 2);
  const tips = arrPick("tips", 2);

  return { category, title, verdict, next_question, quick_choices, tips, when_to_seek_help };
}

function isMetaJsonAnswer(d) {
  const text =
    String(d?.title || "") +
    " " +
    String(d?.verdict || "") +
    " " +
    String(d?.next_question || "") +
    " " +
    String(d?.when_to_seek_help || "") +
    " " +
    (Array.isArray(d?.tips) ? d.tips.join(" ") : "") +
    " " +
    (Array.isArray(d?.quick_choices) ? d.quick_choices.join(" ") : "");
  return /json|format|schema|اقتباس|فواصل|تنسيق/i.test(text);
}

const sStr = (v) => (typeof v === "string" ? v.trim() : "");
const sArr = (v, n) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).slice(0, n) : []);

function normalize(obj) {
  let cat = sStr(obj?.category) || "general";
  if (cat === "blood_pressure" || cat === "bloodpressure") cat = "bp";

  const allowed = new Set([
    "general",
    "nutrition",
    "bp",
    "sugar",
    "sleep",
    "activity",
    "mental",
    "first_aid",
    "report",
    "emergency",
    "water",
    "calories",
    "bmi",
  ]);
  if (!allowed.has(cat)) cat = "general";

  return {
    category: cat,
    title: sStr(obj?.title) || "دليل العافية",
    verdict: sStr(obj?.verdict),
    next_question: sStr(obj?.next_question),
    quick_choices: sArr(obj?.quick_choices, 2),
    tips: sArr(obj?.tips, 2),
    when_to_seek_help: sStr(obj?.when_to_seek_help),
  };
}

function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^\u0600-\u06FFa-z0-9\s/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------- KB ----------
function card({ category, title, verdict, tips = [], next_question = "", quick_choices = [], when_to_seek_help = "" }) {
  return normalize({ category, title, verdict, tips, next_question, quick_choices, when_to_seek_help });
}

// روابط مرجعية رسمية (وزارة الصحة العُمانية)
const MOH = {
  awareness_root: "https://www.moh.gov.om/ar/%D8%AA%D8%B9%D8%B2%D9%8A%D8%B2-%D8%A7%D9%84%D8%B5%D8%AD%D8%A9/%D9%88%D8%B9%D9%8A%D9%83-%D8%B5%D8%AD%D8%A9/",
  nutrition: "https://moh.gov.om/ar/%D8%AA%D8%B9%D8%B2%D9%8A%D8%B2-%D8%A7%D9%84%D8%B5%D8%AD%D8%A9/%D9%88%D8%B9%D9%8A%D9%83-%D8%B5%D8%AD%D8%A9/%D8%A7%D9%84%D8%AF%D9%84%D9%8A%D9%84-%D8%A7%D9%84%D8%B9%D9%85%D8%A7%D9%86%D9%8A-%D9%84%D9%84%D8%BA%D8%B0%D8%A7%D8%A1-%D8%A7%D9%84%D8%B5%D8%AD%D9%8A-%D8%B9%D8%B1%D8%A8%D9%8A/",
  bp: "https://www.moh.gov.om/ar/%D8%AA%D8%B9%D8%B2%D9%8A%D8%B2-%D8%A7%D9%84%D8%B5%D8%AD%D8%A9/%D9%88%D8%B9%D9%8A%D9%83-%D8%B5%D8%AD%D8%A9/%D8%B6%D8%BA%D8%B7-%D8%A7%D9%84%D8%AF%D9%85/",
  diabetes: "https://www.moh.gov.om/ar/%D8%AA%D8%B9%D8%B2%D9%8A%D8%B2-%D8%A7%D9%84%D8%B5%D8%AD%D8%A9/%D9%88%D8%B9%D9%8A%D9%83-%D8%B5%D8%AD%D8%A9/%D9%85%D8%B1%D8%B6-%D8%A7%D9%84%D8%B3%D9%83%D8%B1%D9%8A/",
  heatstroke: "https://www.moh.gov.om/ar/%D8%AA%D8%B9%D8%B2%D9%8A%D8%B2-%D8%A7%D9%84%D8%B5%D8%AD%D8%A9/%D9%88%D8%B9%D9%8A%D9%83-%D8%B5%D8%AD%D8%A9/%D8%B6%D8%B1%D8%A8%D8%A9-%D8%A7%D9%84%D8%B4%D9%85%D8%B3/",
};

const KB = {
  // ===== أساسيات =====
  nutrition: card({
    category: "nutrition",
    title: "غذاء صحي",
    verdict: "الغذاء المتوازن يقلّل مخاطر الأمراض المزمنة المرتبطة بالنمط الغذائي.",
    tips: [
      "اجعل طبقك متوازنًا: خضار/فواكه + بروتين + حبوب كاملة، وقلّل الملح/السكر والدهون المشبعة.",
      "اختر بدائل صحية يوميًا واستمر بخطوات صغيرة قابلة للاستمرار.",
    ],
    next_question: "هل هدفك اليوم: تقليل السكر أم تقليل الملح؟",
    quick_choices: ["تقليل السكر", "تقليل الملح"],
    when_to_seek_help: `إذا لديك مرض مزمن أو أعراض مستمرة، راجع مركز صحي لتقييم مناسب. (وزارة الصحة العُمانية) ${MOH.nutrition}`,
  }),

  activity: card({
    category: "activity",
    title: "نشاط بدني",
    verdict: "النشاط البدني المنتظم يدعم صحة القلب والوزن والمزاج.",
    tips: [
      "ابدأ بمستوى مناسب لك وزِد تدريجيًا (مثل المشي)، مع اختيار وقت ثابت.",
      "التزم بخطة بسيطة أسبوعيًا لتجنب الانقطاع.",
    ],
    next_question: "تفضّل نشاط خفيف أم متوسط؟",
    quick_choices: ["خفيف", "متوسط"],
    when_to_seek_help: `معلومات عامة للتثقيف الصحي. للمزيد: ${MOH.awareness_root}`,
  }),

  bp: card({
    category: "bp",
    title: "ضغط الدم",
    verdict: "الكشف المبكر واتباع نمط حياة صحي يساعدان في الوقاية وتقليل المضاعفات.",
    tips: [
      "قلّل الملح، وداوم على النشاط البدني، وامتنع عن التدخين قدر الإمكان.",
      "قِس الضغط بطريقة صحيحة وبشكل دوري خاصة إذا لديك عوامل خطورة.",
    ],
    next_question: "هل لديك قراءة ضغط (مثل 120/80)؟",
    quick_choices: ["نعم لدي قراءة", "لا"],
    when_to_seek_help: `إذا كانت القراءات مرتفعة بشكل متكرر أو لديك أعراض مقلقة راجع الطبيب/المركز الصحي. (وزارة الصحة العُمانية) ${MOH.bp}`,
  }),

  sugar: card({
    category: "sugar",
    title: "السكري",
    verdict: "السكري حالة مزمنة تتطلب نمط حياة صحي ومتابعة منتظمة لتقليل المضاعفات.",
    tips: [
      "اختر وجبات متوازنة وقلّل السكريات والمشروبات المحلّاة وداوم على الحركة.",
      "التزم بالخطة العلاجية والمتابعة وراقب القياسات حسب إرشاد الطبيب.",
    ],
    next_question: "القياس صائم أم بعد الأكل؟",
    quick_choices: ["صائم", "بعد الأكل"],
    when_to_seek_help: `راجع الطبيب إذا كانت القراءات عالية بشكل متكرر أو ظهرت أعراض شديدة. (وزارة الصحة العُمانية) ${MOH.diabetes}`,
  }),

  sleep: card({
    category: "sleep",
    title: "النوم",
    verdict: "السهر واضطراب النوم قد يؤثران على جودة الحياة والصحة العامة.",
    tips: [
      "حافظ على جدول نوم ثابت قدر الإمكان وقلّل المنبهات قبل النوم.",
      "إذا استمرت المشكلة، قيّم الأسباب (توتر/منبهات/قيلولة طويلة) وضع خطة.",
    ],
    next_question: "مشكلتك: سهر متكرر أم أرق؟",
    quick_choices: ["سهر متكرر", "أرق"],
    when_to_seek_help: `معلومات عامة للتثقيف الصحي. للمزيد: ${MOH.awareness_root}`,
  }),

  first_aid_heatstroke: card({
    category: "first_aid",
    title: "ضربة الشمس",
    verdict: "ضربة الشمس حالة طارئة بسبب التعرض الشديد للحرارة وتتطلب تصرفًا سريعًا.",
    tips: [
      "انقل الشخص لمكان بارد، وبرّده تدريجيًا، وقدّم سوائل إن كان واعيًا وقادرًا على البلع.",
      "اطلب المساعدة الطبية إذا كانت الأعراض شديدة أو الوعي متأثر.",
    ],
    next_question: "هل توجد حرارة عالية مع دوخة/تقيؤ؟",
    quick_choices: ["نعم", "لا"],
    when_to_seek_help: `اطلب الطوارئ فورًا عند فقدان الوعي/تشنجات/حرارة شديدة. (وزارة الصحة العُمانية) ${MOH.heatstroke}`,
  }),

  mental: card({
    category: "mental",
    title: "الصحة النفسية",
    verdict: "الصحة النفسية جزء أساسي من الصحة العامة. الدعم المبكر يساعد.",
    tips: [
      "حافظ على نوم وحركة يومية ودعم اجتماعي، وجرّب تمارين تنفّس بسيطة.",
      "إذا استمرت الأعراض وأثرت على حياتك، ناقش ذلك مع مختص.",
    ],
    next_question: "هل المشكلة: قلق أم حزن مستمر؟",
    quick_choices: ["قلق", "حزن مستمر"],
    when_to_seek_help: `إذا وُجدت أفكار بإيذاء النفس أو خطر عاجل: اطلب مساعدة فورية. للمزيد: ${MOH.awareness_root}`,
  }),

  emergency: card({
    category: "emergency",
    title: "علامات طارئة",
    verdict: "هناك علامات تستدعي التوجه للطوارئ فورًا.",
    tips: [
      "ألم صدر شديد، ضيق نفس شديد، إغماء، نزيف شديد، ضعف مفاجئ/تشوش كلام.",
      "في هذه الحالات لا تنتظر: اتصل بالإسعاف أو اذهب للطوارئ فورًا.",
    ],
    next_question: "هل لديك عرض خطير الآن؟",
    quick_choices: ["نعم", "لا"],
    when_to_seek_help: "هذه علامات طارئة — توجّه للطوارئ فورًا.",
  }),

  general: card({
    category: "general",
    title: "دليل العافية",
    verdict: "اكتب سؤالك الصحي بشكل واضح (أعراض + مدة + العمر إن أمكن) للحصول على إرشاد عام أدق.",
    tips: ["تجنب مشاركة بيانات حساسة.", "إذا كانت الحالة طارئة اذهب للطوارئ."],
    next_question: "هل سؤالك عن تغذية أم نشاط أم نوم؟",
    quick_choices: ["تغذية", "نشاط"],
    when_to_seek_help: "",
  }),

  // ===== مسارات إرشادية (أزرار الشاشة عندك) — كلها محلية بدون AI =====
  path_lifestyle: card({
    category: "general",
    title: "نمط الحياة الصحي",
    verdict: "خطة بسيطة اليوم: تغذية + نشاط + نوم (خطوات صغيرة قابلة للاستمرار).",
    tips: ["اختر تغيير واحد فقط اليوم.", "تابع 7 أيام ثم عدّل خطوة جديدة."],
    next_question: "ما الذي تريد تحسينه أولاً؟",
    quick_choices: ["التغذية", "النشاط", "النوم"],
    when_to_seek_help: `معلومات عامة للتثقيف الصحي. للمزيد: ${MOH.awareness_root}`,
  }),

  path_women: card({
    category: "general",
    title: "صحة النساء",
    verdict: "إرشادات عامة آمنة: وقاية + فحوصات + نمط حياة (بدون أدوية/جرعات).",
    tips: ["نمط حياة صحي (غذاء/نشاط/نوم).", "راجع الطبيب عند أعراض غير معتادة أو مستمرة."],
    next_question: "أي محور تريده الآن؟",
    quick_choices: ["تغذية", "فحوصات"],
    when_to_seek_help: `معلومات عامة للتثقيف الصحي. للمزيد: ${MOH.awareness_root}`,
  }),

  path_children: card({
    category: "general",
    title: "صحة الأطفال",
    verdict: "وقاية عامة: تغذية مناسبة + نشاط + تطعيمات + مراقبة علامات الخطر.",
    tips: ["قلّل السكريات والمشروبات المحلّاة.", "راقب السوائل عند الإسهال/الحرارة."],
    next_question: "العمر التقريبي؟",
    quick_choices: ["أقل من 5", "5+ سنوات"],
    when_to_seek_help: "إذا حرارة عالية مستمرة/خمول شديد/صعوبة تنفس/جفاف واضح: راجع الطبيب أو الطوارئ.",
  }),

  path_elderly: card({
    category: "general",
    title: "صحة المسنين",
    verdict: "الأولوية: الوقاية من السقوط + تغذية/سوائل + متابعة الأمراض المزمنة.",
    tips: ["حركة خفيفة يوميًا حسب القدرة.", "مراجعة الأدوية دوريًا مع الطبيب."],
    next_question: "ما الذي تريده الآن؟",
    quick_choices: ["الوقاية من السقوط", "التغذية"],
    when_to_seek_help: "دوخة شديدة/سقوط متكرر/تدهور مفاجئ: يحتاج تقييم طبي.",
  }),

  path_adolescents: card({
    category: "general",
    title: "صحة اليافعين",
    verdict: "نوم كافٍ + نشاط + تغذية + دعم نفسي… هذه أهم الأساسيات.",
    tips: ["توازن بين الدراسة والنوم.", "تقليل المشروبات المحلّاة والوجبات السريعة قدر الإمكان."],
    next_question: "أكبر تحدي الآن؟",
    quick_choices: ["النوم", "التغذية"],
    when_to_seek_help: "إذا توتر/حزن شديد مستمر أو تأثير واضح على الدراسة/الحياة: اطلب مساعدة مختص.",
  }),

  path_mental_health: card({
    category: "mental",
    title: "مسار الصحة النفسية",
    verdict: "أدوات يومية بسيطة + متى أطلب مساعدة عاجلة.",
    tips: ["تنفّس 3 دقائق.", "مشي خفيف 10 دقائق.", "تواصل مع شخص تثق به."],
    next_question: "هل تريد أدوات للقلق أم لتحسين النوم؟",
    quick_choices: ["القلق", "النوم"],
    when_to_seek_help: "أفكار بإيذاء النفس/خطر عاجل: اطلب مساعدة فورية.",
  }),

  path_ncd: card({
    category: "general",
    title: "الأمراض غير المعدية",
    verdict: "الوقاية تعتمد على: غذاء صحي + نشاط + وزن + إيقاف التدخين + فحوصات دورية.",
    tips: ["قلّل الملح/السكر.", "تحرّك يوميًا قدر الإمكان."],
    next_question: "تريد الوقاية من أي شيء أكثر؟",
    quick_choices: ["الضغط", "السكري"],
    when_to_seek_help: `للتثقيف الصحي العام: ${MOH.awareness_root}`,
  }),

  path_infection_control: card({
    category: "general",
    title: "مكافحة الأمراض والعدوى",
    verdict: "الوقاية: غسل اليدين + آداب السعال + البقاء بالمنزل عند المرض + لقاحات حسب الإرشاد الصحي.",
    tips: ["اغسل اليدين جيدًا.", "تجنب مخالطة الآخرين عند وجود أعراض عدوى."],
    next_question: "هل عندك أعراض تنفسية الآن؟",
    quick_choices: ["نعم", "لا"],
    when_to_seek_help: "إذا ضيق نفس شديد/حرارة عالية مستمرة/تدهور سريع: راجع الطبيب.",
  }),

  path_medication_safety: card({
    category: "general",
    title: "السلامة الدوائية",
    verdict: "قواعد عامة للاستخدام الآمن (بدون جرعات): التزم بوصفة الطبيب واقرأ النشرة.",
    tips: ["لا تخلط أدوية بدون استشارة.", "أبلغ عن الحساسية الدوائية.", "احفظ الدواء بعيدًا عن الأطفال."],
    next_question: "هل السؤال عن تداخلات أم حساسية؟",
    quick_choices: ["تداخلات", "حساسية"],
    when_to_seek_help: "طفح شديد/تورم/صعوبة تنفس بعد دواء: طارئ.",
  }),

  path_emergency: card({
    category: "emergency",
    title: "الحالات الطارئة",
    verdict: "علامات خطر تستدعي الطوارئ فورًا + تصرف أولي عام.",
    tips: ["ألم صدر شديد/ضيق نفس شديد/إغماء/نزيف شديد/تشنجات.", "اتصل بالإسعاف فورًا عند أي علامة خطر."],
    next_question: "هل لديك عرض خطير الآن؟",
    quick_choices: ["نعم", "لا"],
    when_to_seek_help: "هذه حالات طارئة — توجه للطوارئ فورًا.",
  }),
};

// ---------- choice follow-ups ----------
function handleChoiceFollowup(choiceRaw, lastCard) {
  const choice = String(choiceRaw || "").trim();
  const lastCat = String(lastCard?.category || "").trim();
  const lastTitle = String(lastCard?.title || "").trim();

  // ==== Quick follow-ups inside nutrition card ====
  if (lastCat === "nutrition") {
    if (choice.includes("سكر")) {
      return card({
        category: "nutrition",
        title: "تقليل السكر",
        verdict: "خطوات عملية لتقليل السكر اليومي بدون حرمان.",
        tips: [
          "استبدل المشروبات المحلّاة بالماء/شاي بدون سكر، وقلّل العصائر.",
          "قلّل الحلويات تدريجيًا (نصف الكمية) واختر فاكهة معظم الأيام.",
        ],
        next_question: "أكثر شيء يرفع السكر عندك: المشروبات أم الحلويات؟",
        quick_choices: ["المشروبات", "الحلويات"],
        when_to_seek_help: `إذا لديك سكري/ما قبل السكري أو أعراض مستمرة، راجع الطبيب/المركز الصحي. (وزارة الصحة العُمانية) ${MOH.diabetes}`,
      });
    }
    if (choice.includes("ملح")) {
      return card({
        category: "nutrition",
        title: "تقليل الملح",
        verdict: "تقليل الملح يساعد خصوصًا لمرضى الضغط وصحة القلب.",
        tips: [
          "قلّل الأطعمة المصنعة/المعلبة والمخللات، وجرّب تتبيل الطعام بالأعشاب والليمون بدل الملح.",
          "اقرأ الملصق الغذائي واختر خيارات أقل صوديوم تدريجيًا.",
        ],
        next_question: "هل عندك ضغط؟",
        quick_choices: ["نعم", "لا"],
        when_to_seek_help: `إذا عندك ضغط مرتفع أو قراءات متكررة، راجع الطبيب/المركز الصحي. (وزارة الصحة العُمانية) ${MOH.bp}`,
      });
    }
  }

  // ==== Activity follow-ups ====
  if (lastCat === "activity") {
    if (choice.includes("خفيف")) {
      return card({
        category: "activity",
        title: "نشاط خفيف",
        verdict: "ابدأ بخطوة سهلة اليوم.",
        tips: ["مشي 10–15 دقيقة يوميًا لمدة 5 أيام ثم زِد تدريجيًا.", "ابدأ بإطالة خفيفة بعد المشي."],
        next_question: "تقدر تمشي اليوم 10 دقائق؟",
        quick_choices: ["نعم", "لا"],
        when_to_seek_help: "إذا لديك ألم صدر/دوخة شديدة أثناء الحركة، أوقف النشاط واطلب تقييمًا طبيًا.",
      });
    }
    if (choice.includes("متوسط")) {
      return card({
        category: "activity",
        title: "نشاط متوسط",
        verdict: "خطة بسيطة لرفع النشاط بشكل آمن.",
        tips: ["مشي أسرع/دراجة 20–30 دقيقة 3–5 أيام أسبوعيًا.", "أضف يومين تمارين مقاومة خفيفة."],
        next_question: "تفضل المشي السريع أم تمارين منزلية؟",
        quick_choices: ["مشي سريع", "تمارين منزلية"],
        when_to_seek_help: "إذا ظهرت أعراض مقلقة أثناء النشاط، اطلب تقييمًا طبيًا.",
      });
    }
  }

  // ==== Sleep follow-ups ====
  if (lastCat === "sleep") {
    if (choice.includes("سهر")) {
      return card({
        category: "sleep",
        title: "سهر متكرر",
        verdict: "نرتّب لك روتين بسيط خلال 3 أيام.",
        tips: ["قدّم وقت النوم 15 دقيقة يوميًا بدل تغيير كبير مرة واحدة.", "أوقف الشاشات قبل النوم بساعة قدر الإمكان."],
        next_question: "سبب السهر الأقرب: جوال أم قهوة؟",
        quick_choices: ["جوال", "قهوة"],
        when_to_seek_help: "إذا استمر السهر مع نعاس شديد نهارًا أو شخير/انقطاع نفس، راجع مختص.",
      });
    }
    if (choice.includes("أرق")) {
      return card({
        category: "sleep",
        title: "أرق",
        verdict: "الأرق قد يرتبط بالتوتر أو المنبهات أو عادات النوم.",
        tips: ["قلّل القهوة بعد العصر.", "إذا لم تنم خلال 20–30 دقيقة، قم بنشاط هادئ ثم عد للنوم."],
        next_question: "كم ساعة تنام عادة؟",
        quick_choices: ["أقل من 6", "6–8"],
        when_to_seek_help: "إذا استمر الأرق لأكثر من أسبوعين وأثر على حياتك، راجع مختص.",
      });
    }
  }

  // ==== Mental follow-ups ====
  if (lastCat === "mental") {
    if (choice.includes("قلق")) {
      return card({
        category: "mental",
        title: "قلق",
        verdict: "أدوات بسيطة تساعدك اليوم.",
        tips: ["تنفّس 4-4-6 لمدة 3 دقائق.", "خفف الأخبار/المنبهات وخذ مشي قصير."],
        next_question: "القلق يؤثر على النوم؟",
        quick_choices: ["نعم", "لا"],
        when_to_seek_help: "إذا كان القلق شديدًا أو مستمرًا ويعطل حياتك، استشر مختص.",
      });
    }
    if (choice.includes("حزن")) {
      return card({
        category: "mental",
        title: "حزن مستمر",
        verdict: "إذا استمر الحزن وأثر على حياتك، الدعم مهم.",
        tips: ["خطوة صغيرة يوميًا: تواصل مع شخص تثق به.", "نشاط بسيط 10 دقائق قد يحسن المزاج."],
        next_question: "هل الحزن مستمر لأكثر من أسبوعين؟",
        quick_choices: ["نعم", "لا"],
        when_to_seek_help: "إذا وُجدت أفكار بإيذاء النفس أو خطر عاجل: اطلب مساعدة فورية.",
      });
    }
  }

  // ==== Heatstroke follow-up ====
  if (lastTitle.includes("ضربة الشمس") && (choice === "نعم" || choice.includes("نعم"))) {
    return card({
      category: "first_aid",
      title: "احتمال إجهاد/ضربة حرارة",
      verdict: "إذا الحرارة عالية مع دوخة/تقيؤ أو تدهور الوعي: تعامل معها كطارئ.",
      tips: ["تبريد تدريجي + سوائل إن كان واعيًا.", "اطلب طوارئ إذا كانت الأعراض شديدة أو الوعي متأثر."],
      next_question: "",
      quick_choices: [],
      when_to_seek_help: `اطلب الطوارئ فورًا عند فقدان الوعي/تشنجات/حرارة شديدة. (وزارة الصحة العُمانية) ${MOH.heatstroke}`,
    });
  }

  // ==== PATH lifestyle follow-ups ====
  if (lastTitle.includes("نمط الحياة") && lastCat === "general") {
    if (choice.includes("التغذية")) return KB.nutrition;
    if (choice.includes("النشاط")) return KB.activity;
    if (choice.includes("النوم")) return KB.sleep;
  }

  // ==== PATH women follow-ups ====
  if (lastTitle.includes("صحة النساء")) {
    if (choice.includes("تغذية")) return KB.nutrition;
    if (choice.includes("فحوصات")) {
      return card({
        category: "general",
        title: "فحوصات عامة",
        verdict: "الفحوصات المناسبة تختلف حسب العمر والتاريخ الصحي. الهدف هو الكشف المبكر.",
        tips: ["تابع فحوصات دورية حسب إرشاد المركز الصحي.", "دوّن أعراضك/ملاحظاتك قبل الموعد الطبي."],
        next_question: "هل الموضوع مرتبط بالدورة/حمل/أعراض عامة؟",
        quick_choices: ["الدورة", "حمل"],
        when_to_seek_help: `معلومات عامة للتثقيف الصحي. للمزيد: ${MOH.awareness_root}`,
      });
    }
  }

  // ==== PATH children follow-ups ====
  if (lastTitle.includes("صحة الأطفال")) {
    if (choice.includes("أقل")) {
      return card({
        category: "general",
        title: "أطفال أقل من 5 سنوات",
        verdict: "التركيز على التغذية المناسبة، التطعيمات، ومراقبة علامات الخطر.",
        tips: ["سوائل كافية خاصة عند الإسهال/الحرارة.", "تجنب المشروبات المحلّاة قدر الإمكان."],
        next_question: "هل توجد حرارة أو إسهال الآن؟",
        quick_choices: ["حرارة", "إسهال"],
        when_to_seek_help: "علامات الخطر: خمول شديد/جفاف/صعوبة تنفس/تشنجات → طوارئ.",
      });
    }
    if (choice.includes("5")) {
      return card({
        category: "general",
        title: "أطفال 5+ سنوات",
        verdict: "نمط حياة صحي: وجبات متوازنة + نشاط يومي + نوم كافٍ.",
        tips: ["نشاط بدني يومي.", "تقليل الوجبات السريعة تدريجيًا."],
        next_question: "التحدي الأكبر: التغذية أم النشاط؟",
        quick_choices: ["التغذية", "النشاط"],
        when_to_seek_help: "إذا أعراض شديدة أو مستمرة راجع الطبيب.",
      });
    }
  }

  // ==== PATH elderly follow-ups ====
  if (lastTitle.includes("صحة المسنين")) {
    if (choice.includes("السقوط")) {
      return card({
        category: "general",
        title: "الوقاية من السقوط",
        verdict: "قلّل مخاطر السقوط في المنزل وادعم التوازن.",
        tips: ["إزالة العوائق/السجاد المنزلق.", "إضاءة جيدة ليلًا.", "حركة خفيفة لتقوية العضلات."],
        next_question: "هل حصل سقوط سابقًا؟",
        quick_choices: ["نعم", "لا"],
        when_to_seek_help: "بعد سقوط مع ألم شديد/دوخة/إغماء: يحتاج تقييم فوري.",
      });
    }
    if (choice.includes("التغذية")) return KB.nutrition;
  }

  // ==== PATH adolescents follow-ups ====
  if (lastTitle.includes("صحة اليافعين")) {
    if (choice.includes("النوم")) return KB.sleep;
    if (choice.includes("التغذية")) return KB.nutrition;
  }

  // ==== PATH mental follow-ups ====
  if (lastTitle.includes("مسار الصحة النفسية")) {
    if (choice.includes("القلق")) return handleChoiceFollowup("قلق", { category: "mental", title: "الصحة النفسية" }) || KB.mental;
    if (choice.includes("النوم")) return KB.sleep;
  }

  // ==== PATH NCD follow-ups ====
  if (lastTitle.includes("الأمراض غير المعدية")) {
    if (choice.includes("الضغط")) return KB.bp;
    if (choice.includes("السكري")) return KB.sugar;
  }

  // ==== PATH Infection Control follow-ups ====
  if (lastTitle.includes("مكافحة الأمراض")) {
    if (choice.includes("نعم")) {
      return card({
        category: "general",
        title: "أعراض عدوى تنفسية",
        verdict: "إرشاد عام: راقب الأعراض وقلّل الاختلاط واهتم بالسوائل والراحة.",
        tips: ["غطِّ الفم عند السعال/العطاس.", "اغسل اليدين.", "راجع الطبيب إذا ساءت الأعراض."],
        next_question: "هل توجد حرارة عالية أو ضيق نفس؟",
        quick_choices: ["حرارة عالية", "ضيق نفس"],
        when_to_seek_help: "ضيق نفس شديد/تدهور سريع: طوارئ.",
      });
    }
    if (choice.includes("لا")) {
      return card({
        category: "general",
        title: "وقاية من العدوى",
        verdict: "الوقاية أفضل: نظافة اليدين وآداب السعال وتحديث اللقاحات حسب الإرشاد الصحي.",
        tips: ["نظافة اليدين.", "تجنب مخالطة المرضى قدر الإمكان."],
        next_question: "",
        quick_choices: [],
        when_to_seek_help: `معلومات عامة للتثقيف الصحي. للمزيد: ${MOH.awareness_root}`,
      });
    }
  }

  // ==== PATH Medication Safety follow-ups ====
  if (lastTitle.includes("السلامة الدوائية")) {
    if (choice.includes("تداخلات")) {
      return card({
        category: "general",
        title: "تداخلات دوائية",
        verdict: "قاعدة عامة: لا تجمع أدوية/مكملات بدون استشارة، خاصة مع الأمراض المزمنة.",
        tips: ["اذكر كل الأدوية للطبيب/الصيدلي.", "تجنب تكرار نفس المادة الفعالة."],
        next_question: "هل لديك مرض مزمن؟",
        quick_choices: ["نعم", "لا"],
        when_to_seek_help: "إذا ظهرت حساسية شديدة أو صعوبة تنفس بعد دواء: طوارئ.",
      });
    }
    if (choice.includes("حساسية")) {
      return card({
        category: "general",
        title: "حساسية دوائية",
        verdict: "الحساسية قد تظهر بطفح/حكة/تورم، وقد تكون شديدة في بعض الحالات.",
        tips: ["أوقف الدواء واطلب رأي طبي إذا ظهرت أعراض.", "احتفظ باسم الدواء كمعلومة للطبيب."],
        next_question: "هل توجد صعوبة تنفس أو تورم بالوجه؟",
        quick_choices: ["نعم", "لا"],
        when_to_seek_help: "صعوبة تنفس/تورم شديد: طوارئ.",
      });
    }
  }

  // ==== PATH Emergency follow-ups ====
  if (lastTitle.includes("الحالات الطارئة")) {
    if (choice.includes("نعم")) return KB.emergency;
    if (choice.includes("لا")) return KB.general;
  }

  return null;
}

// ---------- detect intents (including the long preset prompts from app.js) ----------
function detectIntent(text) {
  const t = normalizeText(text);

  // Quick paths sent as long prompts — detect by keywords
  if (t.includes("مسار نمط الحياة")) return { kind: "kb", key: "path_lifestyle" };
  if (t.includes("مسار صحة النساء")) return { kind: "kb", key: "path_women" };
  if (t.includes("مسار صحة الأطفال")) return { kind: "kb", key: "path_children" };
  if (t.includes("مسار صحة كبار السن") || t.includes("كبار السن")) return { kind: "kb", key: "path_elderly" };
  if (t.includes("مسار صحة اليافعين") || t.includes("اليفاعين") || t.includes("المراهق")) return { kind: "kb", key: "path_adolescents" };
  if (t.includes("مسار الصحة النفسية")) return { kind: "kb", key: "path_mental_health" };
  if (t.includes("مسار الأمراض غير المعدية")) return { kind: "kb", key: "path_ncd" };
  if (t.includes("مسار مكافحة الأمراض") || t.includes("مكافحة الأمراض والعدوى")) return { kind: "kb", key: "path_infection_control" };
  if (t.includes("مسار السلامة الدوائية")) return { kind: "kb", key: "path_medication_safety" };
  if (t.includes("مسار الحالات الطارئة") || t.includes("الحالات الطارئة")) return { kind: "kb", key: "path_emergency" };

  // طوارئ
  const emergencyFlags = [
    "الم شديد في الصدر",
    "ألم شديد في الصدر",
    "ضيق نفس شديد",
    "صعوبة تنفس",
    "اختناق",
    "اغماء",
    "إغماء",
    "نزيف شديد",
    "تشنج",
    "نوبة",
    "شلل",
    "ضعف مفاجئ",
    "تشوش كلام",
    "افكار انتحارية",
    "إيذاء النفس",
    "انتحار",
  ];
  if (emergencyFlags.some((f) => t.includes(normalizeText(f)))) return { kind: "kb", key: "emergency" };

  // مسارات عامة
  if (/(تغذ|غذاء|حمية|رجيم|سعرات|اكل|أكل|ملح|سكر|دهون)/.test(t)) return { kind: "kb", key: "nutrition" };
  if (/(نشاط|رياضة|مشي|تمارين|حركة)/.test(t)) return { kind: "kb", key: "activity" };
  if (/(ضغط|ضغط الدم|مرتفع الضغط|انقباضي|انبساطي)/.test(t)) return { kind: "kb", key: "bp" };
  if (/(سكر|سكري|غلوكوز|جلوكوز|صائم|بعد الاكل|بعد الأكل)/.test(t)) return { kind: "kb", key: "sugar" };
  if (/(نوم|سهر|أرق|اضطراب النوم|انقطاع النفس)/.test(t)) return { kind: "kb", key: "sleep" };
  if (/(قلق|اكتئاب|توتر|نفسية|حزن|مزاج)/.test(t)) return { kind: "kb", key: "mental" };
  if (/(ضربة الشمس|إجهاد حراري|حرارة شديدة)/.test(t)) return { kind: "kb", key: "first_aid_heatstroke" };

  // قراءة ضغط مباشرة مثل 120/80
  const bpMatch = t.match(/\b(\d{2,3})\s*\/\s*(\d{2,3})\b/);
  if (bpMatch) return { kind: "bp_reading", s: Number(bpMatch[1]), d: Number(bpMatch[2]) };

  // تحيات وتجارب
  if (/^(مرحبا|مرحبًا|السلام عليكم|السلام)\b/.test(t)) return { kind: "kb", key: "general" };
  if (/^(شكرا|شكرًا|مشكور|يسلمو|يعطيك العافية)\b/.test(t)) return { kind: "kb", key: "general" };

  return { kind: "unknown" };
}

function classifyBp(s, d) {
  if (!s || !d) return "لا يمكن التصنيف من هذه القراءة.";
  if (s < 90 || d < 60) return "يميل للانخفاض.";
  if (s < 120 && d < 80) return "في المجال الطبيعي تقريبًا.";
  if (s >= 120 && s <= 129 && d < 80) return "ارتفاع بسيط.";
  if ((s >= 130 && s <= 139) || (d >= 80 && d <= 89)) return "ارتفاع درجة أولى (تقريبي).";
  if (s >= 140 || d >= 90) return "ارتفاع واضح.";
  return "لا يمكن تصنيفه بدقة من هذه القراءة فقط.";
}

// ---------- cache + quotas ----------
const cache = new Map(); // per user normalized msg (+ last category)
const userState = new Map(); // userId -> { lastAt, dayKey, used }
const userMsgCount = new Map(); // userId -> count

function getUserId(req) {
  return String(req.headers["x-user-id"] || req.ip || "anon");
}

function dayKeyNow() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function checkCooldownAndQuota(userId) {
  const now = Date.now();
  const dk = dayKeyNow();
  const st = userState.get(userId) || { lastAt: 0, dayKey: dk, used: 0 };

  if (st.dayKey !== dk) {
    st.dayKey = dk;
    st.used = 0;
  }

  if (now - st.lastAt < COOLDOWN_MS) {
    st.lastAt = now;
    userState.set(userId, st);
    return { ok: false, reason: "cooldown" };
  }

  if (st.used >= DAILY_LIMIT) {
    st.lastAt = now;
    userState.set(userId, st);
    return { ok: false, reason: "daily_limit" };
  }

  st.used += 1;
  st.lastAt = now;
  userState.set(userId, st);
  return { ok: true };
}

function cacheGet(key) {
  const v = cache.get(key);
  if (!v) return null;
  if (Date.now() > v.exp) {
    cache.delete(key);
    return null;
  }
  return v.data;
}
function cacheSet(key, data) {
  cache.set(key, { exp: Date.now() + CACHE_TTL_MS, data });
}

// ---------- Groq ----------
function buildSystemPrompt() {
  return `
أنت "دليل العافية" للتثقيف الصحي العام فقط (ليس تشخيصًا).
أجب بالعربية وباختصار شديد. ممنوع: أدوية/جرعات/تشخيص.
أعد JSON صالح فقط (بدون أي نص خارجه).
التصنيفات: general | nutrition | bp | sugar | sleep | activity | mental | first_aid | report | emergency | water | calories | bmi
الشكل:
{"category":"general","title":"...","verdict":"...","next_question":"...","quick_choices":["..",".."],"tips":["..",".."],"when_to_seek_help":"..."}
`.trim();
}

async function callGroq(messages) {
  const res = await fetchWithTimeout(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL_ID,
        temperature: TEMP,
        max_tokens: MAX_TOKENS,
        messages,
      }),
    },
    20000
  );

  if (!res.ok) throw new Error("Groq API error");
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

function fallback(rawText) {
  const looseVerdict = extractVerdictLoosely(rawText);
  return {
    category: "general",
    title: "معلومة صحية",
    verdict: looseVerdict || "لم أتمكن من توليد رد الآن. حاول كتابة سؤالك بشكل أوضح ومختصر.",
    next_question: "",
    quick_choices: [],
    tips: [],
    when_to_seek_help: "",
  };
}

// ---------- routes ----------
app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/reset", (_req, res) => res.json({ ok: true }));

app.post("/chat", chatLimiter, async (req, res) => {
  try {
    const userId = getUserId(req);
    const msg = String(req.body?.message || "").trim();
    const meta = req.body?.meta || {};
    const isChoice = meta && meta.is_choice === true;

    if (!msg) return res.status(400).json({ ok: false, error: "empty_message" });
    if (msg.length > 1400) return res.status(400).json({ ok: false, error: "message_too_long" });

    const lastCard = req.body?.context?.last || null;

    // 0) اختيار من الأزرار (Quick Choices): نعالجه قبل الكولداون/الحد اليومي
    if (isChoice && lastCard && typeof lastCard === "object") {
      const follow = handleChoiceFollowup(msg, lastCard);
      if (follow) return res.json({ ok: true, data: follow });
      // لو ما عرفناه، نكمل كرسالة عادية لكن بدون "عقوبة" التبريد غالبًا
    }

    // 1) رسائل قصيرة جدًا
    if (msg.length < 2) {
      return res.json({
        ok: true,
        data: card({
          category: "general",
          title: "رسالة قصيرة",
          verdict: "اكتب سؤالك بشكل واضح حتى أقدر أساعدك.",
          tips: ["مثال: (صداع منذ يومين) أو (كيف أخفف الملح؟)"],
          next_question: "هل سؤالك عن تغذية أم نشاط؟",
          quick_choices: ["تغذية", "نشاط"],
          when_to_seek_help: "",
        }),
      });
    }

    // 2) تبريد/حد يومي (لا نطبقها على isChoice)
    if (!isChoice) {
      const gate = checkCooldownAndQuota(userId);
      if (!gate.ok) {
        if (gate.reason === "cooldown") {
          return res.json({
            ok: true,
            data: card({
              category: "general",
              title: "لحظة",
              verdict: "أرسلت رسائل بسرعة. انتظر قليلًا ثم أرسل سؤالك.",
              tips: ["هذا لتقليل الضغط وحماية الخدمة للمجتمع."],
              next_question: "",
              quick_choices: [],
              when_to_seek_help: "",
            }),
          });
        }
        return res.json({
          ok: true,
          data: card({
            category: "general",
            title: "حد يومي",
            verdict: "وصلت للحد اليومي للاستخدام لهذا المستخدم. جرّب غدًا.",
            tips: ["هذا حد حماية لتجنب توقف الخدمة للجميع."],
            next_question: "",
            quick_choices: [],
            when_to_seek_help: "",
          }),
        });
      }
    }

    // 3) Cache (يشمل آخر تصنيف/عنوان حتى ما يكرر نفس البطاقة غلط)
    const cacheKey = `${userId}::${normalizeText(msg)}::${String(lastCard?.category || "")}::${String(lastCard?.title || "")}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json({ ok: true, data: cached });

    // 4) Intent => KB (بدون AI)
    const intent = detectIntent(msg);

    if (intent.kind === "kb") {
      const data = KB[intent.key] || KB.general;
      cacheSet(cacheKey, data);
      return res.json({ ok: true, data });
    }

    if (intent.kind === "bp_reading") {
      const category = classifyBp(intent.s, intent.d);
      const data = card({
        category: "bp",
        title: "قراءة ضغط",
        verdict: `القراءة: ${intent.s}/${intent.d} — التقدير: ${category}`,
        tips: [
          "يفضل أخذ أكثر من قراءة في أوقات مختلفة وعدم الاعتماد على قراءة واحدة فقط.",
          "قلّل الملح وداوم على النشاط وراجع الطبيب إذا تكررت القراءات المرتفعة.",
        ],
        next_question: "هل تكررت هذه القراءة أكثر من مرة؟",
        quick_choices: ["نعم", "لا"],
        when_to_seek_help: `إذا وُجد ألم صدر/ضيق نفس/دوخة شديدة أو قراءات مرتفعة متكررة راجع الطوارئ/الطبيب. (وزارة الصحة العُمانية) ${MOH.bp}`,
      });
      cacheSet(cacheKey, data);
      return res.json({ ok: true, data });
    }

    // 5) إذا AI غير مفعّل
    if (!AI_FALLBACK_ENABLED) {
      const data = card({
        category: "general",
        title: "إرشاد عام",
        verdict: "هذا السؤال يحتاج تفاصيل أو مصدر محدد. جرّب صياغة سؤالك بشكل أوضح.",
        tips: ["اكتب: الأعراض + المدة + العمر (إن أمكن) + هل لديك مرض مزمن؟"],
        next_question: "هل سؤالك عن تغذية أم نشاط أم نوم؟",
        quick_choices: ["تغذية", "نشاط"],
        when_to_seek_help: "",
      });
      cacheSet(cacheKey, data);
      return res.json({ ok: true, data });
    }

    // 6) Gate إضافي: لا نشغّل AI إلا بعد N رسائل (فقط للأسئلة غير المغطاة محليًا)
    if (!isChoice && AI_AFTER_MESSAGES > 0) {
      const c = (userMsgCount.get(userId) || 0) + 1;
      userMsgCount.set(userId, c);
      if (c < AI_AFTER_MESSAGES) {
        const data = card({
          category: "general",
          title: "متابعة",
          verdict: "لأفضل إجابة: اكتب سؤالك بتفصيل أكثر (أعراض + مدة + عمر إن أمكن).",
          tips: ["مثال: (صداع منذ يومين مع غثيان).", "اذكر إن كان لديك مرض مزمن."],
          next_question: "",
          quick_choices: [],
          when_to_seek_help: "",
        });
        cacheSet(cacheKey, data);
        return res.json({ ok: true, data });
      }
    }

    // 7) AI path (limited tokens)
    const messages = [{ role: "system", content: buildSystemPrompt() }];

    if (lastCard && typeof lastCard === "object") {
      messages.push({
        role: "assistant",
        content: "سياق سابق (آخر بطاقة JSON للاستمرار عليها):\n" + JSON.stringify(lastCard),
      });
    }

    messages.push({
      role: "user",
      content: msg + "\n\nملاحظة: إن لم تكن متأكدًا، أعطِ إرشادًا عامًا قصيرًا + سؤال متابعة واحد فقط.",
    });

    const raw = await callGroq(messages);
    let parsed = extractJson(raw);

    let retryRaw = "";
    if (!parsed) {
      retryRaw = await callGroq(messages);
      parsed = extractJson(retryRaw);
    }

    let data;
    if (parsed) data = normalize(parsed);
    else data = normalize(recoverPartialCard(retryRaw || raw) || fallback(raw));

    if (isMetaJsonAnswer(data)) {
      data = normalize(recoverPartialCard(retryRaw || raw) || fallback(raw));
    }

    cacheSet(cacheKey, data);
    return res.json({ ok: true, data });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "server_error", data: fallback("") });
  }
});

app.listen(PORT, () => {
  console.log(
    `🚀 API running on :${PORT} | model=${MODEL_ID} | ai_fallback=${AI_FALLBACK_ENABLED ? "on" : "off"} | max_tokens=${MAX_TOKENS}`
  );
});
