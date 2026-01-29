import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { createRequire } from "module";
import { createWorker } from "tesseract.js";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

const app = express();
const upload = multer({ limits: { fileSize: 8 * 1024 * 1024 } });

/* =========================
   Config
========================= */
const PORT = process.env.PORT || 8000;
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || "";

/* Official Shifaa links */
const SHIFAA_ANDROID =
  "https://play.google.com/store/apps/details?id=om.gov.moh.phr&pcampaignid=web_share";
const SHIFAA_IOS =
  "https://apps.apple.com/us/app/%D8%B4-%D9%81-%D8%A7%D8%A1/id1455936672?l=ar";

/* =========================
   Middleware
========================= */
app.use(helmet({ crossOriginResourcePolicy: false }));

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 90,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

function requireApiKey(req, res, next) {
  if (!INTERNAL_API_KEY) return next();
  const key = req.header("x-api-key");
  if (key !== INTERNAL_API_KEY) return res.status(401).json({ ok: false, error: "unauthorized" });
  next();
}
app.use(requireApiKey);

// عدّل حسب نطاقك
const ALLOWED_ORIGINS = new Set([
  "https://alafya.netlify.app",
  "http://localhost:5173",
  "http://localhost:3000",
  "http://localhost:8000",
  "http://192.168.0.182:8000",
]);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.has(origin)) return cb(null, true);
      return cb(new Error("CORS blocked: " + origin));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-user-id", "x-api-key"],
  })
);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

/* =========================
   Metrics (simple)
========================= */
const METRICS = {
  startedAt: new Date().toISOString(),
  chatRequests: 0,
  chatOk: 0,
  chatFail: 0,
  reportRequests: 0,
  reportOk: 0,
  reportFail: 0,
  emergencyTriggers: 0,
  avgLatencyMs: 0,
  categoryCount: Object.create(null),
  flows: Object.fromEntries(
    ["sugar", "bp", "bmi", "water", "calories", "mental", "first_aid", "general"].flatMap((k) => [
      [`${k}Started`, 0],
      [`${k}Completed`, 0],
    ])
  ),
};

function bumpCategory(cat) {
  if (!cat) return;
  METRICS.categoryCount[cat] = (METRICS.categoryCount[cat] || 0) + 1;
}

function updateAvgLatency(ms) {
  const alpha = 0.2;
  METRICS.avgLatencyMs =
    METRICS.avgLatencyMs === 0 ? ms : Math.round(alpha * ms + (1 - alpha) * METRICS.avgLatencyMs);
}

/* =========================
   Sessions (in-memory) + TTL
========================= */
const sessions = new Map(); // userId -> { history, lastCard, flow, step, profile, ts }

function getSession(userId) {
  const id = userId || "anon";
  if (!sessions.has(id)) {
    sessions.set(id, {
      history: [],
      lastCard: null,
      flow: null, // sugar|bp|bmi|water|calories|mental|first_aid|general
      step: 0,
      profile: {},
      ts: Date.now(),
    });
  }
  const s = sessions.get(id);
  s.ts = Date.now();
  return s;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) {
    if (now - (v.ts || 0) > 24 * 60 * 60 * 1000) sessions.delete(k);
  }
}, 30 * 60 * 1000);

function trimHistory(history, max = 10) {
  if (history.length <= max) return history;
  return history.slice(history.length - max);
}

function resetFlow(session) {
  session.flow = null;
  session.step = 0;
  session.profile = {};
}

/* =========================
   OCR (tesseract.js)
========================= */
let ocrWorkerPromise = null;

async function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => {
      const worker = await createWorker("eng+ara");
      return worker;
    })();
  }
  return ocrWorkerPromise;
}

async function ocrImageBuffer(buffer) {
  const worker = await getOcrWorker();
  const { data } = await worker.recognize(buffer);
  return data?.text ? String(data.text) : "";
}

/* =========================
   Helpers
========================= */
function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function clampText(s, maxChars) {
  const t = String(s || "").trim();
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars) + "\n...[تم قص النص لتفادي الأخطاء]";
}

function looksLikeAppointments(text) {
  const t = String(text || "");
  return /موعد|مواعيد|حجز|احجز|حجوزات|حجزت|حجزي|appointment|booking|شفاء/i.test(t);
}

function isEmergencyText(text) {
  return /(ألم صدر|الم صدر|ضيق نفس|صعوبة تنفس|اختناق|إغماء|اغماء|شلل|ضعف مفاجئ|نزيف شديد|تشنج|نوبة|افكار انتحارية|أفكار انتحارية|انتحار|ايذاء النفس|إيذاء النفس)/i.test(
    String(text || "")
  );
}

