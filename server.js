// ===============================
// server.js — Dalil Alafiyah API (FINAL+DEBUG)
// Stable: context pass + strict JSON parsing + partial recovery
// + retry re-ask (NOT "fix JSON") to avoid meta technical replies
// + prevent code/JSON leakage to UI
// + IMPORTANT: print real Groq error (status + body) to logs
// + add /reset to avoid 404 from UI
// + add /report placeholder (501) if UI calls it
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
 * تنظيف JSON "شبه صحيح":
 * - ```json ... ```
 * - اقتباسات ذكية “ ”
 * - trailing commas
 */
function cleanJsonish(s) {
  let t = String(s || "").trim();

  if (t.startsWith("```")) {
    t = t.replace(/^```[a-zA-Z]*\s*/m, "").replace(/```$/m, "").trim();
  }

  t = t.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  t = t.replace(/,\s*([}\]])/g, "$1");

  return t;
}

function extractJson(text) {
  const s0 = String(text || "");
  let s = cleanJsonish(s0);

  // 1) parse كامل الرد
  try {
    const first = JSON.parse(s);
    if (first && typeof first === "object") return first;

    // 2) لو كان stringified JSON
    if (typeof first === "string") {
      const second = JSON.parse(cleanJsonish(first));
      if (second && typeof second === "object") return second;
    }
  } catch {}

  // 3) اقتناص { ... }
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a === -1 || b === -1 || b <= a) return null;

  let chunk = cleanJsonish(s.slice(a, b + 1));

  try {
    return JSON.parse(chunk);
  } catch {}

  // 4) فك escaping الشائع
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

function extractVerdictLoosely(raw) {
  const s = String(raw || "");

  const m = s.match(/"verdict"\s*:\s*"([^"]+)"/);
  if (m && m[1]) return m[1].replace(/\\"/g, '"').trim();

  const m2 = s.match(/\\"verdict\\"\s*:\s*\\"([^\\]+)\\"/);
  if (m2 && m2[1]) return m2[1].replace(/\\"/g, '"').trim();

  return "";
}

/**
 * Partial Recovery: إذا JSON مقطوع، نلقط أهم الحقول ونبني بطاقة.
 */
function recoverPartialCard(raw) {
  const s = String(raw || "");

  const pick = (re) => {
    const m = s.match(re);
    return m && m[1] ? m[1].replace(/\\"/g, '"').trim() : "";
  };

  const category =
    pick(/"category"\s*:\s*"([^"]+)"/) ||
    pick(/\\"category\\"\s*:\s*\\"([^\\]+)\\"/);

  const title =
    pick(/"title"\s*:\s*"([^"]+)"/) ||
    pick(/\\"title\\"\s*:\s*\\"([^\\]+)\\"/);

  const verdict =
    pick(/"verdict"\s*:\s*"([^"]+)"/) ||
    pick(/\\"verdict\\"\s*:\s*\\"([^\\]+)\\"/);

  const next_question =
    pick(/"next_question"\s*:\s*"([^"]*)"/) ||
    pick(/\\"next_question\\"\s*:\s*\\"([^\\]*)\\"/);

  const when_to_seek_help =
    pick(/"when_to_seek_help"\s*:\s*"([^"]*)"/) ||
    pick(/\\"when_to_seek_help\\"\s*:\s*\\"([^\\]*)\\"/);

  const arrPick = (key) => {
    const m = s.match(new RegExp(`"${key}"\\s*:\\s*\\[([\\s\\S]*?)\\]`));
    const inner = m && m[1] ? m[1] : "";
    if (!inner) return [];
    return inner
      .split(",")
      .map((x) => x.trim())
      .map((x) => x.replace(/^"+|"+$/g, "").replace(/\\"/g, '"'))
      .filter((x) => x);
  };

  const quick_choices = arrPick("quick_choices").slice(0, 2);
  const tips = arrPick("tips").slice(0, 2);

  if (!title && !verdict && tips.length === 0 && !next_question) return null;

  return {
    category: category || "general",
    title: title || "دليل العافية",
    verdict: verdict || "",
    next_question: next_question || "",
    quick_choices,
    tips,
    when_to_seek_help: when_to_seek_help || "",
  };
}

/**
 * منع ردود "Meta JSON" التقنية (حتى لو كانت JSON صحيح)
 */
function isMetaJsonAnswer(d) {
  const text =
    String(d?.title || "") +
    " " +
    String(d?.verdict || "") +
    " " +
    String(d?.next_question || "") +
    " " +
    String(d?.when_to_seek_help || "") +
    " " +
    (Array.isArray(d?.tips) ? d.tips.join(" ") : "") +
    " " +
    (Array.isArray(d?.quick_choices) ? d.quick_choices.join(" ") : "");

  return /json|تنسيق|اقتباس|اقتباسات|فواصل|صيغة|تم تنسيق|تعديل الرد|format|quotes|commas/i.test(
    text
  );
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
أنت "دليل العافية" — مرافق عربي للتثقيف الصحي فقط (ليس تشخيصًا).

مخرجاتك: JSON صالح strict فقط (بدون أي نص خارج JSON، بدون Markdown، بدون \`\`\`، بدون trailing commas).
ممنوع الردود العامة مثل: "أنا هنا لمساعدتك". كن محددًا ومباشرًا.
ممنوع ذكر JSON أو التنسيق أو الفواصل أو الاقتباسات أو "تم تنسيق الإجابة". ركّز فقط على النصائح الصحية.

التصنيفات المسموحة فقط (طابقها حرفيًا):
general | nutrition | bp | sugar | sleep | activity | mental | first_aid | report | emergency | water | calories | bmi

شكل JSON:
{
  "category": "واحد من القائمة أعلاه",
  "title": "عنوان محدد (2-5 كلمات) مرتبط بالموضوع الحالي",
  "verdict": "جملة واحدة محددة مرتبطة بالسياق",
  "next_question": "سؤال واحد فقط لاستكمال نفس الموضوع (أو \\"\\")",
  "quick_choices": ["خيار 1","خيار 2"],
  "tips": ["نصيحة قصيرة 1","نصيحة قصيرة 2"],
  "when_to_seek_help": "متى تراجع الطبيب/الطوارئ (أو \\"\\")"
}

قواعد:
- التزم بالموضوع ولا تغيّر المسار بلا سبب.
- إذا كانت الرسالة قصيرة مثل "نعم/لا" أو اختيار، اعتبرها إجابة لسؤال البطاقة السابقة وكمل بنفس المسار.
- quick_choices: 0 أو 2 فقط وتطابق next_question.
- لا أدوية/لا جرعات/لا تشخيص.
`.trim();
}

// ===============================
// Groq (with real error logging)
// ===============================
async function callGroq(messages) {
  let res;
  try {
    res = await fetchWithTimeout(
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
          max_tokens: 520,
          messages,
        }),
      },
      20000
    );
  } catch (e) {
    // timeout / network / abort
    console.error("❌ Groq fetch failed:", e?.name || "", e?.message || e);
    throw new Error("GROQ_FETCH_FAILED");
  }

  // read text always to print body on errors
  const text = await res.text();

  if (!res.ok) {
    console.error("❌ Groq HTTP:", res.status, res.statusText);
    console.error("❌ Groq body:", text.slice(0, 2000));

    const err = new Error("GROQ_HTTP_" + res.status);
    err.status = res.status;
    err.body = text;
    throw err;
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    console.error("❌ Groq non-JSON:", text.slice(0, 2000));
    throw new Error("GROQ_BAD_JSON");
  }

  return data.choices?.[0]?.message?.content || "";
}

