// ===============================
//  server.js — نسخة نظيفة للمستشفيات مع فلترة خفيفة + تعديل "كمل" + ضبط طول الإجابات
// ===============================

import "dotenv/config";
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fetch from "node-fetch";

const app = express();

// متغيرات البيئة
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MODEL_ID = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const PORT = process.env.PORT || 3000;

if (!GROQ_API_KEY) {
  console.error("❌ GROQ_API_KEY غير مضبوط");
  process.exit(1);
}

app.use(cors());
app.use(bodyParser.json());

// ذاكرة محادثة لكل مستخدم
const conversations = {};

// ===============================
// 1) System Prompt — قصير واحترافي ومختصر
// ===============================
function buildSystemPrompt() {
  return `
أنت مساعد صحي للتثقيف الصحي فقط.
قدّم معلومات عامة عن الصحة ونمط الحياة، بأسلوب عربي مهني واضح ومختصر.
تجنّب التشخيص الطبي، وصف الأدوية، أو إعطاء جرعات محددة.
لا تقدّم خطط علاجية مفصلة أو تفسيرًا دقيقًا لنتائج الفحوصات.
اجعل الإجابة عادة بين 6 و12 سطرًا تقريبًا، مع تنظيم بسيط بنقاط أو عناوين فرعية، وبدون جداول طويلة إلا عند الحاجة القليلة.
يمكنك ذكر متى يفضَّل مراجعة الطبيب أو الطوارئ عند وجود أعراض خطيرة.
  `.trim();
}

// ===============================
// 2) فلترة خفيفة جدًا لمنع الهلوسات (أكل/شرب أشياء غريبة)
// ===============================
const NON_FOOD_KEYWORDS = [
  "بنزين",
  "زجاج",
  "بلاستيك",
  "مادة تنظيف",
  "منظفات",
  "مبيض",
  "فولاذ",
];

const EAT_DRINK_VERBS = ["تناول", "أكل", "اشرب", "شرب"];

function hasNonFoodConsumption(text) {
  return (
    EAT_DRINK_VERBS.some((v) => text.includes(v)) &&
    NON_FOOD_KEYWORDS.some((w) => text.includes(w))
  );
}

// الرسالة التي اخترتيها تُضاف في النهاية عند الحاجة
const SAFETY_NOTE = `
لضمان دقة وسلامة المعلومات، جرى استبدال الجزء غير المناسب بمحتوى صحي عام.

• الامتناع عن أي مواد غير صالحة للاستهلاك.
• التركيز على الغذاء الصحي، وشرب الماء بانتظام، والحصول على نوم كافٍ.
• مراجعة الطبيب عند وجود أي أعراض تتطلب التقييم.
`.trim();

// دالة تنقيح الرد عند وجود اقتراح غير منطقي
async function sanitizeReply(originalReply) {
  if (!hasNonFoodConsumption(originalReply)) {
    return originalReply;
  }

  try {
    const response = await fetch(
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
                "أنت محرر نص صحي. أعد صياغة النص التالي بحذف أي اقتراح لتناول أو شرب مواد غير صالحة للاستهلاك مثل البنزين أو الزجاج أو البلاستيك، وركّز على نصائح صحية عامة فقط، وبأسلوب مختصر وواضح.",
            },
            {
              role: "user",
              content: originalReply,
            },
          ],
        }),
      }
    );

    if (!response.ok) {
      console.error("❌ sanitizeReply API error:", await response.text());
      return SAFETY_NOTE;
    }

    const data = await response.json();
    let cleaned = data.choices?.[0]?.message?.content?.trim() || "";

    if (!cleaned) {
      return SAFETY_NOTE;
    }

    // نضيف ملاحظة السلامة في النهاية
    return `${cleaned}\n\n${SAFETY_NOTE}`;
  } catch (err) {
    console.error("❌ sanitizeReply error:", err);
    return SAFETY_NOTE;
  }
}

// ===============================
// 3) فلتر الألفاظ غير المناسبة
// ===============================
const BLOCKED_WORDS = [
  "زب",
  "قضيب",
  "كس",
  "طيز",
  "عير",
  "مني",
  "فرج",
  "شهوة",
  "قذف",
  "احتلام",

  // الكلمات التي طلبتِ إضافتها
  "فقحة",
  "سمبول",
  "سنبول",
  "مفسى",
  "مفسي",
  "مضرط",
  "مضرّط",
];

