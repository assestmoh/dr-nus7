// ===============================
// server.js — نسخة للمستشفيات + وضع "شرح تقرير" + رفع limit + timeout
// ===============================

import "dotenv/config";
import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MODEL_ID = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const PORT = process.env.PORT || 3000;

if (!GROQ_API_KEY) {
  console.error("❌ GROQ_API_KEY غير مضبوط");
  process.exit(1);
}

// ✅ CORS
app.use(cors());

// ✅ مهم جدًا للتقارير/OCR: ارفع limit
app.use(express.json({ limit: process.env.JSON_LIMIT || "8mb" }));

// ذاكرة محادثة لكل مستخدم
const conversations = {};

// ===============================
// 1) System Prompts
// ===============================
function buildSystemPromptGeneral() {
  return `
أنت مساعد صحي للتثقيف الصحي فقط.
قدّم معلومات عامة عن الصحة ونمط الحياة، بأسلوب عربي مهني واضح ومختصر.
تجنّب التشخيص الطبي، وصف الأدوية، أو إعطاء جرعات محددة.
لا تقدّم خطط علاجية مفصلة.
اجعل الإجابة عادة بين 6 و12 سطرًا تقريبًا، مع تنظيم بسيط بنقاط.
يمكنك ذكر متى يفضَّل مراجعة الطبيب أو الطوارئ عند وجود أعراض خطيرة.
`.trim();
}

// ✅ Prompt خاص للتقارير (يسمح بالتفسير التوعوي للتحاليل)
function buildSystemPromptReport() {
  return `
أنت مساعد صحي للتثقيف الصحي فقط.
ستستقبل نص تقرير/تحاليل. مهمتك: شرح النتائج بلغة عربية بسيطة للمريض.
مسموح: توضيح المصطلحات، شرح معنى "مرتفع/منخفض" بشكل عام، ذكر أن المرجع يختلف حسب المختبر/العمر/الجنس، اقتراح أسئلة يطرحها المريض على الطبيب.
غير مسموح: تشخيص نهائي، وصف أدوية، جرعات، أو خطة علاج مفصلة.
الأسلوب: مرتب بعناوين قصيرة:
1) ملخص سريع
2) أهم النتائج اللافتة (مع تنبيه مرجع المختبر)
3) شرح مبسط للمصطلحات
4) أسئلة للطبيب
5) متى تكون الحالة طارئة
لا تذكر بيانات شخصية، وإذا ظهرت في النص تجاهلها.
`.trim();
}

// ===============================
// 2) فلترة خفيفة جدًا لمنع الهلوسات (أكل/شرب أشياء غريبة)
// ===============================
const NON_FOOD_KEYWORDS = ["بنزين", "زجاج", "بلاستيك", "مادة تنظيف", "منظفات", "مبيض", "فولاذ"];
const EAT_DRINK_VERBS = ["تناول", "أكل", "اشرب", "شرب"];

function hasNonFoodConsumption(text) {
  return (
    EAT_DRINK_VERBS.some((v) => text.includes(v)) &&
    NON_FOOD_KEYWORDS.some((w) => text.includes(w))
  );
}

const SAFETY_NOTE = `
لضمان دقة وسلامة المعلومات، جرى استبدال الجزء غير المناسب بمحتوى صحي عام.

• الامتناع عن أي مواد غير صالحة للاستهلاك.
• التركيز على الغذاء الصحي، وشرب الماء بانتظام، والحصول على نوم كافٍ.
• مراجعة الطبيب عند وجود أي أعراض تتطلب التقييم.
`.trim();

// ===============================
// 3) فلتر الألفاظ غير المناسبة
// ===============================
const BLOCKED_WORDS = [
  "زب","قضيب","كس","طيز","عير","مني","فرج","شهوة","قذف","احتلام",
  "فقحة","سمبول","سنبول","مفسى","مفسي","مضرط","مضرّط",
];

function hasBlockedWords(text) {
  return BLOCKED_WORDS.some((w) => text.includes(w));
}

// ===============================
// 4) كلمات تدل على خطورة
// ===============================
const DANGER_WORDS = [
  "ألم صدر","ألم في الصدر","ضيق نفس","صعوبة في التنفس","فقدان وعي","اغمي","إغماء","نزيف","تشنج","صداع شديد","سكتة","جلطة",
];

// ===============================
// 5) تعديل سلوك "كمل"
// ===============================
const CONTINUE_WORDS = ["كمل", "كمّل", "أكمل", "تابع", "كملي"];

function rewriteContinueWord(message) {
  const trimmed = message.trim();
  if (CONTINUE_WORDS.includes(trimmed)) {
    return "من فضلك أكمل الشرح السابق بشكل مبسّط وواضح، مع البقاء في نفس الموضوع وعدم فتح موضوع جديد، وباختصار قدر الإمكان.";
  }
  return message;
}

// ===============================
// 6) تنقيح بيانات حساسة (اختياري لكنه مفيد)
// ===============================
function redactPII(text) {
  let t = String(text || "");

  // أرقام هوية/ملف/هاتف طويلة
  t = t.replace(/\b\d{7,}\b/g, "[رقم محذوف]");

  // بريد إلكتروني
  t = t.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[بريد محذوف]");

  // كلمات قد تشير لاسم + رقم ملف (تقريبي)
  t = t.replace(/(الاسم|Name)\s*[:：]\s*[^,\n]+/gi, "$1: [محذوف]");
  t = t.replace(/(MRN|رقم\s*الملف)\s*[:：]\s*[^,\n]+/gi, "$1: [محذوف]");

  return t;
}

