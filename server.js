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
// Upload (memory)
// ===============================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
});

// ===============================
// Official allowed URLs (شفاء)
// ===============================
const OFFICIAL_URL_ALLOWLIST = [
  "https://play.google.com/store/apps/details?id=om.gov.moh.phr",
  "https://apps.apple.com/us/app/%D8%B4-%D9%81-%D8%A7%D8%A1/id1455936672",
];

// ===============================
// Session Memory (in-memory)
// ===============================
const sessions = new Map();
/**
 * session = {
 *   lastCard: { ... },
 *   history: [{ role:"user"|"assistant", content:string }],
 *   updatedAt: number
 * }
 */
const SESSION_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours
const MAX_HISTORY = 6;

function getUserId(req, body) {
  const h = (req.get("x-user-id") || "").trim();
  if (h) return h;
  const b = (body?.user_id || "").trim();
  if (b) return b;
  return "anon";
}

function getSession(userId) {
  const now = Date.now();

  // cleanup
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
    "nutrition",
    "sleep",
    "activity",
    "mental",
    "skin",
    "bp",
    "sugar",
    "firstaid",
    "report",
    "emergency",
  ]);

  if (cat === "blood_pressure") return "bp";
  if (cat === "first_aid") return "firstaid";

  return allowed.has(cat) ? cat : "general";
}

// ===============================
// Safety: prevent hallucinated links/phones (except allowlist or user-provided)
// ===============================
function containsUrl(s) {
  return /https?:\/\/\S+/i.test(String(s || ""));
}
function containsPhoneLike(s) {
  return /(\+?\d[\d\s()-]{6,}\d)/.test(String(s || ""));
}
function isAllowedOfficialUrl(url) {
  const u = String(url || "").trim();
  return OFFICIAL_URL_ALLOWLIST.some((base) => u.startsWith(base));
}
function stripDisallowedUrlsAndPhones(text, userMsg) {
  let t = String(text || "");

  // URLs: keep only if user provided any URL OR allowlisted official
  t = t.replace(/https?:\/\/\S+/gi, (m) => {
    if (containsUrl(userMsg)) return m; // user provided urls -> allow
    if (isAllowedOfficialUrl(m)) return m; // allow official
    return "[رابط غير متاح]";
  });

  // phones: keep only if user provided phone-like text
  t = t.replace(/(\+?\d[\d\s()-]{6,}\d)/g, (m) => {
    if (containsPhoneLike(userMsg)) return m;
    return "[رقم غير متاح]";
  });

  return t;
}

function sanitizeHallucinations(userMsg, data) {
  const safe = { ...data };

  safe.verdict = stripDisallowedUrlsAndPhones(safe.verdict, userMsg);
  safe.when_to_seek_help = stripDisallowedUrlsAndPhones(safe.when_to_seek_help, userMsg);
  safe.tips = Array.isArray(safe.tips) ? safe.tips.map((x) => stripDisallowedUrlsAndPhones(x, userMsg)) : [];
  safe.next_question = stripDisallowedUrlsAndPhones(safe.next_question, userMsg);
  safe.quick_choices = Array.isArray(safe.quick_choices)
    ? safe.quick_choices.map((x) => stripDisallowedUrlsAndPhones(x, userMsg))
    : [];

  // If user asks about appointments / booking / شفاء -> force official links (ONLY)
  const msg = String(userMsg || "");
  if (/موعد|مواعيد|حجز|حجوزات|تطبيق|شفاء|app/i.test(msg)) {
    safe.category = "general";
    safe.title = "مواعيد وحجز";
    safe.verdict = "للحجز أو إدارة المواعيد استخدم الروابط الرسمية لتطبيق شفاء.";
    safe.tips = [
      `تحميل أندرويد (رسمي): ${OFFICIAL_URL_ALLOWLIST[0]}`,
      `تحميل آيفون (رسمي): ${OFFICIAL_URL_ALLOWLIST[1]}`,
    ];
    safe.when_to_seek_help = "";
    safe.next_question = "تبغى طريقة الوصول للحجز من داخل التطبيق ولا تواجه مشكلة تسجيل دخول؟";
    safe.quick_choices = ["طريقة الحجز", "مشكلة تسجيل الدخول"];
  }

  return safe;
}

// ===============================
// Prompts
// ===============================
function buildSystemPrompt() {
  return `
أنت "دليل العافية" — مساعد عربي للتثقيف الصحي فقط.

مهم جدًا:
- أخرج JSON فقط بدون أي نص قبل/بعد، بدون Markdown.
- لا تشخيص. لا وصف أدوية. لا جرعات.
- ممنوع اختراع أرقام هواتف أو روابط أو أسماء جهات.
- إذا سأل المستخدم عن الحجز/المواعيد ولم يذكر بيانات رسمية: وجّه المستخدم لاستخدام الروابط الرسمية أو اطلب منه تزويد اسم الجهة/الرابط الرسمي.

صيغة الإخراج:
{
  "category": "general|nutrition|sleep|activity|mental|skin|bp|sugar|firstaid|report|emergency",
  "title": "عنوان قصير (2-5 كلمات)",
  "verdict": "جملة واحدة واضحة: تطمين/إرشاد/تنبيه",
  "tips": ["نصيحة قصيرة 1","نصيحة قصيرة 2"],
  "when_to_seek_help": "متى تراجع الطبيب/الطوارئ (أو \\"\")",
  "next_question": "سؤال متابعة واحد فقط (أو \\"\")",
  "quick_choices": ["خيار 1","خيار 2"]
}

قواعد جودة:
- tips: 2 فقط، قصيرة وعملية.
- next_question: سؤال واحد فقط. إذا ما تحتاج سؤال ضع "" واجعل quick_choices [].
- quick_choices: 0-2 فقط ولازم مرتبطة بالسؤال مباشرة.
- إذا رسالة المستخدم قصيرة وتبدو إجابة لسؤال سابق: اعتبرها إجابة ولا تغيّر الموضوع.
`.trim();
}

