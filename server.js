// server.js — Dalil Alafiyah API (LOW TOKEN VERSION + TTS)

import "dotenv/config";
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

const app = express();

const GROQ_API_KEY = process.env.GROQ_API_KEY;

const SMALL_MODEL =
  process.env.GROQ_SMALL_MODEL || "openai/gpt-oss-120b";

const BIG_MODEL =
  (process.env.GROQ_BIG_MODEL ||
    process.env.GROQ_MODEL ||
    "llama-3.3-70b-versatile").trim();

const TTS_MODEL =
  (process.env.GROQ_TTS_MODEL ||
    "canopylabs/orpheus-arabic-saudi").trim();

const TTS_VOICE =
  (process.env.GROQ_TTS_VOICE || "fahad").trim();

const PORT = process.env.PORT || 3000;

if (!GROQ_API_KEY) {
  console.error("❌ GROQ_API_KEY غير مضبوط");
  process.exit(1);
}

app.use(helmet());
app.set("trust proxy", 1);
app.use(cors());
app.use(bodyParser.json({ limit: "2mb" }));

// ---------- LIMITERS ----------
const chatLimiter = rateLimit({
  windowMs: 60000,
  max: Number(process.env.CHAT_RPM || 25),
});

const ttsLimiter = rateLimit({
  windowMs: 60000,
  max: Number(process.env.TTS_RPM || 18),
});

// ---------- HELPERS ----------
async function fetchWithTimeout(url, options = {}, ms = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

function cleanJsonish(s) {
  return String(s || "")
    .replace(/^```.*?\n/, "")
    .replace(/```$/, "")
    .trim();
}

function extractJson(text) {
  try {
    return JSON.parse(cleanJsonish(text));
  } catch {}

  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a === -1 || b === -1) return null;

  try {
    return JSON.parse(text.slice(a, b + 1));
  } catch {
    return null;
  }
}

function normalize(obj = {}) {
  return {
    category: String(obj.category || "general"),
    title: String(obj.title || "دليل العافية"),
    verdict: String(obj.verdict || ""),
    tips: Array.isArray(obj.tips)
      ? obj.tips.slice(0, 3)
      : [],
    when_to_seek_help:
      String(obj.when_to_seek_help || ""),
  };
}

// ---------- ✅ LOW TOKEN SYSTEM PROMPT ----------
function buildSystemPrompt() {
  return `أنت "دليل العافية" للتثقيف الصحي في سلطنة عمان.

معلومات عامة فقط.
ممنوع التشخيص أو وصف علاج شخصي أو جرعات أو مضادات حيوية.

خطر عالٍ: جروح أو قروح مريض السكري خصوصًا القدم → إسعاف أولي بسيط + تقييم طبي سريع.

طوارئ فورًا عند:
ألم صدر، ضيق نفس، فقدان وعي، نزيف شديد، تشنجات، إصابة خطيرة، أفكار إيذاء النفس.
في عمان: 9999 أو 24343666.
قدّم إسعاف أولي فقط.

أعد JSON فقط:
{"category":"...","title":"2-5 كلمات","verdict":"≤3 جمل مفصولة بـ \\n","tips":["","",""],"when_to_seek_help":"نص قصير أو \\"\\""}

أسلوب واضح عملي غير مكرر.`;
}

// ---------- GROQ CALL ----------
async function callGroq(messages, model) {
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
        temperature: 0.2,
        max_tokens: 220,
        messages,
      }),
    }
  );

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

// ---------- CHAT ----------
app.post("/chat", chatLimiter, async (req, res) => {
  try {
    const msg = String(req.body?.message || "").trim();
    if (!msg)
      return res.status(400).json({ ok: false });

    const compact = req.body?.context?.last || null;

    const messages = [
      { role: "system", content: buildSystemPrompt() },
    ];

    // ✅ token saving context
    if (compact) {
      messages.push({
        role: "system",
        content: JSON.stringify(compact),
      });
    }

    messages.push({
      role: "user",
      content: msg,
    });

    let raw = await callGroq(
      messages,
      SMALL_MODEL
    );

    let parsed = extractJson(raw);

    if (!parsed) {
      raw = await callGroq(
        messages,
        BIG_MODEL
      );
      parsed = extractJson(raw);
    }

    return res.json({
      ok: true,
      data: normalize(parsed),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      ok: false,
      error: "server_error",
    });
  }
});

// ---------- TTS ----------
async function callGroqTTS(text) {
  const res = await fetchWithTimeout(
    "https://api.groq.com/openai/v1/audio/speech",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: TTS_MODEL,
        input: text.slice(0, 200),
        voice: TTS_VOICE,
        response_format: "wav",
      }),
    }
  );

  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

app.post("/tts", ttsLimiter, async (req, res) => {
  try {
    const text = String(req.body?.text || "");
    const wav = await callGroqTTS(text);

    res.setHeader("Content-Type", "audio/wav");
    res.send(wav);
  } catch {
    res.status(500).json({ ok: false });
  }
});

app.get("/health", (_, res) =>
  res.json({ ok: true })
);

app.listen(PORT, () => {
  console.log(
    `🚀 Dalil Alafiyah running :${PORT}`
  );
});
