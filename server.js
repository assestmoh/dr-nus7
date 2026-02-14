// ===============================
// server.js — Dalil Alafiyah API (FINAL)
// هدف النسخة:
// 1) منع ظهور الأكواد/JSON الخام للمستخدم (no leakage)
// 2) استخراج/تنظيف JSON حتى لو رجع النموذج بصيغة غير مثالية
// 3) تمرير سياق آخر بطاقة من الواجهة لاستمرارية المحادثة
// 4) Retry واحد فقط عند فشل الـ JSON (بدون طلب "إصلاح JSON" لتجنب ردود تقنية)
// 5) حجب البطاقات التقنية (Meta about JSON/format)
// 6) تحسين جودة الإرشاد عبر Prompt أدق + حقائق مستخرجة من رسائل الحاسبات
//
// + (تعديلات توفير التوكن - 4 نقاط):
// A) رد محلي للـ small-talk
// B) خفض max_tokens
// C) Slim lastCard context
// D) Retry فقط إذا يستاهل
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
async function fetchWithTimeout(url, options = {}, ms = 20000) {
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

  // إزالة code fences
  if (t.startsWith("```")) {
    t = t.replace(/^```[a-zA-Z]*\s*/m, "").replace(/```\s*$/m, "").trim();
  }

  // اقتباسات ذكية
  t = t.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");

  // trailing commas
  t = t.replace(/,\s*([}\]])/g, "$1");

  return t;
}

/**
 * استخراج JSON من عدة صيغ محتملة:
 * 1) JSON مباشر
 * 2) JSON داخل code block
 * 3) JSON stringified
 * 4) JSON ضمن نص أطول (اقتطاع بين أول { وآخر })
 * 5) JSON مع escaping مثل \" و \n
 */
