// server.js — Dalil Alafiyah API (optimized for LOW token usage)
// الهدف: إجابات تثقيفية محلية (مبنية على مواد وزارة الصحة العُمانية) + استدعاء Groq فقط عند الحاجة
// - لا تغيّر واجهة /chat ولا شكل الرد
// - يخفّض استهلاك التوكنز عبر: (1) قاعدة معرفة محلية، (2) كاش، (3) تبريد/Cooldown، (4) حد يومي، (5) max_tokens أصغر

import "dotenv/config";
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

const app = express();

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MODEL_ID = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const PORT = process.env.PORT || 3000;

// CORS allowlist (comma-separated)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ---- cost controls (env optional) ----
const AI_FALLBACK_ENABLED = (process.env.AI_FALLBACK_ENABLED || "1") === "1"; // 1=يسمح باستدعاء Groq عند عدم وجود جواب محلي
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 2000); // تبريد لكل مستخدم (لا نرجع 429 — نرجع بطاقة لطيفة)
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT || 120); // حد يومي لكل مستخدم (بدون 429)
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 6 * 60 * 60 * 1000); // 6 ساعات
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 220); // خفض الاستهلاك (كان 520)
const TEMP = Number(process.env.TEMPERATURE || 0.25);

if (AI_FALLBACK_ENABLED && !GROQ_API_KEY) {
  console.error("❌ GROQ_API_KEY غير مضبوط (وأنت مفعّل AI_FALLBACK_ENABLED=1)");
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
  max: Number(process.env.RATE_LIMIT_PER_MIN || 25),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.headers["x-user-id"] || req.ip),
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

// تنظيف JSON
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
    const m = s.match(new RegExp(`"\${key}"\\s*:\\s*\\[([\\s\\S]*?)\\]`));
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

  return { category, title, verdict, next_question, quick_choices, tips, when_to_seek_help };
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

// ---------- text normalization for rules ----------
function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^\u0600-\u06FFa-z0-9\s/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------- ultra-light local KB (MoH Oman health awareness materials) ----------
function card({ category, title, verdict, tips = [], next_question = "", quick_choices = [], when_to_seek_help = "" }) {
  return normalize({ category, title, verdict, tips, next_question, quick_choices, when_to_seek_help });
}

