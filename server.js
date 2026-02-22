// server.js — Dalil Alafiyah API (clean + hardened + cheaper routing)
//
// Changes vs your version:
// - Adds Small-first / Big-fallback routing (GROQ_SMALL_MODEL, GROQ_BIG_MODEL)
// - Replaces expensive same-model retry with escalation
// - Lowers max_tokens (dynamic for some categories)
// - Compacts prior context to reduce tokens
// - Makes rate limit key safer (IP by default; optional signed user id later)
// - Keeps your strict JSON card logic and fallback recovery

import "dotenv/config";
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

const app = express();

const GROQ_API_KEY = process.env.GROQ_API_KEY;

// Small-first / Big-fallback
const SMALL_MODEL = process.env.GROQ_SMALL_MODEL || "llama-3.3-70b-versatile";
const BIG_MODEL =
  process.env.GROQ_BIG_MODEL || process.env.GROQ_MODEL || "openai/gpt-oss-120b";

const PORT = process.env.PORT || 3000;

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!GROQ_API_KEY) {
  console.error("❌ GROQ_API_KEY غير مضبوط");
  process.exit(1);
}

app.use(helmet());
app.set("trust proxy", 1);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // curl/health checks
      if (ALLOWED_ORIGINS.length === 0) return cb(null, true); // dev mode
      return ALLOWED_ORIGINS.includes(origin)
        ? cb(null, true)
        : cb(new Error("CORS blocked"), false);
    },
    methods: ["POST", "GET"],
  })
);

app.use(bodyParser.json({ limit: "2mb" }));

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.CHAT_RPM || 25),
  standardHeaders: true,
  legacyHeaders: false,

  // Safer key (avoid header spoofing). If you later add signed x-user-id, you can change this.
  keyGenerator: (req) => String(req.ip),
});

// ---------- helpers ----------
async function fetchWithTimeout(url, options = {}, ms = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

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

  try {
    const first = JSON.parse(s);
    if (first && typeof first === "object") return first;
    if (typeof first === "string") {
      const second = JSON.parse(cleanJsonish(first));
      if (second && typeof second === "object") return second;
    }
  } catch {}

  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a === -1 || b === -1 || b <= a) return null;

  const chunk = cleanJsonish(s.slice(a, b + 1));
  try {
    return JSON.parse(chunk);
  } catch {
    return null;
  }
}

function extractVerdictLoosely(raw) {
  const s = String(raw || "");
  const m = s.match(/"verdict"\s*:\s*"([^"]+)"/);
  return m?.[1]?.replace(/\\"/g, '"').trim() || "";
}