function hasBlockedWords(text) {
  return BLOCKED_WORDS.some((w) => text.includes(w));
}

// ===============================
// 4) كلمات تدل على خطورة (للتنبيه الداخلي فقط)
// ===============================
const DANGER_WORDS = [
  "ألم صدر",
  "ألم في الصدر",
  "ضيق نفس",
  "صعوبة في التنفس",
  "فقدان وعي",
  "اغمي",
  "إغماء",
  "نزيف",
  "تشنج",
  "صداع شديد",
  "سكتة",
  "جلطة",
];

// ===============================
// 5) تعديل سلوك "كمل" وما يشبهها
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
// 6) الدالة الأساسية للتخاطب مع Groq API
// ===============================
async function askHealthAssistant(userMessage, sessionId) {
  if (!conversations[sessionId]) {
    conversations[sessionId] = [];
  }

  conversations[sessionId].push({ role: "user", content: userMessage });

  // نحتفظ بآخر 6 رسائل فقط لتقليل طول السياق
  if (conversations[sessionId].length > 6) {
    conversations[sessionId] = conversations[sessionId].slice(-6);
  }

  const messages = [
    { role: "system", content: buildSystemPrompt() },
    ...conversations[sessionId],
  ];

  const response = await fetch(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL_ID,
        temperature: 0.4,
        max_tokens: 1200, // السماح بإجابات أطول
        messages,
      }),
    }
  );

  if (!response.ok) {
    console.error("❌ Groq API error:", await response.text());
    throw new Error("Groq API failed");
  }

  const data = await response.json();
  let reply = data.choices?.[0]?.message?.content || "";

  // تنقيح الرد عند وجود اقتراح غريب
  reply = await sanitizeReply(reply);

  if (!reply.trim()) {
    reply =
      "لا تتوفر لدي معلومات كافية حول هذا السؤال، ويُفضل استشارة مقدم رعاية صحية.";
  }

  conversations[sessionId].push({ role: "assistant", content: reply });

  return reply;
}

// ===============================
// 7) المسارات
// ===============================
app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "Sehatek Plus API",
    model: MODEL_ID,
  });
});

app.post("/chat", async (req, res) => {
  try {
    let rawMessage = (req.body.message || "").toString().trim();
    if (!rawMessage) {
      return res.status(400).json({ reply: "لم يصلني نص." });
    }

    // فلتر الألفاظ غير المناسبة أولاً
    if (hasBlockedWords(rawMessage)) {
      return res.json({
        reply:
          "يبدو أن الرسالة تحتوي على تعبير غير مناسب.\nيرجى كتابة سؤالك الصحي بشكل واضح ومحترم لأتمكن من مساعدتك.",
      });
    }

    // تعديل "كمل" وما يشبهها إلى طلب استمرار واضح للموديل
    let userMessage = rewriteContinueWord(rawMessage);

    const sessionId =
      (req.headers["x-session-id"] &&
        req.headers["x-session-id"].toString().slice(0, 32)) ||
      req.ip ||
      "default";

    // تنبيه داخلي للموديل عند وجود كلمات خطورة (لا يظهر للمستخدم)
    if (DANGER_WORDS.some((w) => userMessage.includes(w))) {
      userMessage +=
        "\n\n[تنبيه للنموذج: قد تحتوي الرسالة على أعراض خطيرة. وضّح للمستخدم متى يجب مراجعة الطوارئ أو الطبيب.]";
    }

    const reply = await askHealthAssistant(userMessage, sessionId);

    res.json({ reply });
  } catch (err) {
    console.error("❌ Error in /chat:", err);
    res.status(500).json({
      reply:
        "حدث خطأ غير متوقع أثناء معالجة الطلب. يُفضّل إعادة المحاولة، أو مراجعة طبيب عند وجود أعراض مقلقة.",
    });
  }
});

// ===============================
// 8) تشغيل الخادم
// ===============================
app.listen(PORT, () => {
  console.log(
    `🚀 الخادم يعمل على البورت ${PORT}  — النموذج: ${MODEL_ID}`
  );
});