const KB = {
  nutrition: card({
    category: "nutrition",
    title: "غذاء صحي",
    verdict: "الغذاء المتوازن يقلّل مخاطر الأمراض المزمنة المرتبطة بالنمط الغذائي.",
    tips: [
      "اجعل طبقك متوازنًا: خضار/فواكه + بروتين + حبوب كاملة، وقلّل الملح/السكر والدهون المشبعة.",
      "اختر بدائل صحية يوميًا واستمر بخطوات صغيرة قابلة للاستمرار.",
    ],
    next_question: "هل هدفك اليوم: تقليل السكر أم تقليل الملح؟",
    quick_choices: ["تقليل السكر", "تقليل الملح"],
    when_to_seek_help: "إذا لديك مرض مزمن أو أعراض مستمرة، راجع مركز صحي لتقييم غذائي مناسب. (مرجع: الدليل العُماني للغذاء الصحي – وزارة الصحة العُمانية)",
  }),

  activity: card({
    category: "activity",
    title: "نشاط بدني",
    verdict: "النشاط البدني المنتظم يدعم صحة القلب والوزن والمزاج.",
    tips: [
      "ابدأ بمستوى مناسب لك وزِد تدريجيًا (مثل المشي)، مع اختيار وقت ثابت.",
      "التزم بخطة بسيطة أسبوعيًا لتجنب الانقطاع.",
    ],
    next_question: "تفضّل نشاط خفيف أم متوسط؟",
    quick_choices: ["خفيف", "متوسط"],
    when_to_seek_help: "إذا ظهرت أعراض غير طبيعية أثناء النشاط (ألم صدر/دوخة شديدة)، أوقف النشاط واطلب تقييمًا طبيًا. (مرجع: مطوية النشاط البدني – وزارة الصحة العُمانية)",
  }),

  bp: card({
    category: "bp",
    title: "ضغط الدم",
    verdict: "الالتزام بنمط حياة صحي والكشف المبكر يساعدان في الوقاية وتقليل المضاعفات.",
    tips: [
      "قلّل الملح، وداوم على النشاط البدني، وامتنع عن التدخين قدر الإمكان.",
      "قِس الضغط بطريقة صحيحة وبشكل دوري خاصة إذا لديك عوامل خطورة.",
    ],
    next_question: "هل لديك قراءة ضغط (مثل 120/80)؟",
    quick_choices: ["نعم لدي قراءة", "لا"],
    when_to_seek_help: "إذا كانت القراءات مرتفعة بشكل متكرر أو لديك أعراض مقلقة، راجع الطبيب/المركز الصحي. (مرجع: مطويات ضغط الدم – وزارة الصحة العُمانية)",
  }),

  sugar: card({
    category: "sugar",
    title: "السكري",
    verdict: "السكري حالة مزمنة تتطلب نمط حياة صحي ومتابعة منتظمة لتقليل المضاعفات.",
    tips: [
      "اختر وجبات متوازنة وقلّل السكريات والمشروبات المحلّاة وداوم على الحركة.",
      "التزم بالخطة العلاجية والمتابعة وراقب الأعراض/القياسات حسب إرشاد الطبيب.",
    ],
    next_question: "القياس صائم أم بعد الأكل؟",
    quick_choices: ["صائم", "بعد الأكل"],
    when_to_seek_help: "راجع الطبيب إذا كانت القراءات عالية بشكل متكرر أو ظهرت أعراض شديدة. (مرجع: مواد السكري – وزارة الصحة العُمانية)",
  }),

  sleep: card({
    category: "sleep",
    title: "النوم",
    verdict: "السهر وتغيير وقت النوم بشكل مفاجئ قد يسبب مشاكل صحية ويؤثر على جودة الحياة.",
    tips: [
      "حافظ على جدول نوم ثابت قدر الإمكان وقلّل المنبهات قبل النوم.",
      "إذا استمرت مشكلة النوم، قد يفيد تقييم الأسباب ووضع خطة مناسبة.",
    ],
    next_question: "مشكلتك: سهر متكرر أم أرق؟",
    quick_choices: ["سهر متكرر", "أرق"],
    when_to_seek_help: "إذا استمر اضطراب النوم وأثر على حياتك اليومية، راجع مختص/عيادة. (مرجع: توعية السهر واضطرابات النوم – وزارة الصحة العُمانية)",
  }),

  first_aid_heatstroke: card({
    category: "first_aid",
    title: "ضربة الشمس",
    verdict: "ضربة الشمس حالة طارئة قد تحدث بسبب التعرض الشديد للحرارة وتتطلب تصرفًا سريعًا.",
    tips: [
      "انقل الشخص لمكان بارد، وبرّده تدريجيًا، وقدّم سوائل إن كان واعيًا وقادرًا على البلع.",
      "اطلب المساعدة الطبية إذا كانت الأعراض شديدة أو الوعي متأثر.",
    ],
    next_question: "هل توجد حرارة عالية مع دوخة/تقيؤ؟",
    quick_choices: ["نعم", "لا"],
    when_to_seek_help: "اطلب الطوارئ فورًا عند فقدان الوعي/تشنجات/حرارة شديدة. (مرجع: نشرة ضربة الشمس – وزارة الصحة العُمانية)",
  }),

  mental: card({
    category: "mental",
    title: "الصحة النفسية",
    verdict: "الصحة النفسية جزء أساسي من الصحة العامة وقد تتأثر وتؤثر على الأمراض المزمنة.",
    tips: [
      "حافظ على روتين نوم وحركة يومية ودعم اجتماعي، واطلب مساعدة عند الحاجة.",
      "إذا استمرت الأعراض النفسية وأثرت على حياتك، ناقش ذلك مع مختص.",
    ],
    next_question: "هل المشكلة: قلق أم حزن مستمر؟",
    quick_choices: ["قلق", "حزن مستمر"],
    when_to_seek_help: "إذا وُجدت أفكار بإيذاء النفس أو خطر عاجل: اطلب مساعدة فورية. (مرجع: مواد الصحة النفسية – وزارة الصحة العُمانية)",
  }),

  emergency: card({
    category: "emergency",
    title: "علامات طارئة",
    verdict: "هناك علامات تستدعي التوجه للطوارئ فورًا.",
    tips: [
      "ألم صدر شديد، ضيق نفس شديد، إغماء، نزيف شديد، ضعف مفاجئ/تشوش كلام.",
      "في هذه الحالات لا تنتظر: اتصل بالإسعاف أو اذهب للطوارئ فورًا.",
    ],
    next_question: "هل لديك عرض خطير الآن؟",
    quick_choices: ["نعم", "لا"],
    when_to_seek_help: "هذه علامات طارئة — توجّه للطوارئ فورًا.",
  }),

  general: card({
    category: "general",
    title: "دليل العافية",
    verdict: "اكتب سؤالك الصحي بشكل واضح (أعراض + مدة + العمر إن أمكن) للحصول على إرشاد عام أدق.",
    tips: ["تجنب مشاركة بيانات حساسة.", "إذا كانت الحالة طارئة اذهب للطوارئ."],
    next_question: "هل سؤالك عن تغذية أم نشاط أم نوم؟",
    quick_choices: ["تغذية", "نشاط"],
    when_to_seek_help: "",
  }),
};