function inferCategoryFromMessage(message) {
  const t = String(message || "");

  if (isEmergencyText(t)) return "emergency";
  if (looksLikeAppointments(t)) return "appointments";
  if (/(افهم\s*تقريرك|تحاليل|تحليل|نتيجة|cbc|hba1c|cholesterol|vitamin|lab|report|pdf|صورة)/i.test(t))
    return "report";
  if (/(bmi|كتلة الجسم|مؤشر كتلة|وزني|طولي)/i.test(t)) return "bmi";
  if (/(ضغط|ضغط الدم|systolic|diastolic|mmhg|ملم زئبقي)/i.test(t)) return "bp";
  if (/(سكر|سكري|glucose|mg\/dl|mmol|صائم|بعد الأكل|بعد الاكل|hba1c)/i.test(t)) return "sugar";
  if (/(ماء|سوائل|شرب|ترطيب|hydration)/i.test(t)) return "water";
  if (/(سعرات|calories|دايت|رجيم|تخسيس|تنحيف|زيادة وزن|نظام غذائي)/i.test(t)) return "calories";
  if (/(قلق|توتر|اكتئاب|مزاج|نوم|أرق|panic|anxiety|depress)/i.test(t)) return "mental";
  if (/(اسعافات|إسعافات|حروق|جرح|اختناق|إغماء|نزيف|كسر|first aid)/i.test(t)) return "first_aid";
  return "general";
}

function makeCard({
  title,
  category,
  verdict,
  tips,
  when_to_seek_help,
  next_question,
  quick_choices,
}) {
  return {
    title: title || "دليل العافية",
    category: category || "general",
    verdict: verdict || "",
    tips: Array.isArray(tips) ? tips : [],
    when_to_seek_help: when_to_seek_help || "",
    next_question: next_question || "",
    quick_choices: Array.isArray(quick_choices) ? quick_choices : [],
  };
}

function menuCard() {
  return makeCard({
    title: "دليل العافية",
    category: "general",
    verdict: "اختر مسارًا:",
    tips: [],
    when_to_seek_help: "إذا أعراض خطيرة (ألم صدر/ضيق نفس/إغماء/نزيف شديد): طوارئ فورًا.",
    next_question: "وش تحب تبدأ فيه؟",
    quick_choices: [
      "🩸 السكر",
      "🫀 الضغط",
      "⚖️ BMI",
      "💧 شرب الماء",
      "🔥 السعرات",
      "🧠 طمّنا على مزاجك",
      "🩹 إسعافات أولية",
      "📄 افهم تقريرك",
      "📅 مواعيد شفاء",
    ],
  });
}

function appointmentsCard() {
  return makeCard({
    title: "مواعيد شفاء",
    category: "appointments",
    verdict:
      "للحجز وإدارة المواعيد والاطلاع على الملف الصحي في سلطنة عُمان استخدم تطبيق **شفاء** الرسمي.\nروابط التحميل:",
    tips: [`أندرويد: ${SHIFAA_ANDROID}`, `آيفون: ${SHIFAA_IOS}`],
    when_to_seek_help:
      "إذا كانت لديك أعراض طارئة أو شديدة: راجع الطوارئ فورًا.",
    next_question: "هل تريد شرح سريع لخطوات الحجز داخل التطبيق؟",
    quick_choices: ["نعم", "لا"],
  });
}

function reportUploadCard() {
  // ثابت مثل ما طلبت (مو ذكي)
  return makeCard({
    title: "📄 افهم تقريرك",
    category: "report",
    verdict: "اضغط زر **📎 إرفاق ملف** وارفع صورة أو PDF للتقرير، وسأشرح لك **بلغة مبسطة**.",
    tips: [
      "يفضّل تغطية الاسم/الرقم المدني قبل الإرسال.",
      "إذا الصورة غير واضحة، حاول تصويرها بإضاءة جيدة ومن غير اهتزاز.",
    ],
    when_to_seek_help:
      "إذا عندك أعراض شديدة أو مفاجئة (ألم صدر/ضيق نفس/إغماء/نزيف شديد): طوارئ فورًا.",
    next_question: "جاهز ترفق التقرير؟",
    quick_choices: ["📎 إرفاق ملف", "رجوع للقائمة"],
  });
}

/* =========================
   Sugar engine (Option A) - deterministic
========================= */
function parseGlucose(text) {
  const t = String(text || "").replace(",", ".").toLowerCase();

  // التقط رقم مثل 5.6 أو 120
  const m = t.match(/(\d+(\.\d+)?)/);
  if (!m) return null;

  let val = Number(m[1]);
  if (!Number.isFinite(val)) return null;

  // هل هي mmol/L؟
  const hasMmol = /mmol|mmol\/l|mmol\s*l|ممول/i.test(t);

  // heuristic: إذا أقل أو يساوي 25 غالبًا mmol/L
  const assumeMmol = val > 0 && val <= 25;

  if (hasMmol || assumeMmol) {
    const mgdl = Math.round(val * 18);
    return { mgdl, unit: "mmol/L", raw: val };
  }

  // otherwise assume mg/dL
  return { mgdl: Math.round(val), unit: "mg/dL", raw: val };
}

