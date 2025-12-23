// ===============================
// server.js — Dalil Alafiyah API (Final)
// ===============================

import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import fetch from "node-fetch";
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

if (!GROQ_API_KEY) {
  console.error("❌ GROQ_API_KEY غير مضبوط");
  process.exit(1);
}

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ===============================
// Upload (for /report)
// ===============================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
});

// ===============================
// Session Memory (in-memory)
// ===============================
const sessions = new Map();
/**
 * session = {
 *   lastCard: {...},
 *   history: [{ role:"user"|"assistant", content:string }],
 *   updatedAt: number
 * }
 */
const SESSION_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours
const MAX_HISTORY = 8;

function getUserId(req, body) {
  const h = (req.get("x-user-id") || "").trim();
  if (h) return h;
  const b = (body?.user_id || "").trim();
  if (b) return b;
  return "anon";
}

function getSession(userId) {
  const now = Date.now();

  // cleanup occasionally
  for (const [k, s] of sessions.entries()) {
    if (!s?.updatedAt || now - s.updatedAt > SESSION_TTL_MS) sessions.delete(k);
  }

  if (!sessions.has(userId)) {
    sessions.set(userId, { lastCard: null, history: [], updatedAt: now });
  }
  const s = sessions.get(userId);
  s.updatedAt = now;
  return s;
}

function resetSession(userId) {
  sessions.delete(userId);
}

// ===============================
// Helpers
// ===============================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithTimeout(url, options = {}, ms = 20000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

// robust JSON extraction (fallback only)
function extractJson(text) {
  const s = String(text || "").trim();

  try {
    return JSON.parse(s);
  } catch {}

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
  Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).slice(0, n) : [];

function clampCategory(cat) {
  const allowed = new Set([
    "general",
    "mental",
    "report",
    "bmi",
    "bp",
    "sugar",
    "water",
    "calories",
    "emergency",
  ]);

  // legacy mapping just in case
  if (cat === "blood_pressure") return "bp";
  if (cat === "first_aid") return "general";

  return allowed.has(cat) ? cat : "general";
}

// ===============================
// System Prompt (Chat)
// ===============================
function buildSystemPrompt() {
  // روابط شفاء الرسمية (ثابتة) — بدون اختراع
  const SHIFAA_ANDROID =
    "https://play.google.com/store/apps/details?id=om.gov.moh.phr&pcampaignid=web_share";
  const SHIFAA_IOS =
    "https://apps.apple.com/us/app/%D8%B4-%D9%81-%D8%A7%D8%A1/id1455936672?l=ar";

  return `
أنت "دليل العافية" — مساعد عربي للتثقيف الصحي فقط.

مهم جدًا:
- أخرج JSON فقط بدون أي نص قبل/بعد، وبدون تنسيق Markdown.
- لا تشخيص. لا وصف أدوية. لا جرعات.
- اجعل الرد مرتبطًا مباشرة بسؤال المستخدم وسياقه السابق إن وُجد.
- ممنوع اختراع أرقام هواتف أو روابط حجز أو أسماء جهات. إذا سأل عن "مواعيد/حجز/نتائج/ملف صحي" في عُمان:
  قدّم روابط تطبيق شفاء الرسمية فقط:
  Android: ${SHIFAA_ANDROID}
  iOS: ${SHIFAA_IOS}

إذا كانت رسالة المستخدم "تحية" فقط (مثل: السلام عليكم/هلا) رد بتحية قصيرة واسأل سؤال واحد واضح.

صيغة الإخراج (ثابتة):
{
  "category": "general|mental|report|bmi|bp|sugar|water|calories|emergency",
  "title": "عنوان قصير (2-5 كلمات)",
  "verdict": "جملة واحدة واضحة: تطمين/إرشاد/تنبيه",
  "tips": ["نصيحة قصيرة 1","نصيحة قصيرة 2"],
  "when_to_seek_help": "متى تراجع الطبيب/الطوارئ (أو \"\")",
  "next_question": "سؤال متابعة واحد فقط (أو \"\")",
  "quick_choices": ["خيار 1","خيار 2"]
}

قواعد جودة:
- tips: بالعادة 2 فقط (قصيرة وعملية).
- next_question: سؤال واحد فقط. إذا ما تحتاج سؤال ضع "" واجعل quick_choices [].
- quick_choices: 0 إلى 2 خيارات فقط، ويجب أن تكون مرتبطة بالسؤال مباشرة.
- لا تنتقل لموضوع جديد إذا كان إدخال المستخدم قصيرًا ويبدو "إجابة" على سؤال سابق.
`.trim();
}

