// server.js — Dalil Alafiyah API (TPM-safe + token-lean + hardened)
//
// Fixes:
// - NO same-model retry. No double calls per request.
// - System prompt sent once per session (x-session-id / context.session_id)
// - Big model disabled by default (prevents burn)
// - Tight max_tokens + hard cap
// - Graceful 429 handling
// - Normalizes "نعم/تمام" into meaningful follow-up

import "dotenv/config";
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

const app = express();

const GROQ_API_KEY = process.env.GROQ_API_KEY;
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
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.length === 0) return cb(null, true);
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
  max: Number(process.env.CHAT_RPM || 10), // خفّضناه لمنع burst
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.ip),
});

// ========= Model + token settings =========
const SMALL_MODEL = process.env.GROQ_SMALL_MODEL || "llama-3.1-8b-instant";

// ✅ Big model disabled by default (set empty to avoid burn)
const BIG_MODEL = (process.env.GROQ_BIG_MODEL || "").trim();

// Guard: never allow big == small (would cause double calls / TPM spikes)
const EFFECTIVE_BIG_MODEL =
  BIG_MODEL && BIG_MODEL !== SMALL_MODEL ? BIG_MODEL : "";

// Tight tokens
const TEMP = Number(process.env.GROQ_TEMPERATURE || 0.25);
const BASE_MAX_TOKENS = Number(process.env.GROQ_MAX_TOKENS || 120);
const HARD_CAP = Number(process.env.GROQ_HARD_CAP || 160);

// ========= Session (system once) =========
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 6 * 60 * 60 * 1000);
const sessionSeen = new Map(); // sid -> lastSeenMs

setInterval(() => {
  const now = Date.now();
  for (const [sid, ts] of sessionSeen.entries()) {
    if (now - ts > SESSION_TTL_MS) sessionSeen.delete(sid);
  }
}, 30 * 60 * 1000).unref();

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

// ✅ Compressed system prompt (keep short to reduce tokens)
function buildSystemPrompt() {
  return `
أنت "دليل العافية" مساعد تثقيف صحي عربي لمجتمع سلطنة عُمان.
المسموح: معلومات عامة، وقاية، إسعافات أولية عامة.
الممنوع: التشخيص الطبي، علاج شخصي، جرعات.

قواعد:
- أجب مباشرة وباختصار.
- اسأل سؤال واحد فقط عند الضرورة.
- عند علامات خطر: وجّه للطوارئ فورًا (9999 و 24343666) + إسعاف أولي آمن مختصر.
- ممنوع ذكر JSON/format/schema/Markdown.

علامات خطر: ألم صدر شديد، صعوبة تنفس شديدة، فقدان وعي، تشنجات، نزيف شديد، ضعف/كلام مفاجئ، حادث قوي، حروق شديدة، ازرقاق، أفكار انتحارية.

التصنيفات فقط:
general | nutrition | bp | sugar | sleep | activity | mental | first_aid | report | emergency | water | calories | bmi

أخرج JSON strict فقط:
{
 "category":"واحد من القائمة",
 "title":"2-5 كلمات",
 "verdict":"جملة واحدة واضحة",
 "next_question":"سؤال واحد أو \"\"",
 "quick_choices":["خيار 1","خيار 2"],
 "tips":["نصيحة 1","نصيحة 2"],
 "when_to_seek_help":"متى تراجع الطبيب/الطوارئ أو \"\""
}
`.trim();
}

function compactLastCard(lastCard) {
  if (!lastCard || typeof lastCard !== "object") return null;
  return {
    category: sStr(lastCard.category) || "general",
    title: sStr(lastCard.title).slice(0, 50),
    verdict: sStr(lastCard.verdict).slice(0, 220),
    next_question: sStr(lastCard.next_question).slice(0, 140),
  };
}

function chooseMaxTokens(msg, lastCard) {
  const text = String(msg || "");
  const cat = sStr(lastCard?.category);
  let m = BASE_MAX_TOKENS;

  if (cat === "report" || /تقرير|ملخص|تحليل/i.test(text)) m = Math.max(m, 150);
  if (cat === "emergency" || /طوارئ|إسعاف|اختناق|نزيف|حروق/i.test(text)) m = Math.max(m, 150);

  return Math.min(m, HARD_CAP);
}

function getSessionId(req) {
  const h = String(req.headers["x-session-id"] || "").trim();
  const b = String(req.body?.context?.session_id || "").trim();
  const sid = h || b;
  return sid && sid.length <= 80 ? sid : "";
}

function sessionHasSystem(sid) {
  if (!sid) return false;
  const now = Date.now();
  const ts = sessionSeen.get(sid);
  if (!ts) return false;
  if (now - ts > SESSION_TTL_MS) {
    sessionSeen.delete(sid);
    return false;
  }
  sessionSeen.set(sid, now);
  return true;
}

function markSessionSystem(sid) {
  if (!sid) return;
  sessionSeen.set(sid, Date.now());
}

