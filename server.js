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

/* =========================
   App
========================= */
const app = express();
const upload = multer({ limits: { fileSize: 8 * 1024 * 1024 } });

/* =========================
   Config
========================= */
const PORT = process.env.PORT || 8000;

// Groq
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

// Optional internal API key (for pilot)
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

// Rate limit (ضروري للإنتاج/البايلوت)
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// API Key (اختياري) — فعّليه بالبيئة INTERNAL_API_KEY
function requireApiKey(req, res, next) {
  if (!INTERNAL_API_KEY) return next(); // للتطوير
  const key = req.header("x-api-key");
  if (key !== INTERNAL_API_KEY) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}
app.use(requireApiKey);

// CORS مضبوط
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
   Simple metrics (in-memory)
   (لا نخزن بيانات شخصية)
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
};

function bumpCategory(cat) {
  if (!cat) return;
  METRICS.categoryCount[cat] = (METRICS.categoryCount[cat] || 0) + 1;
}

function updateAvgLatency(ms) {
  // EWMA بسيطة
  const alpha = 0.2;
  METRICS.avgLatencyMs =
    METRICS.avgLatencyMs === 0 ? ms : Math.round(alpha * ms + (1 - alpha) * METRICS.avgLatencyMs);
}

/* =========================
   Sessions (in-memory) + TTL
   userId -> { history, lastCard, flow, step, profile, ts }
========================= */
const sessions = new Map();

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
    if (now - (v.ts || 0) > 24 * 60 * 60 * 1000) {
      sessions.delete(k);
    }
  }
}, 30 * 60 * 1000);

function trimHistory(history, max = 10) {
  if (history.length <= max) return history;
  return history.slice(history.length - max);
}

/* =========================
   OCR — tesseract.js (ara+eng)
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
  return /موعد|مواعيد|حجز|احجز|حجوزات|حجزت|حجزي|appointment|booking/i.test(t);
}

// تصنيف من الرسالة (بدون هلوسة)
function inferCategoryFromMessage(message) {
  const t = String(message || "");

  if (
    /(ألم صدر|الم صدر|ضيق نفس|صعوبة تنفس|اختناق|إغماء|اغماء|شلل|ضعف مفاجئ|نزيف شديد|تشنج|نوبة|افكار انتحارية|أفكار انتحارية|انتحار|ايذاء النفس|إيذاء النفس)/i.test(
      t
    )
  ) {
    return "emergency";
  }

  if (looksLikeAppointments(t)) return "appointments";

  if (/(تقرير|تحاليل|تحليل|نتيجة|cbc|hba1c|cholesterol|vitamin|lab|report)/i.test(t))
    return "report";

  if (/(قلق|توتر|اكتئاب|مزاج|نوم|أرق|panic|anxiety|depress)/i.test(t)) return "mental";

  if (/(bmi|كتلة الجسم|مؤشر كتلة|وزني|طولي)/i.test(t)) return "bmi";

  if (/(ضغط|ضغط الدم|systolic|diastolic|mmhg|ملم زئبقي)/i.test(t)) return "bp";

  if (/(سكر|سكري|glucose|mg\/dl|صائم|بعد الأكل|بعد الاكل|hba1c)/i.test(t)) return "sugar";

  if (/(ماء|سوائل|شرب|ترطيب|hydration)/i.test(t)) return "water";

  if (/(سعرات|calories|دايت|رجيم|تخسيس|تنحيف|زيادة وزن|نظام غذائي)/i.test(t))
    return "calories";

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
    next_question: "هل تريد أن أشرح لك خطوات الحجز داخل التطبيق؟",
    quick_choices: ["نعم، اشرح خطوات الحجز", "لا، شكرًا"],
  });
}

/* =========================
   AI Card Schema (Structured)
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
    "أنت أداة تثقيف صحي فقط، ولست طبيبًا ولا بديلاً عن الاستشارة الطبية.\n" +
    "قدّم معلومات عامة عن الصحة ونمط الحياة بأسلوب عربي مهني، واضح، مختصر، وهادئ.\n" +
    "ممنوع منعًا باتًا: التشخيص الطبي، وصف الأدوية، تحديد الجرعات، أو وضع خطط علاجية.\n" +
    "لا تفسّر نتائج الفحوصات بشكل دقيق، بل قدّم توضيحًا عامًا فقط عند الحاجة.\n" +
    "اذكر متى يُنصح بمراجعة الطبيب أو التوجّه للطوارئ عند ظهور أعراض خطيرة أو غير طبيعية.\n" +
    "إذا لم تكن متأكدًا من المعلومة، قل بوضوح: لا أعلم.\n" +
    "مهم جدًا: التزم بسؤال المستخدم فقط. لا تنتقل لموضوع آخر.\n" +
    "أخرج JSON فقط بنفس مفاتيح البطاقة.\n"
  );
}

function reportSystemPrompt() {
  return (
    "أنت مساعد تثقيف صحي عربي لشرح نتائج التحاليل/التقارير.\n" +
    "المدخل نص مُستخرج من صورة/ملف.\n" +
    "اشرح المعنى بالعربية بشكل عام + نصائح عامة + متى يراجع الطبيب.\n" +
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
      json_schema: {
        name: "dalil_alafiyah_card",
        strict: true,
        schema: CARD_SCHEMA,
      },
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
   AI Safety Post-Filter (P0)
   يمنع زلات “جرعات/دواء”
========================= */
function postFilterCard(card) {
  const bad = /(خذ|خذي|جرعة|مرتين يوميًا|مرتين يوميا|ثلاث مرات|حبوب|دواء|انسولين|metformin|ibuprofen|paracetamol)/i;
  const combined =
    (card?.verdict || "") +
    "\n" +
    (Array.isArray(card?.tips) ? card.tips.join("\n") : "") +
    "\n" +
    (card?.when_to_seek_help || "");

  if (bad.test(combined)) {
    return makeCard({
      title: card?.title || "تنبيه",
      category: card?.category || "general",
      verdict:
        "أنا للتثقيف الصحي فقط. ما أقدر أوصف أدوية أو جرعات.\n" +
        "إذا عندك استفسار علاجي أو دوائي، الأفضل تسأل طبيب/صيدلي أو تراجع المؤسسة الصحية.",
      tips: [
        "اذكر للطبيب الأعراض ومدة المشكلة والأدوية الحالية إن وجدت.",
        "إذا الأعراض شديدة أو غير طبيعية: توجّه للطوارئ.",
      ],
      when_to_seek_help: "ألم صدر شديد/ضيق نفس شديد/إغماء/ضعف مفاجئ: طوارئ فورًا.",
      next_question: "هل تريد نصائح عامة عن نمط الحياة بدل العلاج؟",
      quick_choices: ["نعم", "لا"],
    });
  }

  return card;
}

