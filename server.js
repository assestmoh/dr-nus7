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

/* WhatsApp appointments number (as provided) */
const WHATSAPP_APPOINTMENTS = "9880 9901";

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
      // institutional
      "medication_general_guidance",
      "lab_preparation",
      "common_conditions_education",
      "prevention_lifestyle",
      "facility_navigation",
      "shifaa_appointments",
      // NEW
      "lifestyle_bundle",
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
const sessions = new Map(); // userId -> session

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
      // منع الازدواج
      lastInText: "",
      lastInAt: 0,
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

// NEW: Intent للأدوية (لمنع التنبيهات المزعجة)
function hasMedicationIntent(userText) {
  const t = String(userText || "");
  return /(دواء|ادويه|علاج|جرعه|جرعات|كم اخذ|كم آخذ|كم مره|مرتين|ثلاث مرات|حبوب|قرص|كبسول|شراب|بخاخ|انسولين|metformin|ibuprofen|paracetamol|antibiotic)/i.test(
    t
  );
}

// NEW: Parse ضغط
function parseBP(text) {
  const m = String(text || "").match(/(\d{2,3})\s*\/\s*(\d{2,3})/);
  if (!m) return null;
  const sys = Number(m[1]);
  const dia = Number(m[2]);
  if (!Number.isFinite(sys) || !Number.isFinite(dia)) return null;
  if (sys < 50 || sys > 260 || dia < 30 || dia > 160) return { sys, dia, weird: true };
  return { sys, dia, weird: false };
}

// NEW: Parse سكر (قراءة واحدة تقريبية)
function parseSugar(text) {
  const m = String(text || "").match(/(\d{2,3})/);
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  if (v < 30 || v > 600) return { value: v, weird: true };
  return { value: v, weird: false };
}

function inferCategoryFromMessage(message) {
  const t = String(message || "");

  if (isEmergencyText(t)) return "emergency";
  if (looksLikeAppointments(t)) return "appointments";
  if (/(تقرير|تحاليل|تحليل|نتيجة|cbc|hba1c|cholesterol|vitamin|lab|report|pdf|صورة)/i.test(t))
    return "report";
  if (/(قلق|توتر|اكتئاب|مزاج|نوم|أرق|panic|anxiety|depress)/i.test(t)) return "mental";
  if (/(bmi|كتلة الجسم|مؤشر كتلة|وزني|طولي)/i.test(t)) return "bmi";
  if (/(ضغط|ضغط الدم|systolic|diastolic|mmhg|ملم زئبقي|\d{2,3}\s*\/\s*\d{2,3})/i.test(t)) return "bp";
  if (/(سكر|سكري|glucose|mg\/dl|صائم|بعد الأكل|بعد الاكل|hba1c|\b\d{2,3}\b)/i.test(t)) return "sugar";
  if (/(ماء|سوائل|شرب|ترطيب|hydration)/i.test(t)) return "water";
  if (/(سعرات|calories|دايت|رجيم|تخسيس|تنحيف|زيادة وزن|نظام غذائي)/i.test(t)) return "calories";
  if (/(اسعافات|إسعافات|حروق|جرح|اختناق|إغماء|نزيف|كسر|first aid)/i.test(t))
    return "first_aid";
  return "general";
}

/** مهم: استثناء المسارات/الاختيارات من "غامض" */
function isTooVague(text, session) {
  const t = String(text || "").trim();
  if (!t) return true;

  // إذا داخل مسار و المستخدم كتب أرقام/قراءة، لا تعتبرها غامضة
  if (session?.flow === "bp" && (parseBP(t) || /ما\s*اعرف|ما\s*أعرف/i.test(t))) return false;
  if (session?.flow === "sugar" && (parseSugar(t) || /ما\s*اعرف|ما\s*أعرف/i.test(t))) return false;

  // رموز المسارات
  if (/(🩸|🫀|⚖️|💧|🔥|🧠|🩹|📄|📅|🏥|💊|🧪|🌿)/.test(t)) return false;

  // كلمات المسارات الأساسية
  if (
    /^(السكر|سكر|🩸 السكر|🩸|الضغط|ضغط|🫀 الضغط|🫀|bmi|BMI|⚖️ BMI|⚖️|ماء|شرب الماء|💧 شرب الماء|💧|سعرات|calories|🔥 السعرات|🔥|مزاج|🧠 طمّنا على مزاجك|🧠|اسعافات|إسعافات|🩹 إسعافات أولية|🩹|افهم تقريرك|📄 افهم تقريرك|📄|مواعيد شفاء|📅 مواعيد شفاء|📅)$/i.test(
      t
    )
  )
    return false;

  // كلمات المسارات المؤسسية المطلوبة + bundle
  if (
    /^(💊\s*)?إرشاد دوائي عام$/i.test(t) ||
    /^(🧪\s*)?التحضير للمختبر والتحاليل$/i.test(t) ||
    /^(🩺\s*)?تثقيف عن مرض شائع$/i.test(t) ||
    /^(🌿\s*)?(الوقاية ونمط الحياة|نمط الحياه والوقايه|نمط الحياة والوقاية)$/i.test(t) ||
    /^(🏥\s*)?التوجيه داخل المنشأة$/i.test(t) ||
    /^(📅\s*)?مواعيد شفاء( والتحضير لها)?$/i.test(t)
  )
    return false;

  // القائمة الرئيسية
  if (/^(القائمة الرئيسية|القائمه الرئيسيه|منيو|قائمة|ابدأ|ابدء|رجوع)$/i.test(t)) return false;

  // قواعد الغموض (خففناها)
  if (t.length < 3) return true;
  if (t.length < 8 && !/[؟?]/.test(t) && !/\d/.test(t)) return true;
  return false;
}

