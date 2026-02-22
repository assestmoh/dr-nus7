// server.js — Dalil Alafiyah API (cheaper + safer: no big-fallback, forced JSON, system-lite, TTS cache)
import "dotenv/config";
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import crypto from "crypto";

const app = express();

const GROQ_API_KEY = process.env.GROQ_API_KEY;

// LLM (small-only by default)
const SMALL_MODEL = (process.env.GROQ_SMALL_MODEL || "llama-3.1-8b-instant").trim();
// Optional (kept for visibility / future), but we DO NOT auto-fallback to it anymore.
const BIG_MODEL = (process.env.GROQ_BIG_MODEL || process.env.GROQ_MODEL || "").trim();

// TTS (Orpheus Arabic Saudi)
const TTS_MODEL = (process.env.GROQ_TTS_MODEL || "canopylabs/orpheus-arabic-saudi").trim();
const TTS_VOICE = (process.env.GROQ_TTS_VOICE || "fahad").trim();

const PORT = process.env.PORT || 3000;

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!GROQ_API_KEY) {
  console.error("❌ GROQ_API_KEY غير مضبوط");
  process.exit(1);
}

app.use(helmet());
app.set("trust proxy", 1);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // curl/health checks
      if (ALLOWED_ORIGINS.length === 0) return cb(null, true); // dev mode
      return ALLOWED_ORIGINS.includes(origin)
        ? cb(null, true)
        : cb(new Error("CORS blocked"), false);
    },
    methods: ["POST", "GET"],
  })
);

app.use(bodyParser.json({ limit: "2mb" }));

// Better: rate-limit by user-id (falls back to IP)
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.CHAT_RPM || 25),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.header("x-user-id") || req.ip),
});

