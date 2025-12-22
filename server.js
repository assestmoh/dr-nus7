// ===============================
// server.js — Dalil Alafiyah API (Fixed + Contextual)
// ===============================

import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import fetch from "node-fetch";

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
app.use(express.json({ limit: "2mb" }));

// ===============================
// Session Memory (in-memory)
// ===============================
const sessions = new Map();
/**
 * session = {
 *   lastCard: { category,title,verdict,tips,when_to_seek_help,next_question,quick_choices },
 *   history: [{ role:"user"|"assistant", content:string }],
 *   updatedAt: number
 * }
 */
const SESSION_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours
const MAX_HISTORY = 10;

function getUserId(req, body) {
  const h = (req.get("x-user-id") || "").trim();
  if (h) return h;
  const b = (body?.user_id || "").trim();
  if (b) return b;
  return "anon";
}

function getSession(userId) {
  const now = Date.now();

  // cleanup (cheap)
  for (const [k, s] of sessions.entries()) {
    if (!s?.updatedAt || now - s.updatedAt > SESSION_TTL_MS) sessions.delete(k);
  }

  if (!sessions.has(userId)) {
    sessions.set(userId, { lastCard: null, history: [], updatedAt: now });
  }
  const s = sessions.get(userId);
  s.updatedAt = now;
  return s;
}

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

// robust JSON extraction fallback
function extractJson(text) {
  const s = String(text || "").trim();

  // direct parse
  try {
    return JSON.parse(s);
  } catch {}

  // slice between first { and last }
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a === -1 || b === -1 || b <= a) return null;

  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
}

const sStr = (v) => (typeof v === "string" ? v.trim() : "");
const sArr = (v, n) =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).slice(0, n) : [];

function clampCategory(cat) {
  const allowed = new Set([
    "general",
    "nutrition",
    "sleep",
    "activity",
    "mental",
    "skin",
    "bp",
    "sugar",
    "firstaid",
    "report",
    "emergency",
  ]);

  // legacy mapping
  if (cat === "blood_pressure") return "bp";
  if (cat === "first_aid") return "firstaid";

  return allowed.has(cat) ? cat : "general";
}

function looksLikeShortAnswer(msg) {
  const t = sStr(msg).toLowerCase();

  // very short answer or single word
  if (t.length <= 4) return true;

  const yes = ["نعم", "اي", "ايه", "أيوه", "ايوه", "تمام", "ok", "yes"];
  const no = ["لا", "مو", "مش", "لاا", "no", "مابي", "ما ابي", "ماعندي"];

  if (yes.some((w) => t === w || t.includes(w))) return true;
  if (no.some((w) => t === w || t.includes(w))) return true;

  return false;
}

// ===============================
// System Prompt
// ===============================
function buildSystemPrompt() {
  return `
أنت "دليل العافية" — مساعد عربي للتثقيف الصحي فقط.

مهم جدًا:
- أخرج JSON فقط بدون أي نص قبل/بعد وبدون Markdown وبدون كتل كود.
- لا تشخيص. لا وصف أدوية. لا جرعات.
- اجعل الرد مرتبطًا مباشرة بسؤال المستخدم وسياقه السابق إن وُجد.
- إذا كانت رسالة المستخدم قصيرة أو تبدو إجابة (مثل نعم/لا أو اختيار)، اعتبرها إجابة للسؤال الأخير ولا تغيّر الموضوع.

صيغة الإخراج (ثابتة):
{
  "category": "general|nutrition|sleep|activity|mental|skin|bp|sugar|firstaid|report|emergency",
  "title": "عنوان قصير (2-5 كلمات)",
  "verdict": "جملة واحدة واضحة: تطمين/إرشاد/تنبيه",
  "tips": ["نصيحة قصيرة 1","نصيحة قصيرة 2"],
  "when_to_seek_help": "متى تراجع الطبيب/الطوارئ (أو \\"\\" )",
  "next_question": "سؤال متابعة واحد فقط (أو \\"\\" )",
  "quick_choices": ["خيار 1","خيار 2"]
}

قواعد جودة:
- tips: غالبًا 2 فقط، قصيرة وعملية.
- next_question: سؤال واحد فقط. إذا ما تحتاج سؤال ضع "" واجعل quick_choices [].
- quick_choices: 0 إلى 2 خيارات فقط، ويجب أن تكون مرتبطة بالسؤال مباشرة.
- لا تبدأ موضوع جديد إذا كان إدخال المستخدم إجابة على سؤال سابق.
`.trim();
}