function sugarVerdictAndAdvice({ mgdl, context }) {
  // context: fasting | postmeal | random | unknown
  const tips = [];
  let verdict = "";
  let when = "";

  // قواعد إنقاذية
  if (mgdl < 54) {
    verdict = `القراءة منخفضة جدًا (${mgdl} mg/dL). هذا قد يكون خطيرًا.`;
    tips.push(
      "إذا عندك تعرّق شديد/رجفة/دوخة/تشوش: اطلب مساعدة فورًا.",
      "إذا تقدر، تناول شيئًا سكريًا سريعًا (مثل عصير/تمر) ثم راقب نفسك."
    );
    when =
      "إذا فقدان وعي/تشنج/تشوش شديد أو ما تحسّن الوضع بسرعة: طوارئ فورًا.";
    return { verdict, tips, when, level: "low_critical" };
  }

  if (mgdl < 70) {
    verdict = `القراءة منخفضة (${mgdl} mg/dL).`;
    tips.push(
      "إذا عندك أعراض انخفاض سكر: خذ سكر سريع (عصير/تمر/عسل) ثم وجبة خفيفة بعدها.",
      "لا تسوق أو تستخدم آلات إذا تحس بدوخة/تشوش."
    );
    when =
      "إذا تكرر الانخفاض كثيرًا أو كان معه إغماء/تشنج: راجع الطبيب/الطوارئ.";
    return { verdict, tips, when, level: "low" };
  }

  // طبيعي/مرتفع حسب السياق (بدون تشخيص)
  if (context === "fasting") {
    if (mgdl <= 99) {
      verdict = `قراءة صائم ضمن الطبيعي غالبًا (${mgdl} mg/dL).`;
      tips.push(
        "حافظ على وجبات منتظمة ومتوازنة (بروتين + ألياف + كربوهيدرات معتدلة).",
        "المشي الخفيف 10 دقائق بعد الأكل يساعد كثيرًا حتى بدون “تمارين”."
      );
      when = "إذا عندك أعراض مزعجة مستمرة أو قراءات عالية متكررة: راجع الطبيب.";
      return { verdict, tips, when, level: "ok" };
    }
    if (mgdl <= 125) {
      verdict = `قراءة صائم أعلى من الطبيعي (${mgdl} mg/dL). ليست تشخيصًا وحدها.`;
      tips.push(
        "قلّل السكريات المضافة والمشروبات المحلاة قدر الإمكان.",
        "زِد الألياف (خضار/شوفان/بقوليات) لأنها تقلل ارتفاع السكر.",
        "جرّب مشي خفيف 10–15 دقيقة بعد الوجبة الرئيسية."
      );
      when =
        "إذا تكررت قراءات الصائم مرتفعة عدة أيام أو عندك أعراض (عطش شديد/تبول كثير): راجع الطبيب.";
      return { verdict, tips, when, level: "elevated" };
    }
    verdict = `قراءة صائم مرتفعة (${mgdl} mg/dL). ليست تشخيصًا وحدها لكنها تستحق متابعة.`;
    tips.push(
      "أعد القياس في يوم آخر بنفس الظروف (صائم 8 ساعات).",
      "ركّز على: تقليل السكريات + تقليل الخبز/الأرز بكميات كبيرة + زيادة البروتين والألياف.",
      "بعد الأكل: مشي خفيف 10–20 دقيقة يقلل الارتفاع."
    );
    when =
      "إذا كانت القراءة ≥ 300 أو مع أعراض شديدة (تقيؤ/تشوش/خمول شديد): طوارئ فورًا. خلاف ذلك راجع الطبيب قريبًا.";
    return { verdict, tips, when, level: "high" };
  }

  if (context === "postmeal") {
    if (mgdl < 140) {
      verdict = `قراءة بعد الأكل تبدو جيدة غالبًا (${mgdl} mg/dL).`;
      tips.push(
        "حاول تخلي نصف الصحن خضار + ربع بروتين + ربع كربوهيدرات.",
        "اختَر فاكهة كاملة بدل العصير غالبًا."
      );
      when = "إذا عندك أعراض مزعجة أو قراءات عالية متكررة: راجع الطبيب.";
      return { verdict, tips, when, level: "ok" };
    }
    if (mgdl <= 199) {
      verdict = `قراءة بعد الأكل مرتفعة نسبيًا (${mgdl} mg/dL). ليست تشخيصًا وحدها.`;
      tips.push(
        "قلّل النشويات السريعة (رز/خبز أبيض/حلويات) خصوصًا في نفس الوجبة.",
        "ابدأ الوجبة بالخضار/سلطة ثم البروتين ثم الكربوهيدرات.",
        "مشي 10–15 دقيقة بعد الوجبة مفيد جدًا."
      );
      when =
        "إذا تتكرر الارتفاعات أو عندك عطش شديد/تبول كثير/تعب غير معتاد: راجع الطبيب.";
      return { verdict, tips, when, level: "elevated" };
    }
    verdict = `قراءة بعد الأكل عالية (${mgdl} mg/dL). تحتاج متابعة.`;
    tips.push(
      "حاول تقليل كمية الكربوهيدرات في الوجبة القادمة وركّز على البروتين والألياف.",
      "تجنب العصائر حتى لو “طبيعية” لأنها ترفع السكر بسرعة.",
      "أعد القياس بعد يومين بنفس التوقيت (بعد الأكل بساعتين)."
    );
    when =
      "إذا كانت القراءة ≥ 300 أو معها تقيؤ/تشوش/نعاس شديد: طوارئ فورًا. وإلا راجع الطبيب قريبًا.";
    return { verdict, tips, when, level: "high" };
  }

  // random / unknown
  if (mgdl < 140) {
    verdict = `القراءة تبدو مقبولة غالبًا (${mgdl} mg/dL) حسب وقت الأكل.`;
    tips.push(
      "إذا تريد دقة: قس صائم صباحًا، أو بعد الأكل بساعتين.",
      "قلّل المشروبات المحلاة وزِد الألياف."
    );
    when = "إذا عندك أعراض مستمرة أو قراءات عالية متكررة: راجع الطبيب.";
    return { verdict, tips, when, level: "ok" };
  }
  if (mgdl <= 199) {
    verdict = `القراءة مرتفعة نسبيًا (${mgdl} mg/dL) حسب وقت الأكل. ليست تشخيصًا وحدها.`;
    tips.push(
      "للتأكد: قس صائم 8 ساعات، أو بعد الأكل بساعتين.",
      "ركّز على تقليل السكريات والمخبوزات البيضاء، وزِد البروتين والألياف."
    );
    when = "إذا تتكرر القراءات المرتفعة أو مع أعراض (عطش/تبول كثير): راجع الطبيب.";
    return { verdict, tips, when, level: "elevated" };
  }
  verdict = `القراءة عالية (${mgdl} mg/dL). تحتاج متابعة.`;
  tips.push(
    "أعد القياس بوقت معروف (صائم أو بعد الأكل بساعتين) لتقييم أدق.",
    "قلّل السكريات والمشروبات المحلاة فورًا، وخفف النشويات.",
    "اشرب ماء بكفاية إذا ما عندك مانع طبي."
  );
  when =
    "إذا كانت القراءة ≥ 300 أو معها تقيؤ/تشوش/جفاف شديد: طوارئ فورًا. وإلا راجع الطبيب قريبًا.";
  return { verdict, tips, when, level: "high" };
}