function isBareYesNo(text) {
  return /^(نعم|لا|ok|okay|تم)$/i.test(String(text || "").trim());
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
      "🌿 نمط الحياة والوقاية",
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

/* =========================
   Institutional paths (deterministic)
========================= */
function startInstitutionalFlow(session, route) {
  session.flow = route;
  session.step = 1;
  session.profile = {};
  METRICS.flows[`${route}Started`] = (METRICS.flows[`${route}Started`] || 0) + 1;

  // NEW: bundle داخل نمط الحياة
  if (route === "lifestyle_bundle") {
    return makeCard({
      title: "🌿 نمط الحياة والوقاية",
      category: "general",
      verdict: "اختر مسار من المسارات السريعة (كلها داخل نمط الحياة):",
      tips: ["هذه القائمة تجمع السكر/الضغط/BMI/الماء/السعرات/المزاج وغيرها."],
      when_to_seek_help: "إذا أعراض طارئة: طوارئ فورًا.",
      next_question: "وش تختار؟",
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
        "القائمة الرئيسية",
      ],
    });
  }

  if (route === "medication_general_guidance") {
    return makeCard({
      title: "💊 إرشاد دوائي عام",
      category: "general",
      verdict: "هنا تثقيف عام عن فئات الأدوية (بدون وصفة/جرعات). اختر بطاقة:",
      tips: ["لن أذكر جرعات أو علاج محدد.", "إذا لديك حساسية/مرض مزمن: استشر الطبيب/الصيدلي."],
      when_to_seek_help: "حساسية شديدة (تورم وجه/ضيق نفس/طفح شديد): طوارئ فورًا.",
      next_question: "أي فئة تريد؟",
      quick_choices: ["مضاد حيوي", "مسكنات", "مضاد حساسية", "أدوية سعال/زكام", "القائمة الرئيسية"],
    });
  }

  if (route === "lab_preparation") {
    return makeCard({
      title: "🧪 التحضير للمختبر والتحاليل",
      category: "report",
      verdict: "اختر مسار داخل المختبر:",
      tips: ["تعليمات الطبيب/المختبر أولاً.", "بعض التحاليل تحتاج صيام."],
      when_to_seek_help: "دوخة شديدة/إغماء بعد السحب: راجع الطاقم فورًا.",
      next_question: "وش تبي؟",
      quick_choices: ["📄 افهم تقريرك", "🧪 التحضير للمختبر", "القائمة الرئيسية"],
    });
  }

  if (route === "common_conditions_education") {
    return makeCard({
      title: "🩺 تثقيف عن مرض شائع",
      category: "general",
      verdict: "اختر مرض شائع لبطاقة تثقيف مختصرة:",
      tips: ["معلومة عامة + وقاية + متى تراجع الطبيب."],
      when_to_seek_help: "أعراض شديدة/متفاقمة: راجع الطبيب/الطوارئ.",
      next_question: "اختر مرض:",
      quick_choices: [
        "السكري",
        "الضغط",
        "الربو",
        "القولون العصبي",
        "نزلات البرد",
        "حساسية موسمية",
        "آلام أسفل الظهر",
        "القائمة الرئيسية",
      ],
    });
  }

  if (route === "prevention_lifestyle") {
    // بقاء المسار كما هو لكن خفيف
    return makeCard({
      title: "🌿 الوقاية ونمط الحياة",
      category: "general",
      verdict: "اختر بطاقة سريعة:",
      tips: ["هدفنا الوقاية وتقليل المخاطر بعادات بسيطة يومية."],
      when_to_seek_help: "إذا أعراض طارئة: طوارئ فورًا.",
      next_question: "أي بطاقة تريد؟",
      quick_choices: ["نصائح يومية", "غسل اليدين والنظافة", "الوقاية من التقلبات", "القائمة الرئيسية"],
    });
  }

  if (route === "facility_navigation") {
    return makeCard({
      title: "🏥 التوجيه داخل المنشأة",
      category: "general",
      verdict:
        "**معلومات دخول وخدمات المنشأة (مختصر وواضح):**\n" +
        "• أحضر بطاقة الشخصية والبطاقة البنكية.\n" +
        "• تأكد من تجديد/دفع الاشتراك السنوي حسب نظام المنشأة.\n" +
        "• أغلب العيادات بالمواعيد، وبعضها يتطلب تحويل.\n" +
        `• واتساب المواعيد: **${WHATSAPP_APPOINTMENTS}**\n\n` +
        "**العيادات الخارجية المتوفرة:** أطفال، جلدية، أنف وأذن وحنجرة، عيون، فاحص بصريات، تغذية، عظام، جراحة، باطنية، أشعة سينية.",
      tips: ["إذا الحالة طارئة قد يمكن الحضور مباشرة حسب سياسة المنشأة."],
      when_to_seek_help: "أعراض خطيرة: طوارئ فورًا.",
      next_question: "تحب ترجع للقائمة الرئيسية؟",
      quick_choices: ["القائمة الرئيسية"],
    });
  }

  if (route === "shifaa_appointments") {
    return makeCard({
      title: "📅 مواعيد شفاء",
      category: "appointments",
      verdict: "اختر بطاقة:",
      tips: ["هذه معلومات عامة داخل التطبيق."],
      when_to_seek_help: "حالة طارئة: الطوارئ أولًا.",
      next_question: "وش تبغى؟",
      quick_choices: ["روابط التحميل", "خطوات حجز موعد", "عن برنامج شفاء", "القائمة الرئيسية"],
    });
  }

  resetFlow(session);
  return menuCard();
}

