// ===============================
// server.js — شات "نفس القديم" + تقرير/مرفقات (PDF/صورة) بأسلوب مفهوم للمريض
// + Timeout 90s للـ /report
// ===============================

import "dotenv/config";
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fetch from "node-fetch";

import multer from "multer";
import sharp from "sharp";
import Tesseract from "tesseract.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ✅ pdf-parse قد يطلع بأكثر من شكل حسب البيئة
const pdfParseModule = require("pdf-parse");
const pdfParse =
  pdfParseModule?.default ||
  pdfParseModule?.pdfParse ||
  pdfParseModule;

const app = express();

// ===============================
// ENV
// ===============================
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MODEL_ID = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const PORT = process.env.PORT || 3000;

// Limits
const JSON_LIMIT = process.env.JSON_LIMIT || "8mb";
const FILE_LIMIT_BYTES = Number(process.env.FILE_LIMIT_BYTES || 8 * 1024 * 1024);
const MAX_OCR_CHARS = Number(process.env.MAX_OCR_CHARS || 2500);

// Timeouts (✅ المطلوب: 90 ثانية)
const CHAT_TIMEOUT_MS = Number(process.env.CHAT_TIMEOUT_MS || 20000);
const REPORT_TIMEOUT_MS = Number(process.env.REPORT_TIMEOUT_MS || 90000);
const SANITIZE_TIMEOUT_MS = Number(process.env.SANITIZE_TIMEOUT_MS || 20000);

if (!GROQ_API_KEY) {
  console.error("❌ GROQ_API_KEY غير مضبوط");
  process.exit(1);
}

app.use(cors());
app.use(bodyParser.json({ limit: JSON_LIMIT }));

// Upload (memory)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: FILE_LIMIT_BYTES },
});

// Conversations (chat only)
const conversations = {};

// ===============================
// 0) fetchWithTimeout
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

// ===============================
// 1) Prompts
// ===============================
function buildSystemPromptChat() {
  return `
أنت مساعد صحي للتثقيف الصحي فقط.
قدّم معلومات عامة عن الصحة ونمط الحياة، بأسلوب عربي مهني واضح ومريح للقارئ.
تجنّب التشخيص الطبي، وصف الأدوية، أو إعطاء جرعات محددة.
لا تقدّم خطط علاجية مفصلة.
اجعل الإجابة عادة بين 6 و12 سطرًا تقريبًا، مع تنظيم بسيط بنقاط أو عناوين قصيرة.
تجنب الجداول.
يمكنك ذكر متى يفضَّل مراجعة الطبيب أو الطوارئ عند وجود أعراض خطيرة.
`.trim();
}

function buildSystemPromptReport() {
  return `
أنت مساعد صحي للتثقيف فقط.
ستستقبل نص تقرير/تحاليل أو نص مستخرج من صورة/ملف.

المطلوب: شرح النتائج للمريض بلغة عربية بسيطة ومفهومة.
- اشرح "كل فحص مهم" بسطر واحد بسيط (وش يعني إذا مرتفع/منخفض) بدون مصطلحات معقدة.
- لا تستخدم جداول.
- لا تكثر أرقام وحدود مرجعية، فقط اذكر (طبيعي/مرتفع/منخفض/قريب من الحد).
- أعطِ خطوة واضحة للمريض: ماذا يفعل الآن؟
- اختم بسطر "متى تراجع الطبيب بسرعة" إذا في شيء يستدعي.

ممنوع: تشخيص نهائي، أدوية، جرعات، أو خطة علاج مفصلة.

الطول: مريح للمريض (8–14 سطر كحد أقصى).
`.trim();
}

function buildSystemPromptImageNoText() {
  return `
أنت مساعد صحي للتثقيف فقط.
تم رفع صورة طبية بدون نص واضح (قد تكون أشعة أو صورة حالة مثل جرح/جلد/بول).

- لا تشخص من الصورة.
- إذا كانت أشعة: وضّح أن الصورة وحدها لا تكفي للتشخيص واطلب تقرير الأشعة المكتوب إن وُجد، وقدّم شرحًا عامًا ماذا تُستخدم الأشعة له.
- إذا كانت صورة حالة: صف بشكل عام ما يمكن ملاحظته عادةً (بدون جزم) واذكر علامات الخطر التي تستدعي الطبيب.
- أعطِ نصيحة بسيطة للمريض: ماذا يفعل الآن؟

الطول: 6–10 سطور، بدون جداول.
`.trim();
}

// ===============================
// 2) Safety filter (non-food)
// ===============================
const NON_FOOD_KEYWORDS = ["بنزين", "زجاج", "بلاستيك", "مادة تنظيف", "منظفات", "مبيض", "فولاذ"];
const EAT_DRINK_VERBS = ["تناول", "أكل", "اشرب", "شرب"];

function hasNonFoodConsumption(text) {
  return EAT_DRINK_VERBS.some((v) => text.includes(v)) && NON_FOOD_KEYWORDS.some((w) => text.includes(w));
}

