// server.js — Dalil Alafiyah API (token-lean + hardened + stable)
//
// Key upgrades:
// 1) Compressed System Prompt (dramatically fewer tokens)
// 2) Session-based system prompt injection (send system only once per session)
//    - Uses header: x-session-id OR body.context.session_id
//    - In-memory TTL cache (no DB needed)
// 3) Proper Groq error surfacing + graceful 429 handling
// 4) Small-first / Big-fallback routing (optional)
// 5) Keeps your strict JSON card logic & recovery

import "dotenv/config";
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

const app = express();

const GROQ_API_KEY = process.env.GROQ_API_KEY;

// Models (updated defaults)
const SMALL_MODEL = process.env.GROQ_SMALL_MODEL || "llama-3.1-8b-instant";
const BIG_MODEL = process.env.GROQ_BIG_MODEL || ""; // optional; if empty => no escalation
const PORT = process.env.PORT || 3000;

// Token controls
const BASE_MAX_TOKENS = Number(process.env.GROQ_MAX_TOKENS || 160);
const TEMP = Number(process.env.GROQ_TEMPERATURE || 0.35);

// Session memory (in-memory)
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 6 * 60 * 60 * 1000); // 6 hours
const sessionSeen = new Map(); // sessionId -> lastSeenEpochMs

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
  max: Number(process.env.CHAT_RPM || 20),
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

