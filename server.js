// ===============================
// server.js — Dalil Alafiyah API (modified)
// - يمنع ظهور "كود/JSON" بدل بطاقة
// - يحسّن استخراج JSON حتى لو رجع داخل ```json```
// - ينظّف الحقول من backticks / code blocks
// - fallback ثابت (لا يعرض raw للمستخدم)
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

// لو تبي تضيق CORS لاحقًا، غيّر origin هنا
app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-user-id", "X-User-Id"],
  })
);

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

// تنظيف النص من code blocks/backticks
function sanitizeText(v) {
  let s = typeof v === "string" ? v : "";
  s = s.trim();
  // إزالة أي code block بالكامل
  s = s.replace(/```[\s\S]*?```/g, "").trim();
  // إزالة backticks المفردة
  s = s.replace(/`+/g, "").trim();
  // تقليل فراغات كثيرة
  s = s.replace(/\s{3,}/g, " ").trim();
  return s;
}

// استخراج JSON حتى لو جاء داخل ```json``` أو مع نص إضافي
function extractJson(text) {
  let s = String(text || "").trim();

  // شيل fences لو موجودة
  s = s.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();

  // جرّب parse مباشر
  try {
    return JSON.parse(s);
  } catch {}

  // جرّب قصّ أول object
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a === -1 || b === -1 || b <= a) return null;

  const candidate = s.slice(a, b + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

const sStr = (v) => sanitizeText(v);
const sArr = (v, n) =>
  Array.isArray(v)
    ? v.map(sanitizeText).filter((x) => x).slice(0, n)
    : [];

// ===============================
// System Prompt
// ===============================
function buildSystemPrompt() {
  return `
أنت "دليل العافية" — مرافق صحي عربي للتثقيف الصحي فقط.

أخرج الرد بصيغة JSON فقط وبدون أي نص خارجها:

{
  "category": "general | sugar | blood_pressure | nutrition | sleep | activity | mental | first_aid | report | emergency",
  "title": "عنوان قصير (2-5 كلمات)",
  "verdict": "جملة واحدة: تطمين أو تنبيه",
  "next_question": "سؤال واحد فقط (أو \"\")",
  "quick_choices": ["خيار 1","خيار 2"],
  "tips": ["نصيحة قصيرة 1","نصيحة قصيرة 2"],
  "when_to_seek_help": "متى تراجع الطبيب أو الطوارئ (أو \"\")"
}

قواعد:
- لا تشخيص
- لا أدوية
- لا جرعات
- السؤال والأزرار قبل النصائح
- لغة بسيطة
- quick_choices: لا تزيد عن 3 خيارات قصيرة ومباشرة
- tips: لا تزيد عن 2 نصيحة قصيرة
`.trim();
}

// ===============================
// Groq
// ===============================
async function callGroq(messages) {
  const payload = {
    model: MODEL_ID,
    temperature: 0.35,
    max_tokens: 450,
    messages,
    // إذا كان مدعوم عندك سيقلل أخطاء "الكود بدل JSON"
    // لو غير مدعوم غالبًا سيتم تجاهله أو يرجع خطأ؛ لذلك نعمل retry بدونها عند الخطأ
    response_format: { type: "json_object" },
  };

  // محاولة 1: مع response_format
  let res = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  // إذا فشلت لأن response_format غير مدعوم، جرّب بدونها
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    // fallback try without response_format
    const payload2 = { ...payload };
    delete payload2.response_format;

    res = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload2),
    });

    if (!res.ok) {
      // اطبع جزء بسيط فقط (بدون إغراق)
      console.error("Groq API error:", res.status, txt.slice(0, 300));
      throw new Error("Groq API error");
    }
  }

  const data = await res.json().catch(() => ({}));
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

// fallback ثابت: لا يعرض raw أبداً (يمنع ظهور كود للمستخدم)
function fallback() {
  return {
    category: "general",
    title: "دليل العافية",
    verdict: "لم أفهم صيغة الرد. اكتب سؤالك بجملة واحدة وسأساعدك.",
    next_question: "وش تقصد بالضبط؟ (الأعراض/المدة/العمر إن أمكن)",
    quick_choices: ["سكر", "ضغط", "إسعافات"],
    tips: ["اكتب أهم عرض + مدته", "اذكر إن لديك مرض مزمن"],
    when_to_seek_help: "إذا ألم صدر/ضيق نفس/إغماء/نزيف شديد: طوارئ فورًا.",
  };
}

// ضمان شكل البطاقة دائماً (حتى لو الموديل نقص مفاتيح)
function ensureCardShape(data) {
  const d = data || {};
  return {
    category: sStr(d.category) || "general",
    title: sStr(d.title) || "دليل العافية",
    verdict: sStr(d.verdict) || "",
    next_question: sStr(d.next_question) || "",
    quick_choices: sArr(d.quick_choices, 3),
    tips: sArr(d.tips, 2),
    when_to_seek_help: sStr(d.when_to_seek_help) || "",
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
    const msg = String(req.body?.message || "").trim();
    if (!msg) return res.status(400).json({ ok: false, error: "empty_message" });

    const raw = await callGroq([
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: msg },
    ]);

    const parsed = extractJson(raw);

    // لو ما قدرنا نستخرج JSON: لا نعرض raw للمستخدم نهائيًا
    if (!parsed) {
      return res.json({ ok: true, data: fallback() });
    }

    // طبّع ونظّف
    const data = ensureCardShape(normalize(parsed));

    // لو الموديل خبّص ورجّع نصوص فاضية جدًا، رجع fallback بدل ما يطلع “فارغ”
    const weak =
      !data.verdict && !data.next_question && (!data.tips?.length) && (!data.quick_choices?.length);
    if (weak) {
      return res.json({ ok: true, data: fallback() });
    }

    res.json({ ok: true, data });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      ok: false,
      error: "server_error",
      data: fallback(),
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Dalil Alafiyah API يعمل على ${PORT}`);
});