// ===============================
// Normalize (UI compatible categories)
// ===============================
function normalize(obj) {
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
    quick_choices: sArr(obj?.quick_choices, 2),
    tips: sArr(obj?.tips, 2),
    when_to_seek_help: sStr(obj?.when_to_seek_help),
  };
}

function fallback(rawText) {
  const looseVerdict = extractVerdictLoosely(rawText);
  return {
    category: "general",
    title: "معلومة صحية",
    verdict:
      looseVerdict ||
      "تعذر توليد رد منظم الآن. جرّب إعادة صياغة السؤال بشكل مختصر.",
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

// ✅ avoid UI 404
app.post("/reset", (_req, res) => {
  // لا يوجد state في السيرفر حاليًا — مجرد نجاح للواجهة
  res.json({ ok: true });
});

// ✅ placeholder (لو واجهتك تستدعيه)
app.post("/report", (_req, res) => {
  res.status(501).json({
    ok: false,
    error: "not_implemented",
    message: "Endpoint /report غير مفعل في هذا السيرفر.",
  });
});

app.post("/chat", async (req, res) => {
  try {
    const msg = String(req.body.message || "").trim();
    if (!msg) {
      return res.status(400).json({ ok: false, error: "empty_message" });
    }

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

    // 1) call
    const raw = await callGroq(messages);
    let parsed = extractJson(raw);

    // 2) retry مرة واحدة فقط — إعادة السؤال (msg) وليس "إصلاح JSON"
    let retryRaw = "";
    if (!parsed) {
      retryRaw = await callGroq(messages); // نفس الرسائل تمامًا
      parsed = extractJson(retryRaw);
    }

    // 3) build data
    let data;
    if (parsed) {
      data = normalize(parsed);
    } else {
      const recovered = recoverPartialCard(retryRaw || raw);
      data = recovered ? normalize(recovered) : fallback(raw);
    }

    // 4) block meta technical cards
    if (isMetaJsonAnswer(data)) {
      const recovered = recoverPartialCard(retryRaw || raw);
      data = recovered ? normalize(recovered) : fallback(raw);
    }

    res.json({ ok: true, data });
  } catch (e) {
    // هنا بتشوف السبب الحقيقي في اللوق بعد تعديل callGroq
    console.error("❌ /chat error:", e?.message || e);

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
