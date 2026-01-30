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
      // مسارات الموظف الرقمي (8)
      "guide",
      "appointments",
      "lab",
      "radiology",
      "inpatient",
      "er",
      "lifestyle",
      "first_aid",
      // مسارات نمط الحياة (القديمة داخل نمط الحياة)
      "sugar",
      "bp",
      "bmi",
      "water",
      "calories",
      "mental",
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

  // توجيه وخدمات منشأة
  if (/(توجيه|وين|اين|مكان|استقبال|تسجيل|عيادات|طوارئ|تنويم|اشعه|أشعة|مختبر|مختبرات|قسم|تحويله|تحويلة)/i.test(t))
    return "general";

  // نمط حياة/وقاية
  if (/(نمط|وقاية|تغذية|رياضة|نوم|تدخين|سمنة|وزن)/i.test(t)) return "general";

  // المسارات القديمة (نمط الحياة)
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
  if (/(🧭|📅|🧪|🩻|🏥|🚑|🌿|🩹|🩸|🫀|⚖️|💧|🔥|🧠|📄)/.test(t)) return false;

  // كلمات المسارات (الرئيسية + القديمة)
  if (
    /^(🧭\s*التوجيه داخل المنشأة|التوجيه داخل المنشأة|توجيه|🧭|📅\s*مواعيد شفاء|مواعيد شفاء|📅|🧪\s*المختبر والتحاليل|المختبر والتحاليل|مختبر|تحاليل|🧪|🩻\s*الأشعة والتصوير|الأشعة والتصوير|اشعه|أشعة|تصوير|🩻|🏥\s*التنويم والخدمات الداخلية|التنويم والخدمات الداخلية|تنويم|🏥|🚑\s*الطوارئ: متى أراجع\؟|الطوارئ|طوارئ|🚑|🌿\s*نمط الحياة والوقاية|نمط الحياة|وقاية|🌿|🩹\s*إسعافات أولية|إسعافات|اسعافات|🩹|السكر|سكر|🩸 السكر|🩸|الضغط|ضغط|🫀 الضغط|🫀|bmi|BMI|⚖️ BMI|⚖️|ماء|شرب الماء|💧 شرب الماء|💧|سعرات|calories|🔥 السعرات|🔥|مزاج|🧠|📄 افهم تقريرك|افهم تقريرك|📄)$/i.test(
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

  // شفاء: شرح خطوات الحجز
  if (/خطوات الحجز|الحجز داخل التطبيق|شرح خطوات الحجز/i.test(lastQ)) {
    if (isYes) {
      return makeCard({
        title: "📅 خطوات حجز موعد عبر شفاء (عام)",
        category: "appointments",
        verdict: "هذه خطوات عامة وقد تختلف حسب إصدار التطبيق والخدمة:",
        tips: [
          "افتح تطبيق شفاء وسجّل الدخول.",
          "اذهب إلى (المواعيد/حجز موعد).",
          "اختر المنشأة/التخصص ثم العيادة.",
          "اختر الطبيب (إن توفر) ثم الموعد المناسب.",
          "تأكد من بياناتك ثم أكّد الحجز.",
          "احتفظ بتأكيد الموعد وأي تعليمات قبل المراجعة.",
        ],
        when_to_seek_help:
          "إذا أعراض طارئة أو شديدة: لا تنتظر موعدًا—راجع الطوارئ فورًا.",
        next_question: "تريد شرح: (تعديل موعد) أو (إلغاء)؟",
        quick_choices: ["تعديل موعد", "إلغاء", "القائمة الرئيسية"],
      });
    }
    if (isNo) {
      return menuCard();
    }
  }

  // أسئلة عامة لنمط حياة بدل علاج/أدوية
  if (/نصائح نمط حياة بدل العلاج/i.test(lastQ)) {
    if (isYes) {
      return makeCard({
        title: "🌿 نمط حياة ووقاية",
        category: "general",
        verdict: "تمام 👍 هذه نقاط عامة وآمنة تساعد غالبًا:",
        tips: [
          "الغذاء: خضار + بروتين + تقليل السكريات والمقليات.",
          "النشاط: 150 دقيقة/أسبوع مشي سريع أو ما يناسبك.",
          "النوم: انتظام 7–9 ساعات وتقليل المنبهات مساءً.",
          "الماء: اشرب بانتظام (وزّعها خلال اليوم).",
          "التوتر: تنفّس عميق/مشي/تنظيم وقت.",
        ],
        when_to_seek_help:
          "إذا أعراض شديدة أو علامات خطر (ألم صدر/ضيق نفس/إغماء/نزيف شديد): طوارئ فورًا.",
        next_question: "تبغى نركز على: التغذية ولا النوم ولا النشاط؟",
        quick_choices: ["التغذية", "النوم", "النشاط", "القائمة الرئيسية"],
      });
    }
    if (isNo) return menuCard();
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

/* =========================
   Cards (المسارات)
========================= */
function menuCard() {
  return makeCard({
    title: "دليل العافية",
    category: "general",
    verdict: "أنا **موظف التثقيف والتوجيه الصحي الرقمي** داخل المنشأة.\nاختر مسارًا:",
    tips: [
      "تثقيف عام + توجيه للخدمة (عيادات/طوارئ/تنويم/أشعة/مختبر).",
      "لا تشخيص ولا وصف أدوية/جرعات.",
    ],
    when_to_seek_help:
      "إذا أعراض خطيرة (ألم صدر/ضيق نفس/إغماء/نزيف شديد): طوارئ فورًا.",
    next_question: "وش تبغى تبدأ فيه؟",
    quick_choices: [
      "🧭 التوجيه داخل المنشأة",
      "📅 مواعيد شفاء",
      "🧪 المختبر والتحاليل",
      "🩻 الأشعة والتصوير",
      "🏥 التنويم والخدمات الداخلية",
      "🚑 الطوارئ: متى أراجع؟",
      "🌿 نمط الحياة والوقاية",
      "🩹 إسعافات أولية",
    ],
  });
}

function lifestyleHubCard() {
  return makeCard({
    title: "🌿 نمط الحياة والوقاية",
    category: "general",
    verdict:
      "هذا المسار يجمع **المسارات السابقة** (حاسبات/تثقيف) داخل نمط الحياة.\nاختر بطاقة:",
    tips: [
      "معلومة عامة للتثقيف—ليست تشخيصًا.",
      "إذا عندك أعراض طارئة: طوارئ فورًا.",
    ],
    when_to_seek_help:
      "ألم صدر/ضيق نفس/إغماء/نزيف شديد: طوارئ فورًا.",
    next_question: "أي بطاقة تختار؟",
    quick_choices: [
      "🩸 السكر",
      "🫀 الضغط",
      "⚖️ BMI",
      "💧 شرب الماء",
      "🔥 السعرات",
      "🧠 المزاج والنوم",
      "📄 افهم تقريرك",
      "القائمة الرئيسية",
    ],
  });
}

function greetingCard() {
  return makeCard({
    title: "دليل العافية",
    category: "general",
    verdict:
      "وعليكم السلام ورحمة الله وبركاته 🌿\nأنا هنا للتثقيف الصحي **والتوجيه داخل المنشأة**. كيف أخدمك؟",
    tips: ["اختر مسار أو اكتب سؤالك مباشرة (زائر/مراجع/مرافق/موظف)."],
    when_to_seek_help: "إذا عندك أعراض خطيرة: طوارئ فورًا.",
    next_question: "وش تبغى تبدأ فيه؟",
    quick_choices: menuCard().quick_choices,
  });
}

function thanksCard() {
  return makeCard({
    title: "دليل العافية",
    category: "general",
    verdict: "العفو 🌿 اختر مسار أو اكتب سؤالك.",
    tips: [],
    when_to_seek_help: "إذا أعراض طارئة: طوارئ فورًا.",
    next_question: "وش تبغى تسأل؟",
    quick_choices: menuCard().quick_choices,
  });
}

function appointmentsCard() {
  return makeCard({
    title: "📅 مواعيد شفاء",
    category: "appointments",
    verdict:
      "للحجز وإدارة المواعيد والاطلاع على الملف الصحي في سلطنة عُمان استخدم تطبيق **شفاء** الرسمي.\nروابط التحميل الرسمية:",
    tips: [`أندرويد: ${SHIFAA_ANDROID}`, `آيفون: ${SHIFAA_IOS}`],
    when_to_seek_help:
      "إذا كانت لديك أعراض طارئة أو شديدة: راجع الطوارئ فورًا.",
    next_question: "هل تريد **شرح خطوات الحجز** داخل التطبيق؟",
    quick_choices: ["نعم", "لا", "القائمة الرئيسية"],
  });
}

function emergencyGateCard() {
  return makeCard({
    title: "🚑 الطوارئ",
    category: "emergency",
    verdict:
      "قبل التوجيه: هل عندك الآن أي علامة خطر؟ (ألم صدر شديد/ضيق نفس شديد/إغماء/نزيف شديد/ضعف مفاجئ)",
    tips: ["إذا نعم: توجّه للطوارئ فورًا أو اتصل بالإسعاف."],
    when_to_seek_help: "الآن إذا توجد علامات خطر.",
    next_question: "هل توجد علامة خطر الآن؟",
    quick_choices: ["نعم", "لا"],
  });
}

function firstAidGuardIntroCard() {
  return makeCard({
    title: "🩹 إسعافات أولية (محكومة)",
    category: "general",
    verdict:
      "هذا المسار يعطي **إرشادات آمنة وبسيطة فقط**.\nإذا الحالة خطيرة أو فيها فقدان وعي/نزيف شديد/ضيق نفس: طوارئ فورًا.",
    tips: ["اختر الموقف الأقرب:"],
    when_to_seek_help:
      "فقدان وعي/نزيف شديد/صعوبة تنفس/حساسية شديدة: طوارئ فورًا.",
    next_question: "وش الموقف؟",
    quick_choices: ["حروق بسيطة", "جرح/نزيف بسيط", "اختناق", "إغماء", "التواء/كدمة", "القائمة الرئيسية"],
  });
}

/* =========================
   Flow engine
========================= */
function startFlow(session, flowKey) {
  session.flow = flowKey;
  session.step = 1;
  session.profile = {};
  METRICS.flows[`${flowKey}Started`] = (METRICS.flows[`${flowKey}Started`] || 0) + 1;
  bumpCategory(flowKey);

  const commonWho = ["زائر", "مراجع", "مرافق", "موظف"];
  const commonDept = ["العيادات الخارجية", "الطوارئ", "التنويم", "الأشعة", "المختبر", "الاستقبال/التسجيل"];

  // ====== 8 مسارات الموظف الرقمي ======
  if (flowKey === "guide") {
    return makeCard({
      title: "🧭 التوجيه داخل المنشأة",
      category: "general",
      verdict: "أولًا: أنت مين اليوم؟",
      tips: ["يساعدني أعطيك توجيه مناسب داخل المنشأة."],
      when_to_seek_help:
        "إذا عندك أعراض طارئة: اتجه للطوارئ فورًا.",
      next_question: "",
      quick_choices: commonWho,
    });
  }

  if (flowKey === "lab") {
    return makeCard({
      title: "🧪 المختبر والتحاليل",
      category: "general",
      verdict: "وش تحتاج من المختبر؟",
      tips: ["اختيارك يحدد نوع الإرشادات (صيام/تحضير/نتائج/موقع)."],
      when_to_seek_help:
        "إذا أعراض شديدة أو طارئة: راجع الطوارئ فورًا.",
      next_question: "",
      quick_choices: [
        "التحضير للتحاليل (صيام/أدوية)",
        "استلام النتائج",
        "مكان المختبر/الإجراءات",
        "معنى تحليل بشكل عام",
      ],
    });
  }

  if (flowKey === "radiology") {
    return makeCard({
      title: "🩻 الأشعة والتصوير",
      category: "general",
      verdict: "وش نوع التصوير المطلوب؟",
      tips: ["التحضير يختلف حسب النوع."],
      when_to_seek_help:
        "إذا عندك أعراض طارئة: راجع الطوارئ فورًا.",
      next_question: "",
      quick_choices: ["أشعة سينية", "سونار", "CT", "MRI", "تحضير/تعليمات عامة"],
    });
  }

  if (flowKey === "inpatient") {
    return makeCard({
      title: "🏥 التنويم والخدمات الداخلية",
      category: "general",
      verdict: "وش يهمك في التنويم؟",
      tips: ["أعطيك إرشادات عامة (غير مرتبطة بسياسة ساعات محددة)."],
      when_to_seek_help:
        "إذا حالة طارئة: طوارئ فورًا.",
      next_question: "",
      quick_choices: [
        "ماذا أحضر للمريض؟",
        "إجراءات الدخول/الخروج",
        "زيارة المريض (إرشادات عامة)",
        "حقوق/واجبات المريض والمرافق",
      ],
    });
  }

  if (flowKey === "er") {
    return emergencyGateCard();
  }

  if (flowKey === "appointments") {
    // مسار جاهز (بدون Flow أسئلة متعددة)، لكن نخليه Flow عشان يُكمل داخل LLM لو احتاج
    return appointmentsCard();
  }

  if (flowKey === "lifestyle") {
    // Hub فقط
    resetFlow(session);
    return lifestyleHubCard();
  }

  if (flowKey === "first_aid") {
    return firstAidGuardIntroCard();
  }

  // ====== المسارات القديمة (داخل نمط الحياة) ======
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
      title: "🧠 مسار المزاج والنوم",
      category: "mental",
      verdict: "خلال آخر أسبوع، كيف كان مزاجك غالبًا؟",
      tips: [],
      when_to_seek_help: "",
      next_question: "",
      quick_choices: ["ممتاز", "جيد", "متعب", "سيئ"],
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
  const commonDept = ["العيادات الخارجية", "الطوارئ", "التنويم", "الأشعة", "المختبر", "الاستقبال/التسجيل"];

  // ====== مسارات التوجيه/الإجراءات ======
  if (flow === "guide") {
    if (step === 1) {
      session.profile.who = m;
      session.step = 2;
      return makeCard({
        title: "🧭 التوجيه داخل المنشأة",
        category: "general",
        verdict: "تمام. وين وجهتك داخل المنشأة؟",
        tips: ["إذا أنت مراجع: غالبًا تبدأ من الاستقبال/التسجيل ثم العيادة/القسم."],
        when_to_seek_help: "إذا أعراض طارئة: طوارئ فورًا.",
        next_question: "",
        quick_choices: commonDept,
      });
    }
    if (step === 2) {
      session.profile.destination = m;
      session.step = 3;
      return makeCard({
        title: "🧭 التوجيه داخل المنشأة",
        category: "general",
        verdict: "وش تحتاج بالضبط؟",
        tips: ["اختر نوع التوجيه عشان أعطيك خطوات واضحة."],
        when_to_seek_help: "إذا أعراض طارئة: طوارئ فورًا.",
        next_question: "",
        quick_choices: ["أين أذهب أولًا؟", "ما هي الأوراق المطلوبة؟", "طريقة الوصول/الاستقبال", "القائمة الرئيسية"],
      });
    }
    if (step === 3) {
      session.profile.need = m;
      session.step = 4;
      return null;
    }
  }

  if (flow === "lab") {
    if (step === 1) {
      session.profile.topic = m;
      session.step = 2;
      return makeCard({
        title: "🧪 المختبر والتحاليل",
        category: "general",
        verdict: "هل التحليل يتطلب صيام؟ (إذا ما تدري اختر: غير متأكد)",
        tips: ["الصيام يختلف حسب نوع التحليل."],
        when_to_seek_help: "إذا أعراض شديدة: طوارئ فورًا.",
        next_question: "",
        quick_choices: ["نعم", "لا", "غير متأكد"],
      });
    }
    if (step === 2) {
      session.profile.fasting = m;
      session.step = 3;
      return makeCard({
        title: "🧪 المختبر والتحاليل",
        category: "general",
        verdict: "اختر ما يناسب طلبك:",
        tips: ["أعطيك إرشاد عام + متى تسأل الطبيب/المختبر."],
        when_to_seek_help: "",
        next_question: "",
        quick_choices: ["تحضير عام قبل التحاليل", "بعد التحليل: متى تظهر النتائج؟", "معنى التحليل بشكل مبسط", "القائمة الرئيسية"],
      });
    }
    if (step === 3) {
      session.profile.need = m;
      session.step = 4;
      return null;
    }
  }

  if (flow === "radiology") {
    if (step === 1) {
      session.profile.modality = m;
      session.step = 2;
      return makeCard({
        title: "🩻 الأشعة والتصوير",
        category: "general",
        verdict: "هل عندك حمل (للسيدات) أو جهاز/معدن مزروع (للـ MRI)؟",
        tips: ["اختيارك يساعدني أعطي تنبيهات أمان عامة."],
        when_to_seek_help: "",
        next_question: "",
        quick_choices: ["نعم", "لا", "غير متأكد"],
      });
    }
    if (step === 2) {
      session.profile.safety = m;
      session.step = 3;
      return makeCard({
        title: "🩻 الأشعة والتصوير",
        category: "general",
        verdict: "وش تبغى؟",
        tips: ["تحضير/لبس/أكل/سوائل يختلف حسب النوع."],
        when_to_seek_help: "",
        next_question: "",
        quick_choices: ["تحضير قبل الفحص", "ماذا أحضر معي؟", "بعد الفحص", "القائمة الرئيسية"],
      });
    }
    if (step === 3) {
      session.profile.need = m;
      session.step = 4;
      return null;
    }
  }

  if (flow === "inpatient") {
    if (step === 1) {
      session.profile.topic = m;
      session.step = 2;
      return makeCard({
        title: "🏥 التنويم والخدمات الداخلية",
        category: "general",
        verdict: "أنت مين في الحالة؟",
        tips: ["هذا يساعدني أختار تعليمات مناسبة (مريض/مرافق/زائر)."],
        when_to_seek_help: "",
        next_question: "",
        quick_choices: ["مريض", "مرافق", "زائر", "موظف"],
      });
    }
    if (step === 2) {
      session.profile.role = m;
      session.step = 3;
      return makeCard({
        title: "🏥 التنويم والخدمات الداخلية",
        category: "general",
        verdict: "اختر جانب واحد لتفصيله:",
        tips: [],
        when_to_seek_help: "",
        next_question: "",
        quick_choices: ["ماذا أحضر؟", "إجراءات عامة", "زيارة المريض", "القائمة الرئيسية"],
      });
    }
    if (step === 3) {
      session.profile.need = m;
      session.step = 4;
      return null;
    }
  }

  if (flow === "er") {
    if (step === 1) {
      // هذا المسار يبدأ بسؤال خطر
      if (/^نعم$/i.test(m)) {
        METRICS.emergencyTriggers++;
        const card = makeCard({
          title: "⚠️ تنبيه طارئ",
          category: "emergency",
          verdict:
            "إذا توجد علامة خطر: **توجّه لأقرب طوارئ فورًا** أو اتصل بالإسعاف.",
          tips: ["لا تنتظر.", "إذا معك شخص، اطلب مساعدته فورًا."],
          when_to_seek_help: "الآن.",
          next_question: "هل أنت في أمان الآن؟",
          quick_choices: ["نعم", "لا"],
        });
        session.lastCard = card;
        resetFlow(session);
        return card;
      }

      if (/^لا$/i.test(m)) {
        session.profile.noDanger = true;
        session.step = 2;
        return makeCard({
          title: "🚑 الطوارئ: متى أراجع؟",
          category: "general",
          verdict: "وش تبغى تعرف؟",
          tips: ["إرشاد عام يساعدك تختار المكان المناسب (طوارئ/عيادات)."],
          when_to_seek_help:
            "إذا ظهرت علامات خطر لاحقًا: طوارئ فورًا.",
          next_question: "",
          quick_choices: [
            "متى أروح الطوارئ؟",
            "متى تكفي العيادات؟",
            "الفرز (Triage) وش يعني؟",
            "وش أحضر معي؟",
            "القائمة الرئيسية",
          ],
        });
      }

      return null;
    }

    if (step === 2) {
      session.profile.need = m;
      session.step = 4;
      return null;
    }
  }

  // ====== المسارات القديمة (نمط الحياة) ======
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
        title: "🧠 مسار المزاج والنوم",
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
        title: "🧠 مسار المزاج والنوم",
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
    "أنت موظف التثقيف والتوجيه الصحي الرقمي داخل منشأة صحية.\n" +
    "مهامك: تثقيف صحي عام + توجيه للخدمات داخل المنشأة (عيادات/طوارئ/تنويم/أشعة/مختبر) + إرشاد لإجراءات عامة.\n" +
    "ممنوع منعًا باتًا: التشخيص، وصف الأدوية، الجرعات، أو خطة علاج.\n" +
    "اذكر متى يجب مراجعة الطبيب/الطوارئ عند أعراض خطيرة.\n" +
    "إذا لم تكن متأكدًا، قل: لا أعلم.\n" +
    "اكتب بالعربية الواضحة وبشكل عملي مختصر.\n" +
    "أخرج JSON فقط بالمفاتيح المحددة.\n"
  );
}

function reportSystemPrompt() {
  return (
    "أنت موظف تثقيف صحي عربي لشرح نتائج التحاليل/التقارير بشكل عام.\n" +
    "المدخل نص مُستخرج من صورة/ملف.\n" +
    "اشرح بالعربية: معنى عام + ما الذي يُسأل عنه الطبيب + نصائح عامة + متى يراجع الطبيب/الطوارئ.\n" +
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
        "أنا للتثقيف الصحي والتوجيه فقط. ما أقدر أوصف أدوية أو جرعات.\n" +
        "إذا سؤالك علاجي/دوائي: راجع طبيب/صيدلي.",
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

  // طوارئ (نص)
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

  // مواعيد (نص)
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

  // نمط الحياة Hub
  if (/^(🌿\s*)?(نمط الحياة والوقاية|نمط الحياة|وقاية)$/i.test(message)) {
    resetFlow(session);
    const card = lifestyleHubCard();
    session.lastCard = card;
    bumpCategory("general");
    METRICS.chatOk++;
    updateAvgLatency(Date.now() - t0);
    return res.json({ ok: true, data: card });
  }

  // افهم تقريرك (قصير)
  if (/افهم\s*تقريرك|📄/i.test(message) && message.length <= 30) {
    const card = makeCard({
      title: "📄 افهم تقريرك",
      category: "report",
      verdict: "تمام. ارفع صورة أو PDF للتقرير في زر المرفق، وأنا أشرح **بشكل عام**.",
      tips: ["يفضّل إخفاء بيانات شخصية حساسة (رقم ملف/هوية) إن أمكن."],
      when_to_seek_help: "إذا أعراض شديدة مع التقرير: راجع الطبيب/الطوارئ.",
      next_question: "جاهز ترفع التقرير؟",
      quick_choices: ["📎 إضافة مرفق", "إلغاء", "القائمة الرئيسية"],
    });
    session.lastCard = card;
    bumpCategory("report");
    METRICS.chatOk++;
    updateAvgLatency(Date.now() - t0);
    return res.json({ ok: true, data: card });
  }

  const inferred = inferCategoryFromMessage(message);

  // ✅ متابعة المسار قبل أي شيء
  if (session.flow && session.step > 0 && session.step < 4) {
    const card = continueFlow(session, message);
    if (card) {
      session.lastCard = card;
      METRICS.chatOk++;
      updateAvgLatency(Date.now() - t0);
      return res.json({ ok: true, data: card });
    }
  }

  // بدء المسارات (8 + القديمة داخل نمط الحياة)
  const startMap = [
    // 8 مسارات
    { key: "guide", match: /🧭|التوجيه داخل المنشأة|توجيه/i },
    { key: "appointments", match: /📅|مواعيد شفاء|شفاء|موعد|حجز/i },
    { key: "lab", match: /🧪|مختبر|تحاليل|تحليل/i },
    { key: "radiology", match: /🩻|أشعة|اشعه|تصوير|radiology/i },
    { key: "inpatient", match: /🏥|تنويم|تنوم|خدمات داخلية|عنبر/i },
    { key: "er", match: /🚑|الطوارئ|طوارئ|emergency/i },
    { key: "lifestyle", match: /🌿|نمط الحياة|وقاية|تغذية|رياضة|نوم/i },
    { key: "first_aid", match: /🩹|اسعافات|إسعافات|حروق|جرح|اختناق|إغماء/i },

    // القديمة (تأتي غالبًا من Hub)
    { key: "sugar", match: /🩸|سكر|السكر/i },
    { key: "bp", match: /🫀|ضغط|الضغط/i },
    { key: "bmi", match: /⚖️|bmi|BMI|كتلة/i },
    { key: "water", match: /💧|ماء|شرب الماء|ترطيب/i },
    { key: "calories", match: /🔥|سعرات|calories|رجيم|دايت/i },
    { key: "mental", match: /🧠|مزاج|نوم|قلق|توتر|اكتئاب/i },
  ];

  if (!session.flow) {
    const short = message.length <= 45;
    const matched = startMap.find((x) => x.match.test(message));
    if (short && matched) {
      const card = startFlow(session, matched.key);
      session.lastCard = card;
      METRICS.chatOk++;
      updateAvgLatency(Date.now() - t0);
      return res.json({ ok: true, data: card });
    }

    // fallback inferred to old calculators (لو المستخدم كتب مباشرة)
    if (short && ["sugar", "bp", "bmi", "water", "calories", "mental", "first_aid"].includes(inferred)) {
      const card = startFlow(session, inferred);
      session.lastCard = card;
      METRICS.chatOk++;
      updateAvgLatency(Date.now() - t0);
      return res.json({ ok: true, data: card });
    }

    // fallback inferred للمسارات الجديدة
    if (short && /(مختبر|تحاليل)/i.test(message)) {
      const card = startFlow(session, "lab");
      session.lastCard = card;
      METRICS.chatOk++;
      updateAvgLatency(Date.now() - t0);
      return res.json({ ok: true, data: card });
    }
    if (short && /(اشعه|أشعة|تصوير)/i.test(message)) {
      const card = startFlow(session, "radiology");
      session.lastCard = card;
      METRICS.chatOk++;
      updateAvgLatency(Date.now() - t0);
      return res.json({ ok: true, data: card });
    }
    if (short && /(تنويم)/i.test(message)) {
      const card = startFlow(session, "inpatient");
      session.lastCard = card;
      METRICS.chatOk++;
      updateAvgLatency(Date.now() - t0);
      return res.json({ ok: true, data: card });
    }
    if (short && /(طوارئ)/i.test(message)) {
      const card = startFlow(session, "er");
      session.lastCard = card;
      METRICS.chatOk++;
      updateAvgLatency(Date.now() - t0);
      return res.json({ ok: true, data: card });
    }
    if (short && /(توجيه|وين|اين|مكان)/i.test(message)) {
      const card = startFlow(session, "guide");
      session.lastCard = card;
      METRICS.chatOk++;
      updateAvgLatency(Date.now() - t0);
      return res.json({ ok: true, data: card });
    }
  }

  // YES/NO Router
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

  // رسالة قصيرة/غامضة (لا نطبقها عند اكتمال مسار step=4)
  const inCompletedFlow = session.flow && session.step === 4;
  if (!inCompletedFlow && isTooVague(message)) {
    const card = makeCard({
      title: "توضيح سريع",
      category: inferred === "emergency" ? "emergency" : inferred || "general",
      verdict: "أقدر أساعدك، بس أحتاج تفاصيل بسيطة عشان ما أعطيك رد عام.",
      tips: [
        "لو سؤال توجيه: اكتب (زائر/مراجع/مرافق/موظف) + القسم المطلوب.",
        "لو سؤال صحي: اكتب العمر التقريبي + الأعراض + مدتها.",
      ],
      when_to_seek_help: "إذا علامات خطر: طوارئ فورًا.",
      next_question: "وش تبغى بالضبط؟ (توجيه داخل المنشأة أو تثقيف صحي)",
      quick_choices: ["🧭 التوجيه داخل المنشأة", "🌿 نمط الحياة والوقاية", "🚑 الطوارئ: متى أراجع؟", "القائمة الرئيسية"],
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

  // إجبار التصنيف عند اكتمال مسار
  let forcedCategory = null;
  if (session.flow === "sugar" && session.step === 4) forcedCategory = "sugar";
  if (session.flow === "bp" && session.step === 4) forcedCategory = "bp";
  if (session.flow === "bmi" && session.step === 4) forcedCategory = "bmi";
  if (session.flow === "water" && session.step === 4) forcedCategory = "water";
  if (session.flow === "calories" && session.step === 4) forcedCategory = "calories";
  if (session.flow === "mental" && session.step === 4) forcedCategory = "mental";

  // المسارات الجديدة كلها "general" أو "appointments"
  if (["guide", "lab", "radiology", "inpatient", "er", "first_aid"].includes(session.flow) && session.step === 4)
    forcedCategory = session.flow === "er" ? "general" : "general";

  const userPrompt =
    (historyStr ? `سياق المحادثة (آخر رسائل):\n${historyStr}\n\n` : "") +
    (profileStr ? `بيانات تخصيص (اختيارات المستخدم):\n${profileStr}\n\n` : "") +
    (last ? `سياق آخر بطاقة (لا تكررها حرفيًا، استخدمها فقط إذا مرتبطة):\n${lastStr}\n\n` : "") +
    `سؤال المستخدم:\n${msgStr}\n\n` +
    "الالتزام: لا تشخيص، لا أدوية، لا جرعات.\n" +
    "قدّم: توجيه داخل المنشأة/إجراء عام/تثقيف عام + متى يراجع الطبيب/الطوارئ.\n" +
    "مهم: إذا السؤال إسعافات أولية، اجعلها **محكومة** وخطوات آمنة وبسيطة فقط.\n";

  try {
    const obj = await callGroqJSON({
      system: chatSystemPrompt(),
      user: userPrompt,
      maxTokens: 1200,
    });

    let finalCategory = obj?.category || inferred || "general";
    if (forcedCategory) {
      finalCategory = forcedCategory;
      const k = session.flow;
      if (k && METRICS.flows[`${k}Completed`] !== undefined) METRICS.flows[`${k}Completed`]++;
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
      "اشرح بالعربية بشكل عام: ماذا يعني + ماذا أسأل الطبيب + نصائح عامة + متى يراجع الطبيب/الطوارئ.\n" +
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