function sugarStartCard() {
  return makeCard({
    title: "🩸 مسار السكر",
    category: "sugar",
    verdict: "اختَر نوع القراءة:",
    tips: ["إذا ما تعرف، اختر (ما أعرف) وعطيني الرقم فقط."],
    when_to_seek_help: "إذا عندك ألم صدر/ضيق نفس/إغماء: طوارئ فورًا.",
    next_question: "",
    quick_choices: ["صائم", "بعد الأكل بساعتين", "عشوائي", "ما أعرف", "رجوع للقائمة"],
  });
}

function sugarAskValueCard(contextLabel) {
  return makeCard({
    title: "🩸 مسار السكر",
    category: "sugar",
    verdict: `اكتب رقم السكر ${contextLabel ? `(${contextLabel})` : ""}.\nمثال: 110 أو 6.1 mmol`,
    tips: ["إذا كتبت mmol سأحوّله تلقائيًا.", "اكتب رقم واحد فقط قدر الإمكان."],
    when_to_seek_help: "إذا عندك تقيؤ شديد/تشوش/خمول شديد مع سكر عالي جدًا: طوارئ.",
    next_question: "",
    quick_choices: ["إلغاء", "رجوع للقائمة"],
  });
}

/* =========================
   Other flows (as-is minimal)
========================= */
function startFlow(session, flowKey) {
  session.flow = flowKey;
  session.step = 1;
  session.profile = {};
  METRICS.flows[`${flowKey}Started`]++;
  bumpCategory(flowKey);

  if (flowKey === "sugar") return sugarStartCard();

  // (بقية المسارات تظل بسيطة كما كانت)
  if (flowKey === "bp") {
    return makeCard({
      title: "🫀 مسار الضغط",
      category: "bp",
      verdict: "هل لديك قراءة ضغط الآن؟",
      tips: ["اكتبها مثل: 120/80 أو اختر (ما أعرف)."],
      when_to_seek_help: "ألم صدر/ضيق نفس/إغماء: طوارئ فورًا.",
      next_question: "",
      quick_choices: ["أكتب القراءة", "ما أعرف", "رجوع للقائمة"],
    });
  }

  if (flowKey === "bmi") {
    return makeCard({
      title: "⚖️ مسار BMI",
      category: "bmi",
      verdict: "اكتب الوزن والطول مثل: وزن 70، طول 170 (اختياري).",
      tips: ["إذا ما تبغى، اكتب: تخطي."],
      when_to_seek_help: "",
      next_question: "",
      quick_choices: ["تخطي", "رجوع للقائمة"],
    });
  }

  if (flowKey === "water") {
    return makeCard({
      title: "💧 شرب الماء",
      category: "water",
      verdict: "كم تشرب ماء تقريبًا باليوم؟",
      tips: ["مثال: 1 لتر أو 6 أكواب."],
      when_to_seek_help: "",
      next_question: "",
      quick_choices: ["رجوع للقائمة"],
    });
  }

  if (flowKey === "calories") {
    return makeCard({
      title: "🔥 السعرات",
      category: "calories",
      verdict: "وش هدفك؟",
      tips: [],
      when_to_seek_help: "",
      next_question: "",
      quick_choices: ["إنقاص وزن", "تثبيت وزن", "زيادة وزن", "رجوع للقائمة"],
    });
  }

  if (flowKey === "mental") {
    return makeCard({
      title: "🧠 المزاج",
      category: "mental",
      verdict: "خلال آخر أسبوع، كيف كان مزاجك غالبًا؟",
      tips: [],
      when_to_seek_help: "إذا عندك أفكار إيذاء النفس: اطلب مساعدة عاجلة فورًا.",
      next_question: "",
      quick_choices: ["ممتاز", "جيد", "متعب", "سيئ", "رجوع للقائمة"],
    });
  }

  if (flowKey === "first_aid") {
    return makeCard({
      title: "🩹 إسعافات أولية",
      category: "general",
      verdict: "اختر الموقف:",
      tips: [],
      when_to_seek_help: "فقدان وعي/نزيف شديد/صعوبة تنفس: اتصل بالإسعاف فورًا.",
      next_question: "",
      quick_choices: ["حروق بسيطة", "جرح/نزيف بسيط", "اختناق", "إغماء", "التواء/كدمة", "رجوع للقائمة"],
    });
  }

  return menuCard();
}

