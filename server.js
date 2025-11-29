// backend/server.js
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

const GROQ_API_KEY = process.env.GROQ_API_KEY;

// دالة تكلم نموذج Groq بشخصية الدكتور نُصح
async function askDoctorNus7(userMessage) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "llama-3.1-8b-instant", // غيّريها لو عندكم موديل ثاني مفضّل في Groq
      messages: [
        {
          role: "system",
          content:
            "أنت دكتور نُصح، مساعد طبي افتراضي للتثقيف الصحي فقط، لا تشخّص الحالات ولا تصف أدوية ولا تطلب تحاليل، تقدم معلومات صحية عامة بسيطة وتطلب من المستخدم مراجعة الطبيب أو الطوارئ في الحالات الخطيرة. مهمتك الاجابة عن الاسئلة التي تتعلق بالصحة و نمط الحياة الصحي و العادات الوقائية يمنع منعا باتاً الاجابة عن اي سؤال خارج المجال الصحي مثل الدين والسياسة والبرمجة اذا سُئلت عن اي شي خارج الصحة رد دائما برسالة قصيره انا متخصص في التثقيف الصحي فقط اسئلني عن موضوع صحي وسوف اساعدك . أجب بجمل قصيرة وواضحة باللهجة العمانيه و بالعربية.",
        },
        {
          role: "user",
          content: userMessage,
        },
      ],
      temperature: 0.4,
      max_tokens: 512,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error("Groq API error:", errText);
    throw new Error("Groq API request failed");
  }

  const data = await response.json();
  const reply = data.choices?.[0]?.message?.content || "حصلت مشكلة في توليد الرد.";
  return reply;
}

// endpoint تستدعيه الواجهة
app.post("/chat", async (req, res) => {
  try {
    const userMessage = req.body.message || "";
    if (!userMessage.trim()) {
      return res.json({
        reply: "اكتب سؤالك الصحي عشان أقدر أساعدك 🌿",
      });
    }

    const aiReply = await askDoctorNus7(userMessage);
    res.json({ reply: aiReply });
  } catch (err) {
    console.error("AI Error:", err);
    res.status(500).json({
      reply:
        "صار خطأ في الخادم أو في خدمة الذكاء الاصطناعي. جرّب بعد قليل، ولا تعتمد عليّ لو حالتك طارئة.",
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Doctor Nus7 backend (Groq) running on port " + PORT);
});