// ---------- helpers ----------
async function fetchWithTimeout(url, options = {}, ms = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

function extractVerdictLoosely(raw) {
  const s = String(raw || "");
  const m = s.match(/"verdict"\s*:\s*"([^"]+)"/);
  return m?.[1]?.replace(/\\"/g, '"').trim() || "";
}

function recoverPartialCard(raw) {
  const s = String(raw || "");
  const pick = (re) => {
    const m = s.match(re);
    return m?.[1] ? m[1].replace(/\\"/g, '"').trim() : "";
  };

  const category = pick(/"category"\s*:\s*"([^"]+)"/) || "general";
  const title = pick(/"title"\s*:\s*"([^"]+)"/) || "دليل العافية";
  const verdict = pick(/"verdict"\s*:\s*"([^"]+)"/) || "";
  const next_question = pick(/"next_question"\s*:\s*"([^"]*)"/) || "";
  const when_to_seek_help = pick(/"when_to_seek_help"\s*:\s*"([^"]*)"/) || "";

  const arrPick = (key, limit) => {
    const m = s.match(new RegExp(`"${key}"\\s*:\\s*\\[([\\s\\S]*?)\\]`));
    const inner = m?.[1] || "";
    if (!inner) return [];
    return inner
      .split(",")
      .map((x) => x.trim())
      .map((x) => x.replace(/^"+|"+$/g, "").replace(/\\"/g, '"'))
      .filter(Boolean)
      .slice(0, limit);
  };

  const quick_choices = arrPick("quick_choices", 2);
  const tips = arrPick("tips", 2);

  return {
    category,
    title,
    verdict,
    next_question,
    quick_choices,
    tips,
    when_to_seek_help,
  };
}

function isMetaJsonAnswer(d) {
  const text =
    String(d?.title || "") +
    " " +
    String(d?.verdict || "") +
    " " +
    String(d?.next_question || "") +
    " " +
    String(d?.when_to_seek_help || "") +
    " " +
    (Array.isArray(d?.tips) ? d.tips.join(" ") : "") +
    " " +
    (Array.isArray(d?.quick_choices) ? d.quick_choices.join(" ") : "");

  return /json|format|schema|اقتباس|فواصل|تنسيق/i.test(text);
}

const sStr = (v) => (typeof v === "string" ? v.trim() : "");
const sArr = (v, n) =>
  Array.isArray(v)
    ? v.filter((x) => typeof x === "string" && x.trim()).slice(0, n)
    : [];

function normalize(obj) {
  let cat = sStr(obj?.category) || "general";
  if (cat === "blood_pressure" || cat === "bloodpressure") cat = "bp";

  const allowed = new Set([
    "general",
    "nutrition",
    "bp",
    "sugar",
    "sleep",
    "activity",
    "mental",
    "first_aid",
    "report",
    "emergency",
    "water",
    "calories",
    "bmi",
  ]);
  if (!allowed.has(cat)) cat = "general";

  return {
    category: cat,
    title: sStr(obj?.title) || "دليل العافية",
    verdict: sStr(obj?.verdict),
    next_question: sStr(obj?.next_question),
    quick_choices: sArr(obj?.quick_choices, 2),
    tips: sArr(obj?.tips, 2),
    when_to_seek_help: sStr(obj?.when_to_seek_help),
  };
}

// ---------- prompts (system-lite after first message per user) ----------
function buildSystemPromptFull() {
  return `
أنت "دليل العافية" مساعد توعوي صحي عربي لعُمان. توعية عامة فقط (ليس تشخيصًا ولا علاجًا ولا جرعات).
عند علامات الخطر أو الطوارئ: وجّه فورًا للاتصال 9999 أو 24343666 وقدّم إسعافًا أوليًا بسيطًا وآمنًا فقط.
اختصر جدًا، بدون تكرار.

أعد JSON فقط بالشكل:
{"category":"general|nutrition|bp|sugar|sleep|activity|mental|first_aid|report|emergency|water|calories|bmi","title":"","verdict":"","next_question":"","quick_choices":["",""],"tips":["",""],"when_to_seek_help":""}
`.trim();
}

const SYSTEM_LITE = `أجب باختصار وأعد JSON فقط. عند طوارئ: 9999 أو 24343666.`;

const USER_SEEN = new Map(); // userId -> lastSeenTs
const USER_SEEN_TTL_MS = 60 * 60 * 1000; // 1h

function getSystemForUser(userId) {
  const now = Date.now();
  const last = USER_SEEN.get(userId) || 0;
  const fresh = now - last < USER_SEEN_TTL_MS;
  USER_SEEN.set(userId, now);
  return fresh ? SYSTEM_LITE : buildSystemPromptFull();
}

function compactLastCard(lastCard) {
  const cat = sStr(lastCard?.category);
  return cat ? { category: cat } : null;
}

function chooseMaxTokens(msg, lastCard) {
  const base = Number(process.env.GROQ_MAX_TOKENS || 140);

  const text = String(msg || "");
  const cat = sStr(lastCard?.category);

  // reduced ceilings (was 320) to avoid waste
  if (cat === "report" || /تقرير|ملخص|تحليل/i.test(text)) return Math.max(base, 180);
  if (cat === "emergency" || /طوارئ|إسعاف|اختناق|نزيف|حروق|سكتة/i.test(text))
    return Math.max(base, 160);

  return base;
}

async function callGroq(messages, { model, max_tokens }) {
  const res = await fetchWithTimeout(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.2, // helps reduce formatting drift
        max_tokens,
        messages,

        // ✅ Force valid JSON output (kills the JSON-parsing -> big-fallback leak)
        response_format: { type: "json_object" },
      }),
    },
    20000
  );

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Groq API error (${res.status}) ${t.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

function fallback(rawText) {
  const looseVerdict = extractVerdictLoosely(rawText);
  return {
    category: "general",
    title: "معلومة صحية",
    verdict: looseVerdict || "تعذر توليد رد منظم الآن. جرّب إعادة صياغة السؤال بشكل مختصر.",
    next_question: "",
    quick_choices: [],
    tips: [],
    when_to_seek_help: "",
  };
}

// ---------- TTS helpers ----------
function normalizeArabicForTTS(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, 200);
}

