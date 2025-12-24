// server.js (ESM) — Dalil Alafiyah API (Updated for tesseract.js v6 + Groq JSON stability)

import express from "express";
import cors from "cors";
import helmet from "helmet";
import multer from "multer";
import { createRequire } from "module";
import { createWorker } from "tesseract.js";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse"); // ✅ no default export fix

const app = express();
const upload = multer({ limits: { fileSize: 8 * 1024 * 1024 } });

/* =========================
   Config
========================= */
const PORT = process.env.PORT || 8000;
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

/* Official Shifaa links */
const SHIFAA_ANDROID =
  "https://play.google.com/store/apps/details?id=om.gov.moh.phr&pcampaignid=web_share";
const SHIFAA_IOS =
  "https://apps.apple.com/us/app/%D8%B4-%D9%81-%D8%A7%D8%A1/id1455936672?l=ar";

/* =========================
   Middleware
========================= */
app.use(helmet({ crossOriginResourcePolicy: false }));

// ✅ CORS مضبوط لواجهة Netlify + التطوير
const ALLOWED_ORIGINS = new Set([
  "https://alafya.netlify.app",
  "http://localhost:5173",
  "http://localhost:3000",
  "http://localhost:8000",
   "http://192.168.100.26:5173"
]);

app.use(
  cors({
    origin: (origin, cb) => {
      // allow server-to-server / tools without origin
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.has(origin)) return cb(null, true);
      // لو تبيها مفتوحة للتسليم بسرعة: بدّل السطر الجاي بـ cb(null,true)
      return cb(new Error("CORS blocked: " + origin));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-user-id"],
  })
);

// زِد حدود البودي شوي (صور ما تمر هنا غالبًا، لكن احتياط)
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

/* =========================
   Sessions (simple in-memory)
========================= */
const sessions = new Map(); // userId -> { history: [{role,content}], lastCard }

function getSession(userId) {
  const id = userId || "anon";
  if (!sessions.has(id)) sessions.set(id, { history: [], lastCard: null });
  return sessions.get(id);
}

function trimHistory(history, max = 10) {
  if (history.length <= max) return history;
  return history.slice(history.length - max);
}

/* =========================
   OCR (tesseract.js v6) — eng+ara
   IMPORTANT:
   - v6 removed worker.loadLanguage/initialize/load
   - set lang at createWorker("eng+ara")
========================= */
let ocrWorkerPromise = null;

async function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => {
      // language set here (v6)
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
function looksLikeAppointments(text) {
  const t = String(text || "");
  return /موعد|مواعيد|حجز|احجز|حجوزات|حجزت|حجزي|appointment|booking/i.test(t);
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
      "هذه روابط التحميل الرسمية:",
    tips: [
      `أندرويد: ${SHIFAA_ANDROID}`,
      `آيفون: ${SHIFAA_IOS}`,
      "إذا واجهت مشكلة تسجيل/دخول: جرّب تحديث التطبيق أو إعادة تسجيل الدخول.",
    ],
    when_to_seek_help:
      "إذا كانت لديك أعراض طارئة أو شديدة (ألم صدر شديد/ضيق نفس شديد/إغماء/ضعف مفاجئ): راجع الطوارئ فورًا.",
    next_question: "هل تريد أن أشرح لك خطوات الحجز داخل التطبيق؟",
    quick_choices: ["نعم، اشرح خطوات الحجز", "لا، شكرًا"],
  });
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// قصّ النص لتفادي فشل JSON في Groq
function clampText(s, maxChars) {
  const t = String(s || "").trim();
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars) + "\n...[تم قص النص لتفادي الأخطاء]";
}