// ===============================
// System Prompt (Report)
// ===============================
function buildReportSystemPrompt() {
  return `
أنت "دليل العافية" — مساعد عربي للتثقيف الصحي فقط.

مهم جدًا:
- أخرج JSON فقط بدون أي نص قبل/بعد، وبدون تنسيق Markdown.
- لا تشخيص. لا وصف أدوية. لا جرعات.
- أنت تشرح تقرير/تحاليل بشكل مبسط: ما معنى البنود، وما الذي يستدعي مراجعة الطبيب.
- إذا لم تظهر "المدى الطبيعي" في التقرير، اسأل عنه في next_question.

صيغة الإخراج:
{
  "category": "report",
  "title": "شرح التقرير",
  "verdict": "جملة واحدة تلخص الصورة العامة",
  "tips": ["نقطة مهمة 1","نقطة مهمة 2"],
  "when_to_seek_help": "متى تراجع الطبيب/الطوارئ (أو \"\")",
  "next_question": "سؤال متابعة واحد فقط (أو \"\")",
  "quick_choices": ["خيار 1","خيار 2"]
}
`.trim();
}

// ===============================
// Build Context Message
// ===============================
function buildContextMessage(session, clientContext) {
  const last = session?.lastCard || clientContext?.last || null;

  const ctx = {
    has_last_card: !!last,
    last_card: last
      ? {
          category: last.category || "",
          title: last.title || "",
          verdict: last.verdict || "",
          next_question: last.next_question || "",
          quick_choices: Array.isArray(last.quick_choices) ? last.quick_choices : [],
        }
      : null,
    instruction:
      "إذا رسالة المستخدم قصيرة (مثل نعم/لا أو اختيار) فاعتبرها إجابة للسؤال الأخير واستمر بنفس الموضوع.",
  };

  return JSON.stringify(ctx);
}

// ===============================
// Groq (with retry for 429)
// ===============================
async function callGroq(messages, { maxTokens = 520 } = {}) {
  const url = "https://api.groq.com/openai/v1/chat/completions";

  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL_ID,
          temperature: 0.25,
          max_tokens: maxTokens,
          response_format: { type: "json_object" },
          messages,
        }),
      },
      25000
    );

    if (res.ok) {
      const data = await res.json();
      return data.choices?.[0]?.message?.content || "";
    }

    const text = await res.text().catch(() => "");
    if (res.status === 429 && attempt < 3) {
      // backoff بسيط
      await sleep(700 * attempt);
      continue;
    }

    throw new Error(`Groq API error: ${res.status} ${text}`);
  }

  throw new Error("Groq API error: retry_failed");
}

// ===============================
// Normalize
// ===============================
function normalize(obj) {
  const category = clampCategory(sStr(obj?.category) || "general");

  const title = sStr(obj?.title) || "دليل العافية";
  const verdict = sStr(obj?.verdict) || "معلومة عامة للتوعية.";
  const tips = sArr(obj?.tips, 2);
  const when_to_seek_help = sStr(obj?.when_to_seek_help);

  const next_question = sStr(obj?.next_question);
  const quick_choices = sArr(obj?.quick_choices, 2);

  const fixedNextQ = next_question ? next_question : "";
  const fixedChoices = fixedNextQ ? quick_choices : [];

  return {
    category,
    title,
    verdict,
    tips,
    when_to_seek_help: when_to_seek_help || "",
    next_question: fixedNextQ,
    quick_choices: fixedChoices,
  };
}

function fallback(text) {
  return {
    category: "general",
    title: "معلومة عامة",
    verdict: sStr(text) || "تعذر توليد رد الآن.",
    tips: [],
    when_to_seek_help: "",
    next_question: "",
    quick_choices: [],
  };
}

// ===============================
// OCR worker (shared)
// ===============================
let OCR_WORKER = null;

async function getOcrWorker() {
  if (OCR_WORKER) return OCR_WORKER;

  // ara+eng قد يأخذ وقت أول مرة (تحميل بيانات)
  const worker = await createWorker("ara+eng");
  OCR_WORKER = worker;
  return worker;
}

async function ocrImageBuffer(buffer) {
  const worker = await getOcrWorker();

  // preprocess via sharp
  const pre = await sharp(buffer)
    .rotate()
    .resize({ width: 1600, withoutEnlargement: true })
    .grayscale()
    .normalize()
    .toBuffer();

  const {
    data: { text },
  } = await worker.recognize(pre);

  return String(text || "").trim();
}

async function extractTextFromPdfBuffer(buffer) {
  const data = await pdfParse(buffer);
  const text = String(data?.text || "").trim();
  return text;
}

// ===============================
// Routes
// ===============================
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "Dalil Alafiyah API" });
});

