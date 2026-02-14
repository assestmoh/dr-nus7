// ===============================
// server.js — Dalil Alafiyah API (Report Flow + No-code leakage)
// ===============================
//
// ✅ يحافظ على سيرفرك البسيط
// ✅ يمنع ظهور JSON/كود داخل البطاقات
// ✅ يضيف "مسار افهم تقريرك" ثابت مثل الصورة (بدون استدعاء موديل)
// ✅ يضيف /report لاستقبال ملف (PDF/صورة) ويرجع بطاقة شرح عامة
// ✅ إذا OCR غير متوفر/فشل: يعطي بطاقة تطلب PDF نصّي أو لصق النص
//
// ملاحظة مهمة:
// الواجهة عندك جاهزة: زر "📎 إضافة مرفق" يفتح منتقي الملفات (Windows/Android/iOS)
// عبر openAttachmentPicker() داخل app.js، فلا تحتاج تغيير بالواجهة.

import "dotenv/config";
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import helmet from "helmet";
import multer from "multer";

// pdf-parse (CommonJS)
import { createRequire } from "module";
const require = createRequire(import.meta.url);
let pdfParse = null;
try {
  pdfParse = require("pdf-parse");
} catch {}

// tesseract.js (اختياري)
let createWorker = null;
try {
  ({ createWorker } = await import("tesseract.js"));
} catch {}

const app = express();
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB

// ===============================
// ENV
// ===============================
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MODEL_ID = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const PORT = process.env.PORT || 3000;

if (!GROQ_API_KEY) {
  console.error("❌ GROQ_API_KEY غير مضبوط");
  process.exit(1);
}

app.use(helmet());

// CORS: خليته مفتوح لأنك تستخدم localhost + koyeb
app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-user-id", "X-User-Id"],
  })
);

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

