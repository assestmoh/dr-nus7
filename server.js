import "dotenv/config";
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

const app = express();

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const PORT = process.env.PORT || 8000;

if (!GROQ_API_KEY) {
  console.error("❌ GROQ_API_KEY missing");
  process.exit(1);
}

/* ================= CONFIG ================= */

const MODEL = process.env.GROQ_SMALL_MODEL || "llama-3.1-8b-instant";

const TEMP = Number(process.env.GROQ_TEMPERATURE || 0.25);
const MAX_TOKENS = Number(process.env.GROQ_MAX_TOKENS || 120);

const SESSION_TTL = Number(
  process.env.SESSION_TTL_MS || 6 * 60 * 60 * 1000
);

/* ================= BASIC SECURITY ================= */

app.use(helmet());
app.set("trust proxy", 1);

app.use(cors({ origin: true }));

app.use(bodyParser.json({ limit: "2mb" }));

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.CHAT_RPM || 6),
    standardHeaders: true,
    legacyHeaders: false,
  })
);

/* ================= SESSION MEMORY ================= */

const sessions = new Map();

function hasSystem(sid) {
  const s = sessions.get(sid);
  if (!s) return false;

  if (Date.now() - s > SESSION_TTL) {
    sessions.delete(sid);
    return false;
  }

  sessions.set(sid, Date.now());
  return true;
}

function markSystem(sid) {
  sessions.set(sid, Date.now());
}

/* ================= HELPERS ================= */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(url, options, ms = 20000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(id);
  }
}

/* ================= SYSTEM PROMPT ================= */

function systemPrompt() {
  return `
أنت دليل العافية.
قدم تثقيف صحي عام فقط.
لا تشخص.
لا تعطي جرعات.

أخرج JSON فقط:

{
 "category":"general",
 "title":"عنوان قصير",
 "verdict":"جملة مفيدة",
 "next_question":"",
 "quick_choices":[],
 "tips":[],
 "when_to_seek_help":""
}
`.trim();
}

/* ================= GROQ CALL + SMART RETRY ================= */

async function callGroq(messages) {
  async function attempt() {
    const res = await fetchWithTimeout(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          temperature: TEMP,
          max_tokens: MAX_TOKENS,
          messages,
        }),
      }
    );

    if (!res.ok) {
      const txt = await res.text();
      const err = new Error(txt);
      err.status = res.status;
      throw err;
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || "";
  }

  try {
    return await attempt();
  } catch (e) {
    /* ✅ retry ذكي */
    if (e.status === 429 || e.status === 503) {
      await sleep(500 + Math.random() * 300);
      return await attempt();
    }
    throw e;
  }
}

/* ================= JSON SAFE ================= */

function extractJson(text) {
  try {
    return JSON.parse(text);
  } catch {}

  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");

  if (a !== -1 && b !== -1) {
    try {
      return JSON.parse(text.slice(a, b + 1));
    } catch {}
  }

  return null;
}

/* ================= ROUTES ================= */

app.get("/health", (_, res) => {
  res.json({ ok: true });
});

app.post("/chat", async (req, res) => {
  try {
    const msg = String(req.body?.message || "").trim();
    const sid =
      req.headers["x-session-id"] ||
      req.body?.context?.session_id ||
      "anon";

    if (!msg)
      return res.status(400).json({ ok: false });

    const messages = [];

    /* ✅ system once */
    if (!hasSystem(sid)) {
      messages.push({
        role: "system",
        content: systemPrompt(),
      });
      markSystem(sid);
    }

    messages.push({
      role: "user",
      content: msg,
    });

    const raw = await callGroq(messages);
    const parsed = extractJson(raw);

    /* ✅ لا fallback */
    if (!parsed) {
      return res.status(204).end();
    }

    res.json({
      ok: true,
      data: parsed,
    });
  } catch (e) {
    /* ✅ لا رد قبيح */
    if (e.status === 429) {
      return res.status(429).json({
        ok: false,
        error: "rate_limited",
      });
    }

    console.error(e);
    res.status(503).json({
      ok: false,
      error: "temporary_unavailable",
    });
  }
});

/* ================= START ================= */

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `🚀 API running :${PORT} | model=${MODEL}`
  );
});