/* =========================
   Sugar Flow (تخصيص) — يجعل الشات بوت “يُحسب AI”
========================= */
function startSugarFlow(session) {
  session.flow = "sugar";
  session.step = 1;
  session.profile = {};
  return makeCard({
    title: "مسار السكر",
    category: "sugar",
    verdict: "عشان أعطيك معلومات مناسبة، اختر فئتك العمرية:",
    tips: [],
    when_to_seek_help: "",
    next_question: "",
    quick_choices: ["أقل من 18", "18–40", "41–60", "60+"],
  });
}

function handleSugarFlow(session, message) {
  const m = String(message || "").trim();

  if (session.step === 1) {
    session.profile.ageGroup = m;
    session.step = 2;
    return makeCard({
      title: "مسار السكر",
      category: "sugar",
      verdict: "هل تم تشخيصك بالسكري من قبل؟",
      tips: [],
      when_to_seek_help: "",
      next_question: "",
      quick_choices: ["نعم", "لا", "غير متأكد"],
    });
  }

  if (session.step === 2) {
    session.profile.diagnosed = m;
    session.step = 3;
    return makeCard({
      title: "مسار السكر",
      category: "sugar",
      verdict: "وش هدفك الآن؟",
      tips: [],
      when_to_seek_help: "",
      next_question: "",
      quick_choices: ["أفهم السكري ببساطة", "أكل مناسب", "تقليل الارتفاعات", "متابعة عامة"],
    });
  }

  if (session.step === 3) {
    session.profile.goal = m;
    session.step = 4; // جاهز لتوليد الرد المخصص
    return null;
  }

  return null;
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

  // زر إلغاء/إعادة
  if (/^(إلغاء|الغاء|cancel|ابدأ من جديد|ابدأ جديد)$/i.test(message)) {
    session.flow = null;
    session.step = 0;
    session.profile = {};
    const card = makeCard({
      title: "تم",
      category: "general",
      verdict: "تم إلغاء المسار. تقدر تختار موضوع جديد.",
      tips: [],
      when_to_seek_help: "",
      next_question: "",
      quick_choices: ["السكر", "الضغط", "BMI", "افهم تقريرك", "مواعيد شفاء"],
    });
    session.lastCard = card;
    METRICS.chatOk++;
    updateAvgLatency(Date.now() - t0);
    return res.json({ ok: true, data: card });
  }

  // مواعيد: رد ثابت
  if (looksLikeAppointments(message) || /شفاء/i.test(message)) {
    const card = appointmentsCard();
    session.lastCard = card;
    bumpCategory("appointments");
    METRICS.chatOk++;
    updateAvgLatency(Date.now() - t0);
    return res.json({ ok: true, data: card });
  }

  // Emergency trigger counter
  if (inferCategoryFromMessage(message) === "emergency") METRICS.emergencyTriggers++;

  // 1) إذا ليس داخل Flow و الرسالة تشير للسكر بشكل واضح -> ابدأ المسار
  const inferred = inferCategoryFromMessage(message);
  const shortSugarIntent =
    inferred === "sugar" && message.length <= 20; // مثل "سكر" "السكر" "🩸 السكر"
  if (!session.flow && shortSugarIntent) {
    const card = startSugarFlow(session);
    session.lastCard = card;
    bumpCategory("sugar");
    METRICS.chatOk++;
    updateAvgLatency(Date.now() - t0);
    return res.json({ ok: true, data: card });
  }

  // 2) إذا داخل مسار السكر: كمل الأسئلة
  if (session.flow === "sugar" && session.step > 0 && session.step < 4) {
    const card = handleSugarFlow(session, message);
    if (card) {
      session.lastCard = card;
      bumpCategory("sugar");
      METRICS.chatOk++;
      updateAvgLatency(Date.now() - t0);
      return res.json({ ok: true, data: card });
    }
    // لو رجع null يعني وصلنا للـ step=4 وجاهزين للتوليد
  }

  // 3) بناء سياق + تخصيص
  session.history.push({ role: "user", content: message });
  session.history = trimHistory(session.history, 8);

  const last = req.body?.context?.last || session.lastCard || null;
  const lastStr = last ? clampText(JSON.stringify(last), 1200) : "";
  const msgStr = clampText(message, 1200);

  // profile (إذا موجود)
  const profileStr =
    session.flow === "sugar" && session.step === 4
      ? clampText(JSON.stringify(session.profile), 500)
      : "";

  const userPrompt =
    (profileStr
      ? `معلومات مختصرة عن المستخدم (للتخصيص فقط، بدون تشخيص):\n${profileStr}\n\n`
      : "") +
    (last ? `سياق آخر رد (استخدمه فقط إذا مرتبط):\n${lastStr}\n\n` : "") +
    `سؤال المستخدم:\n${msgStr}\n\n` +
    "التزم بالسؤال. لا تشخيص ولا أدوية ولا جرعات.\n" +
    "قدّم نصائح عامة قصيرة + متى يراجع الطبيب/الطوارئ.\n";

  try {
    const obj = await callGroqJSON({
      system: chatSystemPrompt(),
      user: userPrompt,
      maxTokens: 1200,
    });

    // تثبيت التصنيف بشكل منطقي
    let finalCategory = obj?.category || inferred || "general";

    // إذا داخل مسار السكر وخلاص جمعنا البيانات، نخليها sugar
    if (session.flow === "sugar" && session.step === 4) {
      finalCategory = "sugar";
      // بعد الرد نخرج من المسار
      session.flow = null;
      session.step = 0;
      session.profile = {};
    } else {
      // منع التصنيف العشوائي
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
          message: "الصورة لم تُقرأ بوضوح. حاول صورة أوضح (بدون قص شديد/مع إضاءة أفضل).",
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

    const card = makeCard({ ...obj, category: "report" });
    const safeCard = postFilterCard(card);

    session.lastCard = safeCard;

    bumpCategory("report");
    METRICS.reportOk++;
    updateAvgLatency(Date.now() - t0);

    return res.json({ ok: true, data: safeCard });
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
