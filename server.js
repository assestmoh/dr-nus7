// server.js — Dalil Alafiyah API (single-model Groq) + TTS
import "dotenv/config";
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

const app = express();

const GROQ_API_KEY = process.env.GROQ_API_KEY;

// ✅ موديل واحد فقط (Groq)
const MODEL = (process.env.GROQ_MODEL || "openai/gpt-oss-120b").trim();

// TTS (Orpheus Arabic Saudi)
const TTS_MODEL = (process.env.GROQ_TTS_MODEL || "canopylabs/orpheus-arabic-saudi").trim();
const TTS_VOICE = (process.env.GROQ_TTS_VOICE || "fahad").trim();

const PORT = process.env.PORT || 3000;

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!GROQ_API_KEY) {
  console.error("❌ GROQ_API_KEY غير مضبوط");
  process.exit(1);
}

if (!MODEL) {
  console.error("❌ MODEL فارغ. اضبط GROQ_MODEL");
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
  keyGenerator: (req) => String(req.ip),
});

// ✅ TTS limiter منفصل
const ttsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.TTS_RPM || 18),
  standardHeaders: true,
  legacyHeaders: false,
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

  const tips = arrPick("tips", 3);

  return {
    category,
    title,
    verdict,
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
    String(d?.when_to_seek_help || "") +
    " " +
    (Array.isArray(d?.tips) ? d.tips.join(" ") : "");

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
    tips: sArr(obj?.tips, 3),
    when_to_seek_help: sStr(obj?.when_to_seek_help),
  };
}

// ✅ NEW: منع بطاقة العنوان فقط
function isEmptyCard(card) {
  const verdictEmpty = !String(card?.verdict || "").trim();
  const tipsEmpty = !Array.isArray(card?.tips) || card.tips.length === 0;
  const seekEmpty = !String(card?.when_to_seek_help || "").trim();
  return verdictEmpty && tipsEmpty && seekEmpty;
}

function buildSystemPrompt() {
  // ✅ تعديل مهم: القيم عربية فقط، مفاتيح JSON الإنجليزية مسموحة لأنها تنسيق
  return `
أنت **"دليل العافية"** مساعد تثقيف صحي توعوي ذكي يعتمد على معلومات صحية موثوقة.

الهوية:
- تقدم تثقيفًا صحيًا عامًا فقط.
- لست طبيبًا ولا تقدم استشارة طبية.
- هدفك نشر الوعي الصحي وتقليل المخاطر الصحية.
- سلامة المستخدم مقدمة دائمًا على تقديم الإجابة الكاملة.

قواعد الأمان الطبي الصارمة:
يُمنع عليك:
- تشخيص الأمراض أو تأكيد الإصابة.
- إعطاء خطوات علاج أو إسعاف تفصيلية.
- تحديد جرعات أدوية.
- اقتراح أدوية أو وصفات علاج.
- تقديم بدائل عن الطبيب أو الجهات الصحية.

حالات الطوارئ:
عند الاشتباه بخطر صحي (ألم شديد، نزيف، فقدان وعي، أعراض مفاجئة خطيرة):
وجّه المستخدم فورًا لطلب مساعدة طبية عاجلة عبر:
9999 شرطة عُمان السلطانية
24343666 الهيئة الصحية

قاعدة اللغة:
- كل القيم النصية داخل JSON (title/verdict/tips/when_to_seek_help) يجب أن تكون بالعربية فقط.
- مفاتيح JSON ستبقى بالإنجليزية (category,title,verdict,tips,when_to_seek_help) وهذا مسموح لأنها جزء من التنسيق.
- تجنب إدخال أي كلمات لاتينية داخل القيم النصية.

صيغة الإخراج الإلزامية:
- أعد JSON فقط وبلا أي نص خارجه وبدون Markdown، بالشكل:
{"category":"general|nutrition|bp|sugar|sleep|activity|mental|first_aid|report|emergency|water|calories|bmi","title":"2-5 كلمات","verdict":"جملتان توعويتان كحد أقصى","tips":["","",""],"when_to_seek_help":"\\" \\" أو نص قصير"}

تنبيه للمسار:
إذا وصلك سياق فيه "path" فهذا يعني مسار واجهة المستخدم المختار. التزم بنفس المسار وقدّم معلومات جديدة غير مكررة وبنفس هيكلة JSON.
`.trim();
}

// ✅ include path in compact context
function compactLastCard(lastCard) {
  const cat = sStr(lastCard?.category);
  const path = sStr(lastCard?.path);
  const out = {};
  if (cat) out.category = cat;
  if (path) out.path = path;
  return Object.keys(out).length ? out : null;
}

function chooseMaxTokens(msg, lastCard) {
  const base = Number(process.env.GROQ_MAX_TOKENS || 220);

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
    tips: [],
    when_to_seek_help: "",
  };
}

// ---------- TTS helpers ----------
function normalizeArabicForTTS(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, 200);
}