function sanitizeText(v) {
  let s = typeof v === "string" ? v : "";
  s = s.trim();
  // إزالة أي code block بالكامل
  s = s.replace(/```[\s\S]*?```/g, "").trim();
  // إزالة backticks
  s = s.replace(/`+/g, "").trim();
  // تقليل فراغات كثيرة
  s = s.replace(/\s{3,}/g, " ").trim();
  return s;
}

function extractJson(text) {
  let s = String(text || "").trim();

  // إزالة fences
  s = s.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();

  // parse مباشر
  try {
    return JSON.parse(s);
  } catch {}

  // قص أول object
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a === -1 || b === -1 || b <= a) return null;

  const candidate = s.slice(a, b + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

const sStr = (v) => sanitizeText(v);
const sArr = (v, n) =>
  Array.isArray(v)
    ? v.map(sanitizeText).filter((x) => x).slice(0, n)
    : [];

function normalize(obj) {
  return {
    category: sStr(obj?.category) || "general",
    title: sStr(obj?.title) || "دليل العافية",
    verdict: sStr(obj?.verdict),
    next_question: sStr(obj?.next_question),
    quick_choices: sArr(obj?.quick_choices, 3),
    tips: sArr(obj?.tips, 4), // للتقرير نحتاج 3-4 نقاط أحيانًا
    when_to_seek_help: sStr(obj?.when_to_seek_help),
  };
}

function ensureCardShape(d) {
  const x = d || {};
  return {
    category: sStr(x.category) || "general",
    title: sStr(x.title) || "دليل العافية",
    verdict: sStr(x.verdict) || "",
    next_question: sStr(x.next_question) || "",
    quick_choices: Array.isArray(x.quick_choices) ? x.quick_choices : [],
    tips: Array.isArray(x.tips) ? x.tips : [],
    when_to_seek_help: sStr(x.when_to_seek_help) || "",
  };
}

// ✅ fallback ثابت: لا يعرض raw للمستخدم
function fallbackCard() {
  return {
    category: "general",
    title: "دليل العافية",
    verdict: "لم أستلم الرد بالشكل المطلوب. اكتب سؤالك بجملة واحدة وسأساعدك.",
    next_question: "وش تقصد بالضبط؟ (الأعراض/المدة/العمر إن أمكن)",
    quick_choices: ["سكر", "ضغط", "إسعافات"],
    tips: ["اكتب أهم عرض + مدته", "اذكر إن لديك مرض مزمن"],
    when_to_seek_help: "إذا ألم صدر/ضيق نفس/إغماء/نزيف شديد: طوارئ فورًا.",
  };
}

// ===============================
// ثابت: بطاقة "افهم تقريرك" مثل صورتك
// ===============================
function reportEntryCard() {
  return {
    category: "report",
    title: "افهم تقريرك",
    verdict: "تمام. ارفع صورة أو PDF للتقرير في زر المرفق، وأنا أشرح بشكل عام.",
    next_question: "جاهز ترفع التقرير؟",
    quick_choices: ["📎 إضافة مرفق", "إلغاء"],
    tips: ["لا ترفع بيانات شخصية حساسة إن أمكن."],
    when_to_seek_help: "إذا أعراض شديدة مع التقرير: راجع الطبيب/الطوارئ.",
  };
}

function isReportIntent(text) {
  const t = String(text || "");
  return /(افهم\s*تقرير|تقرير|تحاليل|تحليل|نتيجة|lab|report|pdf)/i.test(t);
}

function isCancel(text) {
  return /^(إلغاء|الغاء|cancel|مسح|ابدأ من جديد|ابدأ جديد)$/i.test(
    String(text || "").trim()
  );
}

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
  "quick_choices": ["خيار 1","خيار 2","خيار 3"],
  "tips": ["نصيحة قصيرة 1","نصيحة قصيرة 2"],
  "when_to_seek_help": "متى تراجع الطبيب أو الطوارئ (أو \"\")"
}

قواعد:
- لا تشخيص
- لا أدوية
- لا جرعات
- لغة بسيطة
- quick_choices لا تزيد عن 3 (قصيرة ومباشرة)
- tips لا تزيد عن 2 (مختصرة)
`.trim();
}

function buildReportSystemPrompt() {
  return `
أنت مساعد تثقيف صحي عربي لشرح تقارير التحاليل بشكل عام.
ممنوع: تشخيص مؤكد، وصف أدوية، جرعات، أو خطة علاج.

أخرج JSON فقط بنفس مفاتيح البطاقة:
{
  "category": "report",
  "title": "عنوان قصير",
  "verdict": "شرح عام مختصر (سطرين-3)",
  "next_question": "سؤال واحد (أو \"\")",
  "quick_choices": ["خيار 1","خيار 2"],
  "tips": ["نصيحة 1","نصيحة 2","نصيحة 3"],
  "when_to_seek_help": "متى تراجع الطبيب/الطوارئ"
}
`.trim();
}

// ===============================
// Groq
// ===============================
async function callGroq(messages, { max_tokens = 450 } = {}) {
  const payload = {
    model: MODEL_ID,
    temperature: 0.35,
    max_tokens,
    messages,
    // إن كان مدعوم يقلّل أخطاء JSON، وإن لم يكن: نعيد المحاولة بدونها
    response_format: { type: "json_object" },
  };

  // محاولة 1
  let res = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  // لو فشلت بسبب response_format، جرّب بدونها
  if (!res.ok) {
    const payload2 = { ...payload };
    delete payload2.response_format;

    res = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload2),
    });

    if (!res.ok) throw new Error("Groq API error");
  }

  const data = await res.json().catch(() => ({}));
  return data.choices?.[0]?.message?.content || "";
}

// ===============================
// OCR (اختياري)
// ===============================
let ocrWorkerPromise = null;
async function getOcrWorker() {
  if (!createWorker) return null;
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => {
      const w = await createWorker("eng+ara");
      return w;
    })();
  }
  return ocrWorkerPromise;
}

async function ocrImage(buffer) {
  const w = await getOcrWorker();
  if (!w) return "";
  const { data } = await w.recognize(buffer);
  return data?.text ? String(data.text) : "";
}

// ===============================
// Routes
// ===============================
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "Dalil Alafiyah API" });
});

// ✅ مسار افهم تقريرك: يرجع نفس البطاقة مثل الصورة بدون LLM
app.post("/chat", async (req, res) => {
  try {
    const msg = String(req.body?.message || "").trim();
    if (!msg) return res.status(400).json({ ok: false, error: "empty_message" });

    // إلغاء
    if (isCancel(msg)) {
      return res.json({ ok: true, data: { ...fallbackCard(), title: "تم", verdict: "تم الإلغاء." } });
    }

    // ✅ إذا المستخدم طلب "تقرير/افهم تقريرك" رجّع بطاقة التقرير الثابتة
    // (عشان تكون نفس صورتك دائمًا)
    if (isReportIntent(msg) && msg.length <= 40) {
      return res.json({ ok: true, data: reportEntryCard() });
    }

    // باقي الأسئلة: LLM
    const raw = await callGroq([
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: msg },
    ]);

    const parsed = extractJson(raw);
    if (!parsed) return res.json({ ok: true, data: fallbackCard() });

    const data = ensureCardShape(normalize(parsed));

    // إذا ضعيف جدًا رجع fallback
    const weak =
      !data.verdict &&
      !data.next_question &&
      (!data.tips?.length) &&
      (!data.quick_choices?.length);
    if (weak) return res.json({ ok: true, data: fallbackCard() });

    // ✅ حماية: منع أي كود يظهر داخل verdict
    // (لو sanitize شال كل شيء وبقي فاضي، لا تعرضه)
    if (!data.verdict && data.title && data.title !== "دليل العافية") {
      data.verdict = "أعطني تفاصيل أكثر لأساعدك.";
    }

    res.json({ ok: true, data });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      ok: false,
      error: "server_error",
      data: fallbackCard(),
    });
  }
});

