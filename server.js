// ===============================
// server.js — Dalil Alafiyah API (Hardened)
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
const MODEL_ID = process.env.GROQ_API_MODEL || process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const PORT = process.env.PORT || 3000;

if (!GROQ_API_KEY) {
  console.error("❌ GROQ_API_KEY غير مضبوط");
  process.exit(1);
}

app.use(helmet());
app.use(cors());
app.use(bodyParser.json({ limit: "2mb" }));

// ===============================
// Network
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

// ===============================
// JSON Hardening (Core Fix)
// ===============================

/**
 * تنظيف نص "يشبه JSON" لإزالة أشهر مسببات فشل JSON.parse
 * - اقتباسات ذكية
 * - BOM / رموز تحكم
 * - trailing commas قبل } أو ]
 */
function cleanJsonish(input) {
  return String(input || "")
    .replace(/^\uFEFF/, "")                 // BOM
    .replace(/[\u0000-\u001F\u007F]/g, "")  // control chars
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, "$1");
}

/**
 * استخراج أول كتلة JSON متوازنة الأقواس من نص طويل.
 * هذه تتجاوز مشكلة وجود نص قبل/بعد JSON أو وجود Markdown.
 */
function extractBalancedJsonBlock(text) {
  const s = String(text || "");
  const start = s.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < s.length; i++) {
    const ch = s[i];

    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") depth++;
    if (ch === "}") depth--;

    if (depth === 0) {
      return s.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * محاولة parsing متعددة المراحل:
 * 1) استخراج كتلة JSON متوازنة من النص
 * 2) تنظيفها
 * 3) JSON.parse
 * 4) إذا فشل: محاولة تنظيف أوسع للنص الكامل ثم استخراج مرة ثانية
 */
function safeParseModelJson(raw) {
  // المرحلة 1: استخراج كتلة متوازنة
  const block1 = extractBalancedJsonBlock(raw);
  if (block1) {
    const cleaned1 = cleanJsonish(block1);
    try {
      return JSON.parse(cleaned1);
    } catch {}
  }

  // المرحلة 2: تنظيف النص الكامل ثم استخراج
  const cleanedAll = cleanJsonish(raw);
  const block2 = extractBalancedJsonBlock(cleanedAll);
  if (block2) {
    try {
      return JSON.parse(block2);
    } catch {}
  }

  return null;
}

// ===============================
// Validation / Normalization
// ===============================
const sStr = (v) => (typeof v === "string" ? v.trim() : "");
const sArr = (v, n) =>
  Array.isArray(v)
    ? v.filter((x) => typeof x === "string" && x.trim()).slice(0, n)
    : [];

function normalize(obj) {
  return {
    category: sStr(obj?.category) || "general",
    title: sStr(obj?.title) || "معلومة صحية",
    verdict: sStr(obj?.verdict) || "—",
    next_question: sStr(obj?.next_question) || "",
    quick_choices: sArr(obj?.quick_choices, 3),
    tips: sArr(obj?.tips, 3), // خليتها 3 لو تحب 2 رجّعها
    when_to_seek_help: sStr(obj?.when_to_seek_help) || "",
  };
}

/**
 * IMPORTANT:
 * لا تُرجع raw أبداً للمستخدم (هذا هو سبب ظهور الأكواد).
 */
function safeFallbackCard(message = "تعذر تنسيق الرد، جرّب صياغة السؤال بطريقة مختلفة.") {
  return {
    category: "general",
    title: "معلومة صحية",
    verdict: message,
    next_question: "",
    quick_choices: [],
    tips: [],
    when_to_seek_help: "",
  };
}

// ===============================
// Prompt
// ===============================
function buildSystemPrompt() {
  return `
أنت "دليل العافية" — مساعد تثقيف صحي عربي (معلومات عامة فقط).

# إخراج صارم
أخرج JSON صالح strict فقط وبدون أي نص خارجه.
ممنوع: Markdown، ممنوع: \`\`\`، ممنوع: أي شرح.

# قالب ثابت
{
  "category": "general | sugar | blood_pressure | nutrition | sleep | activity | mental | first_aid | report | emergency",
  "title": "عنوان قصير (2-5 كلمات)",
  "verdict": "جملة واحدة واضحة",
  "next_question": "سؤال واحد فقط (أو \"\")",
  "quick_choices": ["خيار 1","خيار 2"],
  "tips": ["نصيحة قصيرة 1","نصيحة قصيرة 2"],
  "when_to_seek_help": "متى تراجع الطبيب أو الطوارئ (أو \"\")"
}

# قواعد
- لا تشخيص
- لا أدوية ولا جرعات
- لغة عربية بسيطة
- تجنب الفواصل الزائدة trailing commas
`.trim();
}

/**
 * Prompt إصلاحي لو فشل الـ JSON في أول محاولة.
 * قصير وحازم.
 */
function buildRepairPrompt(raw) {
  return `
أعد إخراج "نفس المحتوى" بصيغة JSON صالح strict فقط حسب القالب التالي، بدون أي نص خارج JSON، وبدون trailing commas:

{
  "category": "general | sugar | blood_pressure | nutrition | sleep | activity | mental | first_aid | report | emergency",
  "title": "عنوان قصير (2-5 كلمات)",
  "verdict": "جملة واحدة واضحة",
  "next_question": "سؤال واحد فقط (أو \"\")",
  "quick_choices": ["خيار 1","خيار 2"],
  "tips": ["نصيحة قصيرة 1","نصيحة قصيرة 2"],
  "when_to_seek_help": "متى تراجع الطبيب أو الطوارئ (أو \"\")"
}

النص الذي يجب تحويله إلى JSON (لا تنسخه ككتلة، فقط استخرج المعنى):
${String(raw || "").slice(0, 2500)}
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
        temperature: 0.1, // أقل = أخطاء JSON أقل
        max_tokens: 500,
        messages,
      }),
    }
  );

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Groq API error: ${res.status} ${t}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

// ===============================
// Routes
// ===============================
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "Dalil Alafiyah API", model: MODEL_ID });
});

app.post("/chat", async (req, res) => {
  try {
    const msg = String(req.body.message || "").trim();
    if (!msg) return res.status(400).json({ ok: false, error: "empty_message" });

    // 1) محاولة أولى
    const raw1 = await callGroq([
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: msg },
    ]);

    let obj = safeParseModelJson(raw1);

    // 2) إذا فشل: محاولة إصلاح ثانية تلقائية (تجبر JSON strict)
    if (!obj) {
      const raw2 = await callGroq([
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: buildRepairPrompt(raw1) },
      ]);
      obj = safeParseModelJson(raw2);
    }

    // 3) النتيجة النهائية: لا raw للمستخدم أبداً
    const data = obj ? normalize(obj) : safeFallbackCard();

    return res.json({ ok: true, data });
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      ok: false,
      error: "server_error",
      data: safeFallbackCard("حدث خطأ بالخادم. إذا كان لديك أعراض مقلقة راجع طبيبًا."),
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Dalil Alafiyah API يعمل على المنفذ ${PORT}`);
});
