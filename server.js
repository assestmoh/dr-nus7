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

function trimHistory(history, max = 6) {
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
  return t.slice(0, maxChars) + "\n...[تم قص النص]";
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

function isMedicationRequest(text) {
  const t = String(text || "");
  return /(دواء|ادوية|أدوية|حبوب|علاج|جرعة|جرعات|مضاد|مسكن|انسولين|metformin|ibuprofen|paracetamol|panadol|augmentin|amoxicillin|insulin)/i.test(
    t
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

function makeCard({ title, category, verdict, tips, when_to_seek_help, next_question, quick_choices }) {
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
    verdict: "للحجز وإدارة المواعيد في عُمان استخدم تطبيق شفاء الرسمي:",
    tips: [`أندرويد: ${SHIFAA_ANDROID}`, `آيفون: ${SHIFAA_IOS}`],
    when_to_seek_help: "إذا أعراض طارئة/شديدة: الطوارئ فورًا.",
    next_question: "تبي خطوات الحجز داخل التطبيق؟",
    quick_choices: ["نعم", "لا"],
  });
}

function medsPolicyCard() {
  return makeCard({
    title: "تنبيه",
    category: "general",
    verdict: "أنا للتثقيف الصحي فقط. ما أقدر أقترح أدوية أو جرعات.",
    tips: ["أقدر أعطيك بدائل نمط حياة وخطوات عامة.", "إذا الحالة مستمرة/تسوء: راجع طبيب/مركز صحي."],
    when_to_seek_help: "ألم صدر/ضيق نفس/إغماء/نزيف شديد/ضعف مفاجئ: طوارئ فورًا.",
    next_question: "تبي نصائح نمط حياة؟",
    quick_choices: ["نعم", "لا"],
  });
}

/* =========================
   Flow engine (keep structure, but balanced)
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
      title: "🩸 مسار السكر",
      category: "sugar",
      verdict: "اختر فئتك العمرية (للتنبيه العام فقط):",
      tips: [],
      when_to_seek_help: "",
      next_question: "",
      quick_choices: commonAge,
    });
  }

  if (flowKey === "bp") {
    return makeCard({
      title: "🫀 مسار الضغط",
      category: "bp",
      verdict: "اختر فئتك العمرية (للتنبيه العام فقط):",
      tips: [],
      when_to_seek_help: "",
      next_question: "",
      quick_choices: commonAge,
    });
  }

  if (flowKey === "bmi") {
    return makeCard({
      title: "⚖️ مسار BMI",
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
      title: "💧 مسار شرب الماء",
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
      title: "🔥 مسار السعرات",
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
      title: "🧠 مسار المزاج",
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
      title: "🩹 إسعافات أولية",
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
  const w2 = t.match(/وزن\s*[:=]?\s*(\d{2,3})/i);
  const h2 = t.match(/طول\s*[:=]?\s*(\d{2,3})/i);
  const w = t.match(/(\d{2,3})\s*(kg|كجم|كغ|كيلو|كيلوجرام)?/i);
  const h = t.match(/(\d{2,3})\s*(cm|سم|سنتيمتر)?/i);

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
        title: "🩸 مسار السكر",
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
        title: "🩸 مسار السكر",
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
        title: "🫀 مسار الضغط",
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
        title: "🫀 مسار الضغط",
        category: "bp",
        verdict: "هل لديك قراءة ضغط الآن/مؤخرًا؟ (اختياري)",
        tips: ["اكتبها مثل: 120/80 أو اختر: ما أعرف."],
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
        title: "🫀 مسار الضغط",
        category: "bp",
        verdict: "اكتب القراءة مثل: 120/80",
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
        title: "⚖️ مسار BMI",
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
        title: "⚖️ مسار BMI",
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
        title: "⚖️ مسار BMI",
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
        title: "💧 مسار شرب الماء",
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
        title: "💧 مسار شرب الماء",
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
        title: "🔥 مسار السعرات",
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
        title: "🔥 مسار السعرات",
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
        title: "🧠 مسار المزاج",
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
        title: "🧠 مسار المزاج",
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
   Deterministic responders (short, safe)
========================= */
function deterministicFlowCard(flow, profile) {
  // verdict 2-4 lines, tips 3-6 max
  if (flow === "sugar") {
    const age = profile?.ageGroup || "";
    const diagnosed = profile?.diagnosed || "";
    const goal = profile?.goal || "";

    const extraAgeLine =
      /أقل من 18/.test(age) ? "تنبيه: لمن هم أقل من 18، الأفضل وجود ولي أمر/طبيب." : "";
    const dxLine = /نعم/i.test(diagnosed)
      ? "ملاحظة: هذا تثقيف عام، والمتابعة الطبية مهمة."
      : /غير/i.test(diagnosed)
      ? "غير واضح من البيانات هل لديك سكري مُشخّص."
      : "";

    if (goal === "فهم مبسط") {
      return makeCard({
        title: "🩸 مسار السكر",
        category: "sugar",
        verdict: ["شرح عام للسكر.", dxLine || extraAgeLine].filter(Boolean).slice(0, 2).join("\n"),
        tips: [
          "الأطعمة السكرية/العصائر ترفع السكر بسرعة.",
          "الألياف + البروتين تبطّئ الارتفاع.",
          "مشي 5–10 دقائق بعد الأكل يساعد.",
        ],
        when_to_seek_help: "إذا سكر مرتفع جدًا مع عطش شديد/تبوّل كثير/غثيان/تشوش: راجع الطوارئ.",
        next_question: "تبي نصائح للأكل أو لتقليل الارتفاعات؟",
        quick_choices: ["أكل مناسب", "تقليل الارتفاعات", "القائمة"],
      });
    }

    if (goal === "أكل مناسب") {
      return makeCard({
        title: "🩸 مسار السكر",
        category: "sugar",
        verdict: ["خطة أكل مبسطة.", dxLine || extraAgeLine].filter(Boolean).slice(0, 2).join("\n"),
        tips: [
          "نصف الصحن خضار + ربع بروتين + ربع نشويات.",
          "بدّل العصير بفواكه كاملة.",
          "خفّف السكر المضاف والمشروبات المحلاة.",
          "اختر نشويات أبطأ: شوفان/بر/بقول.",
        ].slice(0, 6),
        when_to_seek_help: "دوخة شديدة/تعرّق ورجفة مع جوع مفاجئ: راجع طبيب (قد يكون هبوط).",
        next_question: "تبي أمثلة وجبات؟",
        quick_choices: ["نعم", "لا", "القائمة"],
      });
    }

    if (goal === "تقليل الارتفاعات") {
      return makeCard({
        title: "🩸 مسار السكر",
        category: "sugar",
        verdict: ["تقليل الارتفاع بعد الأكل.", dxLine || extraAgeLine].filter(Boolean).slice(0, 2).join("\n"),
        tips: [
          "قسّم النشويات (كمية أقل بدل دفعة كبيرة).",
          "ابدأ بالسلطة/الخضار قبل النشويات.",
          "أضف بروتين مع الوجبة.",
          "مشي خفيف 5–10 دقائق بعد الأكل.",
        ],
        when_to_seek_help: "ارتفاعات متكررة جدًا مع أعراض قوية: راجع الطبيب.",
        next_question: "وش أكثر شيء يرفع السكر عندك؟",
        quick_choices: ["رز/خبز", "حلويات", "عصائر", "غير واضح", "القائمة"],
      });
    }

    // متابعة عامة -> اترك للـ LLM فقط إذا السؤال مفتوح
    return null;
  }

  if (flow === "bp") {
    const age = profile?.ageGroup || "";
    const diagnosed = profile?.diagnosed || "";
    const reading = profile?.readingValue || "";
    const hasReading = !!reading && /\d{2,3}\s*\/\s*\d{2,3}/.test(reading);

    const ageNote = /60\+/.test(age) ? "تنبيه: لكبار السن، القياس الصحيح والمتابعة مهمة." : "";
    const dxNote = /غير/i.test(diagnosed) ? "غير واضح من البيانات هل لديك ضغط مُشخّص." : "";

    if (hasReading) {
      return makeCard({
        title: "🫀 مسار الضغط",
        category: "bp",
        verdict: `قراءة مذكورة: ${reading}\n(تفسير دقيق يحتاج طبيب/سياق)`,
        tips: ["قِس وأنت جالس 5 دقائق.", "خذ قياسين وخذ المتوسط.", "قلّل الملح والوجبات السريعة."],
        when_to_seek_help: "ألم صدر/ضيق نفس/ضعف مفاجئ/صداع شديد جدًا مع زغللة: طوارئ.",
        next_question: "تبي خطوات تحسين نمط الحياة للضغط؟",
        quick_choices: ["نعم", "لا", "القائمة"],
      });
    }

    return makeCard({
      title: "🫀 مسار الضغط",
      category: "bp",
      verdict: ["نصائح عامة لتخفيف ارتفاع الضغط.", ageNote || dxNote].filter(Boolean).slice(0, 2).join("\n"),
      tips: ["خفّف الملح.", "نظّم النوم.", "مشي بسيط يوميًا (حتى 10 دقائق).", "قلّل المنبهات إذا ترفع الضغط عندك."],
      when_to_seek_help: "أعراض خطيرة: طوارئ فورًا.",
      next_question: "هل عندك قراءة ضغط الآن؟",
      quick_choices: ["أكتب القراءة", "ما أعرف", "القائمة"],
    });
  }

  if (flow === "bmi") {
    if (profile?.calc === "yes" && profile?.bmi) {
      const bmi = profile.bmi;
      let label = "غير واضح";
      if (bmi < 18.5) label = "أقل من الطبيعي";
      else if (bmi < 25) label = "طبيعي تقريبًا";
      else if (bmi < 30) label = "زيادة وزن";
      else label = "سمنة";

      return makeCard({
        title: "⚖️ BMI",
        category: "bmi",
        verdict: `BMI = ${bmi}\n(${label})`,
        tips: ["هذا مؤشر عام، ليس تشخيص.", "الأهم: قياس الخصر + النشاط + نوع الأكل."],
        when_to_seek_help: "نزول/زيادة وزن شديد غير مفسر أو تعب شديد: راجع الطبيب.",
        next_question: "تبي خطة بسيطة حسب هدفك؟",
        quick_choices: ["إنقاص وزن", "زيادة وزن", "القائمة"],
      });
    }

    // إذا بدون حساب: نصائح عامة مختصرة
    if (profile?.calc === "no") {
      return makeCard({
        title: "⚖️ BMI",
        category: "bmi",
        verdict: "تمام. بدون حساب BMI.",
        tips: ["إذا تبغى لاحقًا: اكتب وزن وطول (مثال: وزن 70 طول 170)."],
        when_to_seek_help: "",
        next_question: "تبي نصائح حسب هدفك؟",
        quick_choices: ["إنقاص وزن", "زيادة وزن", "القائمة"],
      });
    }

    return null;
  }

  if (flow === "water") {
    const act = profile?.activity || "";
    const climate = profile?.climate || "";
    const w = profile?.weightKg || null;

    // قاعدة تقريبية بدون أرقام طبية حادة: نستخدم نطاقات + "غير واضح" عند نقص البيانات
    const base =
      /عالي/i.test(act) || /رياضة/i.test(act)
        ? "ابدأ بزيادة الشرب تدريجيًا خلال اليوم."
        : /متوسط/i.test(act)
        ? "حافظ على شرب منتظم طوال اليوم."
        : "ابدأ بأكواب موزعة على اليوم.";

    const hot = /حار/i.test(climate) ? "مع الجو الحار: زِد الماء تدريجيًا وراقب العطش." : "";
    const wt = w ? `وزنك مذكور (${w} كجم): استخدمه فقط كتقدير عام.` : "وزنك غير واضح من البيانات.";

    return makeCard({
      title: "💧 شرب الماء",
      category: "water",
      verdict: [base, hot].filter(Boolean).slice(0, 2).join("\n"),
      tips: ["قسّم الشرب على اليوم.", "قلّل المشروبات المحلاة.", "لو بولك داكن دائمًا: قد تحتاج ماء أكثر."],
      when_to_seek_help: "إذا لديك فشل كلوي/قصور قلب/تقييد سوائل: اسأل طبيب قبل زيادة الماء.",
      next_question: wt,
      quick_choices: ["القائمة"],
    });
  }

  if (flow === "calories") {
    const goal = profile?.goal || "";
    const activity = profile?.activity || "";
    const age = profile?.ageGroup || "";

    const meta = [goal ? `الهدف: ${goal}` : "", activity ? `النشاط: ${activity}` : "", age ? `العمر: ${age}` : ""]
      .filter(Boolean)
      .slice(0, 2)
      .join(" | ");

    if (/إنقاص/i.test(goal)) {
      return makeCard({
        title: "🔥 السعرات",
        category: "calories",
        verdict: `خطوات لإنقاص الوزن.\n${meta}`,
        tips: ["ابدأ بالمشروبات: قلّل المحلى.", "ثبّت بروتين بكل وجبة.", "خفّف المقليات والوجبات السريعة.", "مشي 10 دقائق يوميًا كبداية."],
        when_to_seek_help: "نزول وزن سريع جدًا/تعب شديد: راجع الطبيب.",
        next_question: "تبي بدائل وجبات سهلة؟",
        quick_choices: ["نعم", "لا", "القائمة"],
      });
    }

    if (/زيادة/i.test(goal)) {
      return makeCard({
        title: "🔥 السعرات",
        category: "calories",
        verdict: `زيادة وزن بشكل صحي.\n${meta}`,
        tips: ["زِد وجبات خفيفة صحية.", "ارفع البروتين تدريجيًا.", "أضف كربوهيدرات مفيدة بكمية محسوبة."],
        when_to_seek_help: "فقدان شهية شديد/نزول وزن غير مفسر: راجع الطبيب.",
        next_question: "تبي مثال يوم كامل؟",
        quick_choices: ["نعم", "لا", "القائمة"],
      });
    }

    return makeCard({
      title: "🔥 السعرات",
      category: "calories",
      verdict: `تحسين أكل صحي.\n${meta}`,
      tips: ["نصف الصحن خضار.", "خفّف السكر المضاف.", "اختر بروتين مشبع.", "راقب الوجبات الخفيفة."],
      when_to_seek_help: "",
      next_question: "تبي أمثلة أكل؟",
      quick_choices: ["نعم", "لا", "القائمة"],
    });
  }

  if (flow === "mental") {
    const mood = profile?.mood || "";
    const sleep = profile?.sleep || "";
    const feeling = profile?.feeling || "";
    const meta = [mood && `مزاج: ${mood}`, sleep && `نوم: ${sleep}`].filter(Boolean).slice(0, 2).join(" | ");

    if (/سيئ|متعب/i.test(mood) || /أرق/i.test(sleep) || /قلق|توتر|حزن/i.test(feeling)) {
      return makeCard({
        title: "🧠 المزاج",
        category: "mental",
        verdict: `خطوات بسيطة لتخفيف الضغط.\n${meta}`,
        tips: ["تنفس 4-6 لمدة 3 دقائق.", "قلّل كافيين بعد العصر.", "مشي خفيف 10 دقائق.", "اكتب أفكارك قبل النوم."],
        when_to_seek_help: "إذا أفكار إيذاء النفس/انتحار: طوارئ فورًا.",
        next_question: "تبي خطوات للنوم؟",
        quick_choices: ["نعم", "لا", "القائمة"],
      });
    }

    return makeCard({
      title: "🧠 المزاج",
      category: "mental",
      verdict: `نصائح عامة.\n${meta}`,
      tips: ["نوم منتظم.", "أكل منتظم.", "حركة بسيطة يوميًا."],
      when_to_seek_help: "إذا تدهور شديد أو أفكار إيذاء النفس: طوارئ.",
      next_question: "وش أكثر شيء مزعج؟",
      quick_choices: ["قلق", "توتر", "حزن", "أرق", "القائمة"],
    });
  }

  if (flow === "first_aid") {
    const s = profile?.scenario || "";
    if (/حروق/i.test(s)) {
      return makeCard({
        title: "🩹 إسعافات: حروق بسيطة",
        category: "general",
        verdict: "خطوات أولية للحروق البسيطة:",
        tips: ["تبريد 10–20 دقيقة بماء فاتر/بارد.", "لا تفقع الفقاعات.", "غطِّ بضماد نظيف غير لاصق."],
        when_to_seek_help: "حرق كبير/بالوجه/ألم شديد جدًا: طوارئ.",
        next_question: "الحرق في أي مكان؟",
        quick_choices: ["يد", "قدم", "وجه", "مكان آخر", "القائمة"],
      });
    }
    if (/جرح|نزيف/i.test(s)) {
      return makeCard({
        title: "🩹 إسعافات: جرح/نزيف بسيط",
        category: "general",
        verdict: "إيقاف نزيف بسيط:",
        tips: ["ضغط مباشر 10 دقائق.", "رفع العضو المصاب إن أمكن.", "تضميد بقطعة نظيفة."],
        when_to_seek_help: "نزيف لا يتوقف/جرح عميق: طوارئ/مركز صحي.",
        next_question: "هل النزيف مستمر؟",
        quick_choices: ["نعم", "لا", "القائمة"],
      });
    }
    return null; // حالات أخرى ممكن تروح لـ LLM أو منيو
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
  // ✅ أقصر + يفرض "غير واضح من البيانات" بدل التخمين + يمنع الأدوية بشكل صريح
  return (
    "مثقف صحي عربي. لا تشخيص. لا أدوية/جرعات/أسماء أدوية.\n" +
    "إذا معلومة غير موجودة: قل 'غير واضح من البيانات' أو 'لا أعلم'.\n" +
    "اجعل verdict 2-4 أسطر، tips 3-6 نقاط.\n" +
    "أخرج JSON فقط وفق المفاتيح المحددة.\n"
  );
}

function reportSystemPrompt() {
  return (
    "اشرح تقرير/تحاليل بالعربية بشكل عام فقط.\n" +
    "لا تشخيص. لا أدوية/جرعات/أسماء أدوية.\n" +
    "إذا غير مذكور: قل 'غير واضح من البيانات'.\n" +
    "verdict قصير + tips 3-6.\n" +
    "أخرج JSON فقط.\n"
  );
}

async function callGroqJSON({ system, user, maxTokens = 420 }) {
  if (!GROQ_API_KEY) throw new Error("Missing GROQ_API_KEY");

  const url = "https://api.groq.com/openai/v1/chat/completions";
  const body = {
    model: GROQ_MODEL,
    temperature: 0, // ✅ ثبات أعلى
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
      await sleep(900 + attempt * 600);
      continue;
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Groq API error: ${res.status} ${JSON.stringify(data)}`);

    const text = data?.choices?.[0]?.message?.content || "";
    const parsed = safeJsonParse(text);
    if (parsed) return parsed;

    await sleep(250);
  }

  throw new Error("Groq returned invalid JSON repeatedly");
}

/* =========================
   Safety post-filter (stronger)
========================= */
function postFilterCard(card) {
  // ✅ أقوى: يمنع أي تسريب أدوية/جرعات/خطة علاج حتى لو تلميح
  const bad =
    /(جرعة|جرعات|خذ|خذي|تناول|تناولي|حبوب|دواء|أدوية|علاج|انسولين|metformin|ibuprofen|paracetamol|panadol|augmentin|amoxicillin|antibiotic|مضاد حيوي|مسكن|فيتامين)\b/i;

  const combined =
    (card?.verdict || "") +
    "\n" +
    (Array.isArray(card?.tips) ? card.tips.join("\n") : "") +
    "\n" +
    (card?.when_to_seek_help || "") +
    "\n" +
    (card?.next_question || "") +
    "\n" +
    (Array.isArray(card?.quick_choices) ? card.quick_choices.join(" | ") : "");

  if (bad.test(combined)) return medsPolicyCard();

  // ✅ حد أقصى للشكل المطلوب
  const c = makeCard(card || {});
  c.verdict = clampText(c.verdict, 360);
  c.tips = (Array.isArray(c.tips) ? c.tips : []).map((x) => clampText(x, 140)).slice(0, 6);
  c.quick_choices = (Array.isArray(c.quick_choices) ? c.quick_choices : []).slice(0, 8);
  c.next_question = clampText(c.next_question, 120);
  c.when_to_seek_help = clampText(c.when_to_seek_help, 220);
  return c;
}

function summarizeLastCard(last) {
  if (!last) return "";
  const obj = {
    title: last.title,
    category: last.category,
    next_question: last.next_question,
    // لا نرسل tips كاملة لتوفير توكنز
    choices: Array.isArray(last.quick_choices) ? last.quick_choices.slice(0, 4) : [],
  };
  return JSON.stringify(obj);
}

function profileSummary(profile) {
  if (!profile || typeof profile !== "object") return "";
  // نرسل فقط مفاتيح قليلة ثابتة
  const allow = ["ageGroup", "diagnosed", "goal", "readingValue", "bmi", "activity", "climate", "weightKg", "mood", "sleep", "feeling", "scenario"];
  const out = {};
  for (const k of allow) if (profile[k] !== undefined && profile[k] !== null && profile[k] !== "") out[k] = profile[k];
  const s = JSON.stringify(out);
  return s === "{}" ? "" : s;
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

  // “مسح/إلغاء”
  if (/^(إلغاء|الغاء|cancel|مسح|مسح المحادثة|ابدأ من جديد|ابدأ جديد)$/i.test(message)) {
    resetFlow(session);
    const card = menuCard();
    session.lastCard = card;
    METRICS.chatOk++;
    updateAvgLatency(Date.now() - t0);
    return res.json({ ok: true, data: card });
  }

  // طلب أدوية -> سياسة فورية (بدون LLM)
  if (isMedicationRequest(message)) {
    const card = medsPolicyCard();
    session.lastCard = card;
    bumpCategory("general");
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
      verdict: "الأعراض قد تكون خطيرة.\nتوجّه للطوارئ/اتصل بالإسعاف الآن.",
      tips: ["لا تنتظر.", "إذا معك شخص اطلب مساعدته."],
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

  // مواعيد شفاء (ثابت)
  if (looksLikeAppointments(message)) {
    const card = appointmentsCard();
    session.lastCard = card;
    bumpCategory("appointments");
    METRICS.chatOk++;
    updateAvgLatency(Date.now() - t0);
    return res.json({ ok: true, data: card });
  }

  // ✅ زر/كلمة "افهم تقريرك" -> action بدون Card
  if (/افهم\s*تقريرك|^تقرير$|^تحاليل$|^تحليل$/i.test(message) || (/افهم\s*تقريرك|تقرير|تحاليل/i.test(message) && message.length <= 30)) {
    bumpCategory("report");
    METRICS.chatOk++;
    updateAvgLatency(Date.now() - t0);
    return res.json({
      ok: true,
      action: "request_attachment",
      kind: "report",
      message: "ارفع PDF أو صورة للتقرير.",
    });
  }

  // بدء مسار من المنيو/كلمات قصيرة
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

  // متابعة مسار (سؤال/اختيار)
  if (session.flow && session.step > 0 && session.step < 4) {
    const card = continueFlow(session, message);
    if (card) {
      session.lastCard = card;
      METRICS.chatOk++;
      updateAvgLatency(Date.now() - t0);
      return res.json({ ok: true, data: card });
    }
    // null => step=4 جاهز
  }

  // ✅ عند step=4: جرّب deterministic أولاً (حتمي) ثم LLM فقط إذا لزم
  if (session.flow && session.step === 4) {
    const det = deterministicFlowCard(session.flow, session.profile);
    if (det) {
      const safe = postFilterCard(det);
      session.lastCard = safe;
      bumpCategory(safe.category);
      METRICS.flows[`${session.flow}Completed`]++;
      resetFlow(session);
      METRICS.chatOk++;
      updateAvgLatency(Date.now() - t0);
      return res.json({ ok: true, data: safe });
    }
    // لو ما قدرنا نرد حتميًا -> نسمح LLM لكن prompt قصير
  }

  // LLM gate: فقط إذا الرسالة ليست قصيرة/أو التصنيف عام/أو نهاية مسار غير مغطاة
  const needLLM = Boolean(
    (session.flow && session.step === 4) ||
      message.length > 60 ||
      inferred === "general" ||
      inferred === "mental"
  );

  if (!needLLM || !GROQ_API_KEY) {
    // بدون LLM: نرجع منيو بدل كلام عام/هلوسة
    const card = menuCard();
    session.lastCard = card;
    bumpCategory("general");
    METRICS.chatOk++;
    updateAvgLatency(Date.now() - t0);
    return res.json({ ok: true, data: card });
  }

  // history مختصر
  session.history.push({ role: "user", content: message });
  session.history = trimHistory(session.history, 6);

  const last = req.body?.context?.last || session.lastCard || null;
  const lastMini = last ? summarizeLastCard(last) : "";
  const msgStr = clampText(message, 800);
  const profMini = session.flow && session.step === 4 ? profileSummary(session.profile) : "";

  // forcedCategory لتثبيت المسار عند نهاية flow
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
    (forcedCategory ? `category=${forcedCategory}\n` : `category_hint=${inferred}\n`) +
    (profMini ? `profile=${profMini}\n` : "") +
    (lastMini ? `last=${lastMini}\n` : "") +
    `q=${msgStr}\n` +
    "Rules: no diagnosis. no meds. if missing say 'غير واضح من البيانات'.\n";

  try {
    const obj = await callGroqJSON({
      system: chatSystemPrompt(),
      user: userPrompt,
      maxTokens: 420,
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
    // لا نخزن JSON كامل لتوفير ذاكرة وتوكنز مستقبلًا
    session.history.push({ role: "assistant", content: `${safeCard.title}|${safeCard.category}` });
    session.history = trimHistory(session.history, 6);

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
          message: "هذا PDF يبدو Scan بدون نص قابل للنسخ. ارفع صورة واضحة للتقرير أو الصق النص.",
        });
      }
    } else if (file.mimetype.startsWith("image/")) {
      extracted = await ocrImageBuffer(file.buffer);
      extracted = extracted.replace(/\s+/g, " ").trim();

      if (extracted.length < 25) {
        METRICS.reportFail++;
        updateAvgLatency(Date.now() - t0);
        return res.json({ ok: false, error: "ocr_failed", message: "الصورة لم تُقرأ بوضوح. حاول صورة أوضح." });
      }
    } else {
      METRICS.reportFail++;
      updateAvgLatency(Date.now() - t0);
      return res.status(400).json({ ok: false, error: "unsupported_type" });
    }

    const extractedClamped = clampText(extracted, 3500);

    const userPrompt =
      "text=" +
      extractedClamped +
      "\nRules: explain only what exists in text; if missing say 'غير واضح من البيانات'. no diagnosis. no meds.\n" +
      "Keep verdict short + tips 3-6.\n";

    const obj = await callGroqJSON({
      system: reportSystemPrompt(),
      user: userPrompt,
      maxTokens: 900,
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