function continueInstitutionalFlow(session, message) {
  const flow = session.flow;
  const m = String(message || "").trim();

  if (/^(القائمة الرئيسية|رجوع)$/i.test(m)) {
    resetFlow(session);
    METRICS.flows[`${flow}Completed`] = (METRICS.flows[`${flow}Completed`] || 0) + 1;
    return menuCard();
  }

  // bundle: أي اختيار من المسارات يشغّل المسار السريع مباشرة
  if (flow === "lifestyle_bundle") {
    return null; // خلّيه يمر على startMap
  }

  if (flow === "medication_general_guidance") {
    if (["مضاد حيوي", "مسكنات", "مضاد حساسية", "أدوية سعال/زكام"].includes(m)) {
      const map = {
        "مضاد حيوي":
          "المضادات الحيوية لبعض العدوى البكتيرية فقط.\n• لا تفيد غالبًا للزكام/الإنفلونزا.\n• إساءة الاستخدام تزيد المقاومة.\n",
        "مسكنات":
          "المسكنات تخفف الألم/الحمّى حسب الحالة.\n• انتبه للحساسية وأمراض الكبد/الكلى وقرحة المعدة.\n",
        "مضاد حساسية":
          "أدوية الحساسية لأعراض مثل العطاس/الحكة.\n• بعض الأنواع تسبب نعاس.\n• تورم وجه/ضيق نفس: طوارئ.\n",
        "أدوية سعال/زكام":
          "أدوية الزكام غالبًا لتخفيف الأعراض فقط.\n• راحة + سوائل.\n• حرارة عالية مستمرة/ضيق نفس: راجع الطبيب.\n",
      };

      return makeCard({
        title: `💊 إرشاد دوائي عام — ${m}`,
        category: "general",
        verdict: map[m],
        tips: ["بدون جرعات.", "إذا حمل/أطفال/مرض مزمن: استشر مختص."],
        when_to_seek_help: "تورم وجه/ضيق نفس/طفح شديد/إغماء: طوارئ فورًا.",
        next_question: "تبغى بطاقة ثانية؟",
        quick_choices: ["مضاد حيوي", "مسكنات", "مضاد حساسية", "أدوية سعال/زكام", "القائمة الرئيسية"],
      });
    }
    return startInstitutionalFlow(session, "medication_general_guidance");
  }

  if (flow === "prevention_lifestyle") {
    if (m === "نصائح يومية") {
      return makeCard({
        title: "🌿 نصائح يومية",
        category: "general",
        verdict: "خطوات بسيطة لكنها قوية:",
        tips: ["نوم منتظم.", "ماء بانتظام.", "مشي يومي.", "غذاء متوازن.", "قلل الوجبات السريعة والتدخين."],
        when_to_seek_help: "تفاقم واضح/أعراض شديدة: راجع الطبيب.",
        next_question: "تبغى بطاقة ثانية؟",
        quick_choices: ["غسل اليدين والنظافة", "الوقاية من التقلبات", "القائمة الرئيسية"],
      });
    }

    if (m === "غسل اليدين والنظافة") {
      return makeCard({
        title: "🧼 غسل اليدين والنظافة",
        category: "general",
        verdict: "أفضل إجراء وقائي يومي:",
        tips: [
          "قبل الأكل وبعد الحمام وبعد السعال/العطاس.",
          "ماء وصابون وافرك بين الأصابع وتحت الأظافر.",
          "إذا ما توفر ماء: معقم مناسب.",
        ],
        when_to_seek_help: "عدوى جلدية شديدة/تورم/ألم شديد: راجع الطبيب.",
        next_question: "تبغى بطاقة ثانية؟",
        quick_choices: ["نصائح يومية", "الوقاية من التقلبات", "القائمة الرئيسية"],
      });
    }

    if (m === "الوقاية من التقلبات") {
      return makeCard({
        title: "🍃 الوقاية من التقلبات",
        category: "general",
        verdict: "الغبار وتقلب الجو قد يزيد الحساسية/الربو:",
        tips: ["قلل التعرض للغبار.", "نوم جيد.", "سوائل.", "اتبع خطة طبيبك لو عندك ربو."],
        when_to_seek_help: "ضيق نفس شديد/ازرقاق: طوارئ فورًا.",
        next_question: "تبغى بطاقة ثانية؟",
        quick_choices: ["نصائح يومية", "غسل اليدين والنظافة", "القائمة الرئيسية"],
      });
    }

    return startInstitutionalFlow(session, "prevention_lifestyle");
  }

  if (flow === "shifaa_appointments") {
    if (m === "روابط التحميل") {
      return makeCard({
        title: "📅 شفاء — روابط التحميل",
        category: "appointments",
        verdict: "روابط التحميل الرسمية:",
        tips: [`أندرويد: ${SHIFAA_ANDROID}`, `آيفون: ${SHIFAA_IOS}`],
        when_to_seek_help: "حالة طارئة: الطوارئ أولًا.",
        next_question: "تبغى بطاقة ثانية؟",
        quick_choices: ["خطوات حجز موعد", "عن برنامج شفاء", "القائمة الرئيسية"],
      });
    }

    if (m === "خطوات حجز موعد") {
      return makeCard({
        title: "📅 شفاء — طريقة حجز موعد",
        category: "appointments",
        verdict:
          "1) افتح شفاء\n2) المواعيد\n3) حجز موعد\n4) اختر المؤسسة\n5) اختر العيادة المتوفرة\n",
        tips: ["إذا ما عندك التطبيق: ارجع لروابط التحميل."],
        when_to_seek_help: "حالة طارئة: الطوارئ أولًا.",
        next_question: "تبغى بطاقة ثانية؟",
        quick_choices: ["روابط التحميل", "عن برنامج شفاء", "القائمة الرئيسية"],
      });
    }

    if (m === "عن برنامج شفاء") {
      return makeCard({
        title: "📌 عن برنامج شفاء",
        category: "appointments",
        verdict: "شفاء يساعد بإدارة الملف الصحي والمواعيد داخل سلطنة عُمان.",
        tips: [
          "السجلات الطبية، المواعيد، نتائج مختبر (حسب الإتاحة).",
          "أفراد العائلة عادةً < 18.",
        ],
        when_to_seek_help: "إذا أعراض قوية مع نتائج مقلقة: راجع الطبيب/الطوارئ.",
        next_question: "تبغى بطاقة ثانية؟",
        quick_choices: ["روابط التحميل", "خطوات حجز موعد", "القائمة الرئيسية"],
      });
    }

    return startInstitutionalFlow(session, "shifaa_appointments");
  }

  if (flow === "lab_preparation" || flow === "common_conditions_education" || flow === "facility_navigation") {
    // (احتفظنا به بسيط: رجوع للقائمة)
    return startInstitutionalFlow(session, flow);
  }

  return null;
}

