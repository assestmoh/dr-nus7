import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const app = express();

// قراءة المتغيرات من .env
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MODEL_ID = process.env.GROQ_MODEL || 'llama3-8b-8192';
const PORT = process.env.PORT || 3000;

if (!GROQ_API_KEY) {
  console.error('❌ لم يتم ضبط GROQ_API_KEY في ملف .env');
  process.exit(1);
}

// 📊 إحصائيات بسيطة في الذاكرة
const stats = {
  totalRequests: 0,
  totalUserMessages: 0,
  totalBotMessages: 0,
  totalTokens: 0,
  messages: []
};

app.use(express.json());
app.use(express.static('public'));

// مسار المحادثة مع البوت
app.post('/api/chat', async (req, res) => {
  const userMessage = (req.body.message || '').toString().trim();

  if (!userMessage) {
    return res.status(400).json({ reply: 'الرسالة فارغة.' });
  }

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL_ID,
        messages: [
          {
            role: 'system',
            content: `
أنت شات بوت للتثقيف الصحي لجميع الفئات (أطفال، بالغين، كبار سن، نساء، مرضى مزمنين).
وظيفتك:
- تقديم نصائح صحية عامة، ونمط حياة صحي، وتوعية عن التغذية والرياضة والنوم والصحة النفسية.
- شرح المفاهيم الطبية والتحاليل والأدوية بلغة عربية بسيطة وواضحة.
- عدم تقديم تشخيص طبي أو خطة علاج أو وصفة دواء مخصصة.
- عدم تحديد جرعات دوائية أبداً، بل توجيه المستخدم لمراجعة الطبيب.
- عند وجود أعراض مقلقة، وجّه المستخدم لمراجعة الطبيب أو الطوارئ مع ذكر بعض علامات الخطر.
- في نهاية كل رد، أضف جملة: "المعلومات للتثقيف الصحي فقط ولا تغني عن استشارة الطبيب."
اكتب إجاباتك بالعربية الفصحى البسيطة، وبنقاط مرتبة قدر الإمكان.
          `.trim()
          },
          {
            role: 'user',
            content: userMessage
          }
        ]
      })
    });

    if (!groqRes.ok) {
      const text = await groqRes.text();
      console.error('❌ خطأ من واجهة Groq:', groqRes.status, text);
      return res.status(500).json({ reply: 'حصل خطأ أثناء الاتصال بمحرك الذكاء الاصطناعي (Groq).' });
    }

    const data = await groqRes.json();

    const reply =
      data?.choices?.[0]?.message?.content ||
      'لم أستطع الحصول على رد مناسب حالياً. حاول مرة أخرى لاحقاً.';

    // 📊 تحديث الإحصائيات
    stats.totalRequests += 1;
    stats.totalUserMessages += 1;
    stats.totalBotMessages += 1;

    if (data?.usage?.total_tokens) {
      stats.totalTokens += data.usage.total_tokens;
    }

    stats.messages.push({
      time: new Date().toISOString(),
      question: userMessage,
      answer: reply
    });
    if (stats.messages.length > 50) {
      stats.messages.shift();
    }

    res.json({ reply });
  } catch (error) {
    console.error('❌ استثناء أثناء الاتصال بـ Groq:', error);
    res.status(500).json({ reply: 'حدث خطأ غير متوقع أثناء معالجة الطلب.' });
  }
});

// مسار الإحصائيات للـ Dashboard
app.get('/api/stats', (req, res) => {
  res.json({
    totalRequests: stats.totalRequests,
    totalUserMessages: stats.totalUserMessages,
    totalBotMessages: stats.totalBotMessages,
    totalTokens: stats.totalTokens,
    lastMessages: stats.messages.slice(-10).reverse()
  });
});

app.listen(PORT, () => {
  console.log(`✅ الخادم يعمل على http://localhost:${PORT}`);
});
