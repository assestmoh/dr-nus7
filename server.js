// ===============================
// server.js — Dalil Alafiyah API
// دمج تحسينات الجودة + منع الأكواد + Retry واحد + تمرير السياق
// (بدون تغيير الواجهة/الفكرة)
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

  // parse عادي
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

  // "verdict": "...."
  const m = s.match(/"verdict"\s*:\s*"([^"]+)"/);
  if (m && m[1]) return m[1].replace(/\\"/g, '"').trim();

  // \"verdict\": \"...\"
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
// System Prompt (محسن للجودة والاستمرارية)
// ===============================
function buildSystemPrompt() {
  return `
أنت "دليل العافية" — مرافق عربي للتثقيف الصحي فقط (ليس تشخيصًا).

مخرجاتك: JSON صالح strict فقط (بدون أي نص خارج JSON، بدون Markdown، بدون \`\`\`، بدون trailing commas).
ممنوع الردود العامة مثل: "أنا هنا لمساعدتك" أو مقدمات مطاطة. كن محددًا ومباشرًا.

التصنيفات المسموحة فقط (طابقها حرفيًا):
general | nutrition | bp | sugar | sleep | activity | mental | first_aid | report | emergency | water | calories | bmi

شكل JSON:
{
  "category": "واحد من القائمة أعلاه",
  "title": "عنوان محدد (2-5 كلمات) مرتبط بالموضوع الحالي. ممنوع: الاستفسار الأول، متابعة، معلومة صحية (إلا عند فشل واضح)",
  "verdict": "جملة واحدة محددة تلخص أهم توجيه/تطمين مرتبط مباشرة بسؤال المستخدم/سياقه",
  "next_question": "سؤال واحد فقط لاستكمال نفس الموضوع (أو \\"\\")",
  "quick_choices": ["خيار 1","خيار 2"],
  "tips": ["نصيحة قصيرة 1","نصيحة قصيرة 2"],
  "when_to_seek_help": "متى تراجع الطبيب/الطوارئ (أو \\"\\")"
}

قواعد جودة مهمة:
- التزم بالموضوع الحالي ولا تغيّر المسار بلا سبب.
- إذا وصلت إجابة قصيرة مثل "نعم/لا" أو اختيار مثل "صحة القلب"، اعتبرها إجابة لسؤال البطاقة السابقة وكمّل نفس السياق.
- tips عملية ومحددة (تجنب: اشرب ماء/نم جيدًا كحل لكل شيء إلا إذا كان مناسبًا فعلًا).
- next_question مرتبط مباشرة بما قاله المستخدم الآن + السياق السابق، وليس سؤالًا عامًا.
- quick_choices: 0 أو 2 فقط وتطابق next_question.
- when_to_seek_help: إنذارات واضحة فقط، وإلا خله فارغًا.
- لا أدوية/لا جرعات/لا تشخيص.
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
// Normalize (مع mapping للتوافق مع الواجهة)
// ===============================
function normalize(obj) {
  let cat = sStr(obj?.category) || "general";

  // mapping شائع من النماذج/التاريخ القديم
  if (cat === "blood_pressure") cat = "bp";
  if (cat === "bloodpressure") cat = "bp";
  if (cat === "nutrition") cat = "nutrition";

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
    quick_choices: sArr(obj?.quick_choices, 2), // خيارين فقط
    tips: sArr(obj?.tips, 2),
    when_to_seek_help: sStr(obj?.when_to_seek_help),
  };
}

/**
 * fallback سابقًا كان يسرب raw داخل verdict -> سبب ظهور الأكواد
 * الآن: لا نسرب raw للمستخدم. نحاول نلتقط verdict فقط، وإلا رسالة عامة.
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

    // ✅ تمرير سياق آخر بطاقة من الواجهة (بدون تغيير الواجهة)
    const lastCard = req.body?.context?.last || null;

    const messages = [{ role: "system", content: buildSystemPrompt() }];

    if (lastCard && typeof lastCard === "object") {
      messages.push({
        role: "assistant",
        content:
          "سياق سابق (آخر بطاقة JSON للاستمرار عليها بدون تكرار):\n" +
          JSON.stringify(lastCard),
      });
    }

    messages.push({ role: "user", content: msg });

    const raw = await callGroq(messages);

    let parsed = extractJson(raw);

    // ✅ Retry مرة واحدة فقط إذا فشل parsing
    if (!parsed) {
      const retryRaw = await callGroq([
        { role: "system", content: buildSystemPrompt() },
        {
          role: "user",
          content:
            "أعد نفس الإجابة بصيغة JSON strict فقط (بدون أي نص خارج JSON وبدون ``` وبدون trailing commas).\n" +
            "هذه كانت الإجابة السابقة غير الصالحة:\n" +
            raw,
        },
      ]);

      parsed = extractJson(retryRaw);
    }

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
