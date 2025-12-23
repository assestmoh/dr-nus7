// server.js (ESM) — Dalil Alafiyah API
import express from "express";
import cors from "cors";
import helmet from "helmet";
import multer from "multer";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse"); // ✅ حل مشكلة: no default export

import { createWorker } from "tesseract.js";

const app = express();
const upload = multer({ limits: { fileSize: 8 * 1024 * 1024 } });

/* =========================
   إعدادات
========================= */
const PORT = process.env.PORT || 8000;
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
// ملاحظة: GPT-OSS 120B يدعم Structured Outputs (strict: true) وهذا يثبّت شكل JSON
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

/* روابط شفاء الرسمية (ثابتة) */
const SHIFAA_ANDROID = "https://play.google.com/store/apps/details?id=om.gov.moh.phr&pcampaignid=web_share";
const SHIFAA_IOS = "https://apps.apple.com/us/app/%D8%B4-%D9%81-%D8%A7%D8%A1/id1455936672?l=ar";

/* =========================
   Middleware
========================= */
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({ origin: true }));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

/* =========================
   Sessions (ذاكرة بسيطة)
========================= */
const sessions = new Map(); // userId -> { history: [{role,content}], lastCard }
function getSession(userId){
  const id = userId || "anon";
  if (!sessions.has(id)) sessions.set(id, { history: [], lastCard: null });
  return sessions.get(id);
}
function trimHistory(history, max = 10){
  if (history.length <= max) return history;
  return history.slice(history.length - max);
}

/* =========================
   OCR Worker (عربي + إنجليزي)
========================= */
let ocrWorkerPromise = null;
async function getOcrWorker(){
  if (!ocrWorkerPromise){
    ocrWorkerPromise = (async () => {
      const worker = await createWorker();
      await worker.load();
      // كان محصور على eng فقط، وهذا يخلي التقارير العربية ما تُقرأ.
      // دمج العربية + الإنجليزي يعطي نتائج أفضل لمعظم تقارير المختبر في عُمان.
      await worker.loadLanguage("eng+ara");
      await worker.initialize("eng+ara");
      return worker;
    })();
  }
  return ocrWorkerPromise;
}
async function ocrImageBuffer(buffer){
  const worker = await getOcrWorker();
  const { data } = await worker.recognize(buffer);
  return (data && data.text) ? String(data.text) : "";
}

/* =========================
   Helpers
========================= */
function looksLikeAppointments(text){
  const t = String(text || "");
  return /موعد|مواعيد|حجز|احجز|حجوزات|حجزت|حجزي|appointment|booking/i.test(t);
}

function makeCard({ title, category, verdict, tips, when_to_seek_help, next_question, quick_choices }){
  return {
    title: title || "دليل العافية",
    category: category || "general",
    verdict: verdict || "",
    tips: Array.isArray(tips) ? tips : [],
    when_to_seek_help: when_to_seek_help || "",
    next_question: next_question || "",
    quick_choices: Array.isArray(quick_choices) ? quick_choices : []
  };
}

function appointmentsCard(){
  return makeCard({
    title: "معلومات المواعيد عبر تطبيق شفاء",
    category: "appointments",
    verdict:
      "للحجز وإدارة المواعيد والاطلاع على الملف الصحي في سلطنة عُمان، استخدم تطبيق **شفاء** الرسمي.\n" +
      "هذه روابط التحميل الرسمية:",
    tips: [
      `أندرويد: ${SHIFAA_ANDROID}`,
      `آيفون: ${SHIFAA_IOS}`,
      "إذا واجهت مشكلة تسجيل/دخول: جرّب تحديث التطبيق أو إعادة تسجيل الدخول."
    ],
    when_to_seek_help:
      "إذا كانت لديك أعراض طارئة أو شديدة (ألم صدر شديد/ضيق نفس شديد/إغماء/ضعف مفاجئ): راجع الطوارئ فورًا.",
    next_question: "هل تريد أن أشرح لك خطوات الحجز داخل التطبيق؟",
    quick_choices: ["نعم، اشرح خطوات الحجز", "لا، شكرًا"]
  });
}

function safeJsonParse(s){
  try{ return JSON.parse(s); }catch(e){ return null; }
}

async function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

