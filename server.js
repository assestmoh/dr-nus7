// =====================================
// server.js — Dalil Alafiyah API (Chat + Report)
// =====================================

import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import fetch from "node-fetch";
import multer from "multer";
import pdfParse from "pdf-parse";

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
// Upload (memory)
// ===============================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
});

// ===============================
// Session Memory (in-memory)
// ===============================
const sessions = new Map();
const SESSION_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours
const MAX_HISTORY = 10;

function getUserId(req, body) {
  const h = (req.get("x-user-id") || "").trim();
  if (h) return h;
  const b = (body?.user_id || "").trim();
  if (b) return b;
  return "anon";
}

function getSession(userId) {
  const now = Date.now();
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

// ===============================
// Helpers
// ===============================
async function fetchWithTimeout(url, options = {}, ms = 25000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

function extractJson(text) {
  const s = String(text || "").trim();
  try { return JSON.parse(s); } catch {}
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a === -1 || b === -1 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

const sStr = (v) => (typeof v === "string" ? v.trim() : "");
const sArr = (v, n) =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).slice(0, n) : [];

function clampCategory(cat) {
  const allowed = new Set([
    "general","nutrition","sleep","activity","mental","skin","bp","sugar","firstaid","report","emergency",
  ]);
  if (cat === "blood_pressure") return "bp";
  if (cat === "first_aid") return "firstaid";
  return allowed.has(cat) ? cat : "general";
}

// ===============================
// Prompts
// ===============================
function buildSystemPromptChat() {
  return `
أنت "دليل العافية" — مساعد عربي للتثقيف الصحي فقط.

مهم جدًا:
- أخرج JSON فقط بدون أي نص قبل/بعد، وبدون Markdown.
- لا تشخيص. لا وصف أدوية. لا جرعات.
- ممنوع اختراع روابط أو قول "حمّل PDF من الرابط" إذا ما فيه رابط فعلي.

صيغة الإخراج (ثابتة):
{
  "category": "general|nutrition|sleep|activity|mental|skin|bp|sugar|firstaid|report|emergency",
  "title": "عنوان قصير (2-5 كلمات)",
  "verdict": "جملة واحدة واضحة: تطمين/إرشاد/تنبيه",
  "tips": ["نصيحة قصيرة 1","نصيحة قصيرة 2"],
  "when_to_seek_help": "متى تراجع الطبيب/الطوارئ (أو \\"\\" )",
  "next_question": "سؤال متابعة واحد فقط (أو \\"\\" )",
  "quick_choices": ["خيار 1","خيار 2"]
}

قواعد:
- tips غالبًا 2 فقط.
- next_question سؤال واحد فقط، وإذا "" اجعل quick_choices [].
- إذا رسالة المستخدم قصيرة (نعم/لا/اختيار) اعتبرها إجابة للسؤال الأخير واستمر بنفس الموضوع.
`.trim();
}

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
      "إذا رسالة المستخدم تبدو إجابة قصيرة (نعم/لا/اختيار)، اربطها بالسؤال الأخير ولا تغيّر الموضوع.",
  };
  return JSON.stringify(ctx);
}

function buildSystemPromptReport() {
  return `
أنت مساعد عربي للتثقيف الصحي.
المستخدم أرسل نص تقرير/تحاليل (قد يكون ناقص/غير واضح).
اكتب شرحًا مبسطًا ومنظمًا:

- ابدأ بملخص سريع.
- اذكر القيم/البنود الواضحة فقط ولا تخترع أرقام.
- فسّر ما تعنيه النتائج بشكل عام (بدون تشخيص).
- اذكر متى يُفضّل مراجعة الطبيب.
- اختم بسؤال واحد لتحديد المعلومة الناقصة إن لزم.

ممنوع اختراع روابط أو وصف أدوية أو جرعات.
`.trim();
}

// ===============================
// Groq callers
// ===============================
async function callGroqJson(messages) {
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
        temperature: 0.25,
        max_tokens: 650,
        response_format: { type: "json_object" },
        messages,
      }),
    },
    25000
  );

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error("Groq API error: " + res.status + " " + t);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

async function callGroqText(messages) {
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
        temperature: 0.25,
        max_tokens: 900,
        messages,
      }),
    },
    35000
  );

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error("Groq API error: " + res.status + " " + t);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

// ===============================
// Normalize chat card
// ===============================
function normalizeCard(obj) {
  const category = clampCategory(sStr(obj?.category) || "general");
  const title = sStr(obj?.title) || "دليل العافية";
  const verdict = sStr(obj?.verdict) || "معلومة عامة للتوعية.";
  const tips = sArr(obj?.tips, 2);
  const when_to_seek_help = sStr(obj?.when_to_seek_help) || "";
  const next_question = sStr(obj?.next_question) || "";
  const quick_choices = sArr(obj?.quick_choices, 2);

  return {
    category,
    title,
    verdict,
    tips,
    when_to_seek_help,
    next_question,
    quick_choices: next_question ? quick_choices : [],
  };
}

