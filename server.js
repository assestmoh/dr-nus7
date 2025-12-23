import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import multer from "multer";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse"); // ✅ FIX: CommonJS via require

const app = express();

// ENV
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MODEL_ID = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const PORT = process.env.PORT || 8000;

if (!GROQ_API_KEY) {
  console.error("❌ GROQ_API_KEY غير مضبوط");
  process.exit(1);
}

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ✅ Serve frontend
app.use(express.static("public"));

// Upload
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

// --------- session memory ----------
const sessions = new Map();
const SESSION_TTL_MS = 1000 * 60 * 60 * 6;
const MAX_HISTORY = 6;

function getUserId(req, body) {
  const h = (req.get("x-user-id") || "").trim();
  if (h) return h;
  const b = (body?.user_id || "").trim();
  if (b) return b;
  return "anon";
}

function cleanupSessions() {
  const now = Date.now();
  for (const [k, s] of sessions.entries()) {
    if (!s?.updatedAt || now - s.updatedAt > SESSION_TTL_MS) sessions.delete(k);
  }
}

function getSession(userId) {
  cleanupSessions();
  const now = Date.now();
  if (!sessions.has(userId)) sessions.set(userId, { lastCard: null, history: [], updatedAt: now });
  const s = sessions.get(userId);
  s.updatedAt = now;
  return s;
}

function resetSession(userId) {
  sessions.delete(userId);
}

// --------- helpers ----------
async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(url, options = {}, ms = 24000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

function extractJson(text) {
  const s = String(text || "").trim();
  try {
    return JSON.parse(s);
  } catch {}
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
const sArr = (v, n) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).slice(0, n) : []);

function clampCategory(cat) {
  const allowed = new Set(["general", "bmi", "bp", "sugar", "water", "calories", "mental", "report", "emergency"]);
  return allowed.has(cat) ? cat : "general";
}

// ✅ official Shifaa links (no fake booking)
const SHIFAA_ANDROID =
  "https://play.google.com/store/apps/details?id=om.gov.moh.phr&pcampaignid=web_share";
const SHIFAA_IOS =
  "https://apps.apple.com/us/app/%D8%B4-%D9%81-%D8%A7%D8%A1/id1455936672?l=ar";

function buildSystemPrompt() {
  return `
أنت "دليل العافية" — توعية صحية فقط.

مهم:
- JSON فقط (بدون أي نص خارج JSON).
- لا تشخيص، لا أدوية، لا جرعات.
- ممنوع اختراع روابط/أرقام/حجز.
- لو المستخدم سأل عن مواعيد/حجز/تطبيق: اعطه الروابط الرسمية فقط:
  - شفاء للأندرويد: ${SHIFAA_ANDROID}
  - شفاء للآيفون: ${SHIFAA_IOS}

الصيغة:
{
 "category":"general|bmi|bp|sugar|water|calories|mental|report|emergency",
 "title":"عنوان قصير",
 "verdict":"جملة واحدة",
 "tips":["نصيحة 1","نصيحة 2"],
 "when_to_seek_help":"... أو \"\"",
 "next_question":"سؤال واحد أو \"\"",
 "quick_choices":["خيار 1","خيار 2"]
}

قواعد:
- مختصر جدًا.
- إذا next_question = "" => quick_choices = [].
`.trim();
}

function buildContextMessage(session, clientContext) {
  const last = session?.lastCard || clientContext?.last || null;
  return JSON.stringify({
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
  });
}

async function callGroq(messages, maxTokens = 650) {
  for (let attempt = 0; attempt < 2; attempt++) {
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
          temperature: 0.15,
          max_tokens: maxTokens,
          response_format: { type: "json_object" },
          messages,
        }),
      },
      26000
    );

    if (res.ok) {
      const data = await res.json();
      return data.choices?.[0]?.message?.content || "";
    }

    const t = await res.text().catch(() => "");
    if (res.status === 429 && attempt === 0) {
      await sleep(1200);
      continue;
    }
    throw new Error("Groq API error: " + res.status + " " + t);
  }
  throw new Error("Groq retry failed");
}