// ---------- lightweight intent router ----------
function detectIntent(text) {
  const t = normalizeText(text);

  if (/^(مرحبا|مرحبًا|السلام عليكم|السلام)\b/.test(t)) return { kind: "smalltalk", key: "general" };
  if (/^(شكرا|شكرًا|مشكور|يسلمو|يعطيك العافية)\b/.test(t)) return { kind: "smalltalk_thanks", key: "general" };

  const emergencyFlags = ["الم شديد في الصدر", "ألم شديد في الصدر", "ضيق نفس شديد", "صعوبة تنفس", "اختناق", "اغماء", "إغماء", "نزيف شديد", "تشنج", "نوبة", "شلل", "ضعف مفاجئ", "تشوش كلام", "افكار انتحارية", "إيذاء النفس", "انتحار"];
  if (emergencyFlags.some((f) => t.includes(normalizeText(f)))) return { kind: "kb", key: "emergency" };

  if (/(تغذ|غذاء|حمية|رجيم|سعرات|اكل|أكل|ملح|سكر|دهون)/.test(t)) return { kind: "kb", key: "nutrition" };
  if (/(نشاط|رياضة|مشي|تمارين|حركة)/.test(t)) return { kind: "kb", key: "activity" };
  if (/(ضغط|ضغط الدم|مرتفع الضغط|انقباضي|انبساطي)/.test(t)) return { kind: "kb", key: "bp" };
  if (/(سكر|سكري|غلوكوز|جلوكوز|صائم|بعد الاكل|بعد الأكل)/.test(t)) return { kind: "kb", key: "sugar" };
  if (/(نوم|سهر|أرق|اضطراب النوم|انقطاع النفس)/.test(t)) return { kind: "kb", key: "sleep" };
  if (/(قلق|اكتئاب|توتر|نفسية|حزن|مزاج)/.test(t)) return { kind: "kb", key: "mental" };
  if (/(ضربة الشمس|إجهاد حراري|حرارة شديدة)/.test(t)) return { kind: "kb", key: "first_aid_heatstroke" };

  const bpMatch = t.match(/\b(\d{2,3})\s*\/\s*(\d{2,3})\b/);
  if (bpMatch) return { kind: "bp_reading", s: Number(bpMatch[1]), d: Number(bpMatch[2]) };

  return { kind: "unknown" };
}

function classifyBp(s, d) {
  if (!s || !d) return "لا يمكن التصنيف من هذه القراءة.";
  if (s < 90 || d < 60) return "يميل للانخفاض.";
  if (s < 120 && d < 80) return "في المجال الطبيعي تقريبًا.";
  if (s >= 120 && s <= 129 && d < 80) return "ارتفاع بسيط.";
  if ((s >= 130 && s <= 139) || (d >= 80 && d <= 89)) return "ارتفاع درجة أولى (تقريبي).";
  if (s >= 140 || d >= 90) return "ارتفاع واضح.";
  return "لا يمكن تصنيفه بدقة من هذه القراءة فقط.";
}

