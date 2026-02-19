// ===============================
// server.js — Dalil Alafiyah API (FINAL)
// Stable: context pass + strict JSON parsing + partial recovery
// + retry re-ask (NOT "fix JSON") to avoid meta technical replies
// + prevent code/JSON leakage to UI
// + block "action claims" (booking/app-like confirmations)
// + early off-scope block based on USER message (robust; ignores short replies)
// + deterministic local handling for Calories flow (fixes "نعم" => خارج النطاق 100%)
// + lastCard moved to SYSTEM to reduce role-play drift
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

/**
 * منع أسلوب "تطبيق" / ادّعاء تنفيذ (حجز/تأكيد/إرسال/إنشاء..)
 */
function isActionClaim(d) {
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

  return /(تم\s*(الحجز|التأكيد|التاكيد|الإرسال|الارسال|الإنشاء|انشاء|فتح|تسجيل)|حجزت\s*لك|أكدت\s*لك|اكدت\s*لك|سأقوم\s*ب|ساقوم\s*ب|تم\s*جدولة|موعدك\s*تم|تذكير\s*تم|تم\s*إضافة|تم\s*اضافة)/i.test(
    text
  );
}

const sStr = (v) => (typeof v === "string" ? v.trim() : "");
const sArr = (v, n) =>
  Array.isArray(v)
    ? v.filter((x) => typeof x === "string" && x.trim()).slice(0, n)
    : [];

// ===============================
// Cards
// ===============================
function makeOffScopeCard() {
  return {
    category: "general",
    title: "خارج النطاق",
    verdict: "أقدر أساعدك بالتثقيف الصحي فقط. اكتب سؤالك الصحي مباشرة وباختصار.",
    next_question: "هل سؤالك عن أعراض، نوم، تغذية، نشاط، أو إسعافات أولية؟",
    quick_choices: ["أعراض", "نمط حياة"],
    tips: ["اذكر العمر/الجنس/مدة الأعراض إن وجدت.", "اكتب هدفك أو عرضك بجملة واحدة."],
    when_to_seek_help: "",
  };
}

function makeNoActionCard() {
  return {
    category: "general",
    title: "توضيح سريع",
    verdict: "أنا محادثة تثقيف صحي فقط ولا أنفّذ حجوزات أو إجراءات. اسألني سؤالًا صحيًا مباشرًا.",
    next_question: "وش الموضوع الصحي اللي تبغى نركز عليه الآن؟",
    quick_choices: ["نوم", "تغذية"],
    tips: ["مثال: أرق منذ أسبوع.", "أو: كيف أوازن وجباتي؟"],
    when_to_seek_help: "",
  };
}

// ✅ مسار محلي للسعرات عند سؤال "هل تريد نصائح حول حاسبة السعرات؟"
function makeCaloriesTipsCard() {
  return {
    category: "calories",
    title: "نصائح للسعرات",
    verdict: "تمام—هذه قواعد بسيطة تجعل تقدير السعرات أدق وأسهل للالتزام.",
    next_question: "هل هدفك تنحيف ولا تثبيت ولا زيادة وزن؟",
    quick_choices: ["تنحيف", "تثبيت"],
    tips: [
      "عدّل الرقم ±200 سعرة لمدة أسبوع ثم راقب الوزن/المحيط.",
      "قسّم البروتين خلال اليوم واهتم بالألياف والماء لتقليل الجوع.",
    ],
    when_to_seek_help: "",
  };
}

function makeCaloriesNoTipsCard() {
  return {
    category: "calories",
    title: "تمام",
    verdict: "ممتاز—نقدر نكمل بتحديد هدفك وتقسيم السعرات على وجبات إذا تحب.",
    next_question: "هل هدفك تنحيف ولا تثبيت ولا زيادة وزن؟",
    quick_choices: ["تنحيف", "تثبيت"],
    tips: [
      "الالتزام أهم من الدقة المطلقة—اختر رقم تقدر تعيش عليه.",
      "راقب المتوسط الأسبوعي بدل يوم واحد.",
    ],
    when_to_seek_help: "",
  };
}

/**
 * فلترة خارج النطاق بناءً على رسالة المستخدم (قبل استدعاء النموذج)
 * ✅ ملاحظة: أي رسالة قصيرة جدًا (مثل نعم/لا/2) نعتبرها داخل المسار دائمًا.
 */
