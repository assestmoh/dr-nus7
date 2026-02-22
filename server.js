// server.js — Dalil Alafiyah API (clean + hardened + cheaper routing)
import "dotenv/config";
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

const app = express();

// ✅ مهم جدًا عند وجود Reverse Proxy (Koyeb/Render/Fly/Nginx...)
// حتى يقرأ Express الـ IP الحقيقي من X-Forwarded-For
app.set("trust proxy", 1);

const GROQ_API_KEY = process.env.GROQ_API_KEY;

// Small-first / Big-fallback (LLM)
const SMALL_MODEL = process.env.GROQ_SMALL_MODEL || "llama-3.1-8b-instant";
const BIG_MODEL = process.env.GROQ_BIG_MODEL || "llama-3.1-70b-versatile";

// Limits
const PORT = process.env.PORT || 3000;
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";

// Middleware
app.use(helmet());
app.use(cors({ origin: ALLOW_ORIGIN === "*" ? true : ALLOW_ORIGIN }));
app.use(bodyParser.json({ limit: "256kb" }));

// Rate limiting
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.RATE_LIMIT_MAX || 40),
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// Helpers
const sStr = (v) => (typeof v === "string" ? v.trim() : "");
const sArr = (v, cap = 3) =>
  Array.isArray(v)
    ? v
        .map((x) => sStr(x))
        .filter(Boolean)
        .slice(0, cap)
    : [];

function safeJsonParse(maybeJson) {
  try {
    return JSON.parse(maybeJson);
  } catch {
    return null;
  }
}

function extractJsonFromText(txt) {
  // Try strict parse
  const parsed = safeJsonParse(txt);
  if (parsed) return parsed;

  // Try to grab first JSON block
  const s = String(txt || "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    const chunk = s.slice(start, end + 1);
    return safeJsonParse(chunk);
  }
  return null;
}

function normalizeLLMOutput(obj) {
  if (!obj || typeof obj !== "object") obj = {};

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
    quick_choices: sArr(obj?.quick_choices, 3), // ✅ 3 بدل 2
    tips: sArr(obj?.tips, 3),                 // ✅ 3 بدل 2
    when_to_seek_help: sStr(obj?.when_to_seek_help),
  };
}

function buildSystemPrompt() {
  // Compressed prompt to cut tokens (still safe + Oman emergency routing)
  return `
أنت "دليل العافية" مساعد توعوي صحي عربي لعُمان. توعية عامة فقط (ليس تشخيصًا ولا وصف علاج/جرعات).
عند علامات الخطر أو الطوارئ: وجّه فورًا للاتصال 9999 أو 24343666 وقدّم إسعافًا أوليًا بسيطًا وآمنًا فقط.
أجب عربيًا واضحًا وباختصار، بدون تكرار.

أعد JSON فقط وبلا أي نص خارجه وبدون Markdown، بالشكل:
{"category":"general|nutrition|bp|sugar|sleep|activity|mental|first_aid|report|emergency|water|calories|bmi","title":"2-5 كلمات","verdict":"سطرين كحد أقصى","next_question":"سؤال واحد أو \"\"","quick_choices":["","",""],"tips":["","",""],"when_to_seek_help":"\"\" أو نص قصير"}
`.trim();
}

function compactLastCard(lastCard) {
  // Keep only what's useful for routing and keep it tiny
  const cat = sStr(lastCard?.category);
  return cat ? { category: cat } : null;
}

function chooseMaxTokens(msg, lastCard) {
  const base = Number(process.env.GROQ_MAX_TOKENS || 140);

  const text = String(msg || "");
  const cat = sStr(lastCard?.category);

  if (cat === "report" || /تقرير|ملخص|تحليل/i.test(text)) return Math.max(base, 320);
  if (cat === "emergency" || /طوارئ|إسعاف|اختناق|نزيف|حروق|سكتة/i.test(text))
    return Math.max(base, 320);

  return base;
}

