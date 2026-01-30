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
  if (key !== INTERNAL_API_KEY)
    return res.status(401).json({ ok: false, error: "unauthorized" });
  next();
}
app.use(requireApiKey);

// عدّلها حسب نطاقك
const ALLOWED_ORIGINS = new Set([
  "https://alafya.netlify.app",
  "http://localhost:5173",
  "http://localhost:3000",
  "http://localhost:8000",
]);

function isAllowedOrigin(origin) {
  try {
    const u = new URL(origin);
    if (ALLOWED_ORIGINS.has(origin)) return true;
    if (u.hostname === "localhost") return true;
    if (u.hostname.endsWith(".netlify.app")) return true;
    return false;
  } catch {
    return false;
  }
}

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (isAllowedOrigin(origin)) return cb(null, true);
      return cb(new Error("CORS blocked: " + origin));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-user-id", "x-api-key"],
  })
);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

/* =========================
   Metrics
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
    [
      "sugar",
      "bp",
      "bmi",
      "water",
      "calories",
      "mental",
      "first_aid",
      "general",
    ].flatMap((k) => [
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
    METRICS.avgLatencyMs === 0
      ? ms
      : Math.round(alpha * ms + (1 - alpha) * METRICS.avgLatencyMs);
}

/* =========================
   Sessions (in-memory) + TTL
========================= */
const sessions = new Map(); // userId -> { history, lastCard, flow, step, profile, ts }

/** حل خلط المستخدمين إذا ما في x-user-id */
function getUserId(req) {
  const headerId = req.header("x-user-id");
  if (headerId) return headerId;
  const ua = req.header("user-agent") || "na";
  return `anon:${req.ip}:${ua.slice(0, 60)}`;
}