function buildReportSystemPrompt() {
  return `
أنت "دليل العافية" — تفسير تقارير/تحاليل للتوعية فقط.

مهم جدًا:
- أخرج JSON فقط بدون أي نص قبل/بعد، بدون Markdown.
- لا تشخيص. لا وصف أدوية. لا جرعات.
- لا تخترع قيم تحاليل غير موجودة بالنص.
- إذا النص غير واضح/قصير: اطلب صورة أوضح أو اطلب لصق النص.

استخدم نفس صيغة الإخراج تمامًا، واجعل category = "report".
ركز على: تلخيص النتيجة + معنى عام + سؤال متابعة واحد (مثل العمر/الأعراض/هل صائم).
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
      "إذا رسالة المستخدم قصيرة (مثل نعم/لا أو اختيار من quick_choices) فاعتبرها إجابة للسؤال الأخير واستمر بنفس الموضوع.",
  };

  return JSON.stringify(ctx);
}

// ===============================
// Groq call (with one retry on 429)
// ===============================
async function callGroq(messages, { maxTokens = 600 } = {}) {
  const payload = {
    model: MODEL_ID,
    temperature: 0.2,
    max_tokens: maxTokens,
    response_format: { type: "json_object" },
    messages,
  };

  const doRequest = async () => {
    const res = await fetchWithTimeout(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
      20000
    );

    const text = await res.text().catch(() => "");
    if (!res.ok) throw new Error(`Groq API error: ${res.status} ${text}`);
    const data = JSON.parse(text);
    return data.choices?.[0]?.message?.content || "";
  };

  try {
    return await doRequest();
  } catch (e) {
    const msg = String(e?.message || "");
    // retry once on 429
    if (msg.includes(" 429 ")) {
      // حاول انتظار بسيط
      await wait(1500);
      return await doRequest();
    }
    throw e;
  }
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
    verdict: sStr(text) || "حدث خطأ غير متوقع.",
    tips: [],
    when_to_seek_help: "",
    next_question: "",
    quick_choices: [],
  };
}

// ===============================
// OCR / PDF helpers
// ===============================
async function ocrImage(buffer) {
  // preprocess for better OCR
  const pre = await sharp(buffer)
    .rotate()
    .resize({ width: 1600, withoutEnlargement: true })
    .grayscale()
    .normalize()
    .sharpen()
    .toBuffer();

  const worker = await createWorker("ara+eng");
  try {
    const { data } = await worker.recognize(pre);
    const text = (data?.text || "").trim();
    return text;
  } finally {
    await worker.terminate().catch(() => {});
  }
}

async function readPdfText(buffer) {
  const data = await pdfParse(buffer);
  return (data?.text || "").trim();
}

// ===============================
// Routes
// ===============================
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "Dalil Alafiyah API" });
});

// reset session (for real reset)
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

    const raw = await callGroq(messages, { maxTokens: 550 });
    const parsed = extractJson(raw);
    const data0 = parsed ? normalize(parsed) : fallback(raw);
    const data = sanitizeHallucinations(msg, data0);

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
      data: fallback("تعذر الرد الآن. جرّب مرة ثانية بعد قليل."),
    });
  }
});

// report endpoint (image/pdf)
app.post("/report", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ ok: false, error: "no_file" });

    const mime = String(file.mimetype || "");
    let text = "";

    if (mime === "application/pdf") {
      text = await readPdfText(file.buffer);
      // إذا PDF ممسوح غالبًا النص يكون فاضي/قصير
      if (!text || text.length < 30) {
        return res.json({
          ok: true,
          data: {
            category: "report",
            title: "قراءة التقرير",
            verdict: "الـPDF يبدو ممسوح (صورة داخل PDF) وما قدرت أستخرج النص منه.",
            tips: ["جرّب ترفع صورة واضحة للتقرير بدل PDF.", "أو انسخ نص النتائج والصقه هنا."],
            when_to_seek_help: "",
            next_question: "هل تقدر ترفع صورة أقرب وواضحة للنتائج؟",
            quick_choices: ["نعم", "لا"],
          },
        });
      }
    } else if (mime.startsWith("image/")) {
      text = await ocrImage(file.buffer);
      if (!text || text.length < 20) {
        return res.json({
          ok: true,
          data: {
            category: "report",
            title: "قراءة الصورة",
            verdict: "النص غير واضح من الصورة الحالية.",
            tips: ["قرب التصوير على النتائج فقط.", "خل الإضاءة قوية بدون فلاش مباشر، وتأكد ما في اهتزاز."],
            when_to_seek_help: "",
            next_question: "ترفع صورة أوضح (قريبة)؟",
            quick_choices: ["نعم", "لا"],
          },
        });
      }
    } else {
      return res.status(400).json({ ok: false, error: "unsupported_type" });
    }

    const userMsg = `نص التقرير المستخرج:\n${text}`;

    const messages = [
      { role: "system", content: buildReportSystemPrompt() },
      { role: "user", content: userMsg },
    ];

    const raw = await callGroq(messages, { maxTokens: 650 });
    const parsed = extractJson(raw);
    const data0 = parsed ? normalize(parsed) : fallback(raw);

    // report may contain values -> allow, but still block random URLs/phones
    const data = sanitizeHallucinations(userMsg, { ...data0, category: "report" });

    res.json({ ok: true, data });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      ok: false,
      error: "server_error",
      data: fallback("تعذر قراءة التقرير الآن. جرّب صورة أوضح أو الصق نص النتائج."),
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Dalil Alafiyah API يعمل على ${PORT}`);
});