// ---------- cache + quotas ----------
const cache = new Map();
const userState = new Map();

function getUserId(req) {
  return String(req.headers["x-user-id"] || req.ip || "anon");
}

function dayKeyNow() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function checkCooldownAndQuota(userId) {
  const now = Date.now();
  const dk = dayKeyNow();
  const st = userState.get(userId) || { lastAt: 0, dayKey: dk, used: 0 };

  if (st.dayKey !== dk) {
    st.dayKey = dk;
    st.used = 0;
  }

  if (now - st.lastAt < COOLDOWN_MS) {
    st.lastAt = now;
    userState.set(userId, st);
    return { ok: false, reason: "cooldown" };
  }

  if (st.used >= DAILY_LIMIT) {
    st.lastAt = now;
    userState.set(userId, st);
    return { ok: false, reason: "daily_limit" };
  }

  st.used += 1;
  st.lastAt = now;
  userState.set(userId, st);
  return { ok: true };
}

function cacheGet(key) {
  const v = cache.get(key);
  if (!v) return null;
  if (Date.now() > v.exp) {
    cache.delete(key);
    return null;
  }
  return v.data;
}
function cacheSet(key, data) {
  cache.set(key, { exp: Date.now() + CACHE_TTL_MS, data });
}

// ---------- Groq ----------
function buildSystemPrompt() {
  return `
أنت "دليل العافية" للتثقيف الصحي العام فقط (ليس تشخيصًا).
أجب بالعربية وباختصار شديد. ممنوع: أدوية/جرعات/تشخيص.
أعد JSON صالح فقط (بدون أي نص خارجه).
التصنيفات: general | nutrition | bp | sugar | sleep | activity | mental | first_aid | report | emergency | water | calories | bmi
الشكل:
{"category":"general","title":"...","verdict":"...","next_question":"...","quick_choices":["..",".."],"tips":["..",".."],"when_to_seek_help":"..."}
`.trim();
}

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
        temperature: TEMP,
        max_tokens: MAX_TOKENS,
        messages,
      }),
    },
    20000
  );

  if (!res.ok) throw new Error("Groq API error");
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

function fallback(rawText) {
  const looseVerdict = extractVerdictLoosely(rawText);
  return {
    category: "general",
    title: "معلومة صحية",
    verdict: looseVerdict || " حاول كتابة سؤالك بشكل أوضح ومختصر.",
    next_question: "",
    quick_choices: [],
    tips: [],
    when_to_seek_help: "",
  };
}

// ---------- routes ----------
app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/reset", (_req, res) => res.json({ ok: true }));

