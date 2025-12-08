// server.js (ESM – متوافق مع "type": "module")

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';

const app = express();

// متغيرات البيئة
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MODEL_ID = process.env.GROQ_MODEL || 'llama-3.1-70b';
const PORT = process.env.PORT || 3000;

if (!GROQ_API_KEY) {
  console.error('❌ GROQ_API_KEY غير مضبوط في متغيرات البيئة');
  process.exit(1);
}

// ميدل وير
app.use(cors());
app.use(bodyParser.json());

// ذاكرة محادثة بسيطة لكل جلسة
const conversations = {};

// كلمات/تعابير تدل على خطورة أعلى (طوارئ محتملة)
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

// عبارات/كلمات غير صالحة للأكل نمنع ظهورها
const BANNED_NONFOOD = [
  'فولاذ',
  'حديد',
  'حاسوب',
  'كمبيوتر',
  'بنزين',
  'منظفات',
  'بلاستيك',
  'زجاج',
  'معادن',
];

// عبارات عن "أوراق الفواكه" / "كل الأوراق"
const BANNED_LEAF = [
  'أوراق الفواكه',
  'كل أوراق الفواكه',
  'أكل أوراق الفواكه',
  'أكل كل الأوراق',
  'كل الأوراق',
];

// برومبت النظام الأساسي: واضح + مختصر
function buildSystemPrompt() {
  return `
أنت مساعد صحي متخصص في التثقيف الصحي، وتقدّم معلومات دقيقة وواضحة باللغة العربية الفصحى السهلة.

الأسلوب:
- أجب بإيجاز دون إهمال النقاط المهمة (تقريبًا من 4 إلى 8 أسطر).
- تجنّب التكرار والإنشاء الزائد، وابتعد عن العبارات الغريبة أو المترجمة حرفيًا.
- استخدم نبرة إنسانية احترافية تشبه كلام موظف صحي خبير.
- نظّم الرد بنقاط عند الحاجة، لكن دون مبالغة في العناوين.

السلامة الطبية:
- لا تعطي تشخيصًا طبيًا نهائيًا.
- لا تذكر أسماء أدوية أو جرعات، ولا تطلب فحوصات محددة بالاسم.
- ركّز على نمط الحياة الصحي، والوقاية، وعلامات الخطورة، ومتى يفضَّل مراجعة الطبيب.

السلامة الغذائية:
- لا تقترح تناول أو شرب مواد غير صالحة للأكل (مثل المعادن، الزجاج، البلاستيك، البنزين، الأجهزة الإلكترونية، المنظفات).
- لا تنصح بتناول "كل الأوراق" أو "أوراق جميع الفواكه" أو "أوراق الأشجار" بشكل عام.
- ركّز فقط على أطعمة طبيعية معروفة: الخضروات، الفواكه، الحبوب الكاملة، البروتينات الطبيعية، الماء، الحليب.

الفئات:
- إذا كان السؤال عن طفل (ابني، طفلي، بنتي...): خاطِب ولي الأمر بلغة مبسطة، واذكر علامات الخطورة عند الأطفال بهدوء.
- إذا كان السؤال عن الحمل أو الدورة أو الولادة أو صحة المرأة: راعِ خصوصية صحة المرأة، واذكر متى يفضَّل مراجعة الطبيبة.

الخطورة:
- إذا ظهرت أعراض خطيرة (ألم صدر شديد، ضيق نفس واضح، نزيف، فقدان وعي...)، وضّح بهدوء أنها قد تستدعي الذهاب إلى قسم الطوارئ فورًا.

التذكير:
- في آخر سطر من كل رد، أضِف تذكيرًا بسيطًا بأن هذه المعلومات للتثقيف الصحي فقط ولا تغني عن استشارة الطبيب أو مقدم الرعاية الصحية.
`.trim();
}

