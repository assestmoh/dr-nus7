// server.js (ESM – متوافق مع "type": "module")

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';

const app = express();

// متغيرات البيئة (من Koyeb أو .env محلياً)
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MODEL_ID = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
const PORT = process.env.PORT || 3000;

if (!GROQ_API_KEY) {
  console.error('❌ GROQ_API_KEY غير مضبوط في متغيرات البيئة');
  process.exit(1);
}

// ميدل وير
app.use(cors());
app.use(bodyParser.json());

// دالة تكلم نموذج Groq بشخصية "صحتك بلس"
async function askSehatekPlus(userMessage) {
  const response = await fetch(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL_ID,
        temperature: 0.2,
        max_tokens: 400,
        messages: [
          {
            role: 'system',
            content: `
أنت "مساعد صحتك بلس" للتثقيف الصحي العام لجميع الفئات:
الأطفال، المراهقون، البالغون، الحوامل، وكبار السن.

اللغة والأسلوب:
- استخدم العربية الفصحى البسيطة والواضحة.
- تجنّب الترجمة الحرفية من الإنجليزية.
- تجنّب الأسلوب الطفولي أو كثرة الرموز التعبيرية.
- استخدم عبارات مهنية وهادئة مثل:
  "ننصح بـ"، "يفضّل"، "من المناسب أن"، "يمكنك الحرص على".
- اجعل الجمل قصيرة وواضحة، بدون حشو أو تكرار.

دورك:
- تقديم معلومات صحية عامة مبسّطة.
- شرح المفاهيم الطبية بلغة مفهومة للغير مختصين.
- التركيز على الوقاية، ونمط الحياة الصحي، والتنبيه على علامات الخطورة.
- لا تقوم بالتشخيص، ولا تعتبر نفسك بديلاً عن الطبيب.
- لا تصف أدوية، ولا تذكر جرعات، ولا تقترح تحاليل أو فحوصات محددة.

إطار الإجابة:
1) توضيح عام لما يمكن أن يعنيه عرض المستخدم من ناحية تثقيفية، بدون تشخيص محدد.
2) تقديم 2–4 نصائح عملية وآمنة في نمط الحياة (غذاء، نوم، حركة، سوائل، عادات صحية).
3) توضيح متى يُفضّل مراجعة عيادة عادية، ومتى يُنصح بالتوجّه للطوارئ إذا ظهرت علامات خطورة.
4) ختم كل إجابة بجملة:
   "هذه المعلومات للتثقيف الصحي فقط ولا تغني عن استشارة الطبيب أو مقدم الرعاية الصحية."

إذا كان السؤال خارج الصحة:
- قل بوضوح: "أنا مساعد للتثقيف الصحي فقط، ولا أستطيع الإجابة على هذا النوع من الأسئلة."
          `.trim(),
          },
          {
            role: 'user',
            content: userMessage,
          },
        ],
      }),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    console.error('Groq API error:', errText);
    throw new Error('Groq API request failed');
  }

  const data = await response.json();
  let reply =
    data.choices?.[0]?.message?.content || 'حدثت مشكلة في توليد الرد.';

  // تنظيف بعض التركيبات الغريبة المحتملة
  reply = reply
    .replace(/أكلات منظفات/g, 'أطعمة صحية وطازجة')
    .replace(/الأكلات المنظفات/g, 'الأطعمة الصحية والطازجة')
    .replace(/أطعمة منقوعة/g, 'أطعمة مقلية أو دسمة')
    .replace(/ادرس على/g, 'حاول أن تركّز على');

  if (!reply.trim()) {
    reply =
      'لا تتوفر لدي معلومات كافية للإجابة بدقة هنا. من الأفضل مناقشة حالتك مع طبيب أو مقدم رعاية صحية.';
  }

  return reply;
}

// مسار صحّة بسيط لفحص أن الباكند شغال
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Sehatek Plus backend' });
});

// مسار الـ API اللي تستدعيه صفحة HTML (BACKEND_URL)
app.post('/chat', async (req, res) => {
  const userMessage = (req.body.message || '').toString().trim();
  if (!userMessage) {
    return res.status(400).json({ reply: 'الرسالة فارغة.' });
  }

  try {
    const reply = await askSehatekPlus(userMessage);
    res.json({ reply });
  } catch (err) {
    console.error('❌ Error in /chat:', err);
    res.status(500).json({
      reply:
        'حدث خطأ في الخادم أثناء معالجة الطلب. يُفضّل المحاولة لاحقًا أو مراجعة طبيب عند القلق.',
    });
  }
});

// تشغيل الخادم
app.listen(PORT, () => {
  console.log(`✅ صحتك بلس backend يعمل على البورت ${PORT}`);
});