function continueFlow(session, message) {
  const flow = session.flow;
  const step = session.step;
  const m = String(message || "").trim();

  // رجوع للقائمة/إلغاء داخل الفلو
  if (/^(رجوع للقائمة|رجوع|القائمة|menu|إلغاء|الغاء|cancel)$/i.test(m)) {
    resetFlow(session);
    return menuCard();
  }

  // ======= SUGAR (Option A)
  if (flow === "sugar") {
    // step 1: pick context
    if (step === 1) {
      let ctx = "unknown";
      if (/صائم/i.test(m)) ctx = "fasting";
      else if (/بعد/i.test(m)) ctx = "postmeal";
      else if (/عشوائي/i.test(m)) ctx = "random";
      else if (/ما\s*أعرف|مااعرف|لا\s*أعرف/i.test(m)) ctx = "unknown";

      session.profile.context = ctx;
      session.step = 2;

      const label =
        ctx === "fasting"
          ? "صائم"
          : ctx === "postmeal"
          ? "بعد الأكل بساعتين"
          : ctx === "random"
          ? "عشوائي"
          : "غير محدد";

      return sugarAskValueCard(label);
    }

    // step 2: parse value -> return result + reset flow
    if (step === 2) {
      const parsed = parseGlucose(m);
      if (!parsed) {
        return makeCard({
          title: "🩸 مسار السكر",
          category: "sugar",
          verdict: "ما قدرت أقرأ الرقم. اكتب رقم واحد مثل: 110 أو 6.1 mmol",
          tips: [],
          when_to_seek_help: "",
          next_question: "",
          quick_choices: ["إلغاء", "رجوع للقائمة"],
        });
      }

      const ctx = session.profile.context || "unknown";
      const { verdict, tips, when, level } = sugarVerdictAndAdvice({
        mgdl: parsed.mgdl,
        context: ctx === "random" ? "unknown" : ctx,
      });

      const shownUnit = parsed.unit === "mmol/L" ? `${parsed.raw} mmol/L ≈ ${parsed.mgdl} mg/dL` : `${parsed.mgdl} mg/dL`;

      const card = makeCard({
        title: "🩸 نتيجة قراءة السكر",
        category: "sugar",
        verdict: `${verdict}\n\n(القراءة المدخلة: ${shownUnit})`,
        tips: [
          ...tips,
          "ملاحظة: هذا تثقيف عام وليس تشخيصًا أو بديلًا للطبيب.",
        ],
        when_to_seek_help: when,
        next_question: "وش تحب تسوي الآن؟",
        quick_choices: [
          "نصائح أكل مناسبة",
          "زيادة النشاط بدون رياضة",
          "كيف أقيس صح؟",
          "رجوع للقائمة",
        ],
      });

      METRICS.flows[`sugarCompleted`]++;
      resetFlow(session);
      return card;
    }
  }

  // باقي المسارات: نتركها للنموذج (أو تطوير لاحق)
  return null;
}