// استدعاء نموذج Groq مع ذاكرة محادثة
async function askSehatekPlus(userMessage, sessionId = 'default') {
  if (!conversations[sessionId]) {
    conversations[sessionId] = [];
  }

  // إضافة رسالة المستخدم
  conversations[sessionId].push({ role: 'user', content: userMessage });

  // الاحتفاظ بآخر 10 رسائل فقط
  if (conversations[sessionId].length > 10) {
    conversations[sessionId] = conversations[sessionId].slice(-10);
  }

  const messages = [
    { role: 'system', content: buildSystemPrompt() },
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
        temperature: 0.3,     // توازن بين الثبات وعدم الهلوسة
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

  // تنظيف بعض التركيبات العربية الغريبة
  reply = reply
    .replace(/أكلات منظفات/g, 'أطعمة صحية وطازجة')
    .replace(/الأكلات المنظفات/g, 'الأطعمة الصحية والطازجة')
    .replace(/أطعمة منقوعة/g, 'أطعمة مقلية أو دسمة')
    .replace(/ادرس على/g, 'حاول أن تركّز على');

  // فلتر 1: منع ذكر مواد غير صالحة للأكل
  if (BANNED_NONFOOD.some((w) => reply.includes(w))) {
    reply = `
تم تجاهل جزء غير منطقي في الاقتراح يتضمن مواد غير صالحة للأكل.

من أجل تغذية صحية بشكل عام يُنصَح بـ:
• الاعتماد على الخضروات والفواكه الطازجة.
• اختيار الحبوب الكاملة مثل الشوفان والخبز الأسمر.
• تناول بروتينات صحية مثل السمك، الدجاج، البقوليات، والبيض (بحسب ما يناسب حالة الشخص الصحية).
• شرب الماء بانتظام والحد من المشروبات الغازية والمحلاة.

هذه المعلومات للتثقيف الصحي فقط ولا تغني عن استشارة الطبيب أو مقدم الرعاية الصحية.
    `.trim();
  }

  // فلتر 2: "أوراق الفواكه" / "كل الأوراق"
  if (BANNED_LEAF.some((w) => reply.includes(w))) {
    reply = `
لا يُنصَح بتناول "كل أوراق الفواكه" أو أوراق النباتات بشكل عام؛ 
بعض الأوراق قد تُستخدم في وصفات معروفة مثل بعض الأعشاب أو ورق العنب، 
لكن تعميم أكل الأوراق قد يكون غير مناسب للجهاز الهضمي، وقد يسبّب مشكلات صحية.

الأفضل التركيز على:
• ثمرة الفاكهة نفسها مع القشرة الصالحة للأكل عندما تكون آمنة ونظيفة.
• الخضروات المعروفة التي تُستخدم في الطعام بشكل شائع.
• التنويع بين الفواكه والخضروات والحبوب الكاملة والبروتينات الصحية.

هذه المعلومات للتثقيف الصحي فقط ولا تغني عن استشارة الطبيب أو مقدم الرعاية الصحية.
    `.trim();
  }

  if (!reply.trim()) {
    reply =
      'لا تتوفر لدي معلومات كافية للإجابة بدقة هنا. من الأفضل مناقشة حالتك مع طبيب أو مقدم رعاية صحية.';
  }

  // حفظ رد المساعد
  conversations[sessionId].push({ role: 'assistant', content: reply });

  if (conversations[sessionId].length > 10) {
    conversations[sessionId] = conversations[sessionId].slice(-10);
  }

  return reply;
}

// مسار صحّة بسيط لفحص أن الباكند شغال
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Sehatek Plus backend' });
});

// مسار الـ API الذي تستدعيه صفحة HTML
app.post('/chat', async (req, res) => {
  let userMessage = (req.body.message || '').toString().trim();

  if (!userMessage) {
    return res.status(400).json({ reply: 'الرسالة فارغة.' });
  }

  // sessionId بسيط (يمكن تطويره لاحقًا بحساب مستخدم)
  const sessionId =
    (req.headers['x-session-id'] &&
      req.headers['x-session-id'].toString().slice(0, 64)) ||
    req.ip ||
    'default';

  // فحص كلمات تدل على خطورة
  const hasDangerWord = DANGER_WORDS.some((w) => userMessage.includes(w));

  if (hasDangerWord) {
    userMessage += `
    
[ملاحظة للنموذج: قد تتضمن هذه الرسالة عرضًا ذا خطورة محتملة،
رجاءً ركّز في الإجابة على توضيح متى يجب مراجعة الطبيب، ومتى قد يكون من الضروري التوجّه إلى قسم الطوارئ فورًا.]`;
  }

  try {
    const reply = await askSehatekPlus(userMessage, sessionId);
    res.json({ reply });
  } catch (err) {
    console.error('❌ Error in /chat:', err);
    res.status(500).json({
      reply:
        'حدث خطأ في الخادم أثناء معالجة الطلب. يُفضّل المحاولة لاحقًا، ولا تهمل مراجعة الطبيب إذا كانت حالتك مقلقة.',
    });
  }
});

// تشغيل الخادم
app.listen(PORT, () => {
  console.log(`✅ صحتك بلس backend يعمل على البورت ${PORT}`);
});