app.post("/chat", chatLimiter, async (req, res) => {
  try {
    const userId = getUserId(req);
    const msg = String(req.body?.message || "").trim();
    if (!msg) return res.status(400).json({ ok: false, error: "empty_message" });
    if (msg.length > 1200) return res.status(400).json({ ok: false, error: "message_too_long" });

    if (msg.length < 2) {
      return res.json({
        ok: true,
        data: card({
          category: "general",
          title: "رسالة قصيرة",
          verdict: "اكتب سؤالك بشكل واضح حتى أقدر أساعدك.",
          tips: ["مثال: (صداع منذ يومين) أو (كيف أخفف الملح؟)"],
          next_question: "هل سؤالك عن تغذية أم نشاط؟",
          quick_choices: ["تغذية", "نشاط"],
          when_to_seek_help: "",
        }),
      });
    }

    const gate = checkCooldownAndQuota(userId);
    if (!gate.ok) {
      if (gate.reason === "cooldown") {
        return res.json({
          ok: true,
          data: card({
            category: "general",
            title: "لحظة",
            verdict: "أرسلت رسائل بسرعة. انتظر ثانيتين ثم أرسل سؤالك.",
            tips: ["هذا لتقليل الضغط وحماية الخدمة للمجتمع."],
            next_question: "",
            quick_choices: [],
            when_to_seek_help: "",
          }),
        });
      }
      return res.json({
        ok: true,
        data: card({
          category: "general",
          title: "حد يومي",
          verdict: "وصلت للحد اليومي للاستخدام لهذا المستخدم. جرّب غدًا.",
          tips: ["هذا حد حماية لتجنب توقف الخدمة للجميع."],
          next_question: "",
          quick_choices: [],
          when_to_seek_help: "",
        }),
      });
    }

    const cacheKey = `${userId}::${normalizeText(msg)}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json({ ok: true, data: cached });

    const intent = detectIntent(msg);

    if (intent.kind === "kb") {
      const data = KB[intent.key] || KB.general;
      cacheSet(cacheKey, data);
      return res.json({ ok: true, data });
    }

    if (intent.kind === "bp_reading") {
      const category = classifyBp(intent.s, intent.d);
      const data = card({
        category: "bp",
        title: "قراءة ضغط",
        verdict: `القراءة: ${intent.s}/${intent.d} — التقدير: ${category}`,
        tips: [
          "يفضل أخذ أكثر من قراءة في أوقات مختلفة وعدم الاعتماد على قراءة واحدة فقط.",
          "قلّل الملح وداوم على النشاط وراجع الطبيب إذا تكررت القراءات المرتفعة.",
        ],
        next_question: "هل تكررت هذه القراءة أكثر من مرة؟",
        quick_choices: ["نعم", "لا"],
        when_to_seek_help: "إذا وُجد ألم صدر/ضيق نفس/دوخة شديدة أو قراءات مرتفعة متكررة راجع الطوارئ/الطبيب. (مرجع: مواد ضغط الدم – وزارة الصحة العُمانية)",
      });
      cacheSet(cacheKey, data);
      return res.json({ ok: true, data });
    }

    if (!AI_FALLBACK_ENABLED) {
      const data = card({
        category: "general",
        title: "إرشاد عام",
        verdict: "هذا السؤال يحتاج تفاصيل أو مصدر محدد. جرّب صياغة سؤالك بشكل أوضح.",
        tips: ["اكتب: الأعراض + المدة + العمر (إن أمكن) + هل لديك مرض مزمن؟"],
        next_question: "هل سؤالك عن تغذية أم نشاط أم نوم؟",
        quick_choices: ["تغذية", "نشاط"],
        when_to_seek_help: "",
      });
      cacheSet(cacheKey, data);
      return res.json({ ok: true, data });
    }

    const lastCard = req.body?.context?.last || null;

    const messages = [{ role: "system", content: buildSystemPrompt() }];

    if (lastCard && typeof lastCard === "object") {
      messages.push({
        role: "assistant",
        content: "سياق سابق (آخر بطاقة JSON للاستمرار عليها):\n" + JSON.stringify(lastCard),
      });
    }

    messages.push({
      role: "user",
      content: msg + "\n\nملاحظة: إن لم تكن متأكدًا، أعطِ إرشادًا عامًا قصيرًا + سؤال متابعة واحد فقط.",
    });

    const raw = await callGroq(messages);
    let parsed = extractJson(raw);

    let retryRaw = "";
    if (!parsed) {
      retryRaw = await callGroq(messages);
      parsed = extractJson(retryRaw);
    }

    let data;
    if (parsed) data = normalize(parsed);
    else data = normalize(recoverPartialCard(retryRaw || raw) || fallback(raw));

    if (isMetaJsonAnswer(data)) {
      data = normalize(recoverPartialCard(retryRaw || raw) || fallback(raw));
    }

    if (data && typeof data.verdict === "string" && data.verdict) {
      if (!/وزارة الصحة العُمانية|وزارة الصحة العمانية|moh\.gov\.om/i.test(data.verdict)) {
        data.verdict = data.verdict.trim() + "\n\n(معلومة تثقيفية عامة)";
      }
    }

    cacheSet(cacheKey, data);
    return res.json({ ok: true, data });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "server_error", data: fallback("") });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 API running on :${PORT} | model=${MODEL_ID} | ai_fallback=${AI_FALLBACK_ENABLED ? "on" : "off"}`);
});
