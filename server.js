// ===============================
// server.js — مساعد صحي مختصر + مرفقات (تحاليل/تقارير/أشعة/صور)
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

// ✅ FIX: pdf-parse قد يرجع default أو module object حسب البيئة
const pdfParseModule = require("pdf-parse");
const pdfParse = pdfParseModule.default || pdfParseModule;

const app = express();

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MODEL_ID = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const PORT = process.env.PORT || 3000;

if (!GROQ_API_KEY) {
  console.error("❌ GROQ_API_KEY غير مضبوط");
  process.exit(1);
}

app.use(cors());
app.use(express.json({ limit: process.env.JSON_LIMIT || "8mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Number(process.env.FILE_LIMIT_BYTES || 8 * 1024 * 1024) },
});

const conversations = {};

// ===============================
// Prompts
// ===============================
function buildSystemPromptGeneral() {
  return `
أنت مساعد صحي للتثقيف فقط.
أجب بإيجاز وبأسلوب مفهوم لشخص عادي.
تجنب التشخيص، الأدوية، والجرعات.
إذا في أعراض خطيرة: انصح بمراجعة الطوارئ.
`.trim();
}

function buildSystemPromptAttachment() {
  return `
أنت مساعد صحي للتثقيف فقط.
قد يصل لك: تحاليل/تقرير/أشعة/صورة حالة.
قواعد صارمة:
- الإجابة قصيرة جدًا (4–6 أسطر).
- لا تشخيص، لا أدوية، لا خطة علاج.
- إذا كانت "أشعة": قل إن الصورة وحدها لا تكفي للتشخيص واطلب تقرير الأشعة إن وُجد، وقدّم شرحًا عامًا فقط.
- إذا كانت "تحاليل": لخص الوضع واذكر فقط غير الطبيعي/القريب من الحد.
- بدون جداول وبدون مصطلحات معقدة.
`.trim();
}

// ===============================
// Helpers
// ===============================
function redactPII(text) {
  return String(text || "")
    .replace(/\b\d{7,}\b/g, "[رقم محذوف]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[بريد محذوف]");
}

async function fetchWithTimeout(url, options = {}, ms = 20000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

function getSessionId(req) {
  return (
    (req.headers["x-session-id"] && String(req.headers["x-session-id"]).slice(0, 32)) ||
    req.ip ||
    "default"
  );
}

async function askAssistant(userMessage, sessionId, mode) {
  if (!conversations[sessionId]) conversations[sessionId] = [];
  conversations[sessionId].push({ role: "user", content: userMessage });
  conversations[sessionId] = conversations[sessionId].slice(-6);

  const systemPrompt = mode === "attachment" ? buildSystemPromptAttachment() : buildSystemPromptGeneral();

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
    },
    mode === "attachment" ? 30000 : 20000
  );

  if (!response.ok) {
    console.error("❌ Groq API error:", await response.text());
    throw new Error("Groq API failed");
  }

  const data = await response.json();
  const reply = data.choices?.[0]?.message?.content?.trim();
  return reply || "لم أستطع استخراج نتيجة واضحة.";
}

// ===============================
// OCR / PDF
// ===============================
async function ocrImage(buf) {
  const pre = await sharp(buf).grayscale().normalize().toBuffer();
  const { data } = await Tesseract.recognize(pre, "ara+eng");
  return (data?.text || "").trim();
}

async function extractTextFromPdf(buf) {
  const data = await pdfParse(buf);
  return (data?.text || "").trim();
}

// ===============================
// Routes
// ===============================
app.get("/", (_req, res) => {
  res.json({ status: "ok", service: "dr-nus7 api", model: MODEL_ID });
});

app.post("/chat", async (req, res) => {
  try {
    const sessionId = getSessionId(req);
    const msg = redactPII(String(req.body?.message || "").trim());
    if (!msg) return res.status(400).json({ reply: "لم يصلني نص." });

    const reply = await askAssistant(msg, sessionId, "general");
    res.json({ reply });
  } catch (err) {
    console.error("❌ Error in /chat:", err);
    res.status(500).json({ reply: "حدث خطأ. حاول مرة أخرى." });
  }
});

// ✅ زر المرفق يرسل هنا: /report
app.post("/report", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ reply: "لم يصلني ملف." });

    const sessionId = getSessionId(req);
    const mime = String(req.file.mimetype || "");
    const buf = req.file.buffer;

    // --------------------
    // PDF
    // --------------------
    if (mime === "application/pdf") {
      const extracted = await extractTextFromPdf(buf);

      // PDF ممسوح (صور)
      if (!extracted || extracted.length < 30) {
        return res.status(400).json({
          reply:
            "هذا الـ PDF غالبًا ممسوح (Scan) لذلك ما فيه نص قابل للقراءة.\n" +
            "الحل: ارفع صورة واضحة لصفحة التقرير، أو ارفع تقرير الأشعة/التحاليل المكتوب.",
        });
      }

      const prompt = redactPII(`المرفق عبارة عن تقرير/تحاليل PDF.\nالنص:\n${extracted}`);
      const reply = await askAssistant(prompt, sessionId, "attachment");
      return res.json({ reply });
    }

    // --------------------
    // IMAGE (تحاليل/أشعة/جرح...)
    // --------------------
    if (mime.startsWith("image/")) {
      const extracted = await ocrImage(buf);

      // ✅ إذا ما فيه نص: لا تفشل — قد تكون أشعة أو صورة حالة
      if (!extracted || extracted.length < 10) {
        const hint =
          "تم رفع صورة طبية بدون نص واضح (قد تكون أشعة أو جرح/حالة).\n" +
          "المطلوب: شرح عام وآمن مختصر (4–6 أسطر):\n" +
          "- إذا كانت أشعة: قل إن الصورة وحدها لا تكفي للتشخيص واطلب تقرير الأشعة إن وُجد.\n" +
          "- إذا كانت جرح/جلد/بول: صف بشكل عام فقط واذكر متى يراجع الطبيب.\n" +
          "مهم: بدون تشخيص أو علاج.";

        const reply = await askAssistant(hint, sessionId, "attachment");
        return res.json({ reply });
      }

      // صورة فيها نص (تحاليل/تقرير مصور)
      const prompt = redactPII(`المرفق صورة تقرير/تحاليل.\nالنص:\n${extracted}`);
      const reply = await askAssistant(prompt, sessionId, "attachment");
      return res.json({ reply });
    }

    return res.status(415).json({ reply: "نوع الملف غير مدعوم. ارفع PDF أو صورة." });
  } catch (err) {
    console.error("❌ Error in /report:", err);
    res.status(500).json({ reply: "حدث خطأ أثناء قراءة المرفق. جرّب ملفًا آخر." });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 الخادم يعمل على البورت ${PORT} — النموذج: ${MODEL_ID}`);
});