/* =========================
   Groq call (Structured JSON)
========================= */
const CARD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    category: {
      type: "string",
      enum: [
        "general",
        "emergency",
        "appointments",
        "report",
        "mental",
        "bmi",
        "bp",
        "sugar",
        "water",
        "calories",
      ],
    },
    verdict: { type: "string" },
    tips: { type: "array", items: { type: "string" } },
    when_to_seek_help: { type: "string" },
    next_question: { type: "string" },
    quick_choices: { type: "array", items: { type: "string" } },
  },
  required: ["title", "category", "verdict", "tips", "when_to_seek_help", "next_question", "quick_choices"],
};

function chatSystemPrompt() {
  return (
    "أنت مساعد تثقيف صحي فقط، ولست طبيبًا.\n" +
    "ممنوع: التشخيص المؤكد، وصف الأدوية، الجرعات، أو خطط علاج.\n" +
    "قدّم نصائح نمط حياة عملية.\n" +
    "استخدم لغة عربية بسيطة جدًا.\n" +
    "إذا اضطررت لذكر مصطلح طبي، اكتب معه معنى مبسط.\n" +
    "اذكر متى يجب مراجعة الطبيب/الطوارئ.\n" +
    "أخرج JSON فقط بالمفاتيح المحددة.\n"
  );
}

function reportSystemPrompt() {
  return (
    "أنت مساعد يشرح تقارير التحاليل للناس العاديين.\n" +
    "مهم جدًا: لغة مبسطة، بدون مصطلحات مختبرية معقدة.\n" +
    "إذا ظهر مصطلح مثل Hemoglobin اكتب: (الهيموغلوبين: بروتين ينقل الأكسجين في الدم).\n" +
    "ممنوع: تشخيص مؤكد، أدوية، جرعات، أو خطة علاج.\n" +
    "اذكر متى يراجع الطبيب/الطوارئ.\n" +
    "أخرج JSON فقط بنفس مفاتيح البطاقة.\n"
  );
}