function fallbackCard(text) {
  return {
    category: "general",
    title: "معلومة عامة",
    verdict: sStr(text) || "لا تتوفر معلومات كافية.",
    tips: [],
    when_to_seek_help: "",
    next_question: "",
    quick_choices: [],
  };
}

// ===============================
// Report extractors
// ===============================
function cleanExtractedText(t) {
  return String(t || "")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function ocrImageIfAvailable(buffer) {
  // اختياري: إذا ما ثبّت tesseract.js بيرجع null بدون ما يطيح السيرفر
  try {
    const mod = await import("tesseract.js");
    const { createWorker } = mod;

    const worker = await createWorker();
    await worker.loadLanguage("eng"); // OCR إنجليزي فقط غالبًا. (العربي يحتاج إعداد إضافي)
    await worker.initialize("eng");
    const { data } = await worker.recognize(buffer);
    await worker.terminate();

    const text = cleanExtractedText(data?.text || "");
    return text || null;
  } catch {
    return null;
  }
}

// ===============================
// Routes
// ===============================
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "Dalil Alafiyah API" });
});

// ---------- CHAT ----------
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
    const last = session.lastCard;

    if (meta?.is_choice === true && last?.next_question) {
      userContent =
        `إجابة المستخدم على السؤال السابق:\n` +
        `السؤال: ${last.next_question}\n` +
        `الإجابة: ${msg}\n` +
        `الموضوع: ${last.title}\n`;
    }

    const messages = [
      { role: "system", content: buildSystemPromptChat() },
      { role: "system", content: buildContextMessage(session, clientContext) },
    ];

    if (Array.isArray(session.history) && session.history.length) {
      for (const h of session.history.slice(-MAX_HISTORY)) {
        if (h?.role && typeof h.content === "string") messages.push(h);
      }
    }

    messages.push({ role: "user", content: userContent });

    const raw = await callGroqJson(messages);
    const parsed = extractJson(raw);
    const data = parsed ? normalizeCard(parsed) : fallbackCard(raw);

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
      data: fallbackCard("حدث خطأ غير متوقع. إذا الأعراض مقلقة راجع الطبيب."),
    });
  }
});

// ---------- REPORT ----------
app.post("/report", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ ok: false, error: "no_file", reply: "ما وصلني ملف. جرّب مرة ثانية." });
    }

    const mime = String(file.mimetype || "");
    let extracted = "";

    if (mime === "application/pdf") {
      // PDF نصي (لو PDF Scan غالبًا بيطلع فاضي)
      const parsed = await pdfParse(file.buffer);
      extracted = cleanExtractedText(parsed?.text || "");
      if (extracted.length < 50) {
        return res.json({
          ok: true,
          reply:
            "قرأت الـ PDF لكن ما طلع نص واضح (يبدو Scan/صورة).\n" +
            "جرّب: 1) ارفع **صورة أوضح**، أو 2) الصق **نص النتائج** داخل المحادثة.",
        });
      }
    } else if (mime.startsWith("image/")) {
      // صورة: OCR اختياري
      const ocr = await ocrImageIfAvailable(file.buffer);
      if (!ocr || ocr.length < 30) {
        return res.json({
          ok: true,
          reply:
            "وصلتني الصورة، لكن ما أقدر أستخرج النص منها الآن.\n" +
            "الحل الأسرع: الصق **نص التقرير/النتائج** هنا، أو ارفع **PDF نصي** (غير ممسوح).",
        });
      }
      extracted = ocr;
    } else {
      return res.status(400).json({
        ok: false,
        error: "unsupported_type",
        reply: "نوع الملف غير مدعوم. ارفع صورة أو PDF فقط.",
      });
    }

    // قلّل النص عشان لا يطير التوكنز
    if (extracted.length > 6000) extracted = extracted.slice(0, 6000);

    const answer = await callGroqText([
      { role: "system", content: buildSystemPromptReport() },
      { role: "user", content: "نص التقرير/النتائج:\n" + extracted },
    ]);

    res.json({ ok: true, reply: String(answer || "").trim() || "ما قدرت أطلع شرح واضح. الصق النتائج كنص أفضل." });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      ok: false,
      error: "server_error",
      reply: "صار خطأ أثناء قراءة التقرير. جرّب مرة ثانية أو الصق النص بدل الملف.",
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Dalil Alafiyah API يعمل على ${PORT}`);
});