function buildContextMessage(session, clientContext) {
  const last = session?.lastCard || clientContext?.last || null;

  const ctx = {
    has_last_card: !!last,
    last_card: last
      ? {
          category: last.category || "",
          title: last.title || "",
          verdict: last.verdict || "",
          next_question: last.next_question || "",
          quick_choices: Array.isArray(last.quick_choices) ? last.quick_choices : [],
        }
      : null,
    instruction:
      "إذا رسالة المستخدم قصيرة أو تبدو اختيارًا/نعم-لا، اعتبرها إجابة للسؤال الأخير وواصل بنفس الموضوع.",
  };

  return JSON.stringify(ctx);
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
        temperature: 0.25,
        max_tokens: 650,
        response_format: { type: "json_object" }, // important
        messages,
      }),
    },
    25000
  );

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error("Groq API error: " + res.status + " " + t);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

// ===============================
// Normalize
// ===============================
function normalize(obj) {
  const category = clampCategory(sStr(obj?.category) || "general");

  const title = sStr(obj?.title) || "دليل العافية";
  const verdict = sStr(obj?.verdict) || "معلومة عامة للتوعية.";
  const tips = sArr(obj?.tips, 2);
  const when_to_seek_help = sStr(obj?.when_to_seek_help) || "";

  const next_question = sStr(obj?.next_question) || "";
  const quick_choices = sArr(obj?.quick_choices, 2);

  return {
    category,
    title,
    verdict,
    tips,
    when_to_seek_help,
    next_question,
    quick_choices: next_question ? quick_choices : [],
  };
}

function fallback(text) {
  return {
    category: "general",
    title: "معلومة عامة",
    verdict: sStr(text) || "لا تتوفر معلومات كافية.",
    tips: [],
    when_to_seek_help: "",
    next_question: "",
    quick_choices: [],
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
    const body = req.body || {};
    const userId = getUserId(req, body);
    const session = getSession(userId);

    const msg = String(body.message || "").trim();
    if (!msg) return res.status(400).json({ ok: false, error: "empty_message" });

    const meta = body.meta || {};
    const clientContext = body.context || null;

    // if server doesn't have last card, take it from client
    if (!session.lastCard && clientContext?.last) session.lastCard = clientContext.last;

    const last = session.lastCard;

    // Detect choice/short-answer even if client didn't send meta.is_choice
    const isChoice = meta?.is_choice === true;
    const autoShort = looksLikeShortAnswer(msg);

    let userContent = msg;

    if ((isChoice || autoShort) && last?.next_question) {
      userContent =
        `إجابة المستخدم على السؤال السابق:\n` +
        `السؤال: ${last.next_question}\n` +
        `الإجابة: ${msg}\n` +
        `الموضوع الحالي: ${last.title}\n` +
        `تابع بنفس الموضوع وقدّم نصائح/توضيح ثم سؤال متابعة واحد فقط إذا يلزم.\n`;
    }

    const messages = [
      { role: "system", content: buildSystemPrompt() },
      { role: "system", content: buildContextMessage(session, clientContext) },
    ];

    // short history
    if (Array.isArray(session.history) && session.history.length) {
      for (const h of session.history.slice(-MAX_HISTORY)) {
        if (h?.role && typeof h.content === "string") messages.push(h);
      }
    }

    messages.push({ role: "user", content: userContent });

    const raw = await callGroq(messages);

    const parsed = extractJson(raw);
    const data = parsed ? normalize(parsed) : fallback(raw);

    // update session
    session.lastCard = data;

    session.history.push({ role: "user", content: userContent });
    session.history.push({ role: "assistant", content: JSON.stringify(data) });

    if (session.history.length > MAX_HISTORY) {
      session.history = session.history.slice(-MAX_HISTORY);
    }

    res.json({ ok: true, data });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      ok: false,
      error: "server_error",
      data: fallback("حدث خطأ غير متوقع. إذا الأعراض مقلقة راجع الطبيب."),
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Dalil Alafiyah API يعمل على ${PORT}`);
});