// ✅ استقبال الملف من الواجهة (FormData: file)
// يرجع بطاقة شرح عام
app.post("/report", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ ok: false, error: "missing_file" });

    const mime = String(file.mimetype || "");
    let extractedText = "";

    // PDF: حاول pdf-parse
    if (mime === "application/pdf") {
      if (!pdfParse) {
        return res.json({
          ok: true,
          data: {
            category: "report",
            title: "افهم تقريرك",
            verdict: "استلام PDF تم، لكن خادمك لا يدعم قراءة PDF حالياً.",
            next_question: "هل تقدر تلصق نص التقرير هنا؟",
            quick_choices: ["ألصق النص", "إلغاء"],
            tips: ["إذا PDF صورة (scan) الأفضل ترفع صورة واضحة أو PDF نصي."],
            when_to_seek_help: "إذا أعراض شديدة: راجع الطبيب/الطوارئ.",
          },
        });
      }
      const parsed = await pdfParse(file.buffer).catch(() => null);
      extractedText = parsed?.text ? String(parsed.text) : "";
      extractedText = extractedText.replace(/\s+/g, " ").trim();
    }

    // صورة: حاول OCR إن توفر
    else if (mime.startsWith("image/")) {
      extractedText = await ocrImage(file.buffer);
      extractedText = extractedText.replace(/\s+/g, " ").trim();
    }

    // نوع غير مدعوم
    else {
      return res.status(400).json({ ok: false, error: "unsupported_type" });
    }

    // إذا ما طلع نص كفاية: رجع بطاقة ثابتة بدل ما نخليها تخرب
    if (!extractedText || extractedText.length < 40) {
      return res.json({
        ok: true,
        data: {
          category: "report",
          title: "افهم تقريرك",
          verdict:
            "استلمت الملف، لكن ما قدرت أقرأ منه نص كافي (قد يكون صورة غير واضحة أو PDF ممسوح).",
          next_question: "تقدر ترفع صورة أوضح أو تلصق أهم النتائج هنا؟",
          quick_choices: ["📎 إضافة مرفق", "ألصق النتائج"],
          tips: [
            "صوّر النتائج بإضاءة جيدة وبدون قصّ.",
            "اخفِ اسمك/رقمك إن أمكن.",
          ],
          when_to_seek_help: "إذا أعراض شديدة: راجع الطبيب/الطوارئ.",
        },
      });
    }

    // قص النص لتوفير توكنز
    const clipped = extractedText.slice(0, 5000);

    const raw = await callGroq(
      [
        { role: "system", content: buildReportSystemPrompt() },
        {
          role: "user",
          content:
            "نص مستخرج من تقرير/تحاليل:\n" +
            clipped +
            "\n\nاشرح بشكل عام وباختصار.",
        },
      ],
      { max_tokens: 700 }
    );

    const parsed = extractJson(raw);
    if (!parsed) return res.json({ ok: true, data: fallbackCard() });

    const data = ensureCardShape(normalize({ ...parsed, category: "report" }));

    // ضمان خيارات مناسبة للتقرير
    data.quick_choices = sArr(data.quick_choices, 2);
    if (data.quick_choices.length === 0) data.quick_choices = ["📎 ملف آخر", "سؤال ثاني"];
    data.tips = sArr(data.tips, 4);

    res.json({ ok: true, data });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      ok: false,
      error: "report_error",
      data: {
        category: "report",
        title: "افهم تقريرك",
        verdict: "تعذر تحليل التقرير الآن.",
        next_question: "جرّب ملف أو صورة أوضح، أو الصق النص هنا.",
        quick_choices: ["📎 إضافة مرفق", "إلغاء"],
        tips: ["تجنب رفع بيانات شخصية حساسة."],
        when_to_seek_help: "إذا أعراض شديدة: راجع الطبيب/الطوارئ.",
      },
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Dalil Alafiyah API يعمل على ${PORT}`);
});