const SAFETY_NOTE = `
لضمان دقة وسلامة المعلومات، جرى استبدال الجزء غير المناسب بمحتوى صحي عام.
• الامتناع عن أي مواد غير صالحة للاستهلاك.
• التركيز على الغذاء الصحي، وشرب الماء بانتظام، والحصول على نوم كافٍ.
• مراجعة الطبيب عند وجود أي أعراض تتطلب التقييم.
`.trim();

async function sanitizeReply(originalReply) {
  if (!hasNonFoodConsumption(originalReply)) return originalReply;

  try {
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
          messages: [
            {
              role: "system",
              content: "أنت محرر نص صحي. احذف أي اقتراح لتناول/شرب مواد غير صالحة للاستهلاك، وقدّم بديلًا صحيًا عامًا مختصرًا.",
            },
            { role: "user", content: originalReply },
          ],
        }),
      },
      SANITIZE_TIMEOUT_MS
    );

    if (!response.ok) {
      console.error("❌ sanitizeReply API error:", await response.text());
      return SAFETY_NOTE;
    }

    const data = await response.json();
    const cleaned = data.choices?.[0]?.message?.content?.trim() || "";
    return cleaned ? `${cleaned}\n\n${SAFETY_NOTE}` : SAFETY_NOTE;
  } catch (err) {
    console.error("❌ sanitizeReply error:", err);
    return SAFETY_NOTE;
  }
}

// ===============================
// 3) Blocked words
// ===============================
const BLOCKED_WORDS = [
  "زب","قضيب","كس","طيز","عير","مني","فرج","شهوة","قذف","احتلام",
  "فقحة","سمبول","سنبول","مفسى","مفسي","مضرط","مضرّط",
];

function hasBlockedWords(text) {
  return BLOCKED_WORDS.some((w) => text.includes(w));
}

// ===============================
// 4) Danger words
// ===============================
const DANGER_WORDS = [
  "ألم صدر","ألم في الصدر","ضيق نفس","صعوبة في التنفس","فقدان وعي","اغمي","إغماء","نزيف","تشنج","صداع شديد","سكتة","جلطة",
];

// ===============================
// 5) Continue rewriting
// ===============================
const CONTINUE_WORDS = ["كمل", "كمّل", "أكمل", "تابع", "كملي"];
function rewriteContinueWord(message) {
  const trimmed = message.trim();
  if (CONTINUE_WORDS.includes(trimmed)) {
    return "من فضلك أكمل الشرح السابق بشكل مبسّط وواضح، مع البقاء في نفس الموضوع وعدم فتح موضوع جديد.";
  }
  return message;
}

// ===============================
// 6) Redact PII
// ===============================
function redactPII(text) {
  let t = String(text || "");
  t = t.replace(/\b\d{7,}\b/g, "[رقم محذوف]");
  t = t.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[بريد محذوف]");
  return t;
}

// ===============================
// 7) Groq call (with timeout)
// ===============================
async function callGroq(messages, { temperature = 0.4, max_tokens = 1200, timeoutMs = CHAT_TIMEOUT_MS } = {}) {
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
        temperature,
        max_tokens,
        messages,
      }),
    },
    timeoutMs
  );

  if (!response.ok) {
    console.error("❌ Groq API error:", await response.text());
    throw new Error("Groq API failed");
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() || "";
}

// ===============================
// 8) Chat (old style)
// ===============================
async function askHealthAssistantChat(userMessage, sessionId) {
  if (!conversations[sessionId]) conversations[sessionId] = [];

  conversations[sessionId].push({ role: "user", content: userMessage });
  if (conversations[sessionId].length > 6) conversations[sessionId] = conversations[sessionId].slice(-6);

  const messages = [{ role: "system", content: buildSystemPromptChat() }, ...conversations[sessionId]];
  let reply = await callGroq(messages, { temperature: 0.4, max_tokens: 1200, timeoutMs: CHAT_TIMEOUT_MS });

  reply = await sanitizeReply(reply);
  if (!reply) reply = "لا تتوفر لدي معلومات كافية. يُفضّل استشارة مقدم رعاية صحية.";

  conversations[sessionId].push({ role: "assistant", content: reply });
  return reply;
}

// ===============================
// 9) Report (separate from chat history)
// ===============================
async function askHealthAssistantReport(reportText, sessionId) {
  const messages = [
    { role: "system", content: buildSystemPromptReport() },
    { role: "user", content: reportText },
  ];

  let reply = await callGroq(messages, {
    temperature: 0.25,
    max_tokens: 900,
    timeoutMs: REPORT_TIMEOUT_MS, // ✅ 90s
  });

  reply = await sanitizeReply(reply);
  return reply || "لم أستطع استخراج شرح واضح من التقرير. جرّب صورة أوضح أو تقرير آخر.";
}

// ===============================
// 10) OCR / PDF helpers
// ===============================
async function ocrImageBufferToText(buf) {
  try {
    // محاولة تحسين الصورة (قد تفشل مع HEIC)
    const pre = await sharp(buf).grayscale().normalize().toBuffer();
    const { data } = await Tesseract.recognize(pre, "ara+eng");
    return (data?.text || "").trim();
  } catch (e) {
    // fallback: OCR مباشر بدون sharp
    const { data } = await Tesseract.recognize(buf, "ara+eng");
    return (data?.text || "").trim();
  }
}