function extractJson(text) {
  const s0 = String(text || "");
  let s = cleanJsonish(s0);

  // محاولة 1: parse كامل الرد
  try {
    const first = JSON.parse(s);
    if (first && typeof first === "object") return first;

    // لو كان stringified JSON
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

  // محاولة 3: فك escaping الشائع
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
 * منع ردود "Meta" التقنية (حتى لو JSON صحيح)
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

  return /json|تنسيق|اقتباس|اقتباسات|فواصل|صيغة|تم تنسيق|تعديل الرد|format|quotes|commas|code fence|```/i.test(
    text
  );
}

const sStr = (v) => (typeof v === "string" ? v.trim() : "");
const sArr = (v, n) =>
  Array.isArray(v)
    ? v.filter((x) => typeof x === "string" && x.trim()).slice(0, n)
    : [];

// ===============================
// (تعديل 1) Small-talk local response (بدون Groq)
// ===============================
function isSmallTalk(msg) {
  const t = String(msg || "").trim().toLowerCase();
  const small = [
    "هلا",
    "مرحبا",
    "السلام عليكم",
    "وعليكم السلام",
    "تمام",
    "طيب",
    "اوك",
    "ok",
    "شكرا",
    "شكرًا",
    "يعطيك العافيه",
    "يعطيك العافية",
    "اهلا",
    "أهلا",
    "hello",
    "hi",
  ];
  if (t.length <= 2) return true;
  if (t.length <= 4 && /^[a-z]+$/i.test(t)) return true;
  return small.some((w) => t === w || t.includes(w));
}

function smallTalkCard() {
  return {
    category: "general",
    title: "دليل العافية",
    verdict: "هلا 👋 اكتب سؤالك مباشرة أو اختر موضوع من الأزرار.",
    next_question: "وش تبي تفحص؟",
    quick_choices: ["سكر", "ضغط"],
    tips: ["إذا عندك رقم ارسله مباشرة (مثال: سكر صائم 90).", "إذا عندك تقرير، الصق نصّه هنا."],
    when_to_seek_help: "",
  };
}

// ===============================
// (تعديل 4) Retry gate: هل يستاهل نعيد الطلب؟
// ===============================
function shouldRetry(raw) {
  const s = String(raw || "");
  if (!s.includes("{") || !s.includes("}")) return false; // ما فيه محاولة JSON أصلاً
  // إذا فيه مؤشرات أنه حاول JSON لكنه انكسر
  if (s.includes("```")) return true;
  if (s.length > 40) return true;
  return true;
}

// ===============================
// System Prompt (محسّن للجودة)
// ===============================
function buildSystemPrompt() {
  return `
أنت "دليل العافية" — مرافق عربي للتثقيف الصحي فقط (ليس تشخيصًا).

مخرجاتك: JSON صالح strict فقط (بدون أي نص خارج JSON، بدون Markdown، بدون \`\`\`، بدون trailing commas).
ممنوع الردود العامة مثل: "أنا هنا لمساعدتك". كن محددًا ومباشرًا.
ممنوع ذكر JSON أو التنسيق أو الفواصل أو الاقتباسات أو "تم تنسيق" أو أي كلام تقني.

التصنيفات المسموحة فقط (طابقها حرفيًا):
general | nutrition | bp | sugar | sleep | activity | mental | first_aid | report | emergency | water | calories | bmi

شكل JSON:
{
  "category": "واحد من القائمة أعلاه",
  "title": "عنوان محدد (2-5 كلمات) مرتبط بالسياق الحالي",
  "verdict": "جملة واحدة محددة مرتبطة مباشرة بسؤال المستخدم/السياق",
  "next_question": "سؤال واحد فقط لاستكمال نفس الموضوع (أو \\\"\\\\\\\"\\\")",
  "quick_choices": ["خيار 1","خيار 2"],
  "tips": ["نصيحة قصيرة 1","نصيحة قصيرة 2"],
  "when_to_seek_help": "متى تراجع الطبيب/الطوارئ (أو \\\"\\\\\\\"\\\")"
}

قواعد جودة (مهم جدًا):
- التزم بالموضوع الحالي ولا تغيّر المسار بلا سبب.
- إذا كانت رسالة المستخدم قصيرة ("نعم/لا" أو اختيار)، اعتبرها إجابة لسؤال البطاقة السابقة وأكمل نفس المسار.
- quick_choices: إما 0 أو 2 فقط، ويجب أن تطابق next_question حرفيًا.
- إذا next_question فارغ، اجعل quick_choices فارغة.
- tips عملية ومحددة (تجنب نصائح عامة جدًا إلا إذا مناسبة فعلًا).
- لا أدوية/لا جرعات/لا تشخيص.

قواعد موضوعية سريعة:
- bp: إذا كان الانبساطي منخفض جدًا أو القراءة غير منطقية، اطلب إعادة القياس بالطريقة الصحيحة قبل أي استنتاج.
- sugar: إذا ظهرت قيمة أقل من 70 mg/dL (صائم أو بعد الأكل)، اعتبرها منخفضة واذكر خطوات عامة آمنة + متى يراجع الطبيب.
- calories: لا توصي بعجز يومي شديد؛ إذا الهدف سريع جدًا، اقترح هدفًا أهدأ أو متابعة مختص.
- emergency (سلطنة عمان): رقم الطوارئ 9999، وللإسعاف/الدفاع المدني يمكن 24343666 كبديل. لا تذكر 911.
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
        // ===============================
        // (تعديل 2) خفض max_tokens لتوفير التوكن
        // ===============================
        max_tokens: 280,
        messages,
      }),
    },
    20000
  );

  if (!res.ok) throw new Error("Groq API error");
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

// ===============================
// Normalize (UI compatible categories)
// ===============================
function normalize(obj) {
  let cat = sStr(obj?.category) || "general";

  // mapping شائع
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

  const nextQ = sStr(obj?.next_question);
  const qc = sArr(obj?.quick_choices, 2);

  return {
    category: cat,
    title: sStr(obj?.title) || "دليل العافية",
    verdict: sStr(obj?.verdict),
    next_question: nextQ,
    quick_choices: nextQ ? qc : [],
    tips: sArr(obj?.tips, 2),
    when_to_seek_help: sStr(obj?.when_to_seek_help),
  };
}

/**
 * fallback سابقًا كان يسرب raw داخل verdict -> سبب ظهور "الأكواد"
 * الآن: لا نسرب raw للمستخدم.
 */
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
// Facts extraction from calculator prompts (اختياري لتحسين الدقة)
// ===============================
function extractFactsFromUserMessage(msg) {
  const t = String(msg || "");

  // سكر
  const sugarMatch = t.match(
    /(?:القيمة\s*:\s*|\b)(\d{2,3})(?:\s*(?:mg\/dL|ملغ\/ديسيلتر|ملغ))?/i
  );

  // نوع السكر
  const isFasting = /نوع\s*القياس\s*:\s*صائم|\bصائم\b/i.test(t);
  const isPost = /نوع\s*القياس\s*:\s*بعد\s*الأكل|بعد\s*الأكل/i.test(t);

  // ضغط
  const bpMatch = t.match(/(\d{2,3})\s*\/\s*(\d{2,3})/);

  const facts = [];

  if (bpMatch) {
    const s = Number(bpMatch[1]);
    const d = Number(bpMatch[2]);
    if (Number.isFinite(s) && Number.isFinite(d)) {
      if (d <= 40) {
        facts.push(
          `حقيقة: قراءة الضغط ${s}/${d} فيها انبساطي منخفض جدًا؛ هذا غالبًا خطأ قياس أو يحتاج إعادة القياس بالطريقة الصحيحة.`
        );
      }
    }
  }

  if (sugarMatch) {
    const v = Number(sugarMatch[1]);
    if (Number.isFinite(v)) {
      const ctx = isFasting ? "صائم" : isPost ? "بعد الأكل" : "غير محدد";
      facts.push(`حقيقة: سكر الدم (${ctx}) = ${v} mg/dL.`);
      if (v < 70) {
        facts.push(
          "قاعدة أمان: قيمة أقل من 70 mg/dL تعتبر منخفضة ويجب إعطاء إرشاد للتعامل مع الهبوط بشكل عام + متى يراجع الطبيب."
        );
      }
    }
  }

  return facts;
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
    if (!msg) return res.status(400).json({ ok: false, error: "empty_message" });

    // ===============================
    // (تعديل 1) رد محلي للـ small-talk لتوفير التوكن
    // ===============================
    if (isSmallTalk(msg)) {
      return res.json({ ok: true, data: smallTalkCard() });
    }

    const lastCard = req.body?.context?.last || null;

    const messages = [{ role: "system", content: buildSystemPrompt() }];

    // ===============================
    // (تعديل 3) Slim lastCard context لتقليل التوكن
    // ===============================
    const slimLast =
      lastCard && typeof lastCard === "object"
        ? {
            category: lastCard.category,
            title: lastCard.title,
            verdict: lastCard.verdict,
            next_question: lastCard.next_question,
            quick_choices: lastCard.quick_choices,
          }
        : null;

    if (slimLast) {
      messages.push({
        role: "assistant",
        content:
          "سياق سابق (آخر بطاقة مختصرة للاستمرار عليها بدون تكرار):\n" +
          JSON.stringify(slimLast),
      });
    }

    // حقائق مستخرجة (تحسين دقة النصائح للحاسبات)
    const facts = extractFactsFromUserMessage(msg);
    if (facts.length) {
      messages.push({
        role: "assistant",
        content: "حقائق مؤكدة من سياق المستخدم (التزم بها):\n" + facts.join("\n"),
      });
    }

    messages.push({ role: "user", content: msg });

    // 1) call
    const raw = await callGroq(messages);
    let parsed = extractJson(raw);

    // 2) retry واحد فقط إذا "يستاهل"
    let retryRaw = "";
    if (!parsed && shouldRetry(raw)) {
      retryRaw = await callGroq(messages);
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

    // 5) emergency number sanity (سلطنة عمان)
    if (data.category === "emergency") {
      const all = `${data.title} ${data.verdict} ${data.when_to_seek_help} ${data.next_question} ${(data.tips || []).join(" ")}`;
      if (/\b911\b/.test(all) || /\b112\b/.test(all)) {
        data.verdict =
          "في سلطنة عُمان: اتصل بالطوارئ على 9999، ولخدمات الإسعاف/الدفاع المدني يمكن 24343666 كبديل.";
        data.title = data.title && data.title !== "دليل العافية" ? data.title : "رقم الطوارئ";
        data.next_question = "هل الحالة الآن طارئة (إغماء/صعوبة تنفس/ألم صدر/تشنجات)؟";
        data.quick_choices = ["نعم", "لا"];
        data.tips = ["اذكر موقعك بدقة", "لا تغلق الخط حتى يطلب منك"];
        data.when_to_seek_help = "";
      }
    }

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
