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
// Session Memory (in-memory)
// ===============================
const sessions = new Map();
/**
 * session = {
 *   lastCard: { category,title,verdict,tips,when_to_seek_help,next_question,quick_choices },
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

  // cleanup occasionally (cheap)
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

function extractJson(text) {
  const s = String(text || "").trim();

  // If it's already valid JSON:
  try {
    return JSON.parse(s);
  } catch {}

  // Otherwise try slice between first { and last }
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
    "bp",
    "sugar",
    "bmi",
    "water",
    "calories",
    "report",
    "emergency",
  ]);

  // legacy
  if (cat === "blood_pressure") return "bp";

  return allowed.has(cat) ? cat : "general";
}

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
    verdict: sStr(text) || "لا تتوفر معلومات كافية.",
    tips: [],
    when_to_seek_help: "",
    next_question: "",
    quick_choices: [],
  };
}

function isShortAnswer(msg) {
  const m = (msg || "").trim();
  if (!m) return false;
  if (m.length <= 12) return true;
  const yesNo = ["نعم", "لا", "اي", "أيوه", "ايوه", "تمام", "موافق", "ok", "yes", "no"];
  const ml = m.toLowerCase();
  return yesNo.some((w) => ml === w.toLowerCase());
}

function isChoiceAnswer(msg, lastCard) {
  const m = (msg || "").trim();
  if (!m || !lastCard?.next_question) return false;
  const choices = Array.isArray(lastCard.quick_choices) ? lastCard.quick_choices : [];
  if (choices.includes(m)) return true;
  return isShortAnswer(m);
}

// ===============================
// System Prompt (NO backticks inside)
// ===============================
function buildSystemPrompt() {
  return `
أنت "دليل العافية" — مساعد عربي للتثقيف الصحي فقط (ليس تشخيصًا ولا علاجًا).

مهم جدًا:
- أخرج JSON فقط بدون أي نص قبل/بعد.
- لا تشخيص. لا وصف أدوية. لا جرعات.
- اربط الرد مباشرة بسؤال المستخدم وسياقه السابق إن وُجد.
- إذا كانت رسالة المستخدم تحية فقط مثل "السلام عليكم" أو "هلا": رد بتحية واطلب منه يحدد الموضوع.
- إذا كانت رسالة المستخدم قصيرة وتبدو إجابة على سؤال سابق، اعتبرها إجابة وكمّل نفس الموضوع.

صيغة الإخراج (ثابتة):
{
  "category": "general|mental|bp|sugar|bmi|water|calories|report|emergency",
  "title": "عنوان قصير (2-5 كلمات)",
  "verdict": "جملة واحدة واضحة: تطمين/إرشاد/تنبيه",
  "tips": ["نصيحة قصيرة 1","نصيحة قصيرة 2"],
  "when_to_seek_help": "متى تراجع الطبيب/الطوارئ (أو \\"\\" )",
  "next_question": "سؤال متابعة واحد فقط (أو \\"\\" )",
  "quick_choices": ["خيار 1","خيار 2"]
}

قواعد جودة:
- tips: بالعادة 2 فقط (قصيرة وعملية).
- next_question: سؤال واحد فقط. إذا لا تحتاج سؤال ضع "" واجعل quick_choices [].
- quick_choices: 0 إلى 2 خيارات فقط، مرتبطة بالسؤال مباشرة.
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
  };
  return JSON.stringify(ctx);
}

// ===============================
// Groq (with small retry on 429)
// ===============================
async function callGroq(messages) {
  const url = "https://api.groq.com/openai/v1/chat/completions";

  for (let attempt = 0; attempt < 3; attempt++) {
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
          max_tokens: 520,
          response_format: { type: "json_object" },
          messages,
        }),
      },
      20000
    );

    if (res.ok) {
      const data = await res.json();
      return data.choices?.[0]?.message?.content || "";
    }

    const body = await res.text().catch(() => "");
    if (res.status === 429 && attempt < 2) {
      await sleep(900 + attempt * 900);
      continue;
    }

    throw new Error("Groq API error: " + res.status + " " + body);
  }

  throw new Error("Groq API error: retries exhausted");
}

// ===============================
// Report helpers (PDF/OCR)
// ===============================
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

async function extractTextFromPdf(buffer) {
  try {
    const out = await pdfParse(buffer);
    return (out?.text || "").trim();
  } catch {
    return "";
  }
}

async function extractTextFromImage(buffer) {
  let img = buffer;
  try {
    img = await sharp(buffer)
      .rotate()
      .grayscale()
      .normalize()
      .resize({ width: 1600, withoutEnlargement: true })
      .png()
      .toBuffer();
  } catch {}

  const worker = await createWorker("ara+eng");
  try {
    const { data } = await worker.recognize(img);
    return (data?.text || "").trim();
  } catch {
    return "";
  } finally {
    try {
      await worker.terminate();
    } catch {}
  }
}

async function explainReportText(text) {
  const prompt =
    `أنت مساعد عربي للتثقيف الصحي فقط.\n` +
    `اشرح نص التقرير التالي بلغة بسيطة. لا تشخيص ولا أدوية.\n` +
    `قسّم الرد لعناوين قصيرة: (ملخص) (ماذا يعني) (نصائح عامة) (متى أراجع الطبيب).\n\n` +
    `نص التقرير:\n${text}`;

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
        temperature: 0.2,
        max_tokens: 700,
        messages: [
          { role: "system", content: "أجب بنص عربي واضح." },
          { role: "user", content: prompt },
        ],
      }),
    },
    45000
  );

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error("Groq report error: " + res.status + " " + t);
  }

  const data = await res.json();
  return (data.choices?.[0]?.message?.content || "").trim();
}

// ===============================
// Routes
// ===============================
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "Dalil Alafiyah API" });
});

// ✅ Reset session (used by "مسح المحادثة")
app.post("/reset", (req, res) => {
  try {
    const userId = getUserId(req, req.body || {});
    sessions.delete(userId);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "reset_failed" });
  }
});

// ✅ Chat
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

    const last = session.lastCard;
    const treatAsAnswer =
      meta?.force_new === true ? false : meta?.is_choice === true || isChoiceAnswer(msg, last);

    let userContent = msg;
    if (treatAsAnswer && last?.next_question) {
      userContent =
        `إجابة المستخدم على السؤال السابق:\n` +
        `السؤال: ${last.next_question}\n` +
        `الإجابة: ${msg}\n` +
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

    const raw = await callGroq(messages);

    const parsed = extractJson(raw);
    const data = parsed ? normalize(parsed) : fallback(raw);

    session.lastCard = data;

    session.history.push({ role: "user", content: userContent });
    session.history.push({ role: "assistant", content: JSON.stringify(data) });

    if (session.history.length > MAX_HISTORY) {
      session.history = session.history.slice(-MAX_HISTORY);
    }

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

// ✅ Report (file upload: PDF/image)
app.post("/report", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ ok: false, reply: "لم يصلني ملف." });

    const mime = (file.mimetype || "").toLowerCase();
    let text = "";

    if (mime === "application/pdf") {
      text = await extractTextFromPdf(file.buffer);
    } else if (mime.startsWith("image/")) {
      text = await extractTextFromImage(file.buffer);
    } else {
      return res.status(400).json({ ok: false, reply: "الملف غير مدعوم. ارفع PDF أو صورة." });
    }

    if (!text || text.length < 15) {
      return res.json({
        ok: true,
        reply:
          "ما قدرت أقرأ نص واضح من الملف.\n" +
          "جرّب: صورة أوضح، إضاءة أفضل، وتأكد أن النص قريب وواضح.",
      });
    }

    const reply = await explainReportText(text);
    res.json({ ok: true, reply });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      ok: false,
      reply: "تعذّر شرح التقرير الآن.\nجرّب لاحقًا أو ارفع صورة أوضح.",
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Dalil Alafiyah API يعمل على ${PORT}`);
});