async function extractTextFromPdfBuffer(buf) {
  if (typeof pdfParse !== "function") {
    // عشان ما تتكرر لك pdfParse is not a function بدون تفسير
    throw new Error("pdf-parse import is not a function in this environment");
  }
  const data = await pdfParse(buf);
  return (data?.text || "").trim();
}

// ===============================
// 11) Routes
// ===============================
app.get("/", (_req, res) => {
  res.json({ status: "ok", service: "Sehatek Plus API", model: MODEL_ID });
});

app.post("/chat", async (req, res) => {
  try {
    let rawMessage = (req.body.message || "").toString().trim();
    if (!rawMessage) return res.status(400).json({ reply: "لم يصلني نص." });

    if (hasBlockedWords(rawMessage)) {
      return res.json({
        reply: "يبدو أن الرسالة تحتوي على تعبير غير مناسب.\nيرجى كتابة سؤالك الصحي بشكل واضح ومحترم لأتمكن من مساعدتك.",
      });
    }

    rawMessage = rewriteContinueWord(rawMessage);
    let userMessage = redactPII(rawMessage);

    const sessionId =
      (req.headers["x-session-id"] && req.headers["x-session-id"].toString().slice(0, 32)) ||
      req.ip ||
      "default";

    if (DANGER_WORDS.some((w) => userMessage.includes(w))) {
      userMessage += "\n\n[تنبيه للنموذج: قد تحتوي الرسالة على أعراض خطيرة. وضّح متى يجب مراجعة الطوارئ.]";
    }

    const reply = await askHealthAssistantChat(userMessage, sessionId);
    res.json({ reply });
  } catch (err) {
    console.error("❌ Error in /chat:", err);
    res.status(500).json({
      reply: "حدث خطأ غير متوقع أثناء معالجة الطلب. يُفضّل إعادة المحاولة، أو مراجعة طبيب عند وجود أعراض مقلقة.",
    });
  }
});

// ✅ PDF/صورة
app.post("/report", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ reply: "لم يصلني ملف." });

    const sessionId =
      (req.headers["x-session-id"] && req.headers["x-session-id"].toString().slice(0, 32)) ||
      req.ip ||
      "default";

    const mime = String(req.file.mimetype || "");
    const buf = req.file.buffer;

    // PDF
    if (mime === "application/pdf") {
      let extracted = await extractTextFromPdfBuffer(buf);

      if (!extracted || extracted.length < 30) {
        return res.status(400).json({
          reply: "هذا الـ PDF غالبًا ممسوح (Scan) وما فيه نص قابل للقراءة.\nارفع صورة واضحة لصفحة التقرير أو أرفق التقرير المكتوب.",
        });
      }

      extracted = extracted.slice(0, MAX_OCR_CHARS);
      const reportText = redactPII(`نص التقرير:\n${extracted}`);
      const reply = await askHealthAssistantReport(reportText, sessionId);
      return res.json({ reply });
    }

    // Image
    if (mime.startsWith("image/")) {
      let extracted = await ocrImageBufferToText(buf);

      // إذا ما فيه نص واضح: أشعة/حالة بدون نص
      if (!extracted || extracted.trim().length < 10) {
        const hint = redactPII(
          "تم رفع صورة طبية بدون نص واضح (قد تكون أشعة أو جرح/جلد/بول).\n" +
          "اشرح للمريض بشكل عام وآمن: ما الذي تعنيه عادةً هذه الصور؟ ومتى يراجع الطبيب؟\n" +
          "بدون تشخيص أو أدوية."
        );

        const messages = [
          { role: "system", content: buildSystemPromptImageNoText() },
          { role: "user", content: hint },
        ];

        let reply = await callGroq(messages, {
          temperature: 0.3,
          max_tokens: 700,
          timeoutMs: REPORT_TIMEOUT_MS, // ✅ 90s
        });

        reply = await sanitizeReply(reply);
        return res.json({
          reply: reply || "وصلت الصورة، لكن لا أستطيع تأكيد شيء طبي منها بدون تقرير مكتوب.",
        });
      }

      extracted = extracted.slice(0, MAX_OCR_CHARS);
      const reportText = redactPII(`نص التقرير:\n${extracted}`);
      const reply = await askHealthAssistantReport(reportText, sessionId);
      return res.json({ reply });
    }

    return res.status(415).json({ reply: "نوع الملف غير مدعوم. ارفع PDF أو صورة." });
  } catch (err) {
    console.error("❌ Error in /report:", err);
    res.status(500).json({ reply: "حدث خطأ أثناء قراءة المرفق. جرّب ملفًا آخر أو صورة أوضح." });
  }
});

// ===============================
// Start server
// ===============================
app.listen(PORT, () => {
  console.log(`🚀 الخادم يعمل على البورت ${PORT} — النموذج: ${MODEL_ID}`);
});