async function callGroqTTS(text, { model = TTS_MODEL, voice = TTS_VOICE } = {}) {
  const input = normalizeArabicForTTS(text);
  if (!input) throw new Error("tts_empty_input");

  const res = await fetchWithTimeout(
    "https://api.groq.com/openai/v1/audio/speech",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input,
        voice,
        response_format: "wav",
      }),
    },
    20000
  );

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Groq TTS error (${res.status}) ${t.slice(0, 200)}`);
  }

  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

// ---------- TTS cache (server-side) ----------
const TTS_CACHE = new Map(); // key -> { wav: Buffer, ts: number }
const TTS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const TTS_CACHE_MAX_ITEMS = 500;

function ttsKey(text, voice) {
  return crypto.createHash("sha256").update(`${voice}||${text}`).digest("hex");
}

function ttsCacheGet(key) {
  const hit = TTS_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > TTS_CACHE_TTL_MS) {
    TTS_CACHE.delete(key);
    return null;
  }
  return hit.wav;
}

function ttsCacheSet(key, wav) {
  if (TTS_CACHE.size >= TTS_CACHE_MAX_ITEMS) {
    const firstKey = TTS_CACHE.keys().next().value;
    if (firstKey) TTS_CACHE.delete(firstKey);
  }
  TTS_CACHE.set(key, { wav, ts: Date.now() });
}

// ---------- routes ----------
app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/reset", (_req, res) => {
  res.json({ ok: true });
});

// ✅ TTS endpoint (cached)
app.post("/tts", chatLimiter, async (req, res) => {
  try {
    const text = String(req.body?.text || "").trim();
    const voice = String(req.body?.voice || TTS_VOICE).trim() || TTS_VOICE;

    if (!text) return res.status(400).json({ ok: false, error: "empty_text" });

    const key = ttsKey(text.slice(0, 200), voice);
    const etag = `"${key}"`;

    // Conditional request
    if (req.headers["if-none-match"] === etag) return res.status(304).end();

    let wav = ttsCacheGet(key);
    if (!wav) {
      wav = await callGroqTTS(text, { voice });
      ttsCacheSet(key, wav);
    }

    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "public, max-age=86400"); // 24h
    res.setHeader("Content-Length", String(wav.length));
    return res.status(200).send(wav);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "tts_error" });
  }
});

app.post("/chat", chatLimiter, async (req, res) => {
  try {
    const msg = String(req.body?.message || "").trim();
    if (!msg) return res.status(400).json({ ok: false, error: "empty_message" });
    if (msg.length > 350) return res.status(400).json({ ok: false, error: "message_too_long" });

    const userId = String(req.header("x-user-id") || req.ip);

    const lastCard = req.body?.context?.last || null;
    const lastCategory = String(req.body?.context?.category || lastCard?.category || "").trim();
    const compact = compactLastCard({ category: lastCategory });

    const messages = [{ role: "system", content: getSystemForUser(userId) }];

    if (compact) {
      messages.push({
        role: "assistant",
        content: "سياق سابق مختصر:\n" + JSON.stringify(compact),
      });
    }

    messages.push({ role: "user", content: msg });

    const maxTokens = chooseMaxTokens(msg, { category: lastCategory });

    // ✅ Small-only call (no hidden big-fallback)
    const raw = await callGroq(messages, { model: SMALL_MODEL, max_tokens: maxTokens });

    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }

    let data;
    if (parsed) data = normalize(parsed);
    else data = normalize(recoverPartialCard(raw) || fallback(raw));

    if (isMetaJsonAnswer(data)) {
      data = normalize(recoverPartialCard(raw) || fallback(raw));
    }

    return res.json({
      ok: true,
      data,
      meta: {
        model_used: SMALL_MODEL,
        system_mode: USER_SEEN.get(userId) ? "lite_or_full" : "unknown",
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "server_error", data: fallback("") });
  }
});

app.listen(PORT, () => {
  console.log(
    `🚀 API running on :${PORT} | small=${SMALL_MODEL}` +
      (BIG_MODEL ? ` | big(kept-unused)=${BIG_MODEL}` : "") +
      ` | tts=${TTS_MODEL}/${TTS_VOICE}`
  );
});
