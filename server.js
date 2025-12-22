// ===============================
// server.js — دليل العافية (Structured JSON API)
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
const MODEL_ID = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
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
async function fetchWithTimeout(url, options = {}, ms = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

function extractJson(text) {
  const s = String(text || "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a === -1 || b === -1 || b <= a) return null;
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
}

function safeStr(v) {
  return typeof v === "string" ? v.trim() : "";
}
function safeArr(v, max = 4) {
  return Array.isArray(v)
    ? v.filter(x => typeof x === "string" && x.trim()).slice(0, max)
    : [];
}

// ===============================
// Prompt (الفرق الجوهري عن ChatGPT)
// ===============================
function buildSystemPrompt() {
  return `
أنت "دليل العافية" — مرافق صحي عربي للتثقيف فقط (لست طبيبًا).

هدفك:
- توجيه المستخدم بخطوات قصيرة
- حكم سريع + سؤال متابعة واحد
- لا محاضرات ولا تشخيص ولا أدوية

❗ أخرج الرد بصيغة JSON فقط وبدون أي نص خارجها:

{
  "title": "عنوان قصير (2-5 كلمات)",
  "verdict": "جملة واحدة: تطمين أو تنبيه",
  "next_question": "سؤال واحد فقط (أو \"\")",
  "quick_choices": ["خيار 1","خيار 2","خيار 3"],
  "tips": ["نصيحة قصيرة 1","نصيحة قصيرة 2"],
  "when_to_seek_help": "متى تراجع الطبيب أو الطوارئ (أو \"\")"
}

قواعد صارمة:
- لا تشخيص
- لا أدوية
- لا جرعات
- لا تتجاوز 2 نصائح
- لغة بسيطة قريبة من الناس
`.trim();
}

// ===============================
// Groq Call
// ===============================
async function callGroq(messages) {
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
        temperature: 0.35,
        max_tokens: 500,
        messages,
      }),
    }
  );

  if (!res.ok) {
    throw new Error("Groq API error");
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

// ===============================
// Normalize Output
// ===============================
function normalizeData(obj) {
  return {
    title: safeStr(obj?.title) || "دليل العافية",
    verdict: safeStr(obj?.verdict),
    next_question: safeStr(obj?.next_question),
    quick_choices: safeArr(obj?.quick_choices, 4),
    tips: safeArr(obj?.tips, 3),
    when_to_seek_help: safeStr(obj?.when_to_seek_help),
  };
}

function fallbackData(text) {
  return {
    title: "معلومة صحية",
    verdict: safeStr(text) || "لا تتوفر لدي معلومات كافية.",
    next_question: "",
    quick_choices: [],
    tips: [],
    when_to_seek_help: "",
  };
}

// ===============================
// Routes
// ===============================
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "Dalil Alafiyah API",
    model: MODEL_ID,
  });
});

// ===============================
// /chat — Structured JSON
// ===============================
app.post("/chat", async (req, res) => {
  try {
    const userMessage = String(req.body.message || "").trim();
    if (!userMessage) {
      return res.status(400).json({
        ok: false,
        error: "empty_message",
      });
    }

    const messages = [
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: userMessage },
    ];

    const raw = await callGroq(messages);
    const parsed = extractJson(raw);

    const data = parsed
      ? normalizeData(parsed)
      : fallbackData(raw);

    res.json({
      ok: true,
      data,
    });

  } catch (err) {
    console.error("❌ /chat error:", err);
    res.status(500).json({
      ok: false,
      error: "server_error",
      data: fallbackData(
        "حدث خطأ غير متوقع. إذا عندك أعراض مقلقة، راجع الطبيب."
      ),
    });
  }
});

// ===============================
// Start
// ===============================
app.listen(PORT, () => {
  console.log(`🚀 دليل العافية يعمل على البورت ${PORT}`);
});
