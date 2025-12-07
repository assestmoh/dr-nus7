// server.js (ESM – متوافق مع "type": "module")

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';

const app = express();

// متغيرات البيئة
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

// ذاكرة محادثة بسيطة لكل جلسة
// المفتاح ممكن يكون IP أو x-session-id لاحقاً
const conversations = {};

// كلمات/تعابير تدل على خطورة أعلى
const DANGER_WORDS = [
  'ألم صدر',
  'الام الصدر',
  'ضيق نفس',
  'صعوبة في التنفس',
  'فقدان وعي',
  'اغمي علي',
  'نزيف',
  'ينزف',
  'اختناق',
  'تشنج',
  'صرع',
  'سكتة',
  'جلطة',
  'ألم شديد في البطن',
  'مغص شديد',
  'صداع قوي جدا',
  'صداع شديد',
];

// برومبت النظام الأساسي (تعليمات ثابتة للبوت)
function buildSystemPrompt() {
  return `
أنت "مساعد صحتك بلس" للتثقيف الصحي العام لجميع الفئات:
الأطفال، المراهقون، البالغون، الحوامل، النساء، وكبار السن.

اللغة والأسلوب:
- استخدم العربية الفصحى البسيطة والواضحة.
- تجنّب الترجمة الحرفية من الإنجليزية.
- تجنّب الأسلوب الطفولي أو كثرة الرموز التعبيرية.
- استخدم عبارات مهنية وهادئة مثل:
  "ننصح بـ"، "يفضّل"، "من المناسب أن"، "يمكنك الحرص على".
- اجعل الجمل قصيرة وواضحة، بدون حشو أو تكرار.

التعامل مع فئات مختلفة:
- إذا كان السؤال عن طفل أو يُذكر فيه (ابني / طفلي / بنتي): استخدم لغة مبسّطة موجّهة لولي الأمر، وركّز على علامات الخطورة عند الأطفال.
- إذا كان السؤال لامرأة أو عن حمل أو دورة أو ولادة: أضف فقرة قصيرة مناسبة لصحة المرأة مع التنبيه على المتابعة مع الطبيبة.
- إذا كان السؤال لمرض مزمن (سكري، ضغط، ربو، قلب): ركّز على نمط الحياة والمتابعة المنتظمة والأدوية كما يصفها الطبيب فقط، دون اقتراح اسم دواء أو جرعة.

دورك:
- تقديم معلومات صحية عامة مبسّطة.
- شرح المفاهيم الطبية بلغة مفهومة لغير المختصين.
- التركيز على الوقاية، ونمط الحياة الصحي، والتنبيه على علامات الخطورة.
- لا تقوم بالتشخيص، ولا تعتبر نفسك بديلاً عن الطبيب.
- لا تصف أدوية، ولا تذكر جرعات، ولا تقترح تحاليل أو فحوصات محددة بالاسم.

إطار الإجابة في كل رد:
1) فقرة قصيرة تشرح الفكرة أو العرض بشكل تثقيفي عام (بدون تشخيص محدد).
2) 2–4 نصائح عملية وآمنة في نمط الحياة (غذاء، نوم، حركة، سوائل، عادات صحية).
3) فقرة "متى أراجع الطبيب؟" توضّح متى يُفضّل مراجعة عيادة عادية.
4) فقرة "متى أذهب للطوارئ فورًا؟" في حال وجود أو ظهور علامات خطورة محتملة.
5) اختم دائمًا بالجملة:
   "هذه المعلومات للتثقيف الصحي فقط ولا تغني عن استشارة الطبيب أو مقدم الرعاية الصحية."

إذا كانت الرسالة تحتوي على تنبيه من الخادم بوجود عرض خطير:
- ارفع درجة التحذير، ووضّح بشكل صريح ضرورة التواصل مع الطوارئ عند الشك.

إذا كان السؤال خارج نطاق الصحة:
- قل بوضوح: "أنا مساعد للتثقيف الصحي فقط، ولا أستطيع الإجابة على هذا النوع من الأسئلة."
`.trim();
}

// دالة تستدعي نموذج Groq مع ذاكرة محادثة
async function askSehatekPlus(userMessage, sessionId = 'default') {
  // تهيئة المحادثة إن لم تكن موجودة
  if (!conversations[sessionId]) {
    conversations[sessionId] = [];
  }

  // إضافة رسالة المستخدم للمحادثة
  conversations[sessionId].push({ role: 'user', content: userMessage });

  // نحافظ فقط على آخر 10 رسائل (5 سؤال/جواب تقريباً)
  if (conversations[sessionId].length > 10) {
    conversations[sessionId] = conversations[sessionId].slice(-10);
  }

  const messages = [
    {
      role: 'system',
      content: buildSystemPrompt(),
    },
    ...conversations[sessionId],
  ];

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
        max_tokens: 500,
        messages,
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

  // إضافة رد المساعد إلى الذاكرة
  conversations[sessionId].push({ role: 'assistant', content: reply });

  // تقليم الذاكرة مرة أخرى احتياطاً
  if (conversations[sessionId].length > 10) {
    conversations[sessionId] = conversations[sessionId].slice(-10);
  }

  return reply;
}

// مسار صحّة بسيط لفحص أن الباكند شغال
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Sehatek Plus backend' });
});

// مسار الـ API اللي تستدعيه صفحة HTML
app.post('/chat', async (req, res) => {
  let userMessage = (req.body.message || '').toString().trim();

  if (!userMessage) {
    return res.status(400).json({ reply: 'الرسالة فارغة.' });
  }

  // تحديد sessionId بسيط (يمكن تطويره لاحقاً)
  const sessionId =
    (req.headers['x-session-id'] &&
      req.headers['x-session-id'].toString().slice(0, 64)) ||
    req.ip ||
    'default';

  // فحص كلمات تدل على خطورة
  const hasDangerWord = DANGER_WORDS.some((w) => userMessage.includes(w));

  if (hasDangerWord) {
    userMessage = `
تنبيه من النظام: تحتوي رسالة المستخدم على عرض قد يكون ذا خطورة محتملة (مثل ألم شديد أو ضيق نفس أو نزيف أو فقدان وعي).
تعامل مع الحالة بحذر، واشرح للمستخدم بشكل واضح متى يجب التوجه فورًا إلى قسم الطوارئ.

نص المستخدم:
${userMessage}
`.trim();
  }

  try {
    const reply = await askSehatekPlus(userMessage, sessionId);
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
