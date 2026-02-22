import "dotenv/config";
import express from "express";
import fetch from "node-fetch";
import helmet from "helmet";
import cors from "cors";
import bodyParser from "body-parser";
import rateLimit from "express-rate-limit";

const app = express();

/* ================= CONFIG ================= */

const PORT = process.env.PORT || 8000;
const API_KEY = process.env.GROQ_API_KEY;
const MODEL = process.env.GROQ_SMALL_MODEL || "llama-3.1-8b-instant";

const MAX_TOKENS = 120;
const TEMP = 0.25;

if (!API_KEY) {
  console.error("Missing GROQ_API_KEY");
  process.exit(1);
}

/* ================= SECURITY ================= */

app.use(helmet());
app.use(cors({ origin: true }));
app.use(bodyParser.json({ limit: "2mb" }));

app.use(
  rateLimit({
    windowMs: 60000,
    max: 6,
  })
);

/* ================= SMART CACHE ================= */

const CACHE = new Map();
const CACHE_TTL = 1000 * 60 * 60 * 6; // 6h

function normalizeKey(text) {
  return text
    .toLowerCase()
    .replace(/[؟?!.,]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getCache(key) {
  const item = CACHE.get(key);
  if (!item) return null;

  if (Date.now() > item.exp) {
    CACHE.delete(key);
    return null;
  }

  return item.data;
}

function setCache(key, data) {
  CACHE.set(key, {
    data,
    exp: Date.now() + CACHE_TTL,
  });
}

/* auto cleanup */
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of CACHE.entries()) {
    if (now > v.exp) CACHE.delete(k);
  }
}, 600000);

/* ================= HELPERS ================= */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function callGroq(messages) {
  async function attempt() {
    const res = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
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
      const t = await res.text();
      const err = new Error(t);
      err.status = res.status;
      throw err;
    }

    const json = await res.json();
    return json.choices?.[0]?.message?.content || "";
  }

  try {
    return await attempt();
  } catch (e) {
    if (e.status === 429) {
      await sleep(500);
      return await attempt();
    }
    throw e;
  }
}

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

/* ================= PROMPT ================= */

function systemPrompt() {
  return `
أنت دليل العافية.
قدم تثقيف صحي فقط.
أخرج JSON فقط.
`.trim();
}

/* ================= ROUTES ================= */

app.get("/health", (_, res) => {
  res.json({ ok: true });
});

app.post("/chat", async (req, res) => {
  try {
    const message = String(req.body?.message || "").trim();
    if (!message) return res.json({ ok: false });

    const key = normalizeKey(message);

    /* ===== CACHE HIT ===== */
    const cached = getCache(key);
    if (cached) {
      console.log("⚡ CACHE HIT");
      return res.json({
        ok: true,
        data: cached,
        cached: true,
      });
    }

    /* ===== AI CALL ===== */
    const messages = [
      { role: "system", content: systemPrompt() },
      { role: "user", content: message },
    ];

    const raw = await callGroq(messages);
    const parsed = extractJson(raw);

    if (!parsed)
      return res.json({
        ok: false,
        error: "ai_no_response",
      });

    /* ===== SAVE CACHE ===== */
    setCache(key, parsed);

    res.json({
      ok: true,
      data: parsed,
      cached: false,
    });
  } catch (e) {
    console.error(e);

    return res.json({
      ok: false,
      error: "temporary_unavailable",
    });
  }
});

/* ================= START ================= */

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Smart Cached API :${PORT}`);
});
