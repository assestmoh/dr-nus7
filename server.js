// server.js — Dalil Alafiyah API (Local-first + AI continuation)
// ✅ نفس /chat و /reset و /health ونفس JSON structure المتوقعة من app.js
// ✅ Local-first: المسارات السريعة + أغلب البطاقات محليًا (بدون AI)
// ✅ إذا انتهى التفريع المحلي (زر/اختيار بدون تفريع) → AI يكمل نفس الموضوع مباشرة (إن كان مفعّلًا)
// ✅ لا نُرجع أبدًا رسالة عامة مثل: "لا توجد معلومة محلية مطابقة الآن"
//
// تشغيل:
// - npm start
// إعدادات بيئة مهمة:
// - GROQ_API_KEY=...
// - AI_FALLBACK_ENABLED=1   (أو 0 لتعطيل الذكاء نهائيًا)
// - MAX_TOKENS=220
// - TEMPERATURE=0.25
// - RATE_LIMIT_PER_MIN=30
// - ALLOWED_ORIGINS=https://alafya.netlify.app,http://localhost:8000

import "dotenv/config";
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

const app = express();

const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const MODEL_ID = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const PORT = process.env.PORT || 3000;

const AI_FALLBACK_ENABLED =
  (process.env.AI_FALLBACK_ENABLED || (GROQ_API_KEY ? "1" : "0")) === "1";

const MAX_TOKENS = Number(process.env.MAX_TOKENS || 220);
const TEMP = Number(process.env.TEMPERATURE || 0.25);

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(helmet());
app.set("trust proxy", 1);
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.length === 0) return cb(null, true);
      return ALLOWED_ORIGINS.includes(origin)
        ? cb(null, true)
        : cb(new Error("CORS blocked"), false);
    },
    methods: ["POST", "GET"],
  })
);

app.use(bodyParser.json({ limit: "2mb" }));

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_PER_MIN || 30),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.headers["x-user-id"] || req.ip),
});

// ---------------- helpers ----------------
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
const sArr = (v, n) =>
  Array.isArray(v)
    ? v.filter((x) => typeof x === "string" && x.trim()).slice(0, n)
    : [];

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

function card({ category, title, verdict, tips = [], next_question = "", quick_choices = [], when_to_seek_help = "" }) {
  return normalize({ category, title, verdict, tips, next_question, quick_choices, when_to_seek_help });
}