function getSession(userId) {
  const id = userId || "anon";
  if (!sessions.has(id)) {
    sessions.set(id, {
      history: [],
      lastCard: null,
      flow: null,
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

function normalizeArabic(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0670]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/\s+/g, " ");
}

function isGreeting(text) {
  const t = normalizeArabic(text);
  return /^(السلام عليكم|سلام عليكم|السلام|سلام|مرحبا|اهلا|هلا|صباح الخير|مساء الخير)([!؟. ]*)$/.test(
    t
  );
}

function isThanks(text) {
  const t = normalizeArabic(text);
  return /^(شكرا|شكرًا|مشكور|يعطيك العافيه|جزاك الله خير)([!؟. ]*)$/.test(t);
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
  if (/(تقرير|تحاليل|تحليل|نتيجة|cbc|hba1c|cholesterol|vitamin|lab|report|pdf|صورة)/i.test(t))
    return "report";
  if (/(قلق|توتر|اكتئاب|مزاج|نوم|أرق|panic|anxiety|depress)/i.test(t)) return "mental";
  if (/(bmi|كتلة الجسم|مؤشر كتلة|وزني|طولي)/i.test(t)) return "bmi";
  if (/(ضغط|ضغط الدم|systolic|diastolic|mmhg|ملم زئبقي)/i.test(t)) return "bp";
  if (/(سكر|سكري|glucose|mg\/dl|صائم|بعد الأكل|بعد الاكل|hba1c)/i.test(t)) return "sugar";
  if (/(ماء|سوائل|شرب|ترطيب|hydration)/i.test(t)) return "water";
  if (/(سعرات|calories|دايت|رجيم|تخسيس|تنحيف|زيادة وزن|نظام غذائي)/i.test(t)) return "calories";
  if (/(اسعافات|إسعافات|حروق|جرح|اختناق|إغماء|نزيف|كسر|first aid)/i.test(t))
    return "first_aid";
  return "general";
}

/** ✅ مهم: استثناء المسارات من "غامض" */
function isTooVague(text) {
  const t = String(text || "").trim();

  // رموز المسارات
  if (/(🩸|🫀|⚖️|💧|🔥|🧠|🩹|📄|📅)/.test(t)) return false;

  // كلمات المسارات
  if (
    /^(السكر|سكر|🩸 السكر|🩸|الضغط|ضغط|🫀 الضغط|🫀|bmi|BMI|⚖️ BMI|⚖️|ماء|شرب الماء|💧 شرب الماء|💧|سعرات|calories|🔥 السعرات|🔥|مزاج|🧠 طمّنا على مزاجك|🧠|اسعافات|إسعافات|🩹 إسعافات أولية|🩹|افهم تقريرك|📄 افهم تقريرك|📄|مواعيد شفاء|📅 مواعيد شفاء|📅)$/i.test(
      t
    )
  )
    return false;

  // القائمة الرئيسية
  if (/^(القائمة الرئيسية|القائمه الرئيسيه|منيو|قائمة|ابدأ|ابدء)$/i.test(t)) return false;

  // قواعد الغموض
  if (t.length < 6) return true;
  if (t.length < 12 && !/[؟?]/.test(t)) return true;
  return false;
}

function isBareYesNo(text) {
  return /^(نعم|لا|ok|okay)$/i.test(String(text || "").trim());
}

/** Router نعم/لا بناء على آخر سؤال فعلي */
function yesNoRouter(session, message) {
  const lastQ = String(session?.lastCard?.next_question || "").trim();
  if (!lastQ) return null;

  const m = String(message || "").trim();
  const isYes = /^نعم$/i.test(m);
  const isNo = /^لا$/i.test(m);
  if (!isYes && !isNo) return null;

  if (/نمط\s*حياه|نمط حياة|بدل\s*العلاج|بدل العلاج/i.test(lastQ)) {
    if (isYes) {
      return makeCard({
        title: "نصائح نمط حياة",
        category: "general",
        verdict: "تمام 👍 هذه نصائح عامة وآمنة تساعد كثيرًا:",
        tips: [
          "خفّف السكريات والمشروبات المحلّاة قدر الإمكان.",
          "اختر وجبات متوازنة: بروتين + خضار + كربوهيدرات معقدة.",
          "نشاط بدني معتدل 30 دقيقة معظم أيام الأسبوع (مشي سريع).",
          "نوم منتظم 7–9 ساعات وتقليل السهر.",
          "اشرب ماء بانتظام وقلل الوجبات السريعة.",
        ],
        when_to_seek_help:
          "إذا الأعراض مستمرة/تسوء أو ظهرت علامات خطورة (ألم صدر/ضيق نفس/إغماء): راجع الطبيب/الطوارئ.",
        next_question: "تحب نركز على: التغذية ولا النشاط البدني؟",
        quick_choices: ["التغذية", "النشاط البدني", "القائمة الرئيسية"],
      });
    }
    if (isNo) {
      return makeCard({
        title: "دليل العافية",
        category: "general",
        verdict: "تمام.",
        tips: [],
        when_to_seek_help: "إذا أعراض طارئة: طوارئ فورًا.",
        next_question: "ترجع للقائمة الرئيسية؟",
        quick_choices: ["القائمة الرئيسية"],
      });
    }
  }

  if (/شرح|خطوات|تفاصيل/i.test(lastQ)) {
    if (isYes) {
      return makeCard({
        title: "توضيح",
        category: session.lastCard?.category || "general",
        verdict: "تمام. اكتب لي: وش بالضبط تبغى أعرفك عليه؟",
        tips: ["مثال: خطوات الحجز، تعديل موعد، إلغاء، أو طريقة الاستخدام."],
        when_to_seek_help: "",
        next_question: "وش تبغى تحديدًا؟",
        quick_choices: ["القائمة الرئيسية", "إلغاء"],
      });
    }
    if (isNo) {
      return makeCard({
        title: "دليل العافية",
        category: "general",
        verdict: "تم 👍",
        tips: [],
        when_to_seek_help: "",
        next_question: "تحب تسأل شيء ثاني؟",
        quick_choices: ["القائمة الرئيسية"],
      });
    }
  }

  return null;
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
    verdict: "اختر مسارًا (كلها ذكية بأسئلة تخصيص قصيرة):",
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

function greetingCard() {
  return makeCard({
    title: "دليل العافية",
    category: "general",
    verdict: "وعليكم السلام ورحمة الله وبركاته 🌿\nأنا هنا للتثقيف الصحي. كيف أقدر أساعدك اليوم؟",
    tips: ["اختر من المسارات السريعة أو اكتب سؤالك مباشرة."],
    when_to_seek_help: "إذا عندك ألم صدر/ضيق نفس/إغماء/نزيف شديد: طوارئ فورًا.",
    next_question: "وش تبغى تبدأ فيه؟",
    quick_choices: menuCard().quick_choices,
  });
}

function thanksCard() {
  return makeCard({
    title: "دليل العافية",
    category: "general",
    verdict: "العفو 🌿 إذا تحب، اكتب سؤالك الصحي مباشرة أو اختر مسار من القائمة.",
    tips: [],
    when_to_seek_help: "إذا أعراض طارئة: طوارئ فورًا.",
    next_question: "وش تحب تسأل؟",
    quick_choices: ["🩸 السكر", "🫀 الضغط", "⚖️ BMI", "💧 شرب الماء", "القائمة الرئيسية"],
  });
}

function appointmentsCard() {
  return makeCard({
    title: "معلومات المواعيد عبر تطبيق شفاء",
    category: "appointments",
    verdict:
      "للحجز وإدارة المواعيد والاطلاع على الملف الصحي في سلطنة عُمان، استخدم تطبيق **شفاء** الرسمي.\n" +
      "روابط التحميل الرسمية:",
    tips: [`أندرويد: ${SHIFAA_ANDROID}`, `آيفون: ${SHIFAA_IOS}`],
    when_to_seek_help:
      "إذا كانت لديك أعراض طارئة أو شديدة (ألم صدر شديد/ضيق نفس شديد/إغماء/ضعف مفاجئ): راجع الطوارئ فورًا.",
    next_question: "هل تريد شرح خطوات الحجز داخل التطبيق؟",
    quick_choices: ["نعم", "لا"],
  });
}

/* =========================
   Flow engine
========================= */
function startFlow(session, flowKey) {
  session.flow = flowKey;
  session.step = 1;
  session.profile = {};
  METRICS.flows[`${flowKey}Started`]++;
  bumpCategory(flowKey);

  const commonAge = ["أقل من 18", "18–40", "41–60", "60+"];

  if (flowKey === "sugar") {
    return makeCard({
      title: "🩸 مسار السكر الذكي",
      category: "sugar",
      verdict: "عشان أعطيك معلومات مناسبة، اختر فئتك العمرية:",
      tips: [],
      when_to_seek_help: "",
      next_question: "",
      quick_choices: commonAge,
    });
  }

  if (flowKey === "bp") {
    return makeCard({
      title: "🫀 مسار الضغط الذكي",
      category: "bp",
      verdict: "اختر فئتك العمرية:",
      tips: [],
      when_to_seek_help: "",
      next_question: "",
      quick_choices: commonAge,
    });
  }

  if (flowKey === "bmi") {
    return makeCard({
      title: "⚖️ مسار BMI الذكي",
      category: "bmi",
      verdict: "وش هدفك الآن؟",
      tips: [],
      when_to_seek_help: "",
      next_question: "",
      quick_choices: ["إنقاص وزن", "زيادة وزن", "تحسين لياقة", "متابعة عامة"],
    });
  }

  if (flowKey === "water") {
    return makeCard({
      title: "💧 مسار شرب الماء الذكي",
      category: "water",
      verdict: "وش وضع نشاطك اليومي غالبًا؟",
      tips: [],
      when_to_seek_help: "",
      next_question: "",
      quick_choices: ["خفيف (عمل مكتبي)", "متوسط", "عالي/رياضة"],
    });
  }

  if (flowKey === "calories") {
    return makeCard({
      title: "🔥 مسار السعرات الذكي",
      category: "calories",
      verdict: "وش هدفك؟",
      tips: [],
      when_to_seek_help: "",
      next_question: "",
      quick_choices: ["إنقاص وزن", "تثبيت وزن", "زيادة وزن", "تحسين أكل صحي"],
    });
  }

  if (flowKey === "mental") {
    return makeCard({
      title: "🧠 مسار المزاج الذكي",
      category: "mental",
      verdict: "خلال آخر أسبوع، كيف كان مزاجك غالبًا؟",
      tips: [],
      when_to_seek_help: "",
      next_question: "",
      quick_choices: ["ممتاز", "جيد", "متعب", "سيئ"],
    });
  }

  if (flowKey === "first_aid") {
    return makeCard({
      title: "🩹 مسار الإسعافات الأولية الذكي",
      category: "general",
      verdict: "اختر الموقف الأقرب:",
      tips: [],
      when_to_seek_help: "إذا فقدان وعي/نزيف شديد/صعوبة تنفس: اتصل بالإسعاف فورًا.",
      next_question: "",
      quick_choices: ["حروق بسيطة", "جرح/نزيف بسيط", "اختناق", "إغماء", "التواء/كدمة"],
    });
  }

  return menuCard();
}

function parseWeightHeight(text) {
  const t = String(text || "").toLowerCase();
  const w = t.match(/(\d{2,3})\s*(kg|كجم|كغ|كيلو|كيلوجرام)?/i);
  const h = t.match(/(\d{2,3})\s*(cm|سم|سنتيمتر)?/i);
  const w2 = t.match(/وزن\s*[:=]?\s*(\d{2,3})/i);
  const h2 = t.match(/طول\s*[:=]?\s*(\d{2,3})/i);

  const weight = w2 ? Number(w2[1]) : w ? Number(w[1]) : null;
  const height = h2 ? Number(h2[1]) : h ? Number(h[1]) : null;

  const W = weight && weight >= 25 && weight <= 250 ? weight : null;
  const H = height && height >= 100 && height <= 220 ? height : null;

  return { weightKg: W, heightCm: H };
}

function bmiFrom(weightKg, heightCm) {
  const h = heightCm / 100;
  const bmi = weightKg / (h * h);
  return Math.round(bmi * 10) / 10;
}

function continueFlow(session, message) {
  const flow = session.flow;
  const step = session.step;
  const m = String(message || "").trim();

  const commonAge = ["أقل من 18", "18–40", "41–60", "60+"];

  if (flow === "sugar") {
    if (step === 1) {
      session.profile.ageGroup = m;
      session.step = 2;
      return makeCard({
        title: "🩸 مسار السكر الذكي",
        category: "sugar",
        verdict: "هل تم تشخيصك بالسكري من قبل؟",
        tips: [],
        when_to_seek_help: "",
        next_question: "",
        quick_choices: ["نعم", "لا", "غير متأكد"],
      });
    }
    if (step === 2) {
      session.profile.diagnosed = m;
      session.step = 3;
      return makeCard({
        title: "🩸 مسار السكر الذكي",
        category: "sugar",
        verdict: "وش هدفك الآن؟",
        tips: [],
        when_to_seek_help: "",
        next_question: "",
        quick_choices: ["فهم مبسط", "أكل مناسب", "تقليل الارتفاعات", "متابعة عامة"],
      });
    }
    if (step === 3) {
      session.profile.goal = m;
      session.step = 4;
      return null;
    }
  }

  if (flow === "bp") {
    if (step === 1) {
      session.profile.ageGroup = m;
      session.step = 2;
      return makeCard({
        title: "🫀 مسار الضغط الذكي",
        category: "bp",
        verdict: "هل تم تشخيصك بضغط الدم من قبل؟",
        tips: [],
        when_to_seek_help: "",
        next_question: "",
        quick_choices: ["نعم", "لا", "غير متأكد"],
      });
    }
    if (step === 2) {
      session.profile.diagnosed = m;
      session.step = 3;
      return makeCard({
        title: "🫀 مسار الضغط الذكي",
        category: "bp",
        verdict: "هل لديك قراءة ضغط الآن/مؤخرًا؟ (اختياري)",
        tips: ["إذا تعرفها، اكتبها مثل: 120/80. أو اختر: ما أعرف."],
        when_to_seek_help: "",
        next_question: "",
        quick_choices: ["أكتب القراءة", "ما أعرف"],
      });
    }
    if (step === 3) {
      if (/ما\s*أعرف/i.test(m)) {
        session.profile.reading = "unknown";
        session.step = 4;
        return null;
      }
      session.profile.reading = "pending";
      session.step = 31;
      return makeCard({
        title: "🫀 مسار الضغط الذكي",
        category: "bp",
        verdict: "اكتب قراءة الضغط بالشكل (انقباضي/انبساطي) مثل: 120/80",
        tips: [],
        when_to_seek_help: "",
        next_question: "",
        quick_choices: ["إلغاء"],
      });
    }
    if (step === 31) {
      session.profile.readingValue = m;
      session.step = 4;
      return null;
    }
  }

  if (flow === "bmi") {
    if (step === 1) {
      session.profile.goal = m;
      session.step = 2;
      return makeCard({
        title: "⚖️ مسار BMI الذكي",
        category: "bmi",
        verdict: "اختر فئتك العمرية:",
        tips: [],
        when_to_seek_help: "",
        next_question: "",
        quick_choices: commonAge,
      });
    }
    if (step === 2) {
      session.profile.ageGroup = m;
      session.step = 3;
      return makeCard({
        title: "⚖️ مسار BMI الذكي",
        category: "bmi",
        verdict: "هل تبي أحسب BMI؟",
        tips: ["إذا نعم: اكتب وزن وطول مثل: وزن 70، طول 170"],
        when_to_seek_help: "",
        next_question: "",
        quick_choices: ["أحسب", "بدون حساب"],
      });
    }
    if (step === 3) {
      if (/بدون/i.test(m)) {
        session.profile.calc = "no";
        session.step = 4;
        return null;
      }
      session.profile.calc = "yes";
      session.step = 32;
      return makeCard({
        title: "⚖️ مسار BMI الذكي",
        category: "bmi",
        verdict: "اكتب الوزن والطول مثل: وزن 70، طول 170",
        tips: [],
        when_to_seek_help: "",
        next_question: "",
        quick_choices: ["إلغاء"],
      });
    }
    if (step === 32) {
      const { weightKg, heightCm } = parseWeightHeight(m);
      session.profile.weightKg = weightKg;
      session.profile.heightCm = heightCm;
      if (weightKg && heightCm) session.profile.bmi = bmiFrom(weightKg, heightCm);
      session.step = 4;
      return null;
    }
  }

  if (flow === "water") {
    if (step === 1) {
      session.profile.activity = m;
      session.step = 2;
      return makeCard({
        title: "💧 مسار شرب الماء الذكي",
        category: "water",
        verdict: "كيف الجو عندك غالبًا هذه الفترة؟",
        tips: [],
        when_to_seek_help: "",
        next_question: "",
        quick_choices: ["معتدل", "حار", "مكيف أغلب الوقت"],
      });
    }
    if (step === 2) {
      session.profile.climate = m;
      session.step = 3;
      return makeCard({
        title: "💧 مسار شرب الماء الذكي",
        category: "water",
        verdict: "لو تقدر: اكتب وزنك بالكيلو (اختياري) أو اختر: تخطي",
        tips: ["مثال: 70"],
        when_to_seek_help: "",
        next_question: "",
        quick_choices: ["تخطي"],
      });
    }
    if (step === 3) {
      if (/تخطي/i.test(m)) {
        session.profile.weightKg = null;
        session.step = 4;
        return null;
      }
      const n = Number(String(m).match(/\d{2,3}/)?.[0]);
      session.profile.weightKg = n && n >= 25 && n <= 250 ? n : null;
      session.step = 4;
      return null;
    }
  }

  if (flow === "calories") {
    if (step === 1) {
      session.profile.goal = m;
      session.step = 2;
      return makeCard({
        title: "🔥 مسار السعرات الذكي",
        category: "calories",
        verdict: "مستوى نشاطك اليومي؟",
        tips: [],
        when_to_seek_help: "",
        next_question: "",
        quick_choices: ["خفيف", "متوسط", "عالي"],
      });
    }
    if (step === 2) {
      session.profile.activity = m;
      session.step = 3;
      return makeCard({
        title: "🔥 مسار السعرات الذكي",
        category: "calories",
        verdict: "اختر فئتك العمرية:",
        tips: [],
        when_to_seek_help: "",
        next_question: "",
        quick_choices: commonAge,
      });
    }
    if (step === 3) {
      session.profile.ageGroup = m;
      session.step = 4;
      return null;
    }
  }

  if (flow === "mental") {
    if (step === 1) {
      session.profile.mood = m;
      session.step = 2;
      return makeCard({
        title: "🧠 مسار المزاج الذكي",
        category: "mental",
        verdict: "كيف نومك خلال آخر أسبوع؟",
        tips: [],
        when_to_seek_help: "",
        next_question: "",
        quick_choices: ["جيد", "متوسط", "سيئ", "أرق شديد"],
      });
    }
    if (step === 2) {
      session.profile.sleep = m;
      session.step = 3;
      return makeCard({
        title: "🧠 مسار المزاج الذكي",
        category: "mental",
        verdict: "وش أكثر شعور مزعج؟",
        tips: [],
        when_to_seek_help: "",
        next_question: "",
        quick_choices: ["قلق", "توتر", "حزن", "ضغط عمل", "أفكار كثيرة"],
      });
    }
    if (step === 3) {
      session.profile.feeling = m;
      session.step = 4;
      return null;
    }
  }

  if (flow === "first_aid") {
    if (step === 1) {
      session.profile.scenario = m;
      session.step = 4;
      return null;
    }
  }

  if (flow === "general") {
    if (step === 1) {
      session.profile.intent = m;
      session.step = 4;
      return null;
    }
  }

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
  required: [
    "title",
    "category",
    "verdict",
    "tips",
    "when_to_seek_help",
    "next_question",
    "quick_choices",
  ],
};

function chatSystemPrompt() {
  return (
    "أنت مساعد تثقيف صحي فقط، ولست طبيبًا ولا بديلاً عن الاستشارة الطبية.\n" +
    "إذا بدأ المستخدم بتحية، ابدأ برد اجتماعي قصير ثم انتقل للسؤال الصحي.\n" +
    "قدّم معلومات عامة عن الصحة ونمط الحياة بأسلوب عربي واضح ومختصر.\n" +
    "ممنوع منعًا باتًا: التشخيص، وصف الأدوية، الجرعات، أو خطة علاج.\n" +
    "اذكر متى يجب مراجعة الطبيب/الطوارئ عند أعراض خطيرة.\n" +
    "إذا لم تكن متأكدًا، قل: لا أعلم.\n" +
    "أخرج JSON فقط بالمفاتيح المحددة.\n"
  );
}

function reportSystemPrompt() {
  return (
    "أنت مساعد تثقيف صحي عربي لشرح نتائج التحاليل/التقارير.\n" +
    "المدخل نص مُستخرج من صورة/ملف.\n" +
    "اشرح بالعربية بشكل عام + نصائح عامة + متى يراجع الطبيب.\n" +
    "ممنوع: تشخيص مؤكد، جرعات، وصف علاج.\n" +
    "أخرج JSON فقط بنفس مفاتيح البطاقة.\n"
  );
}

async function callGroqJSON({ system, user, maxTokens = 1400 }) {
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
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
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
   Safety post-filter
========================= */
function postFilterCard(card) {
  const bad =
    /(خذ|خذي|جرعة|مرتين يوميًا|مرتين يوميا|ثلاث مرات|حبوب|دواء|انسولين|metformin|ibuprofen|paracetamol)/i;

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
        "أنا للتثقيف الصحي فقط. ما أقدر أوصف أدوية أو جرعات.\n" +
        "إذا سؤالك علاجي أو دوائي، راجع طبيب/صيدلي.",
      tips: [
        "اكتب للطبيب الأعراض ومدة المشكلة والأدوية الحالية إن وجدت.",
        "إذا أعراض شديدة: طوارئ.",
      ],
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
  res.json({
    ok: true,
    service: "Dalil Alafiyah API",
    routes: ["/chat", "/report", "/reset", "/metrics"],
  });
});

app.get("/metrics", (req, res) => {
  res.json({ ok: true, data: METRICS });
});

app.post("/reset", (req, res) => {
  const userId = getUserId(req);
  sessions.delete(userId);
  res.json({ ok: true });
});

app.post("/chat", async (req, res) => {
  const t0 = Date.now();
  METRICS.chatRequests++;

  const userId = getUserId(req);
  const session = getSession(userId);

  const message = String(req.body?.message || "").trim();
  if (!message) return res.status(400).json({ ok: false, error: "empty_message" });

  // تحية/شكر
  if (isGreeting(message)) {
    const card = greetingCard();
    session.lastCard = card;
    bumpCategory("general");
    METRICS.chatOk++;
    updateAvgLatency(Date.now() - t0);
    return res.json({ ok: true, data: card });
  }
  if (isThanks(message)) {
    const card = thanksCard();
    session.lastCard = card;
    bumpCategory("general");
    METRICS.chatOk++;
    updateAvgLatency(Date.now() - t0);
    return res.json({ ok: true, data: card });
  }

  // مسح/إلغاء
  if (/^(إلغاء|الغاء|cancel|مسح|مسح المحادثة|ابدأ من جديد|ابدأ جديد)$/i.test(message)) {
    resetFlow(session);
    const card = menuCard();
    session.lastCard = card;
    METRICS.chatOk++;
    updateAvgLatency(Date.now() - t0);
    return res.json({ ok: true, data: card });
  }

  // طوارئ
  if (isEmergencyText(message)) {
    METRICS.emergencyTriggers++;
    const card = makeCard({
      title: "⚠️ تنبيه طارئ",
      category: "emergency",
      verdict:
        "الأعراض المذكورة قد تكون خطيرة.\n" +
        "يُنصح بالتوجه لأقرب طوارئ أو الاتصال بالإسعاف فورًا.",
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

  // مواعيد
  if (looksLikeAppointments(message)) {
    const card = appointmentsCard();
    session.lastCard = card;
    bumpCategory("appointments");
    METRICS.chatOk++;
    updateAvgLatency(Date.now() - t0);
    return res.json({ ok: true, data: card });
  }

  // القائمة الرئيسية
  if (/^(القائمة الرئيسية|القائمه الرئيسيه|منيو|قائمة|ابدأ|ابدء)$/i.test(message)) {
    resetFlow(session);
    const card = menuCard();
    session.lastCard = card;
    bumpCategory("general");
    METRICS.chatOk++;
    updateAvgLatency(Date.now() - t0);
    return res.json({ ok: true, data: card });
  }

  // افهم تقريرك (قصير)
  if (/افهم\s*تقريرك|تقرير|تحاليل/i.test(message) && message.length <= 30) {
    const card = makeCard({
      title: "📄 افهم تقريرك",
      category: "report",
      verdict: "تمام. ارفع صورة أو PDF للتقرير في زر المرفق، وأنا أشرح بشكل عام.",
      tips: ["لا ترفع بيانات شخصية حساسة إن أمكن."],
      when_to_seek_help: "إذا أعراض شديدة مع التقرير: راجع الطبيب/الطوارئ.",
      next_question: "جاهز ترفع التقرير؟",
      quick_choices: ["📎 إضافة مرفق", "إلغاء"],
    });
    session.lastCard = card;
    bumpCategory("report");
    METRICS.chatOk++;
    updateAvgLatency(Date.now() - t0);
    return res.json({ ok: true, data: card });
  }

  const inferred = inferCategoryFromMessage(message);

  // ✅✅ متابعة المسار أولًا قبل أي yes/no guards
  if (session.flow && session.step > 0 && session.step < 4) {
    const card = continueFlow(session, message);
    if (card) {
      session.lastCard = card;
      METRICS.chatOk++;
      updateAvgLatency(Date.now() - t0);
      return res.json({ ok: true, data: card });
    }
  }

  // بدء المسارات
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

    if (
      short &&
      ["sugar", "bp", "bmi", "water", "calories", "mental", "first_aid"].includes(inferred)
    ) {
      const card = startFlow(session, inferred);
      session.lastCard = card;
      METRICS.chatOk++;
      updateAvgLatency(Date.now() - t0);
      return res.json({ ok: true, data: card });
    }
  }

  // YES/NO Router (بعد المسارات)
  const yn = yesNoRouter(session, message);
  if (yn) {
    session.lastCard = yn;
    bumpCategory(yn.category);
    METRICS.chatOk++;
    updateAvgLatency(Date.now() - t0);
    return res.json({ ok: true, data: yn });
  }

  // Bare yes/no فقط إذا ما في Flow
  if (!session.flow && isBareYesNo(message) && !session.lastCard?.next_question) {
    const card = makeCard({
      title: "دليل العافية",
      category: "general",
      verdict: "وضح لي أكثر 😊",
      tips: ["اكتب سؤالك بشكل أوضح أو اختر مسار من القائمة."],
      when_to_seek_help: "إذا أعراض طارئة: طوارئ فورًا.",
      next_question: "وش تبغى تسأل؟",
      quick_choices: menuCard().quick_choices,
    });
    session.lastCard = card;
    METRICS.chatOk++;
    updateAvgLatency(Date.now() - t0);
    return res.json({ ok: true, data: card });
  }

  // رسالة قصيرة/غامضة
  if (isTooVague(message)) {
    const card = makeCard({
      title: "توضيح سريع",
      category: inferred === "emergency" ? "emergency" : inferred || "general",
      verdict: "أقدر أساعدك، بس أحتاج تفاصيل بسيطة عشان ما أعطيك رد عام.",
      tips: ["اكتب: العمر التقريبي + الأعراض + مدتها + هل فيه حرارة/ألم شديد؟"],
      when_to_seek_help: "إذا ألم صدر/ضيق نفس/إغماء/نزيف شديد: طوارئ فورًا.",
      next_question: "وش الأعراض بالضبط ومتى بدأت؟",
      quick_choices: ["أعراض بدأت اليوم", "من يومين", "أسبوع+", "القائمة الرئيسية"],
    });
    session.lastCard = card;
    METRICS.chatOk++;
    updateAvgLatency(Date.now() - t0);
    return res.json({ ok: true, data: card });
  }

  // ====== LLM ======
  session.history.push({ role: "user", content: message });
  session.history = trimHistory(session.history, 10);

  const last = req.body?.context?.last || session.lastCard || null;
  const lastStr = last ? clampText(JSON.stringify(last), 1200) : "";
  const msgStr = clampText(message, 1200);

  const profileStr =
    session.flow && session.step === 4 ? clampText(JSON.stringify(session.profile), 1200) : "";

  const historyStr = clampText(
    session.history
      .slice(-6)
      .map((x) => `${x.role === "user" ? "المستخدم" : "المساعد"}: ${x.content}`)
      .join("\n"),
    1800
  );

  let forcedCategory = null;
  if (session.flow === "sugar" && session.step === 4) forcedCategory = "sugar";
  if (session.flow === "bp" && session.step === 4) forcedCategory = "bp";
  if (session.flow === "bmi" && session.step === 4) forcedCategory = "bmi";
  if (session.flow === "water" && session.step === 4) forcedCategory = "water";
  if (session.flow === "calories" && session.step === 4) forcedCategory = "calories";
  if (session.flow === "mental" && session.step === 4) forcedCategory = "mental";
  if (session.flow === "first_aid" && session.step === 4) forcedCategory = "general";
  if (session.flow === "general" && session.step === 4) forcedCategory = "general";

  const userPrompt =
    (historyStr ? `سياق المحادثة (آخر رسائل):\n${historyStr}\n\n` : "") +
    (profileStr ? `بيانات تخصيص (اختيارات المستخدم):\n${profileStr}\n\n` : "") +
    (last ? `سياق آخر بطاقة (لا تكررها حرفيًا، استخدمها فقط إذا مرتبطة):\n${lastStr}\n\n` : "") +
    `سؤال المستخدم:\n${msgStr}\n\n` +
    "الالتزام: لا تشخيص، لا أدوية، لا جرعات.\n" +
    "قدّم نصائح عامة عملية + متى يراجع الطبيب/الطوارئ.\n" +
    "مهم: لا تعيد نفس البطاقة السابقة إذا كان جواب المستخدم قصيرًا.\n";

  try {
    const obj = await callGroqJSON({
      system: chatSystemPrompt(),
      user: userPrompt,
      maxTokens: 1200,
    });

    let finalCategory = obj?.category || inferred || "general";
    if (forcedCategory) {
      finalCategory = forcedCategory;
      METRICS.flows[`${session.flow}Completed`]++;
      resetFlow(session);
    } else {
      if (inferred && finalCategory !== inferred && finalCategory !== "appointments") {
        finalCategory = inferred;
      }
    }

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

  const userId = getUserId(req);
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

    const extractedClamped = clampText(extracted, 6000);

    const userPrompt =
      "نص مستخرج من تقرير/تحاليل:\n" +
      extractedClamped +
      "\n\n" +
      "اشرح بالعربية بشكل عام: ماذا يعني + نصائح عامة + متى يراجع الطبيب.\n" +
      "التزم بما ورد في التقرير فقط.\n" +
      "ممنوع تشخيص مؤكد أو جرعات أو وصف علاج.";

    const obj = await callGroqJSON({
      system: reportSystemPrompt(),
      user: userPrompt,
      maxTokens: 1600,
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
