// ===============================
// server.js — مساعد صحي مختصر + مرفقات (تحاليل / أشعة / صور)
// ===============================

import "dotenv/config";
import express from "express";
import cors from "cors";
import fetch from "node-fetch";

import multer from "multer";
import sharp from "sharp";
import Tesseract from "tesseract.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

const app = express();

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MODEL_ID = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const PORT = process.env.PORT || 3000;

if (!GROQ_API_KEY) {
  console.error("❌ GROQ_API_KEY غير مضبوط");
  process.exit(1);
}

app.use(cors());
app.use(express.json({ limit: "8mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

const conversations = {};

// ===============================
// 🔹 Prompts
// ===============================
function buildSystemPromptGeneral() {
  return `
أنت مساعد صحي للتثقيف فقط.
أجب بإيجاز وبأسلوب مفهوم لشخص عادي.
تجنّب التشخيص، الأدوية، أو الخطط العلاجية.
`.trim();
}

function buildSystemPromptAttachment() {
  return `
أنت مساعد صحي للتثقيف فقط.
قد يُعرض عليك:
- تحليل مخبري
- تقرير طبي
- صورة أشعة
- صورة حالة (جرح، جلد، بول).

قواعد صارمة:
- الإجابة مختصرة جدًا (4 إلى 6 أسطر).
- لا تشخّص أي مرض.
- لا تفسّر صورة الأشعة تفسيرًا طبيًا دقيقًا.
- اشرح للمريض بشكل عام ماذا تمثله الصورة أو التقرير.
- إذا كانت صورة أشعة: اطلب التقرير المكتوب إن وُجد.
- إذا كانت صورة حالة: صف ما يظهر بشكل عام فقط.

الأسلوب:
- لغة بسيطة.
- بدون مصطلحات طبية معقدة.
- ركّز على الطمأنة ومتى يراجع الطبيب.

ممنوع: تشخيص، أدوية، خطط علاج.
`.trim();
}

// ===============================
// 🔹 Helpers
// ===============================
async function fetchWithTimeout(url, options = {}, ms = 20000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

function redactPII(text) {
  return String(text)
    .replace(/\b\d{7,}\b/g, "[رقم محذوف]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[بريد محذوف]");
}

// ===============================
// 🔹 AI
// ===============================
async function askAssistant(message, sessionId, mode) {
  if (!conversations[sessionId]) conversations[sessionId] = [];
  conversations[sessionId].push({ role: "user", content: message });
  conversations[sessionId] = conversations[sessionId].slice(-6);

  const systemPrompt =
    mode === "attachment"
      ? buildSystemPromptAttachment()
      : buildSystemPromptGeneral();

  const response = await fetchWithTimeout(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL_ID,
        temperature: 0.3,
        max_tokens: 500,
        messages: [{ role: "system", content: systemPrompt }, ...conversations[sessionId]],
      }),
    }
  );

  const data = await response.json();
  return data.choices?.[0]?.message?.content || "لم أستطع فهم المرفق.";
}

// ===============================
// 🔹 OCR / PDF
// ===============================
async function ocrImage(buf) {
  const pre = await sharp(buf).grayscale().normalize().toBuffer();
  const { data } = await Tesseract.recognize(pre, "ara+eng");
  return data.text || "";
}

async function readPdf(buf) {
  const data = await pdfParse(buf);
  return data.text || "";
}

// ===============================
// 🔹 Routes
// ===============================
app.get("/", (_req, res) => {
  res.json({ status: "ok", model: MODEL_ID });
});

app.post("/chat", async (req, res) => {
  try {
    const msg = redactPII(req.body.message || "");
    const reply = await askAssistant(msg, req.ip, "general");
    res.json({ reply });
  } catch {
    res.status(500).json({ reply: "حدث خطأ غير متوقع." });
  }
});

app.post("/report", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.json({ reply: "لم يتم رفع ملف." });

    let text = "";
    const mime = req.file.mimetype;

    if (mime === "application/pdf") {
      text = await readPdf(req.file.buffer);
      if (text.length < 30)
        return res.json({
          reply:
            "هذا PDF يبدو ممسوحًا (صورة). ارفع صورة واضحة أو تقرير مكتوب للحصول على شرح أدق.",
        });
    } else if (mime.startsWith("image/")) {
      text = await ocrImage(req.file.buffer);
      if (!text.trim())
        text =
          "تم رفع صورة طبية بدون نص واضح. اشرح الصورة بشكل عام بدون تشخيص.";
    } else {
      return res.json({ reply: "نوع الملف غير مدعوم." });
    }

    const safe = redactPII(`المرفق:\n${text}`);
    const reply = await askAssistant(safe, req.ip, "attachment");
    res.json({ reply });
  } catch {
    res.status(500).json({ reply: "فشل قراءة المرفق." });
  }
});

// ===============================
app.listen(PORT, () => {
  console.log(`🚀 الخادم يعمل على البورت ${PORT}`);
});
