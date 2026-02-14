// ===============================
// server.js — Dalil Alafiyah API (NO-PAY Optimized)
// Per-user cache + rate limit + 429 backoff
// Strict JSON extraction + partial recovery
// Adds /reset to match frontend
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
// Tunables (بدون دفع)
// ===============================
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 260); // خفّضناها لتقليل استهلاك الحصة
const TEMP = Number(process.env.TEMPERATURE || 0.35);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 20000);

// كاش حسب المستخدم
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 60_000); // 60 ثانية
// Rate limit حسب المستخدم (قلله/زوده حسب راحتك)
const MIN_INTERVAL_MS = Number(process.env.MIN_INTERVAL_MS || 900); // 0.9 ثانية

// Backoff عند 429
const DEFAULT_429_BACKOFF_MS = Number(process.env.DEFAULT_429_BACKOFF_MS || 240_000); // 4 دقائق
const MAX_429_BACKOFF_MS = Number(process.env.MAX_429_BACKOFF_MS || 600_000); // 10 دقائق

// ===============================
// In-memory per-user state
// ===============================
/**
 * userStore.get(uid) => {
 *   lastAt: number,
 *   backoffUntil: number,
 *   cache: Map<string, { at:number, data:any }>,
 *   cacheOrder: string[] // لتفريغ القديم
 * }
 */
const userStore = new Map();

function getUserId(req) {
  const h = String(req.headers["x-user-id"] || "").trim();
  if (h) return h;
  // fallback: ip+ua (غير مثالي لكنه أفضل من لا شيء)
  const ip =
    req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown_ip";
  const ua = String(req.headers["user-agent"] || "ua").slice(0, 80);
  return `ip_${ip}__${ua}`;
}

function getUserState(uid) {
  let st = userStore.get(uid);
  if (!st) {
    st = {
      lastAt: 0,
      backoffUntil: 0,
      cache: new Map(),
      cacheOrder: [],
    };
    userStore.set(uid, st);
  }
  return st;
}

function pruneCache(st) {
  const now = Date.now();
  // امسح المنتهي
  for (const key of st.cacheOrder) {
    const v = st.cache.get(key);
    if (!v) continue;
    if (now - v.at > CACHE_TTL_MS) st.cache.delete(key);
  }
  // نظف order
  st.cacheOrder = st.cacheOrder.filter((k) => st.cache.has(k));
  // حد أقصى بسيط لحجم الكاش
  const MAX_KEYS = 80;
  if (st.cacheOrder.length > MAX_KEYS) {
    const extra = st.cacheOrder.length - MAX_KEYS;
    const drop = st.cacheOrder.splice(0, extra);
    drop.forEach((k) => st.cache.delete(k));
  }
}

function makeCacheKey(message, lastCard) {
  const m = String(message || "").trim();
  // نثبت lastCard (بدون تضخيم)
  let lc = "";
  try {
    if (lastCard && typeof lastCard === "object") lc = JSON.stringify(lastCard);
  } catch {}
  // قص لتقليل الحجم
  if (lc.length > 1200) lc = lc.slice(0, 1200);
  return `${m}__LC__${lc}`;
}

// ===============================
// Helpers
// ===============================
async function fetchWithTimeout(url, options = {}, ms = FETCH_TIMEOUT_MS) {
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

  // 1) parse كامل الرد
  try {
    const first = JSON.parse(s);
    if (first && typeof first === "object") return first;
    if (typeof first === "string") {
      const second = JSON.parse(cleanJsonish(first));
      if (second && typeof second === "object") return second;
    }
  } catch {}

  // 2) اقتناص { ... }
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a === -1 || b === -1 || b <= a) return null;

  let chunk = cleanJsonish(s.slice(a, b + 1));
  try {
    return JSON.parse(chunk);
  } catch {}

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
// System Prompt (مختصر لتوفير التوكنز)
// ===============================
function buildSystemPrompt() {
  return `
أنت "دليل العافية" — تثقيف صحي عربي فقط (ليس تشخيصًا).

أخرج JSON strict فقط: بدون أي نص خارج JSON، بدون Markdown، بدون \`\`\`، بدون trailing commas.
ممنوع ذكر JSON/تنسيق/فواصل/اقتباسات.

التصنيفات المسموحة فقط:
general | nutrition | bp | sugar | sleep | activity | mental | first_aid | report | emergency | water | calories | bmi

شكل JSON:
{
  "category":"واحد من القائمة",
  "title":"عنوان محدد 2-5 كلمات مرتبط بالسياق",
  "verdict":"جملة واحدة محددة مرتبطة بما قاله المستخدم",
  "next_question":"سؤال واحد يكمل نفس الموضوع أو \\"\\")",
  "quick_choices":["خيار1","خيار2"] أو [],
  "tips":["نصيحة1","نصيحة2"] أو [],
  "when_to_seek_help":"إنذارات واضحة أو \\"\\")"
}

قواعد:
- لا أدوية/لا جرعات/لا تشخيص.
- إذا كانت الرسالة نعم/لا أو اختيار: اعتبرها إجابة للبطاقة السابقة وكمل بنفس المسار.
- quick_choices: 0 أو 2 فقط وتطابق next_question.
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
        temperature: TEMP,
        max_tokens: MAX_TOKENS,
        messages,
      }),
    },
    FETCH_TIMEOUT_MS
  );

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    // اطبع تفاصيل الخطأ (هذا اللي كنت تسأل عنه)
    console.error(`❌ Groq HTTP: ${res.status} ${res.statusText}`);
    if (text) console.error("❌ Groq body:", text.slice(0, 2000));
    const err = new Error(`GROQ_HTTP_${res.status}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }

  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // نادر، لكن نحمي نفسنا
    throw new Error("GROQ_BAD_JSON_RESPONSE");
  }

  return data.choices?.[0]?.message?.content || "";
}