function normalize(obj) {
  const category = clampCategory(sStr(obj?.category) || "general");
  const title = sStr(obj?.title) || "دليل العافية";
  const verdict = sStr(obj?.verdict) || "معلومة عامة للتوعية.";
  const tips = sArr(obj?.tips, 2);
  const when_to_seek_help = sStr(obj?.when_to_seek_help);
  const next_question = sStr(obj?.next_question);
  const quick_choices = sArr(obj?.quick_choices, 2);

  const fixedNextQ = next_question ? next_question : "";
  const fixedChoices = fixedNextQ ? quick_choices : [];

  return {
    category,
    title,
    verdict,
    tips,
    when_to_seek_help: when_to_seek_help || "",
    next_question: fixedNextQ,
    quick_choices: fixedChoices,
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

// --------- routes ----------
app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/reset", (req, res) => {
  const userId = getUserId(req, req.body || {});
  resetSession(userId);
  res.json({ ok: true, reset: true });
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

    if (!session.lastCard && clientContext?.last) session.lastCard = clientContext.last;

    const last = session.lastCard;
    const isChoice =
      meta?.is_choice === true ||
      ((msg.length <= 12) && last?.next_question) ||
      (Array.isArray(last?.quick_choices) && last.quick_choices.includes(msg));

    let userContent = msg;
    if (isChoice && last?.next_question) {
      userContent =
        `إجابة المستخدم على السؤال السابق:\n` +
        `السؤال: ${last.next_question}\n` +
        `الإجابة: ${msg}\n` +
        `الموضوع: ${last.title}\n`;
    }

    const messages = [
      { role: "system", content: buildSystemPrompt() },
      { role: "system", content: buildContextMessage(session, clientContext) },
      ...session.history.slice(-MAX_HISTORY),
      { role: "user", content: userContent },
    ];

    const raw = await callGroq(messages, 650);
    const parsed = extractJson(raw);
    const data = parsed ? normalize(parsed) : fallback(raw);

    session.lastCard = data;
    session.history.push({ role: "user", content: userContent });
    session.history.push({ role: "assistant", content: JSON.stringify(data) });
    if (session.history.length > MAX_HISTORY) session.history = session.history.slice(-MAX_HISTORY);

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

app.post("/report", upload.single("file"), async (req, res) => {
  try {
    const f = req.file;
    if (!f) return res.status(400).json({ ok: false, error: "no_file" });

    if (f.mimetype !== "application/pdf") {
      return res.json({
        ok: true,
        reply:
          "حاليًا أقرأ PDF النصّي فقط.\n" +
          "إذا كان التقرير صورة/سكان: انسخي النص والصقيه أو ارفعي PDF نصّي.",
      });
    }

    const out = await pdfParse(f.buffer).catch(() => null);
    const text = (out?.text || "").trim();

    if (text.length < 40) {
      return res.json({
        ok: true,
        reply:
          "ما قدرت أطلع نص واضح من الـ PDF (غالبًا Scan).\n" +
          "الحل: انسخي النص والصقيه هنا، أو وفري PDF نصّي.",
      });
    }

    const clipped = text.slice(0, 4500);

    const reportSystem = `JSON فقط:
{"summary":"سطرين","highlights":["نقطة1","نقطة2"],"question":"سؤال واحد"}
مختصر جدًا. لا تشخيص/أدوية/جرعات.`.trim();

    const raw = await callGroq(
      [
        { role: "system", content: reportSystem },
        { role: "user", content: "نص التقرير:\n" + clipped },
      ],
      520
    );

    const parsed = extractJson(raw) || {};
    const summary = sStr(parsed.summary) || "ملخص مبسط للتقرير.";
    const highlights = sArr(parsed.highlights, 2);
    const question = sStr(parsed.question);

    let reply = "🧾 **شرح مبسط للتقرير**\n" + summary;
    if (highlights.length) reply += "\n\n**أهم النقاط:**\n- " + highlights.join("\n- ");
    if (question) reply += "\n\n**سؤال سريع:**\n" + question;

    reply += "\n\n(توعية عامة — إذا نتيجة مقلقة أو أعراض راجع طبيبك.)";
    res.json({ ok: true, reply });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "report_error", reply: "تعذّر قراءة التقرير الآن." });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Dalil Alafiyah يعمل على ${PORT}`);
});