app.post("/reset", (req, res) => {
  const userId = getUserId(req, req.body || {});
  resetSession(userId);
  res.json({ ok: true });
});

app.post("/chat", async (req, res) => {
  try {
    const body = req.body || {};
    const userId = getUserId(req, body);
    const session = getSession(userId);

    const msg = String(body.message || "").trim();
    if (!msg) return res.status(400).json({ ok: false, error: "empty_message" });

    const meta = body.meta || {};
    const clientContext = body.context || null;

    if (!session.lastCard && clientContext?.last) session.lastCard = clientContext.last;

    let userContent = msg;

    // Explicit choice message
    const last = session.lastCard;
    const isChoice = meta?.is_choice === true;

    if (isChoice && last?.next_question) {
      userContent =
        `إجابة المستخدم على السؤال السابق:\n` +
        `السؤال: ${last.next_question}\n` +
        `الإجابة المختارة: ${msg}\n` +
        `الموضوع: ${last.title}\n`;
    }

    const messages = [
      { role: "system", content: buildSystemPrompt() },
      { role: "system", content: buildContextMessage(session, clientContext) },
    ];

    if (Array.isArray(session.history) && session.history.length) {
      for (const h of session.history.slice(-MAX_HISTORY)) {
        if (h?.role && typeof h.content === "string") messages.push(h);
      }
    }

    messages.push({ role: "user", content: userContent });

    const raw = await callGroq(messages, { maxTokens: 520 });

    const parsed = extractJson(raw);
    const data = parsed ? normalize(parsed) : fallback(raw);

    session.lastCard = data;

    session.history.push({ role: "user", content: userContent });
    session.history.push({ role: "assistant", content: JSON.stringify(data) });
    if (session.history.length > MAX_HISTORY) session.history = session.history.slice(-MAX_HISTORY);

    res.json({ ok: true, data });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      ok: false,
      error: "server_error",
      data: fallback("حدث خطأ غير متوقع. إذا الأعراض مقلقة راجع الطبيب."),
    });
  }
});

app.post("/report", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file?.buffer) {
      return res.status(400).json({ ok: false, error: "no_file" });
    }

    let text = "";
    const mime = String(file.mimetype || "");

    if (mime === "application/pdf") {
      text = await extractTextFromPdfBuffer(file.buffer);

      // PDF سكان غالبًا يطلع نص فاضي
      if (!text || text.length < 40) {
        const data = {
          category: "report",
          title: "لم أستطع قراءة PDF",
          verdict: "هذا الملف يبدو PDF ممسوح (Scan) بدون نص قابل للنسخ.",
          tips: [
            "جرّب رفع صورة واضحة للتقرير بدل PDF.",
            "أو الصق النص هنا مباشرة إذا متوفر.",
          ],
          when_to_seek_help: "",
          next_question: "هل يمكنك رفع صورة للتقرير أو لصق النص؟",
          quick_choices: ["سأرفع صورة", "سألصق النص"],
        };
        return res.json({ ok: true, data });
      }
    } else if (mime.startsWith("image/")) {
      text = await ocrImageBuffer(file.buffer);

      if (!text || text.length < 30) {
        const data = {
          category: "report",
          title: "الصورة غير واضحة",
          verdict: "النص في الصورة غير مقروء بشكل كافٍ.",
          tips: [
            "ارفع صورة أقرب وواضحة بإضاءة جيدة وبدون اهتزاز.",
            "تأكد أن النتائج والارقام ظاهرة بالكامل.",
          ],
          when_to_seek_help: "",
          next_question: "هل تقدر تعيد التصوير بصورة أوضح؟",
          quick_choices: ["نعم", "لا"],
        };
        return res.json({ ok: true, data });
      }
    } else {
      return res.status(400).json({ ok: false, error: "unsupported_type" });
    }

    const userId = getUserId(req, req.body || {});
    const session = getSession(userId);

    const messages = [
      { role: "system", content: buildReportSystemPrompt() },
      { role: "system", content: buildContextMessage(session, null) },
      {
        role: "user",
        content:
          "هذا نص التقرير/التحاليل:\n" +
          text +
          "\n\nاشرحه بشكل مبسط وآمن، واذكر إذا يحتاج مراجعة طبيب.",
      },
    ];

    const raw = await callGroq(messages, { maxTokens: 620 });

    const parsed = extractJson(raw);
    const data = parsed ? normalize({ ...parsed, category: "report" }) : fallback(raw);

    session.lastCard = data;

    res.json({ ok: true, data });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      ok: false,
      error: "server_error",
      data: fallback("تعذر قراءة التقرير الآن. جرّب صورة أوضح أو الصق النص."),
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Dalil Alafiyah API يعمل على ${PORT}`);
});