async function callGroq({ model, messages, max_tokens }) {
  if (!GROQ_API_KEY) throw new Error("Missing GROQ_API_KEY");

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.35,
      max_tokens,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Groq error ${res.status}: ${t.slice(0, 200)}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || "";
  return content;
}

function buildUserPrompt(message, meta, lastCard) {
  const ctx = compactLastCard(lastCard);
  const m = sStr(message);
  const tz = sStr(meta?.tz) || "Asia/Muscat";
  const locale = sStr(meta?.locale) || "ar-OM";

  return `
المستخدم في عُمان. التزم بالتوعية العامة.
الرسالة: ${m}
اللغة/المنطقة: ${locale}
المنطقة الزمنية: ${tz}
السياق السابق (قد يكون فارغًا): ${ctx ? JSON.stringify(ctx) : "{}"}
`.trim();
}

function parseViaRegexFallback(txt) {
  // last resort: attempt to pull keys from noisy output
  const s = String(txt || "");

  const pick = (re) => {
    const m = s.match(re);
    return m && m[1] ? String(m[1]).replace(/\\"/g, '"').trim() : "";
  };

  const category = pick(/"category"\s*:\s*"([^"]+)"/) || "general";
  const title = pick(/"title"\s*:\s*"([^"]+)"/) || "دليل العافية";
  const verdict = pick(/"verdict"\s*:\s*"([^"]+)"/) || "";
  const next_question = pick(/"next_question"\s*:\s*"([^"]*)"/) || "";
  const when_to_seek_help = pick(/"when_to_seek_help"\s*:\s*"([^"]*)"/) || "";

  const arrPick = (key, limit) => {
    const m = s.match(new RegExp(`"${key}"\\s*:\\s*\\[([\\s\\S]*?)\\]`));
    const inner = m?.[1] || "";
    return inner
      .split(",")
      .map((x) => x.replace(/[\[\]"]/g, "").trim())
      .filter(Boolean)
      .slice(0, limit);
  };

  const quick_choices = arrPick("quick_choices", 3); // ✅ 3 بدل 2
  const tips = arrPick("tips", 3);                   // ✅ 3 بدل 2

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

// Routes
app.get("/", (_req, res) => {
  res.json({ ok: true, name: "Dalil Alafiyah API" });
});

app.post("/chat", async (req, res) => {
  try {
    const message = sStr(req.body?.message);
    const meta = req.body?.meta || {};

    // ✅ الواجهة الجديدة ترسل context.category فقط
    // لكن دعمنا القديم (context.last) لو موجود
    const lastCard = req.body?.context?.last || null;
    const lastCategory = String(req.body?.context?.category || lastCard?.category || "").trim();

    const last = lastCategory ? { category: lastCategory } : lastCard;

    if (!message) {
      return res.status(400).json({
        category: "general",
        title: "خطأ",
        verdict: "أرسل رسالة نصية.",
        next_question: "",
        quick_choices: [],
        tips: [],
        when_to_seek_help: "",
      });
    }

    const system = buildSystemPrompt();
    const user = buildUserPrompt(message, meta, last);

    const max_tokens = chooseMaxTokens(message, last);

    // Small model first
    let content = "";
    let parsed = null;

    try {
      content = await callGroq({
        model: SMALL_MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens,
      });

      parsed = extractJsonFromText(content);
      if (!parsed) parsed = parseViaRegexFallback(content);
    } catch {
      parsed = null;
    }

    // Big fallback if needed
    if (!parsed) {
      content = await callGroq({
        model: BIG_MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: Math.max(max_tokens, 240),
      });

      parsed = extractJsonFromText(content) || parseViaRegexFallback(content);
    }

    const normalized = normalizeLLMOutput(parsed);
    return res.json(normalized);
  } catch (e) {
    return res.status(500).json({
      category: "general",
      title: "خطأ",
      verdict: "حصل خطأ في الخادم.",
      next_question: "",
      quick_choices: [],
      tips: [],
      when_to_seek_help: "",
      err: String(e?.message || e),
    });
  }
});

// Start
app.listen(PORT, () => {
  console.log(`Dalil Alafiyah API listening on :${PORT}`);
});