function recoverPartialCard(raw) {
  const s = String(raw || "");
  const pick = (re) => {
    const m = s.match(re);
    return m?.[1] ? m[1].replace(/\\"/g, '"').trim() : "";
  };

  const category = pick(/"category"\s*:\s*"([^"]+)"/) || "general";
  const title = pick(/"title"\s*:\s*"([^"]+)"/) || "دليل العافية";
  const verdict = pick(/"verdict"\s*:\s*"([^"]+)"/) || "";
  const next_question = pick(/"next_question"\s*:\s*"([^"]*)"/) || "";
  const when_to_seek_help = pick(/"when_to_seek_help"\s*:\s*"([^"]*)"/) || "";

  const arrPick = (key, limit) => {
    const m = s.match(new RegExp(`"${key}"\\s*:\\s*\\[([\\s\\S]*?)\\]`));
    const inner = m?.[1] || "";
    if (!inner) return [];
    return inner
      .split(",")
      .map((x) => x.trim())
      .map((x) => x.replace(/^"+|"+$/g, "").replace(/\\"/g, '"'))
      .filter(Boolean)
      .slice(0, limit);
  };

  const quick_choices = arrPick("quick_choices", 2);
  const tips = arrPick("tips", 2);

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

  return /json|format|schema|اقتباس|فواصل|تنسيق/i.test(text);
}

const sStr = (v) => (typeof v === "string" ? v.trim() : "");
const sArr = (v, n) =>
  Array.isArray(v)
    ? v.filter((x) => typeof x === "string" && x.trim()).slice(0, n)
    : [];

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

function buildSystemPrompt() {
  return `
  أنت "دليل العافية" — مساعد تثقيف صحي عربي مخصص لمجتمع سلطنة عُمان.

المهمة الأساسية:
تقديم التثقيف الصحي والمعلومات الطبية العامة والإرشادات الوقائية اعتمادًا على المحتوى التوعوي الرسمي الصادر من وزارة الصحة العُمانية – قسم (وعيـك صحة) والمصادر الصحية الموثوقة.
أنت محادثة تثقيفية صحية وليست خدمة طبية تشخيصية.
يسمح بتقديم معلومات صحية، توعية، إسعافات أولية، وإرشادات عامة، بينما التشخيص الطبي أو تحديد المرض بشكل قاطع ممنوع.

التخصيص للمجتمع العُماني:
استخدم لغة عربية واضحة مناسبة للمجتمع العُماني.
راعِ البيئة المحلية مثل الحرارة المرتفعة، نمط الحياة، العادات الغذائية، والحوادث المنزلية الشائعة.
اجعل النصائح عملية وقابلة للتطبيق داخل المجتمع العُماني.

قواعد الذكاء الحواري:
قدم المعلومة مباشرة دون إدخال المستخدم في سلسلة أسئلة طويلة.
اسأل فقط عند الحاجة لفهم السياق العام.
يمنع تكرار نفس السؤال أو إعادة صياغته لنفس الموضوع.
إذا تمت الإجابة عن نقطة سابقًا فلا تعد للسؤال عنها.
كل رد يجب أن يضيف فائدة أو معلومة جديدة.
تجنب جعل المستخدم يشعر بأنه داخل حلقة محادثة متكررة.
كن مرنًا في الحوار وقدّم المعرفة قبل طرح الأسئلة.

السلوك المسموح:
يمكنك تقديم:
- معلومات عن الحالات الطارئة.
- إرشادات الإسعافات الأولية العامة.
- التوعية بالحوادث المنزلية.
- الوقاية الصحية.
- معلومات عامة عن الأدوية والاستخدام الآمن لها.
- شرح الحالات الصحية بصورة تثقيفية مبسطة.
- دعم التوعية بالصحة النفسية.
- تثقيف صحة المرأة والطفل.
- التوعية بالأمراض المعدية وغير المعدية.

السلوك الممنوع:
لا تقدم تشخيصًا طبيًا.
لا تحدد علاجًا شخصيًا أو جرعات دوائية فردية.
لا تستبدل الطبيب أو الطوارئ.
لا تتصرف كنظام أو تطبيق.
لا تستخدم عبارات مثل:
تم التسجيل
تم الحفظ
تم الاختيار
جاري التنفيذ

الإسعافات الأولية والحالات الطارئة:
يسمح بتقديم إرشادات إسعافات أولية عامة في حالات مثل:
- الحوادث المنزلية.
- الحروق.
- الجروح والنزيف.
- الاختناق.
- السقوط والإصابات البسيطة.
- ضربة الشمس والإجهاد الحراري.
- الإغماء.
- لدغات الحشرات.
- التسمم المنزلي.

العلامات الحمراء الطارئة:
إذا ظهرت أي من التالي اعتبر الحالة طارئة:
- ألم شديد في الصدر.
- صعوبة شديدة في التنفس.
- فقدان الوعي.
- تشنجات.
- نزيف شديد.
- ضعف مفاجئ في أحد أطراف الجسم.
- صعوبة الكلام المفاجئة.
- إصابة قوية أو حادث خطير.
- حروق شديدة.
- ازرقاق الوجه أو الشفاه.
- أفكار انتحارية أو محاولة إيذاء النفس.

عند ظهور علامات طارئة:
وجّه المستخدم فورًا إلى:
شرطة عُمان السلطانية: 9999
مركز عمليات الهيئة الصحية: 24343666
مع إمكانية تقديم خطوات إسعاف أولي بسيطة وآمنة لحين وصول المساعدة.

التوعية الدوائية:
يمكنك تقديم معلومات عامة مثل:
- الاستخدام الصحيح للمضادات الحيوية.
- مخاطر الاستخدام العشوائي للأدوية.
- التداخلات الدوائية الشائعة.
- أهمية الالتزام بوصفة الطبيب.
- التحذير من مشاركة الأدوية بين الأشخاص.
دون تحديد جرعات علاجية فردية.

صحة المرأة:
يمكنك التثقيف حول:
- الدورة الشهرية.
- الحمل ومراحله.
- الرضاعة الطبيعية.
- صحة الأم بعد الولادة.
- سرطان الثدي والفحص الذاتي.
- فقر الدم أثناء الحمل.
- التغيرات الهرمونية.
- سن اليأس.

صحة الأطفال:
يمكنك تقديم معلومات عامة عن:
- الحمى عند الأطفال.
- الإمساك.
- سلس البول.
- التغذية السليمة.
- التطعيمات.
- العناية بالمواليد.
- علامات الخطر لدى الأطفال.

نمط الحياة الصحي:
التوعية حول:
- الإقلاع عن التدخين والتبغ.
- النشاط البدني العام.
- التغذية الصحية.
- النوم الصحي.
- الوقاية من نقص الفيتامينات.

الصحة النفسية:
تقديم توعية حول:
- القلق.
- الاكتئاب.
- التنمر.
- الضغوط النفسية.
- الوقاية من الانتحار.
- طلب المساعدة النفسية.
مع توجيه الحالات الخطرة للطوارئ.

الأمراض غير المعدية:
تقديم معلومات تثقيفية عن:
- فقر الدم المنجلي.
- قصور الغدة الدرقية.
- متلازمة داون.
- اضطرابات نقص الفيتامينات.
- الأمراض المزمنة الشائعة.

مكافحة الأمراض المعدية:
التوعية حول:
- الأمراض المنقولة بالنواقل.
- الأمراض المنقولة بالاتصال المباشر.
- الأمراض المنقولة جنسيًا (بأسلوب تثقيفي مهني).
- الوقاية والنظافة الشخصية والتطعيم.

أسلوب الرد:
ردود طبيعية وذكية تشبه المحادثات البشرية.
واضحة ومباشرة وغير مبالغ في طولها.
نبرة توعوية مطمئنة.
أضف معلومة مفيدة جديدة في كل رد.
تجنب التكرار.

قاعدة منع الحلقة الحوارية:
إذا تكرر نفس الموضوع:
انتقل لمعلومة وقائية أو جانب مكمل بدل إعادة الأسئلة.

تذكير دائم:
أنت مساعد تثقيف صحي يقدم معلومات عامة وإرشادات وقائية وإسعافات أولية فقط — التشخيص الطبي ممنوع.
مخرجاتك: JSON صالح strict فقط (بدون أي نص خارج JSON، بدون Markdown، بدون \`\`\`).
ممنوع ذكر JSON/format/schema أو شرح تقني.

التصنيفات المسموحة فقط:
general | nutrition | bp | sugar | sleep | activity | mental | first_aid | report | emergency | water | calories | bmi

شكل JSON:
{
  "category": "واحد من القائمة أعلاه",
  "title": "عنوان محدد (2-5 كلمات)",
  "verdict": "جملة واحدة محددة",
  "next_question": "سؤال واحد فقط (أو \\"\\")",
  "quick_choices": ["خيار 1","خيار 2"],
  "tips": ["نصيحة 1","نصيحة 2"],
  "when_to_seek_help": "متى تراجع الطبيب/الطوارئ (أو \\"\\")"
}
- لا أدوية/لا جرعات/لا تشخيص.
`.trim();
}

function compactLastCard(lastCard) {
  if (!lastCard || typeof lastCard !== "object") return null;
  return {
    category: sStr(lastCard.category) || "general",
    title: sStr(lastCard.title).slice(0, 60),
    verdict: sStr(lastCard.verdict).slice(0, 240),
    next_question: sStr(lastCard.next_question).slice(0, 160),
  };
}

function chooseMaxTokens(msg, lastCard) {
  // Keep responses tight: most cases don't need many tokens.
  const base = Number(process.env.GROQ_MAX_TOKENS || 260);

  // If user requests report-like output or emergencies, allow a bit more room.
  const text = String(msg || "");
  const cat = sStr(lastCard?.category);
  if (cat === "report" || /تقرير|ملخص|تحليل/i.test(text)) return Math.max(base, 320);
  if (cat === "emergency" || /طوارئ|إسعاف|اختناق|نزيف|حروق|سكتة/i.test(text))
    return Math.max(base, 320);

  return base;
}

async function callGroq(messages, { model, max_tokens }) {
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
        max_tokens,
        messages,
      }),
    },
    20000
  );

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Groq API error (${res.status}) ${t.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

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

// ---------- routes ----------
app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/reset", (_req, res) => {
  // إذا عندك جلسات/تخزين سياق لاحقًا — هنا مكان reset
  res.json({ ok: true });
});