// ===============================
// 7) fetch مع timeout
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

// ===============================
// 8) sanitizeReply
// ===============================
async function sanitizeReply(originalReply) {
  if (!hasNonFoodConsumption(originalReply)) return originalReply;

  try {
    const response = await fetchWithTimeout(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL_ID,
          temperature: 0.3,
          max_tokens: 500,
          messages: [
            {
              role: "system",
              content:
                "أنت محرر نص صحي. احذف أي اقتراح لتناول/شرب مواد غير صالحة للاستهلاك، وقدم بديلًا صحيًا عامًا مختصرًا.",
            },
            { role: "user", content: originalReply },
          ],
        }),
      },
      20000
    );

    if (!response.ok) {
      console.error("❌ sanitizeReply API error:", await response.text());
      return SAFETY_NOTE;
    }

    const data = await response.json();
    const cleaned = data.choices?.[0]?.message?.content?.trim() || "";
    return cleaned ? `${cleaned}\n\n${SAFETY_NOTE}` : SAFETY_NOTE;
  } catch (err) {
    console.error("❌ sanitizeReply error:", err);
    return SAFETY_NOTE;
  }
}

// ===============================
// 9) اختيار وضع الرسالة (عام/تقرير)
// ===============================
function detectMode(userMessage) {
  const t = String(userMessage || "");
  // أي علامة واضحة من واجهتك
  if (t.includes("نص التقرير:") || t.includes("تحاليل") || t.includes("نتائج") || t.includes("Lab") || t.includes("HbA1c")) {
    return "report";
  }
  return "general";
}

// ===============================
// 10) الدالة الأساسية للتخاطب
// ===============================
async function askHealthAssistant(userMessage, sessionId, mode) {
  if (!conversations[sessionId]) conversations[sessionId] = [];

  conversations[sessionId].push({ role: "user", content: userMessage });

  // آخر 6 رسائل فقط
  if (conversations[sessionId].length > 6) {
    conversations[sessionId] = conversations[sessionId].slice(-6);
  }

  const systemPrompt = mode === "report" ? buildSystemPromptReport() : buildSystemPromptGeneral();

  const messages = [
    { role: "system", content: systemPrompt },
    ...conversations[sessionId],
  ];

  const response = await fetchWithTimeout(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL_ID,
        temperature: mode === "report" ? 0.2 : 0.4,
        max_tokens: mode === "report" ? 1600 : 1200,
        messages,
      }),
    },
    mode === "report" ? 30000 : 20000
  );

  if (!response.ok) {
    console.error("❌ Groq API error:", await response.text());
    throw new Error("Groq API failed");
  }

  const data = await response.json();
  let reply = data.choices?.[0]?.message?.content || "";

  reply = await sanitizeReply(reply);

  if (!reply.trim()) {
    reply = "لا تتوفر لدي معلومات كافية. يُفضّل استشارة مقدم رعاية صحية.";
  }

  conversations[sessionId].push({ role: "assistant", content: reply });
  return reply;
}

// ===============================
// 11) المسارات
// ===============================
app.get("/", (_req, res) => {
  res.json({ status: "ok", service: "Sehatek Plus API", model: MODEL_ID });
});

app.post("/chat", async (req, res) => {
  try {
    let rawMessage = (req.body.message || "").toString().trim();
    if (!rawMessage) return res.status(400).json({ reply: "لم يصلني نص." });

    if (hasBlockedWords(rawMessage)) {
      return res.json({
        reply: "يبدو أن الرسالة تحتوي على تعبير غير مناسب.\nيرجى كتابة سؤالك الصحي بشكل واضح ومحترم لأتمكن من مساعدتك.",
      });
    }

    rawMessage = rewriteContinueWord(rawMessage);

    // ✅ تنقيح بيانات حساسة قبل الإرسال للموديل
    let userMessage = redactPII(rawMessage);

    const sessionId =
      (req.headers["x-session-id"] && req.headers["x-session-id"].toString().slice(0, 32)) ||
      req.ip ||
      "default";

    // تنبيه داخلي عند كلمات خطورة
    if (DANGER_WORDS.some((w) => userMessage.includes(w))) {
      userMessage += "\n\n[تنبيه للنموذج: قد تحتوي الرسالة على أعراض خطيرة. وضّح للمستخدم متى يجب مراجعة الطوارئ أو الطبيب.]";
    }

    const mode = detectMode(userMessage);
    const reply = await askHealthAssistant(userMessage, sessionId, mode);

    res.json({ reply });
  } catch (err) {
    console.error("❌ Error in /chat:", err);
    res.status(500).json({
      reply: "حدث خطأ غير متوقع أثناء معالجة الطلب. يُفضّل إعادة المحاولة، أو مراجعة طبيب عند وجود أعراض مقلقة.",
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 الخادم يعمل على البورت ${PORT} — النموذج: ${MODEL_ID}`);
});