/* =========================
   Groq call — Structured Outputs (strict)
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
    if (!res.ok) {
      throw new Error(`Groq API error: ${res.status} ${JSON.stringify(data)}`);
    }

    const text = data?.choices?.[0]?.message?.content || "";
    const parsed = safeJsonParse(text);
    if (parsed) return parsed;

    // احتياط
    await sleep(350);
  }

  throw new Error("Groq returned invalid JSON repeatedly");
}

function chatSystemPrompt() {
  return (
    "أنت مساعد تثقيف صحي عربي. لا تشخّص ولا تصف أدوية. كن مطمئنًا وبسيطًا.\n" +
    "مهم: إذا لم تكن متأكدًا قل: لا أعلم.\n" +
    "أخرج JSON فقط (كائن واحد) بهذه المفاتيح EXACT:\n" +
    "{\n" +
    '  "title": "string",\n' +
    '  "category": "general|emergency|appointments|report|mental|bmi|bp|sugar|water|calories",\n' +
    '  "verdict": "string",\n' +
    '  "tips": ["string"],\n' +
    '  "when_to_seek_help": "string",\n' +
    '  "next_question": "string",\n' +
    '  "quick_choices": ["string"]\n' +
    "}\n" +
    "اجعل النص العربي واضحًا ومختصرًا.\n"
  );
}

function reportSystemPrompt() {
  return (
    "أنت مساعد تثقيف صحي عربي متخصص بشرح نتائج التحاليل/التقارير.\n" +
    "المدخل سيكون نصًا مُستخرجًا من صورة/ملف (قد يكون بالإنجليزية).\n" +
    "اشرح المعنى بالعربية بشكل عام + نصائح عامة + متى يراجع الطبيب.\n" +
    "لا تشخّص، ولا تضع أرقام مرجعية دقيقة إذا غير موجودة.\n" +
    "أخرج JSON فقط بنفس مفاتيح البطاقة.\n"
  );
}

/* =========================
   Routes
========================= */
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "Dalil Alafiyah API",
    routes: ["/chat", "/report", "/reset"],
  });
});

app.post("/reset", (req, res) => {
  const userId = req.header("x-user-id") || "anon";
  sessions.delete(userId);
  res.json({ ok: true });
});

app.post("/chat", async (req, res) => {
  const userId = req.header("x-user-id") || "anon";
  const session = getSession(userId);

  const message = String(req.body?.message || "").trim();
  if (!message) return res.status(400).json({ ok: false, error: "empty_message" });

  // مواعيد: رد ثابت
  if (looksLikeAppointments(message)) {
    const card = appointmentsCard();
    session.lastCard = card;
    return res.json({ ok: true, data: card });
  }

  session.history.push({ role: "user", content: message });
  session.history = trimHistory(session.history, 8);

  const last = req.body?.context?.last || session.lastCard || null;

  // قص السياق لتفادي تضخم الطلب
  const lastStr = last ? clampText(JSON.stringify(last), 1200) : "";
  const msgStr = clampText(message, 1200);

  const userPrompt =
    (last ? `سياق آخر رد (قد يفيد):\n${lastStr}\n\n` : "") +
    `سؤال المستخدم:\n${msgStr}\n\n` +
    "أجب ببطاقة منظمة وبأسلوب مطمئن وبنصائح قصيرة ومتى يراجع طبيب.";

  try {
    const obj = await callGroqJSON({
      system: chatSystemPrompt(),
      user: userPrompt,
      maxTokens: 1200,
    });

    const card = makeCard(obj);
    session.lastCard = card;

    session.history.push({ role: "assistant", content: JSON.stringify(card) });
    session.history = trimHistory(session.history, 10);

    return res.json({ ok: true, data: card });
  } catch (err) {
    console.error("[chat] FAILED:", err?.message || err);
    return res.status(200).json({ ok: false, error: "model_error" });
  }
});

app.post("/report", upload.single("file"), async (req, res) => {
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

      console.log("[report] ocr length:", extracted.length);
      console.log("[report] ocr sample:", extracted.slice(0, 160));

      if (extracted.length < 25) {
        return res.json({
          ok: false,
          error: "ocr_failed",
          message: "الصورة لم تُقرأ بوضوح. حاول صورة أوضح (بدون قص شديد/مع إضاءة أفضل).",
        });
      }
    } else {
      return res.status(400).json({ ok: false, error: "unsupported_type" });
    }

    // ✅ قص النص قبل Groq لتفادي json_validate_failed
    const extractedClamped = clampText(extracted, 6000);

    // ✅ Prompt مختصر وواضح
    const userPrompt =
      "نص مستخرج من تقرير/تحاليل:\n" +
      extractedClamped +
      "\n\n" +
      "اكتب شرحًا عربيًا مطمئنًا وبسيطًا: ماذا يعني بشكل عام + نصائح عامة + متى يراجع الطبيب.\n" +
      "لا تذكر تشخيصات مؤكدة.";

    const obj = await callGroqJSON({
      system: reportSystemPrompt(),
      user: userPrompt,
      maxTokens: 1600,
    });

    const card = makeCard({ ...obj, category: "report" });
    session.lastCard = card;

    return res.json({ ok: true, data: card });
  } catch (err) {
    console.error("[report] FAILED:", err?.message || err);
    return res.status(200).json({
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
  console.log(`🚀 Dalil Alafiyah API يعمل على ${PORT}`);
});
