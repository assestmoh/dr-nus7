// ===============================
// server.js — Dalil Alafiyah API (FINAL + Smart Fallback + Local Busy Reply)
// ===============================

import "dotenv/config";
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import helmet from "helmet";

const app = express();

// ===============================
// ENV
// ===============================
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const PRIMARY_MODEL =
  process.env.GROQ_MODEL_PRIMARY ||
  process.env.GROQ_MODEL ||
  "openai/gpt-oss-120b";

const FALLBACK_MODEL =
  process.env.GROQ_MODEL_FALLBACK || "qwen/qwen3-32b";

const PORT = process.env.PORT || 3000;

if (!GROQ_API_KEY) {
  console.error("❌ GROQ_API_KEY غير مضبوط");
  process.exit(1);
}

app.use(helmet());
app.use(cors());
app.use(bodyParser.json({ limit: "2mb" }));

// ===============================
// Helpers
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

function isRateLimitStatus(status, bodyText) {
  const b = String(bodyText || "");
  return (
    status === 429 ||
    /rate_limit|rate limit|tokens per day|tpd|quota|limit exceeded/i.test(b)
  );
}

// ===============================
// Local Busy Reply
// ===============================
function busyFallbackCard() {
  return {
    category: "general",
    title: "الخدمة مزدحمة",
    verdict:
      "الخدمة مزدحمة حاليًا بسبب الضغط على الذكاء الاصطناعي. حاول مرة أخرى بعد قليل.",
    next_question: "",
    quick_choices: [],
    tips: [
      "انتظر دقيقة أو دقيقتين ثم أعد المحاولة",
      "تأكد من اتصال الإنترنت قبل الإرسال",
    ],
    when_to_seek_help: "",
  };
}

// ===============================
// Groq Calls
// ===============================
async function callGroqOnce(messages, model) {
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
        temperature: 0.35,
        max_tokens: 520,
        messages,
      }),
    },
    20000
  );

  const txt = await res.text();

  if (!res.ok) {
    const err = new Error(`GROQ_HTTP_${res.status}`);
    err.status = res.status;
    err.body = txt;
    err.model = model;
    throw err;
  }

  const data = JSON.parse(txt);
  return data.choices?.[0]?.message?.content || "";
}

async function callGroqSmart(messages) {
  try {
    return await callGroqOnce(messages, PRIMARY_MODEL);
  } catch (e) {
    const status = e?.status;
    const body = e?.body;

    if (isRateLimitStatus(status, body)) {
      console.error(
        `❌ Primary rate-limited (${PRIMARY_MODEL}) → switching to fallback (${FALLBACK_MODEL})`
      );
      try {
        return await callGroqOnce(messages, FALLBACK_MODEL);
      } catch (e2) {
        const status2 = e2?.status;
        const body2 = e2?.body;

        if (isRateLimitStatus(status2, body2)) {
          console.error("❌ Fallback model also rate-limited");
          throw new Error("ALL_MODELS_RATE_LIMITED");
        }

        throw e2;
      }
    }

    throw e;
  }
}

// ===============================
// Basic JSON extractor
// ===============================
function extractJson(text) {
  try {
    const a = text.indexOf("{");
    const b = text.lastIndexOf("}");
    if (a !== -1 && b !== -1) {
      return JSON.parse(text.slice(a, b + 1));
    }
  } catch {}
  return null;
}

function normalize(obj) {
  return {
    category: obj?.category || "general",
    title: obj?.title || "دليل العافية",
    verdict: obj?.verdict || "",
    next_question: obj?.next_question || "",
    quick_choices: Array.isArray(obj?.quick_choices)
      ? obj.quick_choices.slice(0, 2)
      : [],
    tips: Array.isArray(obj?.tips) ? obj.tips.slice(0, 2) : [],
    when_to_seek_help: obj?.when_to_seek_help || "",
  };
}

// ===============================
// Routes
// ===============================
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "Dalil Alafiyah API",
    models: { primary: PRIMARY_MODEL, fallback: FALLBACK_MODEL },
  });
});

app.post("/reset", (_req, res) => {
  res.json({ ok: true });
});

app.post("/chat", async (req, res) => {
  try {
    const msg = String(req.body.message || "").trim();
    if (!msg) {
      return res.status(400).json({ ok: false, error: "empty_message" });
    }

    const messages = [
      {
        role: "system",
        content:
          "أنت مساعد صحي. أجب دائمًا بصيغة JSON فقط حسب الهيكل المحدد.",
      },
      { role: "user", content: msg },
    ];

    const raw = await callGroqSmart(messages);
    const parsed = extractJson(raw);

    if (!parsed) {
      return res.json({
        ok: true,
        data: busyFallbackCard(),
      });
    }

    return res.json({
      ok: true,
      data: normalize(parsed),
    });
  } catch (e) {
    console.error("❌ /chat error:", e?.message || e);

    // هنا التعديل المهم:
    return res.json({
      ok: true,
      data: busyFallbackCard(),
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Dalil Alafiyah API يعمل على ${PORT}`);
  console.log(`Primary: ${PRIMARY_MODEL}`);
  console.log(`Fallback: ${FALLBACK_MODEL}`);
});