async function callGroqTTS(text, { model = TTS_MODEL, voice = TTS_VOICE } = {}) {
  const input = normalizeArabicForTTS(text);
  if (!input) throw new Error("tts_empty_input");

  const res = await fetchWithTimeout(
    "https://api.groq.com/openai/v1/audio/speech",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input,
        voice,
        response_format: "wav",
      }),
    },
    20000
  );

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    const e = new Error(`Groq TTS error (${res.status}) ${t.slice(0, 200)}`);
    e.status = res.status;
    e.body = t.slice(0, 500);
    throw e;
  }

  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

// ---------- TTS cache (in-memory) ----------
const TTS_CACHE = new Map();
const TTS_CACHE_TTL_MS = Number(process.env.TTS_CACHE_TTL_MS || 1000 * 60 * 60 * 6);
const TTS_CACHE_MAX_ITEMS = Number(process.env.TTS_CACHE_MAX_ITEMS || 40);
const TTS_CACHE_MAX_BYTES = Number(process.env.TTS_CACHE_MAX_BYTES || 18 * 1024 * 1024);

function ttsCacheKey(text, voice) {
  return `${String(voice || TTS_VOICE).trim()}|${normalizeArabicForTTS(text)}`;
}

function ttsCacheGet(key) {
  const hit = TTS_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > TTS_CACHE_TTL_MS) {
    TTS_CACHE.delete(key);
    return null;
  }
  TTS_CACHE.delete(key);
  TTS_CACHE.set(key, hit);
  return hit.buf;
}

function ttsCacheTotalBytes() {
  let sum = 0;
  for (const v of TTS_CACHE.values()) sum += Number(v.bytes || 0);
  return sum;
}

function ttsCacheSet(key, buf) {
  try {
    TTS_CACHE.set(key, { buf, ts: Date.now(), bytes: buf.length });
    while (TTS_CACHE.size > TTS_CACHE_MAX_ITEMS) {
      const first = TTS_CACHE.keys().next().value;
      if (!first) break;
      TTS_CACHE.delete(first);
    }
    while (ttsCacheTotalBytes() > TTS_CACHE_MAX_BYTES) {
      const first = TTS_CACHE.keys().next().value;
      if (!first) break;
      TTS_CACHE.delete(first);
    }
  } catch {}
}

// ---------- routes ----------
app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/reset", (_req, res) => {
  res.json({ ok: true });
});

// ✅ TTS endpoint
app.post("/tts", ttsLimiter, async (req, res) => {
  try {
    const text = String(req.body?.text || "").trim();
    const voice = String(req.body?.voice || TTS_VOICE).trim() || TTS_VOICE;

    if (!text) return res.status(400).json({ ok: false, error: "empty_text" });

    const key = ttsCacheKey(text, voice);
    const cached = ttsCacheGet(key);
    const wav = cached || (await callGroqTTS(text, { voice }));
    if (!cached) ttsCacheSet(key, wav);

    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("Content-Length", String(wav.length));
    return res.status(200).send(wav);
  } catch (e) {
    console.error(e);
    const status = Number(e?.status || 0);
    if (status === 402 || status === 429) {
      return res.status(503).json({ ok: false, error: "tts_unavailable", hint: "quota_or_rate_limit" });
    }
    return res.status(500).json({ ok: false, error: "tts_error" });
  }
});

app.post("/chat", chatLimiter, async (req, res) => {
  try {
    const msg = String(req.body?.message || "").trim();
    if (!msg) return res.status(400).json({ ok: false, error: "empty_message" });
    if (msg.length > 350) return res.status(400).json({ ok: false, error: "message_too_long" });

    const lastCard = req.body?.context?.last || null;

    const ctxPath = String(req.body?.context?.path || req.body?.meta?.path || "").trim();
    const lastCategory = String(req.body?.context?.category || lastCard?.category || "").trim();

    const compact = compactLastCard({ category: lastCategory, path: ctxPath });

    const messages = [{ role: "system", content: buildSystemPrompt() }];

    if (compact) {
      messages.push({
        role: "assistant",
        content: "سياق سابق مختصر للاستمرار:\n" + JSON.stringify(compact),
      });
    }

    messages.push({ role: "user", content: msg });

    const maxTokens = chooseMaxTokens(msg, { category: lastCategory });

    // ✅ موديل واحد فقط
    const raw1 = await callGroq(messages, { model: MODEL, max_tokens: maxTokens });
    const parsed = extractJson(raw1);

    let data;
    if (parsed) data = normalize(parsed);
    else data = normalize(recoverPartialCard(raw1) || fallback(raw1));

    if (isMetaJsonAnswer(data)) {
      data = normalize(recoverPartialCard(raw1) || fallback(raw1));
    }

    // ✅ حارس نهائي: لا ترجع بطاقة عنوان فقط
    if (isEmptyCard(data)) {
      data = fallback(raw1);
    }

    return res.json({
      ok: true,
      data,
      meta: {
        model_used: MODEL,
        path: ctxPath || null,
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "server_error", data: fallback("") });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 API running on :${PORT} | model=${MODEL} | tts=${TTS_MODEL}/${TTS_VOICE}`);
});
