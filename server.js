// server.js — Dalil Alafiyah API (Local Quick Paths + AI only when needed)
// ✅ لا تغيير على واجهة front-end: نفس /chat و/ reset و/ health ونفس JSON structure المتوقعة من app.js
// ✅ "المسارات السريعة" (المحفوظة في app.js) تُجاب محليًا 100% بدون ذكاء
// ✅ داخل كل مسار: بطاقات + أسئلة سريعة + quick_choices (تفريعات محلية)
// ✅ الاتصال بالذكاء فقط عندما السؤال خارج المعرفة المحلية
//
// ملاحظات سلامة:
// - محتوى تثقيفي عام فقط (ليس تشخيصًا).
// - بدون أدوية/جرعات/وصفات.
// - نذكر "متى تراجع الطبيب/الطوارئ" بشكل واضح.

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

// السماح بالذكاء كـ fallback فقط (افتراضي: ON إذا يوجد مفتاح)
const AI_FALLBACK_ENABLED =
  (process.env.AI_FALLBACK_ENABLED || (GROQ_API_KEY ? "1" : "0")) === "1";

const MAX_TOKENS = Number(process.env.MAX_TOKENS || 220);
const TEMP = Number(process.env.TEMPERATURE || 0.25);

// CORS allowlist (comma-separated). إذا فارغ: dev/any origin
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
  return m?.[1]?.replace(/\\\"/g, '"').trim() || "";
}

function recoverPartialCard(raw) {
  const s = String(raw || "");
  const pick = (re) => {
    const m = s.match(re);
    return m?.[1] ? m[1].replace(/\\\"/g, '"').trim() : "";
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
      .map((x) => x.replace(/^"+|"+$/g, "").replace(/\\\"/g, '"'))
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

// ---------- Local Knowledge Base ----------
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
    verdict: "خطة يومية بسيطة: (غذاء متوازن) + (حركة) + (نوم كافٍ).",
    tips: ["اختر تغيير واحد فقط اليوم واستمر 7 أيام.", "قلّل السكر والملح تدريجيًا بدل التغيير المفاجئ."],
    next_question: "تريد تبدأ من أي محور؟",
    quick_choices: ["التغذية", "النشاط"],
    when_to_seek_help: "إذا لديك مرض مزمن/أعراض مستمرة، الأفضل مراجعة مركز صحي لخطّة مناسبة.",
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
    when_to_seek_help:
      "طوارئ/طبيب فورًا عند: خمول شديد، صعوبة تنفس، تشنجات، جفاف واضح، أو تدهور سريع.",
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

  if (lastTitle.includes("نمط الحياة")) {
    if (choice.includes("التغذية"))
      return card({
        category: "nutrition",
        title: "الغذاء المتوازن",
        verdict: "أساسيات اليوم: طبق متوازن + تقليل السكر/الملح تدريجيًا.",
        tips: ["نصف الطبق خضار/فواكه.", "اختر بروتين وحبوب كاملة.", "الماء أفضل من المشروبات المحلّاة."],
        next_question: "تركز على تقليل السكر أم الملح؟",
        quick_choices: ["تقليل السكر", "تقليل الملح"],
        when_to_seek_help: "إذا لديك مرض مزمن، راجع مختص لتوصيات مناسبة.",
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

  if (lastTitle.includes("صحة الأطفال")) {
    if (choice.includes("أقل")) return KB.child_u5;
    if (choice.includes("5+")) return KB.child_5p;
  }
  if (lastTitle.includes("أطفال أقل من 5")) {
    if (choice.includes("حرارة")) return KB.child_fever_u5;
    if (choice.includes("إسهال")) return KB.child_diarrhea_u5;
  }

  if (lastTitle.includes("صحة المسنين")) {
    if (choice.includes("السقوط")) return KB.elderly_falls;
    if (choice.includes("التغذية")) return KB.path_lifestyle;
  }

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

// ---------- AI fallback ----------
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
  return card({
    category: "general",
    title: "إرشاد عام",
    verdict:
      looseVerdict ||
      "لا توجد معلومة محلية مطابقة الآن. اكتب سؤالك بتفاصيل أكثر (الأعراض + المدة + العمر) وسأحاول المساعدة.",
    tips: ["لا تشارك بيانات حساسة.", "إذا كانت الحالة طارئة توجّه للطوارئ."],
    next_question: "",
    quick_choices: [],
    when_to_seek_help: "",
  });
}

// ---------- routes ----------
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

    // 1) quick_choices → تفريعات محلية فقط
    if (isChoice && lastCard && typeof lastCard === "object") {
      const follow = handleChoiceFollowup(msg, lastCard);
      if (follow) return res.json({ ok: true, data: follow });

      return res.json({
        ok: true,
        data: card({
          category: "general",
          title: "متابعة",
          verdict: "تم استلام اختيارك. اكتب تفاصيل أكثر لأعطيك إرشادًا أدق.",
          tips: ["مثال: (العمر/المدة/الأعراض/هل يوجد مرض مزمن؟)."],
          next_question: "",
          quick_choices: [],
          when_to_seek_help: "",
        }),
      });
    }

    // 2) presetPrompts الطويلة من app.js → محلي 100%
    const pathKey = detectQuickPathIntent(msg);
    if (pathKey && KB[pathKey]) return res.json({ ok: true, data: KB[pathKey] });

    // 3) عناوين مباشرة
    if (msg === "صحة الأطفال") return res.json({ ok: true, data: KB.path_children });
    if (msg === "السلامة الدوائية") return res.json({ ok: true, data: KB.path_med_safety });
    if (msg === "مكافحة الأمراض") return res.json({ ok: true, data: KB.path_infection });
    if (msg === "الحالات الطارئة") return res.json({ ok: true, data: KB.path_emergency });

    // 4) كلمات مفتاحية محلية
    const t = normalizeText(msg);
    if (/(مضاد حيوي)/.test(t)) return res.json({ ok: true, data: KB.med_antibiotic });
    if (/(مضاد حساسية|حساسيه)/.test(t)) return res.json({ ok: true, data: KB.med_antihistamine });
    if (/(خافض حرارة|حرارة|حمى|حمي)/.test(t) && t.length <= 40) return res.json({ ok: true, data: KB.med_antipyretic });

    // 5) بدون AI
    if (!AI_FALLBACK_ENABLED || !GROQ_API_KEY) return res.json({ ok: true, data: fallback("") });

    // 6) AI fallback فقط هنا
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

    if (isMetaJsonAnswer(data)) data = normalize(recoverPartialCard(retryRaw || raw) || fallback(raw));
    if (!data.verdict && (!data.tips || data.tips.length === 0)) data = fallback("");

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