async function callGroqJSON({ system, user, maxTokens = 1200 }) {
  if (!GROQ_API_KEY) throw new Error("Missing GROQ_API_KEY");

  const url = "https://api.groq.com/openai/v1/chat/completions";
  const body = {
    model: GROQ_MODEL,
    temperature: 0.2,
    max_tokens: maxTokens,
    response_format: {
      type: "json_schema",
      json_schema: { name: "dalil_alafiyah_card", strict: true, schema: CARD_SCHEMA },
    },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (res.status === 429) {
      await sleep(1200 + attempt * 700);
      continue;
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Groq API error: ${res.status} ${JSON.stringify(data)}`);

    const text = data?.choices?.[0]?.message?.content || "";
    const parsed = safeJsonParse(text);
    if (parsed) return parsed;

    await sleep(350);
  }

  throw new Error("Groq returned invalid JSON repeatedly");
}

/* =========================
   Safety post-filter (LLM only)
========================= */
function postFilterCard(card) {
  // فلتر للأدوية/الجرعات — فقط لحماية مخرجات LLM
  const bad =
    /(جرعة|مرتين\s*يوميًا|ثلاث\s*مرات|حبوب|دواء|انسولين|metformin|ibuprofen|paracetamol|amoxicillin|antibiotic)/i;

  const combined =
    (card?.verdict || "") +
    "\n" +
    (Array.isArray(card?.tips) ? card.tips.join("\n") : "") +
    "\n" +
    (card?.when_to_seek_help || "");

  if (bad.test(combined)) {
    return makeCard({
      title: "تنبيه",
      category: card?.category || "general",
      verdict:
        "أنا للتثقيف الصحي فقط. ما أقدر أوصف أدوية أو جرعات.\nإذا سؤالك علاجي/دوائي راجع طبيب/صيدلي.",
      tips: ["اكتب للطبيب الأعراض ومدة المشكلة وأي أدوية تستخدمها.", "إذا أعراض شديدة: طوارئ."],
      when_to_seek_help: "ألم صدر/ضيق نفس/إغماء/نزيف شديد: طوارئ فورًا.",
      next_question: "هل تريد نصائح نمط حياة بدل العلاج؟",
      quick_choices: ["نعم", "لا"],
    });
  }
  return card;
}

/* =========================
   Routes
========================= */
app.get("/", (req, res) => {
  res.json({ ok: true, service: "Dalil Alafiyah API", routes: ["/chat", "/report", "/reset", "/metrics"] });
});

app.get("/metrics", (req, res) => {
  res.json({ ok: true, data: METRICS });
});

app.post("/reset", (req, res) => {
  const userId = req.header("x-user-id") || "anon";
  sessions.delete(userId);
  res.json({ ok: true });
});

app.post("/chat", async (req, res) => {
  const t0 = Date.now();
  METRICS.chatRequests++;

  const userId = req.header("x-user-id") || "anon";
  const session = getSession(userId);

  const message = String(req.body?.message || "").trim();
  if (!message) return res.status(400).json({ ok: false, error: "empty_message" });

  // reset commands
  if (/^(إلغاء|الغاء|cancel|مسح|مسح المحادثة|ابدأ من جديد|ابدأ جديد|رجوع للقائمة)$/i.test(message)) {
    resetFlow(session);
    const card = menuCard();
    session.lastCard = card;
    METRICS.chatOk++;
    updateAvgLatency(Date.now() - t0);
    return res.json({ ok: true, data: card });
  }

  // emergency
  if (isEmergencyText(message)) {
    METRICS.emergencyTriggers++;
    const card = makeCard({
      title: "⚠️ تنبيه طارئ",
      category: "emergency",
      verdict: "الأعراض المذكورة قد تكون خطيرة. توجّه لأقرب طوارئ أو اتصل بالإسعاف فورًا.",
      tips: ["لا تنتظر.", "إذا معك شخص، اطلب مساعدته فورًا."],
      when_to_seek_help: "الآن.",
      next_question: "هل أنت في أمان الآن؟",
      quick_choices: ["نعم", "لا"],
    });
    session.lastCard = card;
    bumpCategory("emergency");
    METRICS.chatOk++;
    updateAvgLatency(Date.now() - t0);
    return res.json({ ok: true, data: card });
  }

  // appointments
  if (looksLikeAppointments(message)) {
    const card = appointmentsCard();
    session.lastCard = card;
    bumpCategory("appointments");
    METRICS.chatOk++;
    updateAvgLatency(Date.now() - t0);
    return res.json({ ok: true, data: card });
  }

  // report button (fixed)
  if (/^(📄\s*)?افهم\s*تقريرك$/i.test(message) || message === "📄 افهم تقريرك") {
    const card = reportUploadCard();
    session.lastCard = card;
    bumpCategory("report");
    METRICS.chatOk++;
    updateAvgLatency(Date.now() - t0);
    return res.json({ ok: true, data: card });
  }

  // If user is inside a flow: do NOT infer other categories (fix the drift)
  if (session.flow && session.step > 0) {
    const card = continueFlow(session, message);
    if (card) {
      session.lastCard = card;
      METRICS.chatOk++;
      updateAvgLatency(Date.now() - t0);
      return res.json({ ok: true, data: card });
    }
    // if null -> we will use LLM fallback (other flows)
  }

  // start flows from menu / short triggers
  const inferred = inferCategoryFromMessage(message);

  const startMap = [
    { key: "sugar", match: /🩸|سكر|السكر/i },
    { key: "bp", match: /🫀|ضغط|الضغط/i },
    { key: "bmi", match: /⚖️|bmi|BMI|كتلة/i },
    { key: "water", match: /💧|ماء|شرب الماء|ترطيب/i },
    { key: "calories", match: /🔥|سعرات|calories|رجيم|دايت/i },
    { key: "mental", match: /🧠|مزاج|قلق|توتر|اكتئاب/i },
    { key: "first_aid", match: /🩹|اسعافات|إسعافات|حروق|جرح/i },
    { key: "general", match: /قائمة|منيو|ابدأ|ابدء/i },
  ];

  if (!session.flow) {
    const short = message.length <= 40;
    const matched = startMap.find((x) => x.match.test(message));
    if (short && matched) {
      const card = startFlow(session, matched.key);
      session.lastCard = card;
      METRICS.chatOk++;
      updateAvgLatency(Date.now() - t0);
      return res.json({ ok: true, data: card });
    }

    if (short && ["sugar", "bp", "bmi", "water", "calories", "mental", "first_aid"].includes(inferred)) {
      const card = startFlow(session, inferred);
      session.lastCard = card;
      METRICS.chatOk++;
      updateAvgLatency(Date.now() - t0);
      return res.json({ ok: true, data: card });
    }
  }

  // LLM fallback (general chat / other flows)
  session.history.push({ role: "user", content: message });
  session.history = trimHistory(session.history, 8);

  const last = req.body?.context?.last || session.lastCard || null;
  const lastStr = last ? clampText(JSON.stringify(last), 1200) : "";
  const msgStr = clampText(message, 1200);

  const userPrompt =
    (last ? `سياق آخر رد (استخدمه فقط إذا مرتبط):\n${lastStr}\n\n` : "") +
    `سؤال المستخدم:\n${msgStr}\n\n` +
    "قيود مهمة: لا تشخيص، لا أدوية، لا جرعات.\n" +
    "لغة مبسطة جدًا.\n" +
    "قدّم نصائح عملية + متى يراجع الطبيب/الطوارئ.\n";

  try {
    const obj = await callGroqJSON({
      system: chatSystemPrompt(),
      user: userPrompt,
      maxTokens: 1100,
    });

    let finalCategory = obj?.category || inferred || "general";
    // لا تغيّر السكر لأنه صار له مسار خاص
    if (finalCategory === "sugar") finalCategory = "general";

    const card = makeCard({ ...obj, category: finalCategory });
    const safeCard = postFilterCard(card);

    session.lastCard = safeCard;
    session.history.push({ role: "assistant", content: JSON.stringify(safeCard) });
    session.history = trimHistory(session.history, 10);

    bumpCategory(safeCard.category);
    METRICS.chatOk++;
    updateAvgLatency(Date.now() - t0);

    return res.json({ ok: true, data: safeCard });
  } catch (err) {
    console.error("[chat] FAILED:", err?.message || err);
    METRICS.chatFail++;
    updateAvgLatency(Date.now() - t0);
    return res.status(502).json({ ok: false, error: "model_error" });
  }
});

app.post("/report", upload.single("file"), async (req, res) => {
  const t0 = Date.now();
  METRICS.reportRequests++;

  const userId = req.header("x-user-id") || "anon";
  const session = getSession(userId);

  const file = req.file;
  if (!file) return res.status(400).json({ ok: false, error: "missing_file" });

  try {
    let extracted = "";

    if (file.mimetype === "application/pdf") {
      const parsed = await pdfParse(file.buffer).catch(() => null);
      extracted = parsed?.text ? String(parsed.text) : "";
      extracted = extracted.replace(/\s+/g, " ").trim();

      if (extracted.length < 40) {
        METRICS.reportFail++;
        updateAvgLatency(Date.now() - t0);
        return res.json({
          ok: false,
          error: "pdf_no_text",
          message:
            "هذا PDF يبدو ممسوح (Scan) ولا يحتوي نصًا قابلًا للنسخ. ارفع صورة واضحة للتقرير أو الصق النص.",
        });
      }
    } else if (file.mimetype.startsWith("image/")) {
      extracted = await ocrImageBuffer(file.buffer);
      extracted = extracted.replace(/\s+/g, " ").trim();

      if (extracted.length < 25) {
        METRICS.reportFail++;
        updateAvgLatency(Date.now() - t0);
        return res.json({
          ok: false,
          error: "ocr_failed",
          message: "الصورة لم تُقرأ بوضوح. حاول صورة أوضح.",
        });
      }
    } else {
      METRICS.reportFail++;
      updateAvgLatency(Date.now() - t0);
      return res.status(400).json({ ok: false, error: "unsupported_type" });
    }

    const extractedClamped = clampText(extracted, 6500);

    const userPrompt =
      "هذا نص مستخرج من تقرير تحاليل.\n" +
      "مطلوب: شرح مبسط جدًا للناس العاديين.\n" +
      "إذا ظهر مصطلح إنجليزي أو طبي، اكتب معناه بالعربي بكلمات بسيطة.\n" +
      "رتّب الشرح على شكل نقاط واضحة.\n\n" +
      "النص:\n" +
      extractedClamped +
      "\n\n" +
      "قيود: ممنوع تشخيص مؤكد أو أدوية/جرعات.\n" +
      "اختم بمتى يراجع الطبيب أو الطوارئ.";

    const obj = await callGroqJSON({
      system: reportSystemPrompt(),
      user: userPrompt,
      maxTokens: 1500,
    });

    const card = postFilterCard(makeCard({ ...obj, category: "report" }));
    session.lastCard = card;

    bumpCategory("report");
    METRICS.reportOk++;
    updateAvgLatency(Date.now() - t0);

    return res.json({ ok: true, data: card });
  } catch (err) {
    console.error("[report] FAILED:", err?.message || err);
    METRICS.reportFail++;
    updateAvgLatency(Date.now() - t0);
    return res.status(502).json({
      ok: false,
      error: "report_error",
      message: "تعذر تحليل التقرير الآن. جرّب صورة أوضح أو الصق النص.",
    });
  }
});

/* =========================
   Start
========================= */
app.listen(PORT, () => {
  console.log(`🚀 Dalil Alafiyah API يعمل على http://localhost:${PORT}`);
});