function userLooksOffScope(msg) {
  const s = String(msg || "").trim();

  // ✅ أي رد قصير اعتبره داخل السياق (يمنع false-positive)
  if (s.length <= 6) return false;

  if (/^(نعم|لا|1|2|3|خفيف|متوسط|عالي)$/i.test(s)) return false;

  return /(برمجة|سيرفر|node|express|api|endpoint|قاعدة بيانات|داتا|شبكات|سياسة|انتخابات|دين|فتوى|استثمار|سوق|شراء|تسوق|متجر|سعر|مباراة|فيلم|مسلسل)/i.test(
    s
  );
}

// ===============================
// System Prompt
// ===============================
function buildSystemPrompt() {
  return `
أنت "دليل العافية" — مرافق عربي للتثقيف الصحي فقط (ليس تشخيصًا).

مخرجاتك: JSON صالح strict فقط (بدون أي نص خارج JSON، بدون Markdown، بدون \`\`\`، بدون trailing commas).
ممنوع الردود العامة مثل: "أنا هنا لمساعدتك". كن محددًا ومباشرًا.
ممنوع ذكر JSON أو التنسيق أو الفواصل أو الاقتباسات أو "تم تنسيق الإجابة". ركّز فقط على النصائح الصحية.

مهم جدًا:
- ممنوع تمامًا ادّعاء تنفيذ أي إجراء في العالم الحقيقي: (حجز/موعد/تأكيد/إرسال/فتح تذكرة/تم/سأقوم الآن/حجزت لك).
- أنت محادثة تثقيف صحي فقط. أي طلب خارج التثقيف الصحي (حجز موعد، دعم فني، سياسة، دين، برمجة، تسوق...) → أعد بطاقة category="general" تشرح أنه خارج النطاق وتطلب سؤالًا صحيًا محددًا.
- لا تستخدم كلمات توحي بتنفيذ: "تم الحجز" "تم التأكيد" "تم إنشاء" "تم الإرسال" "سجّلت" "حجزت".
- حاسبة السعرات/الوزن/BMI/الماء/النشاط/النوم كلها ضمن التثقيف الصحي.

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
- التزم بالتثقيف الصحي فقط ولا تغيّر المسار بلا سبب.
- إذا لم يكن السؤال صحيًا/عافية/نمط حياة/إسعاف أولي → لا تجاوب محتواه، فقط أعد توجيهه لسؤال صحي.
- إذا كانت الرسالة قصيرة مثل "نعم/لا" أو اختيار، اعتبرها إجابة لسؤال البطاقة السابقة وكمل بنفس المسار.
- quick_choices: 0 أو 2 فقط وتطابق next_question.
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
        temperature: 0.2, // كان 0.35 — خفضناها لتقليل الانحراف
        max_tokens: 520,
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

app.post("/chat", async (req, res) => {
  try {
    const msg = String(req.body.message || "").trim();
    if (!msg) {
      return res.status(400).json({ ok: false, error: "empty_message" });
    }

    // ✅ block off-scope user messages early (robust)
    if (userLooksOffScope(msg)) {
      return res.json({ ok: true, data: makeOffScopeCard() });
    }

    const lastCard = req.body?.context?.last || null;

    // ✅ deterministic local continuation for Calories "tips" question
    if (lastCard && typeof lastCard === "object") {
      const lastCat = String(lastCard.category || "").trim();
      const lastQ = String(lastCard.next_question || "");

      const isCaloriesTrack = lastCat === "calories" || lastCat === "nutrition";
      const isTipsQuestion =
        /نصائح\s*حول\s*حاسبة\s*السعرات/i.test(lastQ) ||
        /حاسبة\s*السعرات/i.test(lastQ);

      if (isCaloriesTrack && isTipsQuestion && /^(نعم|لا)$/i.test(msg)) {
        return res.json({
          ok: true,
          data: /^نعم$/i.test(msg) ? makeCaloriesTipsCard() : makeCaloriesNoTipsCard(),
        });
      }
    }

    const messages = [{ role: "system", content: buildSystemPrompt() }];

    // مهم: نقل سياق آخر بطاقة إلى system لتقليل "role-play" والانحراف
    if (lastCard && typeof lastCard === "object") {
      messages.push({
        role: "system",
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

    // 4.5) block "action claims" (appointment/app-like confirmations)
    if (isActionClaim(data)) {
      data = makeNoActionCard();
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
