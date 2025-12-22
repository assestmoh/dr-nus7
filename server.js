// ===============================
// server.js — Dalil Alafiyah API
// ===============================

import "dotenv/config";
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import helmet from "helmet";
import multer from "multer";
import pdfParse from "pdf-parse";
import sharp from "sharp";
import { createWorker } from "tesseract.js";

const app = express();

// ===============================
// ENV
// ===============================
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MODEL_ID = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const PORT = process.env.PORT || 3000;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "";

if (!GROQ_API_KEY) {
  console.error("❌ GROQ_API_KEY غير مضبوط");
  process.exit(1);
}

app.use(helmet());
app.use(cors(FRONTEND_ORIGIN ? { origin: FRONTEND_ORIGIN.split(",").map(s=>s.trim()).filter(Boolean), methods: ["GET","POST","OPTIONS"], allowedHeaders: ["Content-Type","Authorization"] } : undefined));
app.use(bodyParser.json({ limit: "2mb" }));

// ===============================
// Helpers
// ===============================
async function fetchWithTimeout(url, options = {}, ms = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

function extractJson(text) {
  const s = String(text || "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a === -1 || b === -1 || b <= a) return null;
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
}

const sStr = (v) => (typeof v === "string" ? v.trim() : "");
const sArr = (v, n) =>
  Array.isArray(v) ? v.filter(x => typeof x === "string" && x.trim()).slice(0, n) : [];

// ===============================
// System Prompt
// ===============================
function buildSystemPrompt() {
  return `
أنت "دليل العافية" — مرافق صحي عربي للتثقيف الصحي فقط.

أخرج الرد بصيغة JSON فقط وبدون أي نص خارجها:

{
  "category": "general | sugar | blood_pressure | nutrition | sleep | activity | mental | first_aid | report | emergency",
  "title": "عنوان قصير (2-5 كلمات)",
  "verdict": "جملة واحدة: تطمين أو تنبيه",
  "next_question": "سؤال واحد فقط (أو \"\")",
  "quick_choices": ["خيار 1","خيار 2"],
  "tips": ["نصيحة قصيرة 1","نصيحة قصيرة 2"],
  "when_to_seek_help": "متى تراجع الطبيب أو الطوارئ (أو \"\")"
}

قواعد:
- لا تشخيص
- لا أدوية
- لا جرعات
- السؤال والأزرار قبل النصائح
- لغة بسيطة
`.trim();
}

// ===============================
// Groq
// ===============================
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
        temperature: 0.35,
        max_tokens: 450,
        messages,
      }),
    }
  );
  if (!res.ok) throw new Error("Groq API error");
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

// ===============================
// Normalize
// ===============================
function normalize(obj) {
  return {
    category: sStr(obj?.category) || "general",
    title: sStr(obj?.title) || "دليل العافية",
    verdict: sStr(obj?.verdict),
    next_question: sStr(obj?.next_question),
    quick_choices: sArr(obj?.quick_choices, 3),
    tips: sArr(obj?.tips, 2),
    when_to_seek_help: sStr(obj?.when_to_seek_help),
  };
}

function fallback(text) {
  return {
    category: "general",
    title: "معلومة صحية",
    verdict: sStr(text) || "لا تتوفر معلومات كافية.",
    next_question: "",
    quick_choices: [],
    tips: [],
    when_to_seek_help: "",
  };
}


// ===============================
// Report helper (PDF/Image -> text)
// ===============================

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

async function ocrImage(buffer) {
  const worker = await createWorker("ara+eng");
  try {
    const { data } = await worker.recognize(buffer);
    return (data?.text || "").trim();
  } finally {
    await worker.terminate().catch(() => {});
  }
}

async function extractTextFromUpload(file) {
  if (!file?.buffer) return "";
  const type = String(file.mimetype || "").toLowerCase();

  if (type === "application/pdf") {
    const parsed = await pdfParse(file.buffer);
    return String(parsed?.text || "").trim();
  }

  if (type.startsWith("image/")) {
    // normalize for OCR
    const normalized = await sharp(file.buffer)
      .rotate()
      .resize({ width: 1800, withoutEnlargement: true })
      .grayscale()
      .toBuffer();
    return await ocrImage(normalized);
  }

  return "";
}

function buildReportSystemPrompt() {
  return `
أنت مساعد عربي لتثقيف صحي عام فقط.
سيصلك نص تقرير/تحاليل (قد يحتوي أرقام ووحدات).

اكتب شرحًا مبسطًا بالعربية:
- لخص أهم النتائج بنقاط.
- اذكر ما هو الطبيعي تقريبًا بشكل عام (بدون تشخيص وبدون أدوية وبدون جرعات).
- اذكر أسئلة متابعة قصيرة (2-4 أسئلة) لتحسين الفهم.
- اذكر متى يجب مراجعة الطبيب أو الطوارئ بشكل عام.
- إذا النص غير واضح/ناقِص: اطلب من المستخدم صورة أوضح أو قيم/وحدات محددة.

ممنوع: تشخيص، وصف أدوية، جرعات.
`.trim();
}

// ===============================
// Routes
// ===============================
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "Dalil Alafiyah API" });
});

app.post("/chat", async (req, res) => {
  try {
    const msg = String(req.body.message || "").trim();
    if (!msg) {
      return res.status(400).json({ ok: false, error: "empty_message" });
    }

    const raw = await callGroq([
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: msg },
    ]);

    const parsed = extractJson(raw);
    const data = parsed ? normalize(parsed) : fallback(raw);

    res.json({ ok: true, data });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      ok: false,
      error: "server_error",
      data: fallback("حدث خطأ غير متوقع. راجع الطبيب إذا الأعراض مقلقة."),
    });
  }
});



app.post("/report", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "no_file" });

    const text = await extractTextFromUpload(req.file);
    if (!text) {
      return res.status(400).json({
        ok: false,
        error: "no_text",
        reply: "لم أستطع استخراج نص واضح من الملف. جرّب صورة أوضح أو PDF نصي (غير ممسوح).",
      });
    }

    const raw = await callGroq([
      { role: "system", content: buildReportSystemPrompt() },
      { role: "user", content: "نص التقرير:\n" + text.slice(0, 12000) },
    ]);

    // هنا نرجع نص مباشر (الواجهة تتوقع reply)
    return res.json({ ok: true, reply: raw });
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      ok: false,
      error: "server_error",
      reply: "حدث خطأ أثناء معالجة التقرير. جرّب مرة أخرى.",
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Dalil Alafiyah API يعمل على ${PORT}`);
});
