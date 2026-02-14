// ===============================
// server.js — Dalil Alafiyah API
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

/**
 * تنظيف JSON "شبه صحيح" + حالات شائعة تسبب فشل JSON.parse:
 * - ```json ... ```
 * - اقتباسات ذكية “ ”
 * - trailing commas
 */
function cleanJsonish(s) {
  let t = String(s || "").trim();

  // إزالة code fences
  if (t.startsWith("```")) {
    t = t.replace(/^```[a-zA-Z]*\s*/m, "").replace(/```$/m, "").trim();
  }

  // اقتباسات ذكية
  t = t.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");

  // trailing commas
  t = t.replace(/,\s*([}\]])/g, "$1");

  return t;
}

/**
 * استخراج JSON من رد النموذج في عدة صيغ محتملة:
 * 1) JSON مباشر: { ... }
 * 2) JSON داخل code block
 * 3) JSON stringified: "{\"title\":\"...\"}"
 * 4) JSON ضمن نص أطول -> اقتناص { ... }
 * 5) JSON فيه escaping مثل \" و \\n
 */
function extractJson(text) {
  const s0 = String(text || "");
  let s = cleanJsonish(s0);

  // محاولة 1: parse كامل الرد
  try {
    const first = JSON.parse(s);

    if (first && typeof first === "object") return first;

    if (typeof first === "string") {
      const second = JSON.parse(cleanJsonish(first));
      if (second && typeof second === "object") return second;
    }
  } catch {}

  // محاولة 2: اقتناص { ... }
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a === -1 || b === -1 || b <= a) return null;

  let chunk = cleanJsonish(s.slice(a, b + 1));

  try {
    return JSON.parse(chunk);
  } catch {}

  // محاولة 3: فك escaping الشائع ثم parse
  const unescaped = cleanJsonish(
    chunk
      .replace(/\\"/g, '"')
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\r/g, "\r")
  );

  try {
    return JSON.parse(unescaped);
  } catch {
    return null;
  }
}

// محاولة استخراج "verdict" بنمط Regex إذا فشل JSON.parse
function extractVerdictLoosely(raw) {
  const s = String(raw || "");
  // يلتقط: "verdict": "...."
  const m = s.match(/"verdict"\s*:\s*"([^"]+)"/);
  if (m && m[1]) return m[1].replace(/\\"/g, '"').trim();

  // أحيانًا تكون: \"verdict\": \"...\"
  const m2 = s.match(/\\"verdict\\"\s*:\s*\\"([^\\]+)\\"/);
  if (m2 && m2[1]) return m2[1].replace(/\\"/g, '"').trim();

  return "";
}

const sStr = (v) => (typeof v === "string" ? v.trim() : "");
const sArr = (v, n) =>
  Array.isArray(v)
    ? v.filter((x) => typeof x === "string" && x.trim()).slice(0, n)
    : [];

// ===============================
// System Prompt
// ===============================
function buildSystemPrompt() {
  return `
أنت "دليل العافية" — مرافق صحي عربي للتثقيف الصحي فقط.

أخرج الرد بصيغة JSON فقط وبدون أي نص خارجها.
مهم: يجب أن يكون JSON صالحًا strict (بدون trailing commas وبدون Markdown وبدون \`\`\`).

{
  "category": "general | sugar | blood_pressure | nutrition | sleep | activity | mental | first_aid | report | emergency",
  "title": "عنوان قصير (2-5 كلمات)",
  "verdict": "جملة واحدة: تطمين أو تنبيه",
  "next_question": "سؤال واحد فقط (أو \\"\\")",
  "quick_choices": ["خيار 1","خيار 2"],
  "tips": ["نصيحة قصيرة 1","نصيحة قصيرة 2"],
  "when_to_seek_help": "متى تراجع الطبيب أو الطوارئ (أو \\"\\")"
}

قواعد:
- لا تشخيص
- لا أدوية
- لا جرعات
- السؤال والأزرار قبل النصائح
- لغة بسيطة
`.trim();
}

// ===============================
// Groq
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
        max_tokens: 450,
        messages,
      }),
    }
  );

  if (!res.ok) throw new Error("Groq API error");
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

// ===============================
// Normalize
// ===============================
function normalize(obj) {
  return {
    category: sStr(obj?.category) || "general",
    title: sStr(obj?.title) || "دليل العافية",
    verdict: sStr(obj?.verdict),
    next_question: sStr(obj?.next_question),
    quick_choices: sArr(obj?.quick_choices, 3),
    tips: sArr(obj?.tips, 2),
    when_to_seek_help: sStr(obj?.when_to_seek_help),
  };
}

/**
 * fallback سابقًا كان يسرب raw داخل verdict -> هذا سبب ظهور "الأكواد" في الواجهة.
 * الآن: لا نسرب raw للمستخدم. نحاول نلتقط verdict بشكل بسيط، وإلا رسالة عامة.
 * (لا تغيير في المنطق/الواجهة: فقط منع ظهور الأكواد)
 */
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

// ===============================
// Routes
// ===============================
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "Dalil Alafiyah API" });
});

app.post("/chat", async (req, res) => {
  try {
    const msg = String(req.body.message || "").trim();
    if (!msg) {
      return res.status(400).json({ ok: false, error: "empty_message" });
    }

    const raw = await callGroq([
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: msg },
    ]);

    const parsed = extractJson(raw);
    const data = parsed ? normalize(parsed) : fallback(raw);

    res.json({ ok: true, data });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      ok: false,
      error: "server_error",
      data: fallback("حدث خطأ غير متوقع. راجع الطبيب إذا الأعراض مقلقة."),
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Dalil Alafiyah API يعمل على ${PORT}`);
});