function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^\u0600-\u06FFa-z0-9\s/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// -------- Local KB (polished) --------
const KB = {
  general_home: card({
    category: "general",
    title: "دليل العافية",
    verdict: "اكتب سؤالك الصحي بشكل واضح (الأعراض + المدة + العمر إن أمكن) للحصول على إرشاد عام أدق.",
    tips: ["تجنّب مشاركة بيانات حساسة.", "إذا كانت الحالة طارئة اذهب للطوارئ فورًا."],
    next_question: "هل سؤالك عن تغذية أم نشاط؟",
    quick_choices: ["تغذية", "نشاط"],
    when_to_seek_help: "",
  }),

  path_lifestyle: card({
    category: "general",
    title: "نمط الحياة الصحي",
    verdict:
      "نمط حياة صحي = ثلاث ركائز: **طبق متوازن** + **حركة يومية** + **نوم منتظم**. نبدأ بخطوة صغيرة قابلة للاستمرار.",
    tips: [
      "اختر تغييرًا واحدًا اليوم وطبّقه 7 أيام.",
      "خفّض السكر والملح تدريجيًا لتثبيت العادة (نهج موصى به في الإرشادات الغذائية).",
    ],
    next_question: "تريد تبدأ من أي محور؟",
    quick_choices: ["التغذية", "النشاط"],
    when_to_seek_help: "إذا لديك مرض مزمن أو أعراض مستمرة، راجع مركزًا صحيًا لوضع خطة تناسب حالتك.",
  }),

  path_women: card({
    category: "general",
    title: "صحة النساء",
    verdict: "إرشادات عامة آمنة: وقاية + نمط حياة + متابعة أعراض مستمرة. (بدون أدوية/جرعات).",
    tips: ["سجّلي الأعراض ومدتها قبل زيارة الطبيب.", "توازن غذائي ونشاط ونوم يساعد."],
    next_question: "أي جزء تريده الآن؟",
    quick_choices: ["تغذية", "فحوصات"],
    when_to_seek_help: "نزيف شديد/ألم شديد مفاجئ/دوخة شديدة: طوارئ.",
  }),

  path_children: card({
    category: "general",
    title: "صحة الأطفال",
    verdict: "وقاية عامة: تغذية مناسبة + نشاط + تطعيمات + مراقبة علامات الخطر.",
    tips: ["قلّل السكريات والمشروبات المحلّاة.", "راقب السوائل عند الإسهال/الحرارة."],
    next_question: "العمر التقريبي؟",
    quick_choices: ["أقل من 5", "5+ سنوات"],
    when_to_seek_help: "حرارة عالية مستمرة/خمول شديد/صعوبة تنفس/جفاف واضح: راجع الطبيب أو الطوارئ.",
  }),

  child_u5: card({
    category: "general",
    title: "أطفال أقل من 5 سنوات",
    verdict: "التركيز: تغذية مناسبة + التطعيمات + مراقبة علامات الخطر + سوائل كافية.",
    tips: ["سوائل بكميات صغيرة ومتكررة عند المرض.", "تجنّب المشروبات المحلّاة قدر الإمكان."],
    next_question: "هل توجد حرارة أو إسهال الآن؟",
    quick_choices: ["حرارة", "إسهال"],
    when_to_seek_help: "علامات الخطر: خمول شديد/جفاف/صعوبة تنفس/تشنجات → طوارئ.",
  }),

  child_5p: card({
    category: "general",
    title: "أطفال 5+ سنوات",
    verdict: "الأساسيات: وجبات متوازنة + نشاط يومي + نوم كافٍ + تقليل الوجبات السريعة تدريجيًا.",
    tips: ["نشاط بدني يومي حسب العمر.", "الوجبات السريعة تكون استثناء وليس عادة."],
    next_question: "المشكلة الأكثر؟",
    quick_choices: ["التغذية", "النوم"],
    when_to_seek_help: "إذا أعراض شديدة أو مستمرة راجع الطبيب.",
  }),

  child_fever_u5: card({
    category: "general",
    title: "حرارة عند طفل (<5)",
    verdict: "إرشاد عام: ركّز على السوائل والراحة وراقب العلامات الحمراء. (بدون أدوية/جرعات هنا).",
    tips: ["راقب التبول/جفاف الفم/الخمول.", "خفف الملابس واجعل المكان معتدل."],
    next_question: "منذ متى بدأت الحرارة؟",
    quick_choices: ["أقل من 24 ساعة", "أكثر من 24 ساعة"],
    when_to_seek_help: "طوارئ/طبيب فورًا عند: خمول شديد، صعوبة تنفس، تشنجات، جفاف واضح، أو تدهور سريع.",
  }),

  child_diarrhea_u5: card({
    category: "general",
    title: "إسهال عند طفل (<5)",
    verdict: "الأولوية: منع الجفاف. سوائل بكميات صغيرة ومتكررة ومراقبة العلامات.",
    tips: ["استمر على الرضاعة/الطعام المعتاد إن أمكن.", "راقب الجفاف: قلة التبول/خمول/جفاف."],
    next_question: "هل يوجد قيء متكرر أو دم في البراز؟",
    quick_choices: ["قيء متكرر", "دم/لون أسود"],
    when_to_seek_help:
      "راجع الطبيب/الطوارئ عند: جفاف واضح، دم بالبراز، قيء مستمر يمنع الشرب، حرارة عالية مستمرة، أو خمول شديد.",
  }),

  path_elderly: card({
    category: "general",
    title: "صحة المسنين",
    verdict: "الأولوية: الوقاية من السقوط + تغذية/سوائل + متابعة الأمراض المزمنة.",
    tips: ["أمّن المنزل (إضاءة/إزالة عوائق).", "راجِع الأدوية دوريًا مع الطبيب."],
    next_question: "أي موضوع الآن؟",
    quick_choices: ["الوقاية من السقوط", "التغذية"],
    when_to_seek_help: "سقوط مع ألم شديد/إغماء/دوخة شديدة: يحتاج تقييم فوري.",
  }),

  elderly_falls: card({
    category: "general",
    title: "الوقاية من السقوط",
    verdict: "قلّل مخاطر السقوط في المنزل وادعم التوازن.",
    tips: ["إزالة السجاد المنزلق والعوائق.", "إضاءة جيدة ليلًا.", "حركة خفيفة لتقوية العضلات."],
    next_question: "هل حصل سقوط سابقًا؟",
    quick_choices: ["نعم", "لا"],
    when_to_seek_help: "بعد سقوط مع ألم شديد/دوخة/إغماء: يحتاج تقييم طبي سريع.",
  }),

  path_adolescents: card({
    category: "general",
    title: "صحة اليافعين",
    verdict: "النوم + التغذية + النشاط + الدعم النفسي… أهم الأساسيات.",
    tips: ["ثبّت وقت النوم قدر الإمكان.", "قلّل مشروبات الطاقة والسكريات."],
    next_question: "التحدي الأكبر؟",
    quick_choices: ["النوم", "التغذية"],
    when_to_seek_help: "إذا حزن/توتر شديد مستمر يؤثر على الدراسة/الحياة: اطلب مساعدة مختص.",
  }),

  path_mental: card({
    category: "mental",
    title: "الصحة النفسية",
    verdict: "أدوات بسيطة يومية قد تساعد (ليس تشخيصًا).",
    tips: ["تنفّس ببطء 3 دقائق.", "مشي خفيف 10 دقائق.", "تواصل مع شخص تثق به."],
    next_question: "تريد أدوات للقلق أم لتحسين النوم؟",
    quick_choices: ["القلق", "النوم"],
    when_to_seek_help: "إذا وُجدت أفكار بإيذاء النفس أو خطر عاجل: اطلب مساعدة فورية.",
  }),

  mental_anxiety: card({
    category: "mental",
    title: "أدوات للقلق",
    verdict: "جرّب اليوم: تنفّس + تقليل المنبهات + خطوة حركة بسيطة.",
    tips: ["تنفّس 4-4-6 لمدة 3 دقائق.", "قلّل القهوة/المنبهات خاصة مساءً."],
    next_question: "هل القلق يؤثر على النوم؟",
    quick_choices: ["نعم", "لا"],
    when_to_seek_help: "إذا القلق شديد/مستمر ويعطّل حياتك: استشر مختص.",
  }),

  path_ncd: card({
    category: "general",
    title: "الأمراض غير المعدية",
    verdict: "الوقاية تعتمد على: غذاء صحي + نشاط + وزن + إيقاف التدخين + فحوصات دورية.",
    tips: ["قلّل الملح/السكر.", "تحرّك يوميًا قدر الإمكان."],
    next_question: "تهتم أكثر بالضغط أم السكري؟",
    quick_choices: ["الضغط", "السكري"],
    when_to_seek_help: "أعراض شديدة/قراءات عالية متكررة: راجع الطبيب.",
  }),

  path_infection: card({
    category: "general",
    title: "مكافحة العدوى",
    verdict: "الوقاية: غسل اليدين + آداب السعال + البقاء بالمنزل عند المرض + لقاحات حسب الإرشاد الصحي.",
    tips: ["اغسل اليدين جيدًا.", "تجنب مخالطة الآخرين عند وجود أعراض عدوى."],
    next_question: "هل عندك أعراض تنفسية الآن؟",
    quick_choices: ["نعم", "لا"],
    when_to_seek_help: "ضيق نفس شديد/تدهور سريع: طوارئ.",
  }),

  path_med_safety: card({
    category: "general",
    title: "السلامة الدوائية",
    verdict: "قواعد عامة للاستخدام الآمن (بدون جرعات): اتّبع الوصفة/النشرة ولا تخلط أدوية بدون استشارة.",
    tips: ["اذكر كل أدويتك للطبيب/الصيدلي لتجنب التداخلات.", "لا تكرر نفس المادة الفعالة بأسماء تجارية مختلفة."],
    next_question: "هل تريد معلومات عامة عن نوع دواء؟",
    quick_choices: ["خافض حرارة", "مضاد حساسية"],
    when_to_seek_help: "طفح شديد/تورم/صعوبة تنفس بعد دواء: طارئ.",
  }),

  med_antipyretic: card({
    category: "general",
    title: "خافض حرارة",
    verdict: "معلومات عامة: خافضات الحرارة تُستخدم للتخفيف من الحرارة/الألم وفق إرشاد مختص. (بدون جرعات هنا).",
    tips: [
      "تجنب أخذ أكثر من منتج يحتوي نفس المادة الفعالة في نفس الوقت.",
      "انتبه للحساسية، وأمراض الكبد/الكلى، وتحقق من النشرة أو اسأل الصيدلي.",
    ],
    next_question: "هل السؤال عن طفل أم بالغ؟",
    quick_choices: ["طفل", "بالغ"],
    when_to_seek_help: "حرارة عالية مستمرة/خمول شديد/تشنجات/صعوبة تنفس: طوارئ أو طبيب فورًا.",
  }),

  med_antihistamine: card({
    category: "general",
    title: "مضاد حساسية",
    verdict: "معلومات عامة: مضادات الحساسية قد تخفف أعراض الرشح التحسسي/الحكة حسب الحالة. (بدون جرعات).",
    tips: [
      "بعض الأنواع تسبب نعاس؛ تجنب القيادة إذا شعرت بالنعاس.",
      "راجع الطبيب/الصيدلي إذا لديك أمراض مزمنة أو تستخدم أدوية متعددة.",
    ],
    next_question: "هل الأعراض: عطاس/رشح أم حكة/طفح؟",
    quick_choices: ["عطاس/رشح", "حكة/طفح"],
    when_to_seek_help: "تورم بالوجه/صعوبة تنفس/صفير شديد: طوارئ.",
  }),

  med_antibiotic: card({
    category: "general",
    title: "مضاد حيوي",
    verdict: "المضادات الحيوية تُستخدم لعدوى بكتيرية فقط — وليست مفيدة لمعظم نزلات البرد الفيروسية.",
    tips: ["لا تستخدم مضاد حيوي بدون وصفة/تقييم طبي.", "أكمل الخطة العلاجية كما يحدد الطبيب لتقليل المقاومة."],
    next_question: "هل هناك تشخيص طبي بعدوى بكتيرية؟",
    quick_choices: ["نعم", "لا"],
    when_to_seek_help: "حساسية شديدة/طفح واسع/صعوبة تنفس بعد دواء: طوارئ.",
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

function handleChoiceFollowup(choiceRaw, lastCard) {
  const choice = String(choiceRaw || "").trim();
  const lastTitle = String(lastCard?.title || "").trim();

  // lifestyle
  if (lastTitle.includes("نمط الحياة")) {
    if (choice.includes("التغذية"))
      return card({
        category: "nutrition",
        title: "الغذاء المتوازن",
        verdict: "هدفنا اليوم: **طبق متوازن** مع خفض تدريجي للسكر/الملح. ركّز على الجودة لا الحرمان.",
        tips: [
          "نصف الطبق خضار/فواكه (تنويع الألوان أفضل).",
          "أضف بروتينًا مناسبًا + حبوبًا كاملة.",
          "اختر الماء بدل المشروبات المُحلّاة قدر الإمكان.",
        ],
        next_question: "ما الأولوية هذا الأسبوع؟",
        quick_choices: ["تقليل السكر", "تقليل الملح"],
        when_to_seek_help: "إذا لديك مرض مزمن، راجع مختصًا لتوصيات مناسبة. (مرجع: الإرشادات الغذائية العُمانية – وزارة الصحة)",
      });
    if (choice.includes("النشاط"))
      return card({
        category: "activity",
        title: "خطة نشاط بسيطة",
        verdict: "ابدأ بخطوة خفيفة ثم زد تدريجيًا.",
        tips: ["مشي 10–15 دقيقة يوميًا 5 أيام.", "زد 5 دقائق كل أسبوع حسب القدرة."],
        next_question: "تفضل نشاط خفيف أم متوسط؟",
        quick_choices: ["خفيف", "متوسط"],
        when_to_seek_help: "ألم صدر/دوخة شديدة أثناء النشاط: أوقف واطلب تقييم طبي.",
      });
  }

  // nutrition followups
  if (lastTitle.includes("الغذاء المتوازن")) {
    if (choice.includes("تقليل السكر")) {
      return card({
        category: "nutrition",
        title: "تقليل السكر",
        verdict: "خطة عملية: خفّض السكر **بالتدريج** وركّز على بدائل ذكية دون شعور بالحرمان.",
        tips: [
          "استبدل المشروبات المُحلّاة بالماء/شاي غير مُحلّى، وقلّل التحلية خطوة خطوة.",
          "اقرأ الملصق الغذائي واختر منتجات أقل سكرًا، وفضّل الفاكهة بدل الحلويات اليومية.",
        ],
        next_question: "أكبر مصدر سكر عندك غالبًا؟",
        quick_choices: ["مشروبات", "حلويات"],
        when_to_seek_help:
          "إذا لديك سكري/ما قبل السكري أو أعراض غير معتادة، راجع الطبيب/أخصائي التغذية. (مرجع: مواد التوعية بالملح/السكر – وزارة الصحة)",
      });
    }
    if (choice.includes("تقليل الملح")) {
      return card({
        category: "nutrition",
        title: "تقليل الملح",
        verdict: "تقليل الملح مفيد للصحة القلبية والضغط عند كثير من الناس— والأفضل أن يكون تدريجيًا.",
        tips: [
          "خفّض الأطعمة المصنعة (معلبات/مقرمشات/لحوم معالجة) لأنها الأعلى بالصوديوم.",
          "استبدل الملح بالأعشاب/الليمون/البهارات، واطلب في المطاعم عدم إضافة ملح قدر الإمكان.",
        ],
        next_question: "مصدر الملح الأكبر عندك؟",
        quick_choices: ["مطاعم", "معلبات"],
        when_to_seek_help:
          "إذا لديك ضغط مرتفع/مرض كلوي/قلب، خفّض الملح تحت متابعة صحية. (مرجع: كتيّب التوعية عن الملح – وزارة الصحة)",
      });
    }
  }

  // women
  if (lastTitle.includes("صحة النساء")) {
    if (choice.includes("تغذية")) return KB.path_lifestyle;
    if (choice.includes("فحوصات"))
      return card({
        category: "general",
        title: "فحوصات عامة",
        verdict: "الفحوصات تعتمد على العمر والتاريخ الصحي. الهدف: الكشف المبكر والمتابعة.",
        tips: ["دوّني الأعراض وتاريخها.", "اسألي الطبيب عن الفحوصات المناسبة لحالتك."],
        next_question: "هل الموضوع مرتبط بالدورة أم أعراض عامة؟",
        quick_choices: ["الدورة", "أعراض عامة"],
        when_to_seek_help: "نزيف شديد/ألم شديد مفاجئ/إغماء: طوارئ.",
      });
  }

  // children
  if (lastTitle.includes("صحة الأطفال")) {
    if (choice.includes("أقل")) return KB.child_u5;
    if (choice.includes("5+")) return KB.child_5p;
  }
  if (lastTitle.includes("أطفال أقل من 5")) {
    if (choice.includes("حرارة")) return KB.child_fever_u5;
    if (choice.includes("إسهال")) return KB.child_diarrhea_u5;
  }
  if (lastTitle.includes("إسهال عند طفل")) {
    if (choice.includes("قيء")) {
      return card({
        category: "general",
        title: "إسهال مع قيء متكرر عند طفل (<5)",
        verdict:
          "استمر في إعطاء سوائل صغيرة ومتكررة (ماء/محلول رطوبة فموي) وراقب علامات الجفاف. قدّم كميات قليلة كل 5–10 دقائق بدل كمية كبيرة دفعة واحدة.",
        tips: [
          "إذا كان يرضع: استمر على الرضاعة.",
          "راقب الجفاف: قلة البول/جفاف الفم/خمول/انعدام الدموع.",
        ],
        next_question: "هل ظهر حمى أعلى من 38°C أو تغيّر في الوعي؟",
        quick_choices: ["حمى مرتفعة", "تغير الوعي"],
        when_to_seek_help:
          "راجع الطبيب/الطوارئ عند: جفاف واضح، قيء يمنع الشرب، دم بالبراز، خمول شديد، أو صعوبة تنفس.",
      });
    }
    if (choice.includes("دم")) {
      return card({
        category: "general",
        title: "إسهال مع دم/لون أسود (<5)",
        verdict: "وجود دم أو لون أسود في البراز يحتاج تقييمًا طبيًا عاجلًا.",
        tips: ["حافظ على السوائل قدر الإمكان.", "لا تُعطِ أدوية بدون استشارة."],
        next_question: "هل الطفل خامل جدًا أو لديه جفاف؟",
        quick_choices: ["نعم", "لا"],
        when_to_seek_help: "توجّه للطوارئ/الطبيب فورًا.",
      });
    }
  }

  // elderly
  if (lastTitle.includes("صحة المسنين")) {
    if (choice.includes("السقوط")) return KB.elderly_falls;
    if (choice.includes("التغذية")) return KB.path_lifestyle;
  }
  if (lastTitle.includes("الوقاية من السقوط")) {
    if (choice === "نعم") {
      return card({
        category: "general",
        title: "بعد سقوط سابق",
        verdict: "بما أن هناك سقوطًا سابقًا: ركّز على **تقييم السبب** وتقليل عوامل الخطر في البيت.",
        tips: [
          "تحقق من النظر/السمع وراجع الأدوية التي قد تسبب دوخة (مع طبيب/صيدلي).",
          "أضف وسائل أمان: مقابض في الحمام، إضاءة ليلية، أحذية مناسبة داخل المنزل.",
        ],
        next_question: "هل كان السقوط بسبب دوخة أم تعثر؟",
        quick_choices: ["دوخة", "تعثر"],
        when_to_seek_help: "إذا تكرر السقوط أو وُجد إغماء/دوخة شديدة: يلزم تقييم طبي.",
      });
    }
    if (choice === "لا") {
      return card({
        category: "general",
        title: "وقاية استباقية",
        verdict: "ممتاز. الوقاية قبل حدوث السقوط أفضل: ثبّت البيئة الآمنة وادعم التوازن.",
        tips: ["تمارين توازن خفيفة (حسب القدرة) + مشي منتظم.", "حافظ على الإضاءة وإزالة العوائق بشكل دائم."],
        next_question: "هل يوجد دوخة متكررة؟",
        quick_choices: ["نعم", "لا"],
        when_to_seek_help: "دوخة شديدة/إغماء/ضعف مفاجئ: طوارئ أو تقييم عاجل.",
      });
    }
  }


  // falls: followups for "بعد سقوط سابق" (حتى لا يعتمد على AI هنا)
  if (lastTitle.includes("بعد سقوط سابق")) {
    if (choice === "دوخة") {
      return card({
        category: "general",
        title: "دوخة مسببة للسقوط",
        verdict:
          "الدوخة عند الوقوف قد ترتبط بهبوط ضغط انتصابي/جفاف/نقص سكر/أدوية أو مشاكل بالأذن الداخلية. الهدف الآن: تقليل خطر السقوط إلى أن يتم تقييم السبب.",
        tips: [
          "قم ببطء: اجلس دقيقة ثم قف تدريجيًا، واشرب سوائل كفاية (ما لم يمنعك الطبيب).",
          "راجع الأدوية التي قد تسبب دوخة (خافضات ضغط/مدرات/مهدئات) مع طبيب/صيدلي.",
        ],
        next_question: "هل تشعر بالدوخة عند الوقوف فجأة؟",
        quick_choices: ["نعم", "لا"],
        when_to_seek_help:
          "طارئ إذا وُجد: إغماء/ألم صدر/ضعف أو خدر مفاجئ/ضيق نفس/صداع شديد مفاجئ.",
      });
    }
    if (choice === "تعثر") {
      return card({
        category: "general",
        title: "تعثر مسبّب للسقوط",
        verdict:
          "التعثر غالبًا سببه عوائق منزلية/حذاء غير مناسب/ضعف توازن أو رؤية. نركّز على تقليل المخاطر فورًا.",
        tips: [
          "أزل العوائق والسجاد المنزلق، وثبّت الأسلاك، واستخدم إضاءة ليلية بالممرات.",
          "اختر أحذية ثابتة داخل البيت، وفكّر بعصا/مساند إذا كان التوازن ضعيفًا.",
        ],
        next_question: "هل حصل التعثر داخل المنزل غالبًا؟",
        quick_choices: ["نعم", "لا"],
        when_to_seek_help:
          "إذا تكرر السقوط أو وُجد ألم شديد/تورم كبير/عدم قدرة على المشي: تقييم طبي.",
      });
    }
  }

  // falls: followups for "دوخة مسببة للسقوط" (إلغاء كرت المتابعة العام)
  if (lastTitle.includes("دوخة مسببة للسقوط")) {
    if (choice === "نعم") {
      return card({
        category: "general",
        title: "دوخة عند الوقوف",
        verdict:
          "هذا يوحي بوجود **هبوط ضغط عند الوقوف** أو **جفاف** أو تأثير دواء. غالبًا يتحسن بتعديل بسيط + تقييم السبب إن تكرر.",
        tips: [
          "انهض تدريجيًا: من الاستلقاء → جلوس 60 ثانية → وقوف ببطء، واثبت قبل المشي.",
          "زد السوائل على مدار اليوم إن لم يكن لديك منع طبي (قلب/كلية)، وتجنب الوقوف المفاجئ بعد حمام ساخن.",
        ],
        next_question: "هل تستخدم أدوية ضغط/مدرات بول؟",
        quick_choices: ["نعم", "لا"],
        when_to_seek_help:
          "إذا حدث إغماء، أو سقطت بسبب الدوخة، أو ظهرت أعراض عصبية/قلبية: اطلب تقييمًا عاجلًا.",
      });
    }
    if (choice === "لا") {
      return card({
        category: "general",
        title: "دوخة ليست مرتبطة بالوقوف",
        verdict:
          "قد تكون مرتبطة بالأذن الداخلية (دوار)، أو انخفاض سكر، أو أسباب أخرى. نحتاج تحديد النمط لتوجيه الإرشاد.",
        tips: [
          "إذا الدوخة كإحساس دوران ومع غثيان: تجنب القيادة وانهض ببطء.",
          "تناول وجبات خفيفة منتظمة وتجنب الصيام الطويل إذا لاحظت ارتباطًا بالجوع.",
        ],
        next_question: "هل الدوخة على شكل دوران (الغرفة تدور)؟",
        quick_choices: ["نعم", "لا"],
        when_to_seek_help:
          "طارئ إذا وُجد: ضعف/خدر مفاجئ، اضطراب كلام، صداع شديد مفاجئ، ألم صدر أو ضيق نفس.",
      });
    }
  }

  // falls: followups for "تعثر مسبّب للسقوط"
  if (lastTitle.includes("تعثر مسبّب للسقوط")) {
    if (choice === "نعم") {
      return card({
        category: "general",
        title: "تعثر داخل المنزل",
        verdict:
          "ممتاز أنك حددت المكان—المنزل هو أسهل نقطة للتحسين السريع وتقليل السقوط.",
        tips: [
          "ثبت السجاد أو أزله، وضع شرائط مانعة للانزلاق في الحمام.",
          "رتّب الممرات، وثبت الإضاءة، وتجنب المشي في الظلام.",
        ],
        next_question: "هل توجد إضاءة ليلية بالممرات؟",
        quick_choices: ["نعم", "لا"],
        when_to_seek_help:
          "إذا تكرر التعثر رغم تعديل البيئة: تقييم نظر/توازن وأدوية مفيد.",
      });
    }
    if (choice === "لا") {
      return card({
        category: "general",
        title: "تعثر خارج المنزل",
        verdict:
          "ركز على الحذاء المناسب والانتباه للأسطح غير المستوية، ويفيد دعم التوازن حسب القدرة.",
        tips: [
          "اختر حذاء بنعل ثابت غير زلق، وتجنب النعال المفتوحة أثناء المشي الطويل.",
          "إذا تستخدم نظارات: تأكد من تحديثها لأن الرؤية تؤثر على التعثر.",
        ],
        next_question: "هل تستخدم عكاز/مساند عند المشي؟",
        quick_choices: ["نعم", "لا"],
        when_to_seek_help:
          "سقوط مع ألم شديد/عدم قدرة على التحميل على القدم: تقييم طبي.",
      });
    }
  }

  // adolescents
  if (lastTitle.includes("صحة اليافعين")) {
    if (choice.includes("النوم"))
      return card({
        category: "sleep",
        title: "نوم اليافعين",
        verdict: "ثبّت وقت النوم وقلّل الشاشات والمنبهات قبل النوم.",
        tips: ["إيقاف الشاشات قبل النوم بساعة إن أمكن.", "تجنب مشروبات الطاقة مساءً."],
        next_question: "المشكلة: سهر أم أرق؟",
        quick_choices: ["سهر", "أرق"],
        when_to_seek_help: "إذا نعاس شديد نهارًا/تدهور دراسي واضح: تقييم مختص مفيد.",
      });
    if (choice.includes("التغذية")) return KB.path_lifestyle;
  }

  // mental
  if (lastTitle.includes("الصحة النفسية")) {
    if (choice.includes("القلق")) return KB.mental_anxiety;
    if (choice.includes("النوم"))
      return card({
        category: "sleep",
        title: "نوم وتحسينه",
        verdict: "روتين نوم ثابت يساعد، خاصة مع القلق.",
        tips: ["موعد نوم/استيقاظ ثابت.", "تنفّس بطيء 3 دقائق قبل النوم."],
        next_question: "هل تستخدم منبهات (قهوة/طاقة) مساءً؟",
        quick_choices: ["نعم", "لا"],
        when_to_seek_help: "إذا استمر الأرق أكثر من أسبوعين وأثر على الحياة: راجع مختص.",
      });
  }

  // ncd
  if (lastTitle.includes("الأمراض غير المعدية")) {
    if (choice.includes("الضغط"))
      return card({
        category: "bp",
        title: "ضغط الدم",
        verdict: "الوقاية: تقليل الملح + نشاط + وزن مناسب + متابعة القياس.",
        tips: ["قلّل الأطعمة المصنعة عالية الصوديوم.", "قِس الضغط بشكل دوري."],
        next_question: "هل لديك قراءة ضغط؟",
        quick_choices: ["نعم", "لا"],
        when_to_seek_help: "قراءات مرتفعة متكررة أو أعراض مقلقة: راجع الطبيب.",
      });
    if (choice.includes("السكري"))
      return card({
        category: "sugar",
        title: "السكري",
        verdict: "الوقاية: غذاء متوازن + حركة + تقليل السكريات + متابعة.",
        tips: ["قلّل المشروبات المحلّاة.", "قسّم الوجبات واهتم بالألياف."],
        next_question: "هل القياس صائم أم بعد الأكل؟",
        quick_choices: ["صائم", "بعد الأكل"],
        when_to_seek_help: "قراءات عالية متكررة أو أعراض شديدة: راجع الطبيب.",
      });
  }

  // infection
  if (lastTitle.includes("مكافحة العدوى")) {
    if (choice === "نعم")
      return card({
        category: "general",
        title: "أعراض تنفسية",
        verdict: "إرشاد عام: راحة + سوائل + تقليل الاختلاط + مراقبة تدهور الأعراض.",
        tips: ["غسل اليدين وآداب السعال.", "البقاء بالمنزل عند المرض قدر الإمكان."],
        next_question: "هل يوجد ضيق نفس شديد؟",
        quick_choices: ["نعم", "لا"],
        when_to_seek_help: "ضيق نفس شديد/تدهور سريع: طوارئ.",
      });
    if (choice === "لا")
      return card({
        category: "general",
        title: "وقاية يومية",
        verdict: "الوقاية: نظافة اليدين، تهوية جيدة، تقليل المخالطة عند المرض.",
        tips: ["اغسل اليدين 20 ثانية.", "لا تشارك الأدوات الشخصية."],
        next_question: "",
        quick_choices: [],
        when_to_seek_help: "",
      });
  }

  // med safety
  if (lastTitle.includes("السلامة الدوائية")) {
    if (choice.includes("خافض")) return KB.med_antipyretic;
    if (choice.includes("حساسية")) return KB.med_antihistamine;
    if (choice.includes("مضاد حيوي") || choice.includes("مضاد")) return KB.med_antibiotic;
  }
  if (lastTitle.includes("خافض حرارة")) {
    if (choice.includes("طفل"))
      return card({
        category: "general",
        title: "خافض حرارة لطفل",
        verdict: "معلومة عامة: الأفضل استشارة طبيب/صيدلي لتحديد الخيار المناسب حسب العمر/الوزن والحالة. (بدون جرعات).",
        tips: ["لا تجمع أكثر من منتج لنفس المادة.", "راجع النشرة وتاريخ الصلاحية."],
        next_question: "هل الحرارة مستمرة أكثر من 24 ساعة؟",
        quick_choices: ["نعم", "لا"],
        when_to_seek_help: "خمول شديد/تشنجات/صعوبة تنفس: طوارئ.",
      });
    if (choice.includes("بالغ"))
      return card({
        category: "general",
        title: "خافض حرارة لبالغ",
        verdict: "معلومة عامة: اختر المنتج المناسب وتجنب تكرار المادة الفعالة. (بدون جرعات).",
        tips: ["انتبه لأمراض الكبد/الكلى وتداخلات الأدوية.", "اقرأ النشرة أو اسأل الصيدلي."],
        next_question: "هل لديك مرض مزمن؟",
        quick_choices: ["نعم", "لا"],
        when_to_seek_help: "حرارة عالية مستمرة/أعراض شديدة: راجع الطبيب.",
      });
  }
  if (lastTitle.includes("خافض حرارة لبالغ")) {
    if (choice === "نعم")
      return card({
        category: "general",
        title: "خافض حرارة مع مرض مزمن",
        verdict: "مع الأمراض المزمنة، الأفضل اختيار الدواء **بعد استشارة** لتجنب التداخلات والمضاعفات.",
        tips: ["أخبر الصيدلي/الطبيب بكل أدويتك الحالية.", "تجنب تكرار نفس المادة الفعالة في أكثر من منتج."],
        next_question: "هل المرض المزمن مرتبط بالكبد/الكلى؟",
        quick_choices: ["الكبد/الكلى", "غير ذلك"],
        when_to_seek_help: "إذا ظهرت أعراض حساسية شديدة (تورم/صعوبة تنفس): طوارئ.",
      });
    if (choice === "لا")
      return card({
        category: "general",
        title: "خافض حرارة بدون مرض مزمن",
        verdict: "اختر منتجًا واحدًا واضح المادة الفعالة وتجنب الجمع غير الضروري.",
        tips: ["اقرأ الملصق لتجنب التكرار.", "إذا استمرت الحرارة أو ظهر عرض شديد: لا تؤخر الاستشارة."],
        next_question: "هل الحرارة مستمرة أكثر من يومين؟",
        quick_choices: ["نعم", "لا"],
        when_to_seek_help: "حرارة عالية مستمرة/أعراض شديدة: راجع الطبيب.",
      });
  }

  if (lastTitle.includes("مضاد حساسية")) {
    if (choice.includes("عطاس"))
      return card({
        category: "general",
        title: "تحسس أنفي",
        verdict: "قد يفيد تجنب المحفزات (غبار/عطور) وتنظيف الأنف بمحلول ملحي عند الحاجة.",
        tips: ["تجنب المحفزات قدر الإمكان.", "تهوية المنزل وتقليل الغبار."],
        next_question: "هل الأعراض مزمنة أم موسمية؟",
        quick_choices: ["مزمنة", "موسمية"],
        when_to_seek_help: "صفير/ضيق نفس شديد أو تورم: طوارئ.",
      });
    if (choice.includes("حكة"))
      return card({
        category: "general",
        title: "حكة/طفح",
        verdict: "إذا الطفح بسيط: راقب المحفزات وابتعد عن المهيجات. إذا ينتشر بسرعة أو مع تورم: طوارئ.",
        tips: ["تجنب الحك الشديد.", "استخدم مرطّب لطيف وتجنب العطور."],
        next_question: "هل يوجد تورم بالوجه أو صعوبة تنفس؟",
        quick_choices: ["نعم", "لا"],
        when_to_seek_help: "تورم/صعوبة تنفس/دوخة شديدة: طوارئ.",
      });
  }

  if (lastTitle.includes("الحالات الطارئة")) {
    if (choice === "نعم")
      return card({
        category: "emergency",
        title: "تحذير",
        verdict: "إذا العرض خطير الآن: اتصل بالإسعاف أو توجّه للطوارئ فورًا.",
        tips: ["لا تنتظر.", "إذا تستطيع: اطلب مساعدة شخص قريب."],
        next_question: "",
        quick_choices: [],
        when_to_seek_help: "طارئ.",
      });
    if (choice === "لا") return KB.general_home;
  }

  return null;
}

function detectQuickPathIntent(text) {
  const t = normalizeText(text);
  if (t.includes("مسار نمط الحياة الصحي")) return "path_lifestyle";
  if (t.includes("مسار صحة النساء")) return "path_women";
  if (t.includes("مسار صحة الأطفال")) return "path_children";
  if (t.includes("مسار صحة كبار السن") || t.includes("كبار السن")) return "path_elderly";
  if (t.includes("مسار صحة اليافعين") || t.includes("اليفاعين")) return "path_adolescents";
  if (t.includes("مسار الصحة النفسية")) return "path_mental";
  if (t.includes("مسار الأمراض غير المعدية")) return "path_ncd";
  if (t.includes("مسار مكافحة الأمراض") || t.includes("مكافحة الأمراض والعدوى")) return "path_infection";
  if (t.includes("مسار السلامة الدوائية")) return "path_med_safety";
  if (t.includes("مسار الحالات الطارئة") || t.includes("الحالات الطارئة")) return "path_emergency";
  return "";
}

// ---------------- AI ----------------
function buildSystemPrompt() {
  return `
أنت "دليل العافية" للتثقيف الصحي العام فقط (ليس تشخيصًا).
أجب بالعربية وباختصار أنيق وواضح. ممنوع: أدوية/جرعات/تشخيص.
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

function contextualFallback(lastCard, msg) {
  const lastTitle = String(lastCard?.title || "متابعة");
  const lastCat = String(lastCard?.category || "general");
  const chosen = msg ? `("${msg}")` : "";
  return card({
    category: lastCat,
    title: `${lastTitle} — متابعة`,
    verdict: `نكمل على نفس الموضوع ${chosen}: اتبع الإرشادات السابقة وراقب التحسّن خلال الساعات القادمة.`,
    tips: ["ركّز على خطوة واحدة عملية الآن.", "إذا ظهرت أعراض جديدة أو تدهور واضح، لا تؤخر الاستشارة."],
    next_question: "",
    quick_choices: [],
    when_to_seek_help: "إذا ظهرت علامات خطر/تدهور سريع: توجّه للطوارئ.",
  });
}

// ---------------- routes ----------------
app.get("/health", (_req, res) => res.json({ ok: true }));
app.post("/reset", (_req, res) => res.json({ ok: true }));

app.post("/chat", chatLimiter, async (req, res) => {
  try {
    const msg = String(req.body?.message || "").trim();
    const meta = req.body?.meta || {};
    const isChoice = meta && meta.is_choice === true;

    if (!msg) return res.status(400).json({ ok: false, error: "empty_message" });
    if (msg.length > 1400) return res.status(400).json({ ok: false, error: "message_too_long" });

    const lastCard = req.body?.context?.last || null;

    // 1) quick_choices: محلي أولًا، إن لم يوجد تفريع → AI يكمل نفس الموضوع (إن كان مفعّلًا)
    if (isChoice && lastCard && typeof lastCard === "object") {
      const follow = handleChoiceFollowup(msg, lastCard);
      if (follow) return res.json({ ok: true, data: follow });

      // إذا يوجد AI: اكمل بنفس الموضوع (هذا يمنع سقوط "إرشاد عام" نهائيًا)
      if (AI_FALLBACK_ENABLED && GROQ_API_KEY) {
        const messages = [
          { role: "system", content: buildSystemPrompt() },
          { role: "assistant", content: "آخر بطاقة للاستمرار عليها:\n" + JSON.stringify(lastCard) },
          {
            role: "user",
            content:
              `المستخدم اختار زر: "${msg}".\n` +
              `تابع نفس الموضوع فقط ولا تغيّر السياق.\n` +
              `اكتب بطاقة واحدة عملية مع سؤال متابعة واحد وخيارين إن أمكن.`,
          },
        ];

        const raw = await callGroq(messages);
        let parsed = extractJson(raw);

        let retryRaw = "";
        if (!parsed) {
          retryRaw = await callGroq(messages);
          parsed = extractJson(retryRaw);
        }

        let data;
        if (parsed) data = normalize(parsed);
        else data = normalize(recoverPartialCard(retryRaw || raw) || contextualFallback(lastCard, msg));

        if (isMetaJsonAnswer(data)) data = normalize(recoverPartialCard(retryRaw || raw) || contextualFallback(lastCard, msg));
        if (!data.verdict && (!data.tips || data.tips.length === 0)) data = contextualFallback(lastCard, msg);

        return res.json({ ok: true, data });
      }

      // إذا AI غير مفعّل: متابعة مرتبطة بالسياق (بدون أي رسالة عامة)
      return res.json({ ok: true, data: contextualFallback(lastCard, msg) });
    }

    // 2) presetPrompts الطويلة من app.js → محلي 100%
    const pathKey = detectQuickPathIntent(msg);
    if (pathKey && KB[pathKey]) return res.json({ ok: true, data: KB[pathKey] });

    // 3) عناوين مباشرة
    if (msg === "صحة الأطفال") return res.json({ ok: true, data: KB.path_children });
    if (msg === "السلامة الدوائية") return res.json({ ok: true, data: KB.path_med_safety });
    if (msg === "مكافحة الأمراض") return res.json({ ok: true, data: KB.path_infection });
    if (msg === "الحالات الطارئة") return res.json({ ok: true, data: KB.path_emergency });

    // 4) كلمات مفتاحية محلية سريعة
    const t = normalizeText(msg);
    if (/(مضاد حيوي)/.test(t)) return res.json({ ok: true, data: KB.med_antibiotic });
    if (/(مضاد حساسية|حساسيه)/.test(t)) return res.json({ ok: true, data: KB.med_antihistamine });
    if (/(خافض حرارة|حرارة|حمى|حمي)/.test(t) && t.length <= 40) return res.json({ ok: true, data: KB.med_antipyretic });

    // 5) سؤال حر: AI إذا مفعّل، وإلا رد محلي محترم
    if (!AI_FALLBACK_ENABLED || !GROQ_API_KEY) {
      return res.json({ ok: true, data: KB.general_home });
    }

    const messages = [{ role: "system", content: buildSystemPrompt() }];
    if (lastCard && typeof lastCard === "object") {
      messages.push({ role: "assistant", content: "سياق سابق:\n" + JSON.stringify(lastCard) });
    }
    messages.push({
      role: "user",
      content:
        msg +
        "\n\nملاحظة: إن لم تكن متأكدًا، أعطِ إرشادًا عامًا قصيرًا + سؤال متابعة واحد فقط.",
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
    else data = normalize(recoverPartialCard(retryRaw || raw) || contextualFallback(lastCard, msg));

    if (isMetaJsonAnswer(data)) data = normalize(recoverPartialCard(retryRaw || raw) || contextualFallback(lastCard, msg));
    if (!data.verdict && (!data.tips || data.tips.length === 0)) data = contextualFallback(lastCard, msg);

    return res.json({ ok: true, data });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "server_error", data: KB.general_home });
  }
});

app.listen(PORT, () => {
  console.log(
    `🚀 API running on :${PORT} | model=${MODEL_ID} | ai_fallback=${AI_FALLBACK_ENABLED ? "on" : "off"} | max_tokens=${MAX_TOKENS}`
  );
});