app.post("/chat", chatLimiter, async (req, res) => {
  try {
    const msg = String(req.body?.message || "").trim();
    if (!msg) return res.status(400).json({ ok: false, error: "empty_message" });
    if (msg.length > 1200)
      return res.status(400).json({ ok: false, error: "message_too_long" });

    const lastCard = req.body?.context?.last || null;
    const compact = compactLastCard(lastCard);

    const messages = [{ role: "system", content: buildSystemPrompt() }];

    // Only include prior context if it exists; keep it compact to save tokens.
    if (compact) {
      messages.push({
        role: "assistant",
        content: "سياق سابق مختصر للاستمرار:\n" + JSON.stringify(compact),
      });
    }

    messages.push({ role: "user", content: msg });

    const maxTokens = chooseMaxTokens(msg, lastCard);

    // 1) Small model first (cheap)
    const raw1 = await callGroq(messages, { model: SMALL_MODEL, max_tokens: maxTokens });
    let parsed = extractJson(raw1);

    // 2) Big model only if parsing failed (escalation, not retry)
    let raw2 = "";
    if (!parsed) {
      raw2 = await callGroq(messages, { model: BIG_MODEL, max_tokens: maxTokens });
      parsed = extractJson(raw2);
    }

    // Normalize / recover
    let data;
    if (parsed) data = normalize(parsed);
    else data = normalize(recoverPartialCard(raw2 || raw1) || fallback(raw1));

    // Guard against meta formatting answers
    if (isMetaJsonAnswer(data)) {
      data = normalize(recoverPartialCard(raw2 || raw1) || fallback(raw1));
    }

    return res.json({
      ok: true,
      data,
      meta: {
        model_used: parsed ? (raw2 ? BIG_MODEL : SMALL_MODEL) : (raw2 ? BIG_MODEL : SMALL_MODEL),
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "server_error", data: fallback("") });
  }
});

app.listen(PORT, () => {
  console.log(
    `🚀 API running on :${PORT} | small=${SMALL_MODEL} | big=${BIG_MODEL}`
  );
});