// ===============================
// Normalize
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
      looseVerdict || "تعذر توليد رد منظم الآن. جرّب إعادة صياغة السؤال بشكل مختصر.",
    next_question: "",
    quick_choices: [],
    tips: [],
    when_to_seek_help: "",
  };
}

function overloadCard(msg = "") {
  return {
    category: "general",
    title: "ازدحام مؤقت",
    verdict:
      msg ||
      "الخدمة الآن تحت ضغط أو انتهت الحصة اليومية مؤقتًا. جرّب بعد قليل.",
    next_question: "",
    quick_choices: [],
    tips: [],
    when_to_seek_help: "",
  };
}

// استخرج وقت المحاولة التالي من رسالة Groq (إن وُجد)
function parseRetryAfterMsFromGroqBody(bodyText) {
  const s = String(bodyText || "");
  // مثال: "Please try again in 3m53.712s."
  const m = s.match(/try again in\s+(\d+)m([\d.]+)s/i);
  if (m) {
    const mm = Number(m[1] || 0);
    const ss = Number(m[2] || 0);
    const ms = Math.round((mm * 60 + ss) * 1000);
    if (ms > 0) return ms;
  }
  return 0;
}

// ===============================
// Routes
// ===============================
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "Dalil Alafiyah API" });
});

// الواجهة عندك تنادي /reset — لا نخليه 404
app.post("/reset", (req, res) => {
  const uid = getUserId(req);
  const st = getUserState(uid);
  st.lastAt = 0;
  st.backoffUntil = 0;
  st.cache.clear();
  st.cacheOrder = [];
  res.json({ ok: true });
});

app.post("/chat", async (req, res) => {
  const uid = getUserId(req);
  const st = getUserState(uid);

  try {
    const msg = String(req.body?.message || "").trim();
    if (!msg) {
      return res.status(400).json({ ok: false, error: "empty_message" });
    }

    // 1) Backoff إذا Groq كان 429 قبل قليل
    const now = Date.now();
    if (st.backoffUntil && now < st.backoffUntil) {
      return res.json({ ok: true, data: overloadCard("انتهت الحصة/ازدحام مؤقت. جرّب بعد قليل.") });
    }

    // 2) Rate limit (حسب المستخدم)
    if (st.lastAt && now - st.lastAt < MIN_INTERVAL_MS) {
      return res.json({
        ok: true,
        data: overloadCard("بطّئ قليلًا: أرسل رسالة واحدة كل ثانية تقريبًا."),
      });
    }
    st.lastAt = now;

    // 3) Cache
    pruneCache(st);
    const lastCard = req.body?.context?.last || null;
    const cacheKey = makeCacheKey(msg, lastCard);
    const cached = st.cache.get(cacheKey);
    if (cached && now - cached.at <= CACHE_TTL_MS) {
      return res.json({ ok: true, data: cached.data });
    }

    // 4) Build messages
    const messages = [{ role: "system", content: buildSystemPrompt() }];

    if (lastCard && typeof lastCard === "object") {
      // لا نرسل سياق ضخم
      let lc = "";
      try {
        lc = JSON.stringify(lastCard);
      } catch {}
      if (lc.length > 1600) lc = lc.slice(0, 1600);

      messages.push({
        role: "assistant",
        content: "سياق سابق (آخر بطاقة للاستمرار بنفس الموضوع):\n" + lc,
      });
    }

    messages.push({ role: "user", content: msg });

    // 5) Call Groq (بدون retry على 429)
    const raw = await callGroq(messages);
    let parsed = extractJson(raw);

    // إذا فشل parse: نحاول recovery من نفس raw (بدون إعادة طلب يستهلك حصة)
    let data;
    if (parsed) data = normalize(parsed);
    else {
      const recovered = recoverPartialCard(raw);
      data = recovered ? normalize(recovered) : fallback(raw);
    }

    // منع بطاقات الميتا التقنية
    if (isMetaJsonAnswer(data)) {
      const recovered = recoverPartialCard(raw);
      data = recovered ? normalize(recovered) : fallback(raw);
    }

    // 6) Save to cache
    st.cache.set(cacheKey, { at: now, data });
    st.cacheOrder.push(cacheKey);

    return res.json({ ok: true, data });
  } catch (e) {
    // معالجة 429 بشكل واضح بدل 500
    const status = Number(e?.status || 0);

    if (status === 429) {
      const ms =
        parseRetryAfterMsFromGroqBody(e?.body) || DEFAULT_429_BACKOFF_MS;
      const backoff = Math.min(Math.max(ms, 30_000), MAX_429_BACKOFF_MS);
      st.backoffUntil = Date.now() + backoff;

      console.error("❌ /chat error: GROQ_HTTP_429");
      return res.json({
        ok: true,
        data: overloadCard("انتهت الحصة اليومية/ازدحام من Groq. جرّب بعد قليل."),
      });
    }

    if (status === 401 || status === 403) {
      console.error(`❌ /chat auth error: GROQ_HTTP_${status}`);
      return res.json({
        ok: true,
        data: overloadCard("مفتاح Groq غير صالح أو لا يملك صلاحية. راجع GROQ_API_KEY."),
      });
    }

    console.error("❌ /chat error:", e?.message || e);
    return res.status(500).json({
      ok: false,
      error: "server_error",
      data: overloadCard("حصل خطأ داخلي. جرّب مرة ثانية."),
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Dalil Alafiyah API يعمل على ${PORT}`);
});