// ✅ Compressed System Prompt (token-lean)
function buildSystemPromptCompressed() {
  return `
أنت "دليل العافية" مساعد تثقيف صحي عربي لمجتمع سلطنة عُمان. معلومات عامة/وقاية/إسعافات أولية فقط. التشخيص الطبي والجرعات الفردية ممنوعان.

قواعد أساسية:
- أجب مباشرة وباختصار، وتجنب التكرار.
- اسأل سؤال واحد فقط عند الحاجة الضرورية.
- إذا ظهرت علامات خطر: وجّه فورًا للطوارئ واذكر أرقام عُمان: 9999 و 24343666، وقدّم إسعاف أولي آمن ومختصر.
- لا تقل: تم التسجيل/تم الحفظ/جاري التنفيذ.
- لا تذكر JSON أو schema أو format أو Markdown.

علامات خطر (اعتبرها طارئة): ألم صدر شديد، صعوبة تنفس شديدة، فقدان وعي، تشنجات، نزيف شديد، ضعف مفاجئ بطرف، صعوبة كلام مفاجئة، حادث قوي/إصابة خطيرة، حروق شديدة، ازرقاق، أفكار انتحارية/إيذاء النفس.

التصنيفات المسموحة فقط:
general | nutrition | bp | sugar | sleep | activity | mental | first_aid | report | emergency | water | calories | bmi

أخرج JSON strict فقط (بدون أي نص خارج JSON):
{
  "category":"واحد من القائمة",
  "title":"2-5 كلمات",
  "verdict":"جملة واحدة واضحة",
  "next_question":"سؤال واحد فقط أو \"\"",
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
    title: sStr(lastCard.title).slice(0, 60),
    verdict: sStr(lastCard.verdict).slice(0, 240),
    next_question: sStr(lastCard.next_question).slice(0, 160),
  };
}

function chooseMaxTokens(msg, lastCard) {
  const text = String(msg || "");
  const cat = sStr(lastCard?.category);

  let m = BASE_MAX_TOKENS;

  // allow a bit more for report/emergency only
  if (cat === "report" || /تقرير|ملخص|تحليل/i.test(text)) m = Math.max(m, 220);
  if (cat === "emergency" || /طوارئ|إسعاف|اختناق|نزيف|حروق|سكتة/i.test(text)) m = Math.max(m, 220);

  // hard cap to protect budget
  const hardCap = Number(process.env.GROQ_HARD_CAP || 260);
  return Math.min(m, hardCap);
}

function getSessionId(req) {
  const h = String(req.headers["x-session-id"] || "").trim();
  const b = String(req.body?.context?.session_id || "").trim();
  const sid = h || b;
  // avoid unbounded memory keys
  return sid && sid.length <= 80 ? sid : "";
}

function sessionHasSystem(sid) {
  if (!sid) return false;
  const now = Date.now();
  const last = sessionSeen.get(sid);
  if (!last) return false;
  if (now - last > SESSION_TTL_MS) {
    sessionSeen.delete(sid);
    return false;
  }
  // refresh TTL
  sessionSeen.set(sid, now);
  return true;
}

function markSessionSystem(sid) {
  if (!sid) return;
  sessionSeen.set(sid, Date.now());
}

// basic cleanup to prevent memory growth
setInterval(() => {
  const now = Date.now();
  for (const [sid, ts] of sessionSeen.entries()) {
    if (now - ts > SESSION_TTL_MS) sessionSeen.delete(sid);
  }
}, 30 * 60 * 1000).unref();

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
  return {
    content: data.choices?.[0]?.message?.content || "",
    usage: data.usage || null,
  };
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

app.post("/reset", (req, res) => {
  const sid = getSessionId(req);
  if (sid) sessionSeen.delete(sid);
  res.json({ ok: true });
});

app.post("/chat", chatLimiter, async (req, res) => {
  try {
    const msg = String(req.body?.message || "").trim();
    if (!msg) return res.status(400).json({ ok: false, error: "empty_message" });
    if (msg.length > 1200) return res.status(400).json({ ok: false, error: "message_too_long" });

    const sid = getSessionId(req);
    const lastCard = req.body?.context?.last || null;
    const compact = compactLastCard(lastCard);

    const messages = [];

    // ✅ Only send system prompt once per session (if session id provided)
    if (!sessionHasSystem(sid)) {
      messages.push({ role: "system", content: buildSystemPromptCompressed() });
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

    // 1) Small model first
    let usedModel = SMALL_MODEL;
    let raw1 = "";
    let parsed = null;
    let usage = null;

    try {
      const r1 = await callGroq(messages, { model: SMALL_MODEL, max_tokens: maxTokens });
      raw1 = r1.content;
      usage = r1.usage;
      parsed = extractJson(raw1);
    } catch (e) {
      // If small model decommissioned/invalid, and big exists, escalate
      const em = String(e?.message || "");
      const decomm = e?.code === "model_decommissioned" || /decommissioned/i.test(em);
      if (!decomm) throw e;
    }

    // 2) Big model fallback (optional) if parse failed
    let raw2 = "";
    if (!parsed && BIG_MODEL) {
      usedModel = BIG_MODEL;
      const r2 = await callGroq(messages, { model: BIG_MODEL, max_tokens: maxTokens });
      raw2 = r2.content;
      usage = r2.usage;
      parsed = extractJson(raw2);
    }

    let data;
    if (parsed) data = normalize(parsed);
    else data = normalize(recoverPartialCard(raw2 || raw1) || fallback(raw2 || raw1));

    if (isMetaJsonAnswer(data)) {
      data = normalize(recoverPartialCard(raw2 || raw1) || fallback(raw2 || raw1));
    }

    // Optional: log usage for debugging costs (disable by setting LOG_USAGE=0)
    if (String(process.env.LOG_USAGE || "1") === "1" && usage) {
      console.log("usage:", { model: usedModel, ...usage });
    }

    return res.json({
      ok: true,
      data,
      meta: {
        model_used: usedModel,
        session_id: sid || "",
      },
    });
  } catch (e) {
    const status = Number(e?.status || 0);
    const msg = String(e?.message || "");

    // ✅ Graceful 429 (prevents crashes/restarts)
    if (status === 429 || msg.includes("(429)") || msg.toLowerCase().includes("rate limit")) {
      return res.status(429).json({
        ok: false,
        error: "rate_limited",
        data: {
          category: "general",
          title: "حد الاستخدام اليومي",
          verdict: "تم الوصول لحد الاستخدام في Groq (Tokens/Day). جرّب لاحقًا أو خفّض الاستهلاك.",
          next_question: "",
          quick_choices: ["جرّب بعد فترة", "خفّض الاستهلاك"],
          tips: ["قلّل طول الرسالة والسياق", "خفض max_tokens أو استخدم موديل أصغر"],
          when_to_seek_help: "",
        },
      });
    }

    // Surface the real error (don't hide it)
    console.error(e);
    return res.status(500).json({ ok: false, error: "server_error", data: fallback("") });
  }
});

app.listen(PORT, () => {
  console.log(
    `🚀 API running on :${PORT} | small=${SMALL_MODEL} | big=${BIG_MODEL || "(none)"} | max=${BASE_MAX_TOKENS}`
  );
});