/* =========================
   Groq call
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

async function callGroqJSON({ system, user, maxTokens = 650 }){
  if (!GROQ_API_KEY) throw new Error("Missing GROQ_API_KEY");

  const url = "https://api.groq.com/openai/v1/chat/completions";

  const body = {
    model: GROQ_MODEL,
    temperature: 0.2,
    max_tokens: maxTokens,
    // Structured Outputs (strict) يقلّل خراب البطاقات/المفاتيح الغلط
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
      { role: "user", content: user }
    ]
  };

  for (let attempt = 0; attempt < 3; attempt++){
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (res.status === 429){
      // rate limit: انتظر شوي وكرر
      await sleep(1200 + attempt * 600);
      continue;
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok){
      throw new Error(`Groq API error: ${res.status} ${JSON.stringify(data)}`);
    }

    const text = data?.choices?.[0]?.message?.content || "";
    const parsed = safeJsonParse(text);
    if (parsed) return parsed;

    // المفروض ما يصير مع strict:true، لكن نخلي retry كاحتياط
    body.max_tokens = Math.max(350, maxTokens - 200);
    await sleep(350);
  }

  throw new Error("Groq returned invalid JSON repeatedly");
}

function chatSystemPrompt(){
  return (
    "أنت مساعد تثقيف صحي عربي. لا تشخّص ولا تصف أدوية. كن مطمّنًا وبسيطًا.\n" +
    "مهم جدًا: لا تخترع أرقام هواتف أو روابط أو مواعيد. إذا لم تكن متأكدًا قل: لا أعلم.\n" +
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

function reportSystemPrompt(){
  return (
    "أنت مساعد تثقيف صحي عربي متخصص بشرح نتائج التحاليل/التقارير.\n" +
    "المدخل سيكون نصًا مُستخرجًا من صورة/ملف (قد يكون بالإنجليزية).\n" +
    "حوّل المعنى لشرح عربي مطمّن: ما الذي يعنيه بشكل عام + نصائح عامة + متى يراجع الطبيب.\n" +
    "لا تشخّص، ولا تضع أرقام مرجعية دقيقة إذا غير موجودة.\n" +
    "أخرج JSON فقط بنفس مفاتيح البطاقة.\n"
  );
}

/* =========================
   Routes
========================= */
app.get("/", (req, res) => {
  res.json({ ok: true, service: "Dalil Alafiyah API", routes: ["/chat","/report","/reset"] });
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
  if (!message) return res.status(400).json({ ok:false, error:"empty_message" });

  // ✅ مواعيد/حجز: رد ثابت بدون نموذج (عشان ما يهبد)
  if (looksLikeAppointments(message)){
    const card = appointmentsCard();
    session.lastCard = card;
    return res.json({ ok:true, data: card });
  }

  // history بسيط (اختياري)
  session.history.push({ role: "user", content: message });
  session.history = trimHistory(session.history, 8);

  // نبني user prompt مع سياق آخر بطاقة إن وجدت
  const last = req.body?.context?.last || session.lastCard || null;
  const userPrompt =
    (last ? `سياق آخر رد (قد يفيد):\n${JSON.stringify(last)}\n\n` : "") +
    `سؤال المستخدم:\n${message}\n\n` +
    "أجب ببطاقة منظمة وبأسلوب مطمّن وبنصائح قصيرة ومتى يراجع طبيب.";

  try{
    const obj = await callGroqJSON({
      system: chatSystemPrompt(),
      user: userPrompt,
      maxTokens: 650
    });

    const card = makeCard(obj);
    session.lastCard = card;

    session.history.push({ role: "assistant", content: JSON.stringify(card) });
    session.history = trimHistory(session.history, 10);

    return res.json({ ok:true, data: card });
  }catch(err){
    console.error(err);
    return res.status(200).json({
      ok:false,
      error:"model_error"
    });
  }
});

app.post("/report", upload.single("file"), async (req, res) => {
  const userId = req.header("x-user-id") || "anon";
  const session = getSession(userId);

  const file = req.file;
  if (!file) return res.status(400).json({ ok:false, error:"missing_file" });

  try{
    let extracted = "";

    if (file.mimetype === "application/pdf"){
      // PDF نصي
      const parsed = await pdfParse(file.buffer).catch(() => null);
      extracted = parsed?.text ? String(parsed.text) : "";
      extracted = extracted.replace(/\s+/g, " ").trim();
      // إذا كان PDF سكان، النص غالبًا فاضي/قصير
      if (extracted.length < 40){
        return res.json({
          ok:false,
          error:"pdf_no_text",
          message:"هذا PDF يبدو ممسوح (Scan) ولا يحتوي نصًا قابلًا للنسخ. ارفع صورة واضحة للتقرير أو الصق النص."
        });
      }
    } else if (file.mimetype.startsWith("image/")){
      // OCR للصور (إنجليزي)
      extracted = await ocrImageBuffer(file.buffer);
      extracted = extracted.replace(/\s+/g, " ").trim();
      if (extracted.length < 25){
        return res.json({
          ok:false,
          error:"ocr_failed",
          message:"الصورة لم تُقرأ بوضوح. حاول صورة أوضح (بدون قص شديد/مع إضاءة أفضل)."
        });
      }
    } else {
      return res.status(400).json({ ok:false, error:"unsupported_type" });
    }

    const userPrompt =
      "هذا نص مستخرج من تقرير/تحاليل (قد يكون بالإنجليزية):\n" +
      extracted + "\n\n" +
      "اشرحه بالعربية بشكل مطمّن وبسيط، مع نصائح عامة ومتى يراجع الطبيب.";

    const obj = await callGroqJSON({
      system: reportSystemPrompt(),
      user: userPrompt,
      maxTokens: 700
    });

    const card = makeCard({ ...obj, category: "report" });
    session.lastCard = card;

    return res.json({ ok:true, data: card });
  }catch(err){
    console.error(err);
    return res.status(200).json({
      ok:false,
      error:"report_error",
      message:"تعذر تحليل التقرير الآن. جرّب صورة أوضح أو الصق النص."
    });
  }
});

/* =========================
   Start
========================= */
app.listen(PORT, () => {
  console.log(`🚀 Dalil Alafiyah API يعمل على ${PORT}`);
});