/* =========================
   Smart flows (quick paths)
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
      verdict:
        "إرشادات عامة فقط.\n🚨 إذا ألم صدر شديد/ضيق نفس شديد/نزيف شديد/فقدان وعي: طوارئ فورًا.\nاختر الحالة الأقرب:",
      tips: [],
      when_to_seek_help: "فقدان وعي/نزيف شديد/صعوبة تنفس: إسعاف فورًا.",
      next_question: "وش الحالة الأقرب؟",
      quick_choices: ["حروق بسيطة", "جرح/نزيف بسيط", "اختناق", "إغماء", "التواء/كدمة", "القائمة الرئيسية"],
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
        tips: ["إذا تعرفها اكتبها مثل: 120/80 أو اختر: ما أعرف."],
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
      const allowed = new Set(["حروق بسيطة", "جرح/نزيف بسيط", "اختناق", "إغماء", "التواء/كدمة"]);
      if (!allowed.has(m)) return startFlow(session, "first_aid");
      session.profile.scenario = m;
      session.step = 4;
      return null;
    }
  }

  return null;
}

/* =========================
   Deterministic final cards (✅ يمنع التنبيهات المزعجة)
========================= */
function finalizeFlowDeterministic(session) {
  const flow = session.flow;
  const p = session.profile || {};

  if (!flow) return null;

  if (flow === "bp") {
    const reading = p.readingValue ? parseBP(p.readingValue) : null;

    let verdict = "معلومات عامة عن ضغط الدم.\n";
    const tips = [];
    let seek = "إذا ألم صدر/ضيق نفس/إغماء/ضعف مفاجئ: طوارئ فورًا.";

    if (reading?.weird) {
      verdict += `قراءة غير معتادة: ${reading.sys}/${reading.dia}. تأكد من القياس الصحيح وأعد القياس بعد 5 دقائق راحة.`;
      tips.push("قِس بعد راحة 5 دقائق، والذراع بمستوى القلب.");
      tips.push("إذا تكررت قراءة غير طبيعية مع أعراض: راجع طبيب.");
    } else if (reading) {
      const { sys, dia } = reading;

      verdict += `قراءة: ${sys}/${dia} mmHg.\n`;

      if (sys >= 180 || dia >= 120) {
        verdict += "هذه قراءة عالية جدًا (قد تكون أزمة ضغط).";
        seek = "إذا صداع شديد/ألم صدر/ضيق نفس/تشوش رؤية: طوارئ فورًا.";
      } else if (sys >= 140 || dia >= 90) {
        verdict += "هذا ضمن نطاق مرتفع (مرحلة عالية).";
        tips.push("أعد القياس خلال أيام مختلفة وسجّل القراءات.");
        tips.push("قلل الملح والأطعمة المصنعة، واهتم بالمشي والنوم.");
      } else if (sys >= 130 || dia >= 80) {
        verdict += "هذا ضمن نطاق مرتفع (مرحلة 1).";
        tips.push("قلل الملح، وداوم على نشاط منتظم.");
        tips.push("تابع قراءاتك (صباح/مساء) لأسبوع.");
      } else if (sys >= 120 && dia < 80) {
        verdict += "قراءة قريبة من الارتفاع (مرتفع بسيط).";
        tips.push("قلل الملح وراقب الضغط أسبوعيًا.");
      } else if (sys < 90 || dia < 60) {
        verdict += "قد تكون قراءة منخفضة.";
        tips.push("اشرب سوائل كفاية وتجنب الوقوف المفاجئ.");
        tips.push("إذا دوخة شديدة/إغماء: راجع طبيب.");
      } else {
        verdict += "غالبًا ضمن الطبيعي.";
        tips.push("استمر على نمط حياة صحي وقياس دوري.");
      }
    } else {
      verdict += "إذا ما عندك قراءة: تقدر تقيس في المنزل أو الصيدلية وتكتبها هنا مثل 120/80.";
      tips.push("أفضل قياس: بعد راحة 5 دقائق، بدون قهوة/تدخين قبلها 30 دقيقة.");
    }

    const card = makeCard({
      title: "🫀 نتيجة مسار الضغط",
      category: "bp",
      verdict,
      tips,
      when_to_seek_help: seek,
      next_question: "تبغى ترجع للقائمة أو تدخل مسار ثاني؟",
      quick_choices: ["القائمة الرئيسية", "🩸 السكر", "⚖️ BMI", "💧 شرب الماء"],
    });

    METRICS.flows.bpCompleted++;
    resetFlow(session);
    return card;
  }

  if (flow === "sugar") {
    const diagnosed = String(p.diagnosed || "");
    const goal = String(p.goal || "");

    const tips = [];
    let verdict = "معلومات عامة عن سكر الدم ونمط الحياة.\n";
    let seek =
      "إذا أعراض شديدة (دوخة شديدة/إغماء/تشوش شديد/قيء مستمر): راجع الطوارئ.";

    if (/نعم/i.test(diagnosed)) {
      verdict += "بما أنك مُشخّص: المهم المتابعة الطبية + الالتزام بالخطة.\n";
      tips.push("قلل السكريات والمشروبات المحلاة.");
      tips.push("وزّع الكربوهيدرات على اليوم وتجنب الوجبات الكبيرة.");
      tips.push("نشاط يومي مناسب (مشي).");
    } else {
      verdict += "إذا ما في تشخيص: التوازن الغذائي والنشاط يقللان خطر ارتفاع السكر.\n";
      tips.push("اختر كربوهيدرات معقدة (حبوب كاملة) بدل السكر السريع.");
      tips.push("زد الخضار والبروتين في الوجبات.");
    }

    if (/أكل مناسب/i.test(goal)) {
      tips.push("قاعدة سهلة: نصف الطبق خضار، ربع بروتين، ربع كربوهيدرات.");
    } else if (/تقليل الارتفاعات/i.test(goal)) {
      tips.push("امشِ 10–15 دقيقة بعد الوجبة إذا يناسبك.");
      tips.push("تجنب العصائر والمشروبات المحلاة.");
    } else if (/فهم مبسط/i.test(goal)) {
      tips.push("الأكل والنشاط والوزن والنوم يؤثرون على سكر الدم.");
    } else {
      tips.push("سجّل عاداتك أسبوع وحسّن نقطة واحدة كل مرة.");
    }

    const card = makeCard({
      title: "🩸 نتيجة مسار السكر",
      category: "sugar",
      verdict,
      tips,
      when_to_seek_help: seek,
      next_question: "تبغى تكتب قراءة سكر (اختياري)؟",
      quick_choices: ["لا", "أكتب القراءة", "القائمة الرئيسية"],
    });

    METRICS.flows.sugarCompleted++;
    resetFlow(session);
    return card;
  }

  if (flow === "bmi") {
    const bmi = p.bmi;
    const tips = [];
    let verdict = "معلومات عامة عن BMI.\n";
    let seek = "إذا فقدان وزن شديد غير مبرر/أعراض قوية: راجع طبيب.";

    if (bmi) {
      verdict += `BMI التقريبي: ${bmi}\n`;
      if (bmi < 18.5) verdict += "يميل للنحافة.\n";
      else if (bmi < 25) verdict += "ضمن الطبيعي غالبًا.\n";
      else if (bmi < 30) verdict += "زيادة وزن.\n";
      else verdict += "سمنة.\n";

      tips.push("BMI مؤشر عام ولا يراعي الكتلة العضلية.");
      tips.push("الأهم: الأكل المتوازن + نشاط + نوم.");
    } else {
      verdict += "إذا تبغى حساب: اكتب وزن وطول مثل: وزن 70 طول 170.";
      tips.push("أو استخدم المسار مرة ثانية واختر (أحسب).");
    }

    const card = makeCard({
      title: "⚖️ نتيجة مسار BMI",
      category: "bmi",
      verdict,
      tips,
      when_to_seek_help: seek,
      next_question: "تبغى تدخل مسار ثاني؟",
      quick_choices: ["القائمة الرئيسية", "🔥 السعرات", "💧 شرب الماء", "🫀 الضغط"],
    });

    METRICS.flows.bmiCompleted++;
    resetFlow(session);
    return card;
  }

  if (flow === "water") {
    const activity = String(p.activity || "");
    const climate = String(p.climate || "");
    const weight = p.weightKg;

    let verdict = "معلومات عامة عن شرب الماء.\n";
    const tips = [];
    let seek = "إذا دوخة شديدة/جفاف شديد/قلة بول واضحة: راجع طبيب.";

    // تقدير بسيط (غير علاجي)
    let baseLiters = 2.0;
    if (weight && Number.isFinite(weight)) baseLiters = Math.min(4.0, Math.max(1.8, weight * 0.03)); // 30ml/kg
    if (/عالي/i.test(activity)) baseLiters += 0.4;
    if (/حار/i.test(climate)) baseLiters += 0.4;

    verdict += `هدف يومي تقريبي: حوالي ${baseLiters.toFixed(1)} لتر.\n`;

    tips.push("وزّع الماء على اليوم ولا تنتظر العطش.");
    tips.push("راقب لون البول: الأصفر الفاتح غالبًا جيد.");
    tips.push("زد السوائل مع الرياضة/الحرارة.");

    const card = makeCard({
      title: "💧 نتيجة مسار شرب الماء",
      category: "water",
      verdict,
      tips,
      when_to_seek_help: seek,
      next_question: "تبغى خطة بسيطة للتوزيع خلال اليوم؟",
      quick_choices: ["نعم", "لا", "القائمة الرئيسية"],
    });

    METRICS.flows.waterCompleted++;
    resetFlow(session);
    return card;
  }

  if (flow === "calories") {
    const goal = String(p.goal || "");
    const activity = String(p.activity || "");
    const ageGroup = String(p.ageGroup || "");

    const tips = [];
    let verdict = "إرشادات عامة للسعرات والأكل الصحي.\n";
    let seek = "إذا عندك مرض مزمن/حمل/نقص وزن شديد: الأفضل استشارة مختص.";

    verdict += `هدفك: ${goal} | نشاطك: ${activity} | العمر: ${ageGroup}\n`;

    if (/إنقاص/i.test(goal)) {
      tips.push("قلّل المشروبات المحلاة والوجبات السريعة.");
      tips.push("زد البروتين والخضار لتشبع أعلى.");
      tips.push("قلّل حجم الحصص تدريجيًا.");
    } else if (/زيادة/i.test(goal)) {
      tips.push("زد سعرات من مصادر جيدة: مكسرات، لبن، زيت زيتون، بروتين.");
      tips.push("قسّم الأكل لوجبات أكثر بدل وجبة ضخمة.");
    } else if (/تثبيت/i.test(goal)) {
      tips.push("حافظ على ثبات الوجبات والنشاط.");
    } else {
      tips.push("قاعدة سهلة: نصف الطبق خضار، ربع بروتين، ربع كربوهيدرات.");
      tips.push("ركز على أكل أقل معالجة.");
    }

    tips.push("نوم أقل يرفع الشهية عند كثير من الناس.");
    tips.push("ابدأ بتغيير واحد أسبوعيًا عشان يثبت.");

    const card = makeCard({
      title: "🔥 نتيجة مسار السعرات",
      category: "calories",
      verdict,
      tips,
      when_to_seek_help: seek,
      next_question: "كم وجبة تتناول عادةً في اليوم؟ (اختياري)",
      quick_choices: ["2", "3", "4+", "القائمة الرئيسية"],
    });

    METRICS.flows.caloriesCompleted++;
    resetFlow(session);
    return card;
  }

  if (flow === "mental") {
    const mood = String(p.mood || "");
    const sleep = String(p.sleep || "");
    const feeling = String(p.feeling || "");

    const tips = [];
    let verdict = "معلومات عامة لدعم المزاج (غير علاجي).\n";
    let seek = "إذا أفكار إيذاء النفس/انتحار: طوارئ فورًا أو تواصل مع مختص حالًا.";

    verdict += `مزاجك: ${mood} | نومك: ${sleep} | شعور مزعج: ${feeling}\n`;

    tips.push("نوم منتظم قدر الإمكان.");
    tips.push("مشي خفيف يوميًا حتى لو 10 دقائق.");
    tips.push("قلل كافيين آخر اليوم.");
    tips.push("اكتب 3 أشياء صغيرة تُنجزها اليوم (واقعية).");

    const card = makeCard({
      title: "🧠 نتيجة مسار المزاج",
      category: "mental",
      verdict,
      tips,
      when_to_seek_help: seek,
      next_question: "تبغى تمارين تنفس بسيطة 60 ثانية؟",
      quick_choices: ["نعم", "لا", "القائمة الرئيسية"],
    });

    METRICS.flows.mentalCompleted++;
    resetFlow(session);
    return card;
  }

  if (flow === "first_aid") {
    const s = String(p.scenario || "");
    let verdict = "إرشاد عام.\n";
    const tips = [];
    let seek = "ألم صدر/ضيق نفس/نزيف شديد/فقدان وعي: طوارئ فورًا.";

    if (s === "حروق بسيطة") {
      verdict = "حروق بسيطة: برّد المكان بماء جارٍ فاتر 10–20 دقيقة، وغطّه بضماد نظيف.";
      tips.push("لا تضع معجون/زيوت على الحرق.");
      tips.push("راجع طبيب إذا الحرق كبير/عميق/على الوجه أو الأعضاء الحساسة.");
    } else if (s === "جرح/نزيف بسيط") {
      verdict = "جرح بسيط: اضغط بضماد نظيف عدة دقائق، ثم نظف بلطف وغطّه.";
      tips.push("راجع طبيب إذا نزيف ما يوقف أو الجرح عميق.");
    } else if (s === "اختناق") {
      verdict = "اختناق: إذا ما يقدر يتكلم/يتنفس: اطلب إسعاف فورًا واتبع الإسعافات المعروفة (Heimlich) إن كنت مدربًا.";
      tips.push("إذا فقد وعيه: إسعاف + إنعاش حسب التدريب.");
    } else if (s === "إغماء") {
      verdict = "إغماء: مدد الشخص وارفع قدميه قليلًا، وتأكد من التنفس، واطلب إسعاف إذا طول أو تكرر.";
      tips.push("لا تعطه شيء يشربه وهو فاقد وعي.");
    } else if (s === "التواء/كدمة") {
      verdict = "التواء/كدمة: راحة + ثلج 10–15 دقيقة + رباط ضاغط خفيف + رفع الطرف.";
      tips.push("راجع طبيب إذا ألم شديد/تورم كبير/عدم قدرة على الحركة.");
    }

    const card = makeCard({
      title: "🩹 نتيجة مسار الإسعافات",
      category: "general",
      verdict,
      tips,
      when_to_seek_help: seek,
      next_question: "تبغى ترجع للقائمة؟",
      quick_choices: ["القائمة الرئيسية"],
    });

    METRICS.flows.first_aidCompleted++;
    resetFlow(session);
    return card;
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
      enum: ["general", "emergency", "appointments", "report", "mental", "bmi", "bp", "sugar", "water", "calories"],
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
    "ممنوع: التشخيص، وصف الأدوية، الجرعات.\n" +
    "مهم جدًا: لا تُظهر تنبيه (لا أقدر أوصف أدوية) إلا إذا سأل المستخدم عن دواء/جرعة/علاج.\n" +
    "اكتب بالعربية وبشكل عملي ومختصر.\n" +
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
   Safety post-filter (✅ صارت غير مزعجة)
   - التنبيه الدوائي فقط إذا المستخدم طلب أدوية/جرعات فعليًا
========================= */
function postFilterCard(card, userMessage) {
  if (!card) return card;

  // إذا المستخدم ما سأل عن دواء/جرعة -> لا تطلع تنبيه دوائي أبدًا
  if (!hasMedicationIntent(userMessage)) return card;

  const combined =
    (card?.verdict || "") +
    "\n" +
    (Array.isArray(card?.tips) ? card.tips.join("\n") : "") +
    "\n" +
    (card?.when_to_seek_help || "");

  const hasMedContext =
    /(دواء|ادويه|حبوب|قرص|كبسول|كبسولة|شراب|بخاخ|انسولين|مضاد|مسكن|antibiotic|metformin|ibuprofen|paracetamol)/i.test(
      combined
    );

  const hasDoseUnit =
    /(\b\d{1,4}\b)\s*(mg|ملغ|mcg|µg|g|جرام|مل|ml|cc)\b/i.test(combined);

  const hasDailyFrequency =
    /(مرة|مرتين|ثلاث|4)\s*(يوميا|يوميًا|في اليوم)/i.test(combined);

  const hasDirectPrescriptionVerb =
    /(خذ|خذي|تناول|تناولي|استخدم|استخدمي|ابدأ|ابدا)\s+/i.test(combined) && hasMedContext;

  if (hasMedContext && (hasDoseUnit || hasDailyFrequency || hasDirectPrescriptionVerb)) {
    return makeCard({
      title: "تنبيه",
      category: card?.category || "general",
      verdict:
        "أنا للتثقيف الصحي فقط. ما أقدر أوصف أدوية أو جرعات.\n" +
        "إذا سؤالك علاجي/دوائي، راجع طبيب/صيدلي.",
      tips: ["اكتب للطبيب الأعراض ومدة المشكلة والأدوية الحالية.", "إذا أعراض شديدة: طوارئ."],
      when_to_seek_help: "ألم صدر/ضيق نفس/إغماء/نزيف شديد: طوارئ فورًا.",
      next_question: "هل تريد معلومات تثقيفية عامة بدل العلاج؟",
      quick_choices: ["نعم", "لا", "القائمة الرئيسية"],
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

  // Dedup
  const now = Date.now();
  if (session.lastInText === message && now - (session.lastInAt || 0) < 900) {
    const fallback = session.lastCard || menuCard();
    return res.json({ ok: true, data: fallback, dedup: true });
  }
  session.lastInText = message;
  session.lastInAt = now;

  // ========= Institutional routing from app meta.route =========
  const route = String(req.body?.meta?.route || "").trim();
  if (route) {
    const institutionalRoutes = new Set([
      "medication_general_guidance",
      "lab_preparation",
      "common_conditions_education",
      "prevention_lifestyle",
      "facility_navigation",
      "shifaa_appointments",
      "lifestyle_bundle", // NEW
    ]);

    if (institutionalRoutes.has(route)) {
      const card = startInstitutionalFlow(session, route);
      session.lastCard = card;
      bumpCategory(card.category);
      METRICS.chatOk++;
      updateAvgLatency(Date.now() - t0);
      return res.json({ ok: true, data: card });
    }
  }

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

  // إلغاء/مسح
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
      verdict: "الأعراض المذكورة قد تكون خطيرة.\nيُنصح بالتوجه لأقرب طوارئ أو الاتصال بالإسعاف فورًا.",
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

  // مواعيد (كتابة حرة)
  if (looksLikeAppointments(message)) {
    const card = startInstitutionalFlow(session, "shifaa_appointments");
    session.lastCard = card;
    bumpCategory("appointments");
    METRICS.chatOk++;
    updateAvgLatency(Date.now() - t0);
    return res.json({ ok: true, data: card });
  }

  // نمط الحياة والوقاية (كتابة)
  if (/نمط\s*الحياه|نمط\s*الحياة|الوقايه|الوقاية/i.test(message) && message.length <= 30) {
    const card = startInstitutionalFlow(session, "lifestyle_bundle");
    session.lastCard = card;
    bumpCategory("general");
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
      quick_choices: ["📎 إضافة مرفق", "إلغاء", "القائمة الرئيسية"],
    });
    session.lastCard = card;
    bumpCategory("report");
    METRICS.chatOk++;
    updateAvgLatency(Date.now() - t0);
    return res.json({ ok: true, data: card });
  }

  const inferred = inferCategoryFromMessage(message);

  // 1) institutional flows
  if (
    session.flow &&
    [
      "medication_general_guidance",
      "lab_preparation",
      "common_conditions_education",
      "prevention_lifestyle",
      "facility_navigation",
      "shifaa_appointments",
      "lifestyle_bundle",
    ].includes(session.flow)
  ) {
    const card = continueInstitutionalFlow(session, message);
    if (card) {
      session.lastCard = card;
      bumpCategory(card.category);
      METRICS.chatOk++;
      updateAvgLatency(Date.now() - t0);
      return res.json({ ok: true, data: card });
    }
  }

  // 2) existing smart flows (steps 1-3)
  if (session.flow && session.step > 0 && session.step < 4) {
    const card = continueFlow(session, message);
    if (card) {
      session.lastCard = card;
      METRICS.chatOk++;
      updateAvgLatency(Date.now() - t0);
      return res.json({ ok: true, data: card });
    }
  }

  // بدء المسارات (من الأزرار/النص)
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
    const short = message.length <= 50;
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

  // ✅ إذا خلّص مسار سريع (step 4) -> بطاقة ثابتة (بدون LLM)
  if (session.flow && session.step === 4) {
    const finalCard = finalizeFlowDeterministic(session);
    if (finalCard) {
      session.lastCard = finalCard;
      bumpCategory(finalCard.category);
      METRICS.chatOk++;
      updateAvgLatency(Date.now() - t0);
      return res.json({ ok: true, data: finalCard });
    }
  }

  // Bare yes/no بدون سؤال سابق
  if (!session.flow && isBareYesNo(message) && !session.lastCard?.next_question) {
    const card = makeCard({
      title: "توضيح سريع",
      category: inferred || "general",
      verdict: "اكتب سؤالك بجملة واضحة أو اختر مسار من القائمة.",
      tips: ["مثال: (عندي صداع من يومين) أو (قراءة الضغط 130/85)."],
      when_to_seek_help: "إذا أعراض طارئة: طوارئ فورًا.",
      next_question: "وش تبغى تسأل؟",
      quick_choices: menuCard().quick_choices,
    });
    session.lastCard = card;
    METRICS.chatOk++;
    updateAvgLatency(Date.now() - t0);
    return res.json({ ok: true, data: card });
  }

  // رسالة غامضة
  if (isTooVague(message, session)) {
    const card = makeCard({
      title: "توضيح سريع",
      category: inferred || "general",
      verdict: "أقدر أساعدك، بس اكتب تفاصيل بسيطة عشان ما أعطيك رد عام.",
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

  // ====== LLM fallback (فقط للأسئلة الحرة) ======
  session.history.push({ role: "user", content: message });
  session.history = trimHistory(session.history, 10);

  const last = req.body?.context?.last || session.lastCard || null;
  const lastStr = last ? clampText(JSON.stringify(last), 1200) : "";
  const msgStr = clampText(message, 1200);

  const historyStr = clampText(
    session.history
      .slice(-6)
      .map((x) => `${x.role === "user" ? "المستخدم" : "المساعد"}: ${x.content}`)
      .join("\n"),
    1800
  );

  const userPrompt =
    (historyStr ? `سياق المحادثة:\n${historyStr}\n\n` : "") +
    (last ? `سياق آخر بطاقة:\n${lastStr}\n\n` : "") +
    `سؤال المستخدم:\n${msgStr}\n\n` +
    "مهم: لا تذكر تنبيه الأدوية إلا إذا سأل المستخدم عن دواء/جرعة.\n" +
    "قدّم نصائح عامة عملية + متى يراجع الطبيب/الطوارئ.\n";

  try {
    const obj = await callGroqJSON({
      system: chatSystemPrompt(),
      user: userPrompt,
      maxTokens: 1200,
    });

    const card = makeCard({ ...obj, category: obj?.category || inferred || "general" });
    const safeCard = postFilterCard(card, message);

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
          message: "هذا PDF ممسوح ولا يحتوي نص قابل للنسخ. ارفع صورة واضحة للتقرير أو الصق النص.",
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

    const card = postFilterCard(makeCard({ ...obj, category: "report" }), "تقرير");
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
