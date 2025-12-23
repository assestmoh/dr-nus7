// ===============================
// server.js — Dalil Alafiyah (FINAL FIXED)
// ===============================

import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import multer from "multer";
import pdfParsePkg from "pdf-parse"; // قد يشتغل في بعض البيئات
import { createRequire } from "module";

const require = createRequire(import.meta.url);
// حل مضمون لـ pdf-parse مع ESM
const pdfParse = (() => {
  try {
    // إذا اشتغل import فوق كـ function
    if (typeof pdfParsePkg === "function") return pdfParsePkg;
  } catch {}
  // fallback: require
  return require("pdf-parse");
})();

const app = express();

// ===============================
// ENV
// ===============================
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MODEL_ID = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const PORT = process.env.PORT || 8000;

const SHIFAA_ANDROID =
  "https://play.google.com/store/apps/details?id=om.gov.moh.phr&pcampaignid=web_share";
const SHIFAA_IOS =
  "https://apps.apple.com/us/app/%D8%B4-%D9%81-%D8%A7%D8%A1/id1455936672?l=ar";

if (!GROQ_API_KEY) {
  console.error("❌ GROQ_API_KEY غير مضبوط");
  process.exit(1);
}

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ✅ لخدمة الصفحة من public/
app.use(express.static("public"));

// ===============================
// Upload (Report)
// ===============================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
});

// ===============================
// Session Memory (in-memory)
// ===============================
const sessions = new Map();
const SESSION_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours
const MAX_HISTORY = 8;

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

// ===============================
// Helpers
// ===============================
async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(url, options = {}, ms = 22000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal }); // Node 22 فيه fetch مدمج
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

function buildSystemPrompt() {
  // ✅ أقصر + يمنع الاختراع + يذكر روابط شفاء
  return `
أنت "دليل العافية" — توعية صحية فقط.

مهم:
- أخرج JSON فقط (بدون أي نص خارج JSON).
- لا تشخيص، لا أدوية، لا جرعات.
- لا تخترع أرقام هواتف أو روابط أو معلومات حجز.
- إذا سأل عن المواعيد/الحجز/تطبيق رسمي: قدم الروابط فقط:
  - [شفاء للأندرويد](${SHIFAA_ANDROID})
  - [شفاء للآيفون](${SHIFAA_IOS})

صيغة ثابتة:
{
 "category":"general|bmi|bp|sugar|water|calories|mental|report|emergency",
 "title":"عنوان قصير",
 "verdict":"جملة واحدة واضحة",
 "tips":["نصيحة 1","نصيحة 2"],
 "when_to_seek_help":"متى تراجع الطبيب أو الطوارئ أو \"\"",
 "next_question":"سؤال واحد أو \"\"",
 "quick_choices":["خيار 1","خيار 2"]
}

قواعد:
- tips غالبًا 2.
- إذا next_question = "" => quick_choices = [].
- خليك مختصر جدًا.
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
    rule: "إذا المستخدم رد ردّ قصير (نعم/لا/اختيار) وكان فيه سؤال سابق، اعتبره إجابة لنفس السؤال.",
  });
}

async function callGroq(messages, maxTokens = 750) {
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
  throw new Error("Groq API error: retry failed");
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

// ===============================
// Routes
// ===============================

// health check
app.get("/health", (_req, res) => res.json({ ok: true }));

// reset memory
app.post("/reset", (req, res) => {
  const userId = getUserId(req, req.body || {});
  resetSession(userId);
  res.json({ ok: true, reset: true });
});

// chat
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
    const shouldTreatAsChoice =
      meta?.is_choice === true ||
      ((msg.length <= 12) && last?.next_question) ||
      (Array.isArray(last?.quick_choices) && last.quick_choices.includes(msg));

    let userContent = msg;
    if (shouldTreatAsChoice && last?.next_question) {
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

    const raw = await callGroq(messages, 750);

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

// report upload
app.post("/report", upload.single("file"), async (req, res) => {
  try {
    const f = req.file;
    if (!f) return res.status(400).json({ ok: false, error: "no_file" });

    if (f.mimetype === "application/pdf") {
      const out = await pdfParse(f.buffer).catch(() => null);
      const text = (out?.text || "").trim();

      if (text.length < 40) {
        return res.json({
          ok: true,
          reply:
            "ما قدرت أقرأ نص واضح من الـ PDF (غالبًا ملف ممسوح Scan).\n" +
            "جرّب:\n" +
            "1) صوّر الصفحة كصورة واضحة وارفعها.\n" +
            "2) أو انسخ النص والصقه هنا.\n",
        });
      }

      const clipped = text.slice(0, 4500);

      const reportSystem = `
أخرج JSON فقط:
{"summary":"سطرين","highlights":["نقطة1","نقطة2"],"questions":["سؤال واحد"]}

مختصر جدًا. لا تشخيص ولا أدوية ولا جرعات.
`.trim();

      const raw = await callGroq(
        [
          { role: "system", content: reportSystem },
          { role: "user", content: "نص التقرير:\n" + clipped },
        ],
        650
      );

      const parsed = extractJson(raw) || {};
      const summary = sStr(parsed.summary) || "هذا ملخص مبسط للنتائج.";
      const highlights = sArr(parsed.highlights, 2);
      const questions = sArr(parsed.questions, 1);

      let reply = "🧾 **شرح مبسط للتقرير**\n" + summary;
      if (highlights.length) reply += "\n\n**أهم النقاط:**\n- " + highlights.join("\n- ");
      if (questions.length) reply += "\n\n**سؤال سريع:**\n" + questions[0];
      reply += "\n\n(توعية عامة — إذا فيه أعراض أو نتيجة مقلقة راجع طبيبك.)";

      return res.json({ ok: true, reply });
    }

    if (f.mimetype.startsWith("image/")) {
      // بدون OCR عربي هنا
      return res.json({
        ok: true,
        reply:
          "قراءة الصور تحتاج OCR، وقد تفشل إذا كانت الصورة بعيدة/غير واضحة.\n" +
          "الأفضل:\n" +
          "1) قرّب التصوير جدًا على النتيجة.\n" +
          "2) أو انسخ/الصق نص النتائج هنا.\n" +
          "3) أو ارفع PDF نصّي (مو Scan) إن توفر.\n",
      });
    }

    return res.status(415).json({ ok: false, error: "unsupported_type" });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      ok: false,
      error: "report_error",
      reply: "تعذّر قراءة التقرير الآن. جرّب صورة أوضح أو الصق النص.",
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Dalil Alafiyah يعمل على ${PORT}`);
});