// normalize "نعم/تمام" etc into meaningful instruction
function normalizeShortReply(userMsg, lastCard) {
  const m = String(userMsg || "").trim();
  if (!m) return m;

  const yesLike = /^(نعم|اي|أيوه|ايوه|تمام|اوكي|حاضر|طيب|موافق|👍)$/i.test(m);
  const noLike = /^(لا|مو|ليس|👎)$/i.test(m);

  if (!lastCard || typeof lastCard !== "object") return m;

  if (yesLike) {
    const topic = sStr(lastCard.title) || "النصائح السابقة";
    return `المستخدم قال نعم على "${topic}". قدم خطوتين عمليتين إضافيتين قابلة للتطبيق اليوم، ثم اسأل سؤال واحد لتحديد الهدف (نوم/غذاء/نشاط/نفسية).`;
  }
  if (noLike) {
    const topic = sStr(lastCard.title) || "النصائح السابقة";
    return `المستخدم قال غير مفيد بخصوص "${topic}". قدم بديلين عمليين مناسبين، ثم اسأل سؤال واحد: ما الذي يصعب تطبيقه؟`;
  }
  return m;
}

function parseGroqErrorBody(text) {
  try {
    const j = JSON.parse(text);
    return {
      code: j?.error?.code || "",
      message: j?.error?.message || text || "",
    };
  } catch {
    return { code: "", message: text || "" };
  }
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
        temperature: TEMP,
        max_tokens,
        messages,
      }),
    },
    20000
  );

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    const { code, message } = parseGroqErrorBody(t);
    const err = new Error(`Groq API error (${res.status}) ${message}`);
    err.status = res.status;
    err.code = code;
    err.raw = t;
    throw err;
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

function fallback(rawText) {
  const looseVerdict = extractVerdictLoosely(rawText);
  return {
    category: "general",
    title: "إرشاد",
    verdict:
      looseVerdict ||
      "للمتابعة: اختر هدفًا واحدًا (نوم/غذاء/نشاط/نفسية) وسأعطيك خطوتين عمليتين.",
    next_question: "ما الهدف الأقرب لك الآن: النوم أم الغذاء أم النشاط أم الصحة النفسية؟",
    quick_choices: ["النوم", "الغذاء"],
    tips: ["ابدأ بخطوة صغيرة اليوم", "لا تكثر أهداف دفعة واحدة"],
    when_to_seek_help: "",
  };
}

// ---------- routes ----------
app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/reset", (req, res) => {
  const sid = getSessionId(req);
  if (sid) sessionSeen.delete(sid);
  res.json({ ok: true });
});

app.post("/chat", chatLimiter, async (req, res) => {
  try {
    let msg = String(req.body?.message || "").trim();
    if (!msg) return res.status(400).json({ ok: false, error: "empty_message" });
    if (msg.length > 1200) return res.status(400).json({ ok: false, error: "message_too_long" });

    const sid = getSessionId(req);
    const lastCard = req.body?.context?.last || null;
    const compact = compactLastCard(lastCard);

    // ✅ fix "نعم" style replies
    msg = normalizeShortReply(msg, lastCard);

    const messages = [];

    // ✅ system prompt once per session (if sid provided)
    if (!sessionHasSystem(sid)) {
      messages.push({ role: "system", content: buildSystemPrompt() });
      markSessionSystem(sid);
    }

    if (compact) {
      messages.push({
        role: "assistant",
        content: "سياق سابق مختصر:\n" + JSON.stringify(compact),
      });
    }

    messages.push({ role: "user", content: msg });

    const maxTokens = chooseMaxTokens(msg, lastCard);

    // ✅ ONE call per request (prevents TPM spikes)
    const raw = await callGroq(messages, { model: SMALL_MODEL, max_tokens: maxTokens });
    const parsed = extractJson(raw);

    let data;
    if (parsed) data = normalize(parsed);
    else data = normalize(recoverPartialCard(raw) || fallback(raw));

    if (isMetaJsonAnswer(data)) {
      data = normalize(recoverPartialCard(raw) || fallback(raw));
    }

    if (!data.verdict) data = fallback(raw);

    return res.json({ ok: true, data, meta: { model_used: SMALL_MODEL, session_id: sid } });
  } catch (e) {
    const status = Number(e?.status || 0);
    const code = String(e?.code || "");
    const msg = String(e?.message || "");

    // ✅ graceful 429
    if (status === 429 || code === "rate_limit_exceeded" || msg.includes("(429)")) {
      return res.status(429).json({
        ok: false,
        error: "rate_limited",
        data: {
          category: "general",
          title: "ازدحام مؤقت",
          verdict: "فيه حد توكنز/دقيقة على Groq. انتظر قليلًا ثم أعد المحاولة.",
          next_question: "",
          quick_choices: ["أعد المحاولة بعد 20 ثانية", "خفّض طول الرسالة"],
          tips: ["لا ترسل رسائل متتالية بسرعة", "خفّض max_tokens إذا لزم"],
          when_to_seek_help: "",
        },
      });
    }

    console.error(e);
    return res.status(500).json({ ok: false, error: "server_error", data: fallback("") });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 API running on :${PORT} | small=${SMALL_MODEL} | big=${EFFECTIVE_BIG_MODEL || "(none)"} | max=${BASE_MAX_TOKENS}`);
});
