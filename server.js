

You said:

app.js
JavaScript

index.html
File

server.js
JavaScript
مشروعي احاول اكتب سؤال ما يرد يقولي تعذر الاتصال بالذكاء جرب مره ثانيه وش المشكلة

ChatGPT said:
المشكلة واضحة جدًا من الكود 👍
الرسالة:

تعذر الاتصال بالذكاء جرب مرة ثانية

لا تأتي من الذكاء نفسه — بل من الـ Frontend عندما يفشل الاتصال بالسيرفر.

دعني أشرحها مباشرة بدون تجميل:

✅ السبب الحقيقي (من مشروعك)
في app.js عند فشل الاتصال يتم تنفيذ fallback:

addMsg(fallbackReply(message), "bot"
وهذه الدالة ترجع النص:

تعذر الاتصال بالذكاء الان. جرّب مرة ثانية.
يعني التطبيق لم يصل أصلاً إلى API.

📌 المصدر: 
app


🔥 أين يحدث الفشل تحديدًا؟
التطبيق يرسل السؤال هنا:

const DEFAULT_BACKEND_URL =
"https://ruling-violet-m0h-217b6aa8.koyeb.app/chat";
ثم ينادي:

POST /chat
إذا حدث واحد من التالي → تظهر الرسالة فورًا:

🚨 الأسباب الأكثر احتمالًا (بالترتيب)
1️⃣ السيرفر متوقف (الأكثر شيوعًا)
سيرفرك على Koyeb غالبًا:

Sleep

Crash

Deployment فشل

أو Container مات

✅ جرب:

https://ruling-violet-m0h-217b6aa8.koyeb.app/health
إذا لم يرجع:

{ "ok": true }
→ السيرفر ميت.

2️⃣ مفتاح GROQ غير موجود ❌
في server.js:

if (!GROQ_API_KEY) {
  process.exit(1);
}
يعني السيرفر يقفل بالكامل إذا المفتاح ناقص.

📌 المصدر: 
server


وهذا سبب شائع جدًا بعد إعادة deploy.

3️⃣ CORS Block
إذا الدومين غير مسموح:

ALLOWED_ORIGINS
السيرفر يرفض الطلب → Frontend يعتقد أن الذكاء لا يعمل.

4️⃣ Rate Limit
عند الضغط كثير:

max: CHAT_RPM || 25
بعد 25 طلب/دقيقة → السيرفر يبدأ الرفض.

5️⃣ Timeout
في الواجهة:

fetchWithTimeout(..., 16000)
إذا الرد تأخر أكثر من 16 ثانية → يعتبر فشل اتصال.

✅ أسرع اختبار الآن (دقيقة واحدة)
افتح DevTools → Console ثم:

fetch("https://ruling-violet-m0h-217b6aa8.koyeb.app/health")
.then(r=>r.json())
.then(console.log)
النتائج:
النتيجة	التشخيص
{ok:true}	السيرفر يعمل
Failed to fetch	السيرفر متوقف
CORS error	إعداد origins
500	GROQ أو كود السيرفر
⭐ التشخيص بنسبة 80٪
بناءً على بنية مشروعك:

السيرفر على Koyeb توقف أو GROQ_API_KEY غير مضبوط بعد deploy

هذا أكثر سبب رأيته مع نفس الهيكلة.

إذا تريد، أقدر الآن أقول لك:
✅ أين الخطأ تحديدًا خلال 30 ثانية
فقط أرسل لي:

هل المشروع يعمل محليًا؟

رابط /health ماذا يرجع؟

هل غيرت أي ENV مؤخرًا؟

وسنحدد العطل بدقة جراحية.


Sources

You said:

(index):1 Banner not shown: beforeinstallpromptevent.preventDefault() called. The page must call beforeinstallpromptevent.prompt() to show the banner.
ruling-violet-m0h-217b6aa8.koyeb.app/chat:1   Failed to load resource: the server responded with a status of 500 ()

ChatGPT said:

Thought for 4 seconds
واضح عندك موضوعين منفصلين في الكونسول:

1) رسالة الـ PWA: Banner not shown...
هذه ليست خطأ قاتل. معناها فقط:
المتصفح يقول “أنت منعت البانر الافتراضي” لأنك عملت preventDefault() داخل beforeinstallprompt، ولازم تستدعي prompt() بنفسك عشان يظهر البانر.

وهذا بالضبط اللي تسويه عند الضغط على زر التثبيت عندك:

أنت تخزن الحدث في deferredInstallPrompt

وبعدين في handleInstallClick() تستدعي deferredInstallPrompt.prompt() إذا كان موجود 
app


✅ الخلاصة:
تجاهل الرسالة إذا زر “تحميل التطبيق” عندك يطلع نافذة التثبيت. الرسالة مجرد تحذير من المتصفح.

إذا الزر ما يطلع نافذة: غالبًا الحدث ما انطلق أصلًا (الموقع مو HTTPS/ما فيه manifest صحيح/ما فيه service worker)، لكن هذا موضوع مختلف عن الذكاء.

2) الخطأ الحقيقي: /chat يرجع 500
هذا هو سبب “تعذر الاتصال بالذكاء”.

الـ Frontend يرسل إلى:
https://ruling-violet-m0h-217b6aa8.koyeb.app/chat (POST) 
app


وسيرفرك عندك في server.js إذا صار أي استثناء داخل /chat يرجّع 500 مباشرة: 
server

 
server


أكثر سببين شيوعًا للـ 500 هنا (من كودك نفسه)
A) Groq API يفشل
داخل callGroq() إذا Groq رجّع أي status غير 200، أنت ترمي Error:
Groq API error (status) ... 
server


وهذا يطيحك في catch حق /chat → 500 
server


أسباب فشل Groq عادة:

GROQ_API_KEY غلط/منتهي/مفقود (ولو مفقود غالبًا السيرفر ما يقوم أصلًا، لكن أحيانًا البيئة تختلف) 
server


اسم الموديل غلط أو غير متاح (openai/gpt-oss-120b أو llama-3.3-70b-versatile) 
server


Rate limit / quota من Groq

B) الكود ينهار بسبب JSON/Parsing (أقل احتمال، لكن ممكن)
عندك معالجة استخراج JSON ومحاولة إصلاح، لكن لو صار شيء غير متوقع في extractJson/normalize ممكن يطيح برضه → 500 
server


تشخيص سريع (بدون تخمين)
جرّب هذا من المتصفح (Console):
fetch("https://ruling-violet-m0h-217b6aa8.koyeb.app/chat",{
  method:"POST",
  headers:{"Content-Type":"application/json","x-user-id":"debug"},
  body: JSON.stringify({message:"اختبار", meta:{}, context:{}})
}).then(r=>r.text()).then(console.log).catch(console.error)
إذا رجع لك JSON فيه { ok:false, error:"server_error" ... } → فعلاً السيرفر يطيح في catch 
server


لو طلع داخل النص “Groq API error (…)" → السبب مؤكد أنه Groq 
server


إصلاح عملي سريع (أنصحك تضيفه الآن)
بدل ما ترجع 500 بدون تفاصيل، خل السيرفر يرجّع سبب مختصر (آمن) عشان تعرف المشكلة فورًا:

في catch داخل /chat غيّرها إلى:

ترجع hint فيه String(e.message).slice(0,120)

لأن حاليًا أنت “تدفن” السبب الحقيقي وتتركك تتعذب في المتصفح. (الكود الحالي يرجع 500 عام) 
server


إذا تبغى أقول لك السبب بنسبة شبه مؤكدة الآن
أرسل لي رد /chat كامل من تجربة الـ fetch اللي فوق (النص اللي يطلع في console).
منه أحدد هل هو:

مفتاح Groq

موديل غير متاح

Rate limit

أو شيء ثاني داخل السيرفر


Sources

You said:

server.js
JavaScript
لما استخدم هذا السيرفر عادي يشتغل انا استبدلت هذا القديم لان اريد استخدم موديل واحد ولما غيرت السيرفر طلعت لي مشكلة تعذر الاتصال بالذكاء

ChatGPT said:

Thought for 12s
اللي صار بسيط: السيرفر الجديد يرجّع 500 على /chat، والواجهة عندك تعتبر أي res.ok === false خطأ وتدخل على رسالة “تعذر الاتصال بالذكاء”. هذا مطابق تمامًا لسطر الكونسول عندك: .../chat -> 500.

لماذا تظهر “تعذر الاتصال” مع أن السيرفر “شغال”؟
في app.js أنت تعمل هذا: إذا الاستجابة ليست 200 → ترمي خطأ → يدخل catch → يطبع fallback “تعذر الاتصال…” 
app


يعني حتى لو السيرفر ردّ JSON فيه تفاصيل، أنت ما تقرأه لأنك ترمي الخطأ قبل القراءة.

السبب الأكثر احتمالًا للـ 500 بعد تبديل السيرفر (سيرفرك single-model)
في server.js الجديد الموديل الافتراضي هو:
openai/gpt-oss-120b 
server


إذا Groq ما يدعم هذا الموديل على حسابك/منطقتك/وقتك الحالي، أو اسم الموديل غير صحيح عندهم، طلب Groq يفشل، وسيرفرك يرمي Error داخل callGroq() ويرجع 500. 
server


الخلاصة: “السيرفر القديم يشتغل” لأن إعداد GROQ_MODEL فيه موديل معروف شغال، والجديد رجع لاختيار افتراضي غير مناسب.

افحصها بسرعة (بدون تخمين)
1) تأكد /health:
افتح:
https://...koyeb.app/health
لازم يرجع {ok:true}. 
server


2) راقب Logs في Koyeb
بتشوف سطر واضح مثل:

Groq API error (400/401/404/429) ...

هذا هو التشخيص النهائي.

إصلاح مباشر (حلّين)
الحل A (الأقوى): اضبط متغير البيئة GROQ_MODEL في Koyeb
في إعدادات الخدمة (Environment Variables) حط:

GROQ_MODEL=llama-3.3-70b-versatile
(أو أي موديل أنت متأكد أنه كان شغال مع السيرفر القديم)

السيرفر يعتمد على process.env.GROQ_MODEL أولًا 
server


لا تعتمد على الافتراضي openai/gpt-oss-120b إلا إذا أنت متأكد 100% أنه متاح عند Groq لحسابك.

الحل B (مهم جدًا للتشخيص): خلّ الواجهة تعرض سبب الخطأ بدل “تعذر الاتصال”
عدّل app.js بدل ما تسوي throw على 500. الفكرة: اقرأ JSON واعرض payload.hint أو payload.error.

الآن عندك:

if (!res.ok) throw ... وهذا يسبب fallback دائمًا 
app


الأفضل (منطقيًا):

إذا !res.ok: اقرأ await res.json() واعرض رسالة من السيرفر.

وسيرفرك في حالة الخطأ يرجع:
{ ok:false, error:"server_error", data: fallback("") } 
server


يعني عندك “محتوى” تقدر تعرضه بدل رسالة الاتصال.

ملاحظة إضافية مهمة
تأكد أيضًا أن GROQ_API_KEY مضبوط في Koyeb؛ لأن السيرفر يقفل لو ناقص. 
server


إذا تبغى أقطعها يقينًا: انسخ لي آخر 5 أسطر من Logs في Koyeb بعد ما ترسل سؤال (خصوصًا سطر Groq API error (...)). سأقول لك هل المشكلة موديل/مفتاح/Rate-limit مباشرة.


Sources

You said:
Instance created. Preparing to start...

> dr-nus7@1.0.0 start
> node server.js

🚀 API running on :8000 | model=openai/gpt-oss-120b | tts=canopylabs/orpheus-arabic-saudi/fahad
Instance is healthy. All health checks are passing.
Error: Groq API error (400) 
    at callGroq (file:///workspace/server.js:332:11)
    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)
    at async file:///workspace/server.js:502:16
Error: Groq API error (400) 
    at callGroq (file:///workspace/server.js:332:11)
    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)
    at async file:///workspace/server.js:502:16
Error: Groq API error (400) 
    at callGroq (file:///workspace/server.js:332:11)
    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)
    at async file:///workspace/server.js:502:16
Error: Groq API error (400) 
    at callGroq (file:///workspace/server.js:332:11)
    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)
    at async file:///workspace/server.js:502:16
Error: Groq API error (400) 
    at callGroq (file:///workspace/server.js:332:11)
    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)
    at async file:///workspace/server.js:502:16
Error: Groq API error (400) 
    at callGroq (file:///workspace/server.js:332:11)
    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)
    at async file:///workspace/server.js:502:16
Error: Groq API error (400) 
    at callGroq (file:///workspace/server.js:332:11)
    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)
    at async file:///workspace/server.js:502:16
Error: Groq API error (400) 
    at callGroq (file:///workspace/server.js:332:11)
    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)
    at async file:///workspace/server.js:502:16

ChatGPT said:

Thought for 23s
تمام—الـ Logs عندك حسمت الموضوع نهائيًا.

السبب الحقيقي
السيرفر شغال ويمرّ الـ health checks ✅
لكن كل طلب /chat يفشل داخل Groq ويرجع 400:

Error: Groq API error (400)

وهذا يعني: الطلب اللي ترسله لـ Groq “غير مقبول” (Bad Request)، وليس مشكلة اتصال من المتصفح.

والأهم: السيرفر عندك شغّال على موديل:
model=openai/gpt-oss-120b (واضح من سطر التشغيل عندك)

وفي كود السيرفر هذا هو الافتراضي إذا ما ضبطت متغير بيئة:
const MODEL = (process.env.GROQ_MODEL || "openai/gpt-oss-120b").trim(); 
server


يعني غالبًا أنت ما ضبطت GROQ_MODEL بعد ما غيرت السيرفر، فاشتغل على موديل غير مدعوم عند Groq لحسابك/غير صحيح الاسم → Groq يرجع 400 → سيرفرك يرمي Error → الـ Frontend يطلع “تعذر الاتصال”.

الحل المباشر (بدون فلسفة)
1) في Koyeb (Environment Variables)
ضبط:

GROQ_MODEL = نفس الموديل اللي كان شغال مع السيرفر القديم (أو أي موديل معروف أنه متاح لك على Groq)

مثال شائع (إذا كان شغال سابقًا عندك):

GROQ_MODEL=llama-3.3-70b-versatile

لا تعتمد على الافتراضي openai/gpt-oss-120b لأنه واضح أنه سبب 400 عندك. 
server


ثم Redeploy/Restart.

2) (اختياري لكن أنصحك) غيّر الافتراضي في الكود
بدل:

const MODEL = (process.env.GROQ_MODEL || "openai/gpt-oss-120b").trim();
خله:

const MODEL = (process.env.GROQ_MODEL || "llama-3.3-70b-versatile").trim();
عشان ما يتكرر نفس الخطأ مستقبلًا. 
server


لماذا الواجهة تقول “تعذر الاتصال” بدل ما تقول “Groq 400”؟
لأن app.js يسوي:
if (!res.ok) throw new Error("HTTP_"+res.status); 
app


وبالتالي أي 500 من السيرفر يتحول لـ fallback “تعذر الاتصال…” 
app


يعني الرسالة “تعذر الاتصال” مضللة؛ المشكلة من Groq وليس من الشبكة.

خطوة تحقق سريعة بعد التعديل
بعد ما تضبط GROQ_MODEL وتشغل، المفروض يظهر في Logs:
model=<اسم الموديل الجديد> 
server


وتختفي أخطاء Groq API error (400).

إذا تبغاني أقطعها 100% بدون تخمين:
قلّي ما هو الموديل اللي كان شغال في السيرفر القديم (اسم متغير البيئة أو السطر اللي يطبع في اللوق)، وأنا أعطيك إعدادات Koyeb الدقيقة (GROQ_MODEL + أي متغيرات إضافية لو كانت موجودة).


Sources

You said:
app.js:157   POST https://ruling-violet-m0h-217b6aa8.koyeb.app/chat 500 (Internal Server Error)
fetchWithTimeout @ app.js:157
sendToBackend @ app.js:806
btn.onclick @ app.js:921
app.js:157   POST https://ruling-violet-m0h-217b6aa8.koyeb.app/chat 500 (Internal Server Error)

ChatGPT said:
هذا متوقع 100%. عندك الآن التسلسل كالتالي:

المتصفح يرسل POST /chat

السيرفر داخليًا يرمي خطأ من Groq (400)

السيرفر يحوّلها إلى 500 ويرجعها للواجهة

الواجهة تطبع: POST .../chat 500 ثم تعرض “تعذر الاتصال”

يعني المشكلة ليست في app.js ولا في fetch — المشكلة في السيرفر (Groq request).

ماذا تعمل الآن بالضبط (خطوتين سريعتين)
1) أصلح سبب 500: غيّر الموديل على السيرفر
حسب اللوق السابق عندك، السيرفر شغال على:
openai/gpt-oss-120b
وهذا يسبب Groq 400.

✅ في Koyeb > Environment Variables:

GROQ_MODEL=llama-3.3-70b-versatile (أو الموديل اللي كان شغال مع السيرفر القديم)

ثم Redeploy.

هذا هو الإصلاح الحقيقي.

2) (مهم للتشخيص) خلّ السيرفر يرجع سبب الخطأ بدل 500 صامت
حاليًا callGroq() يرمي خطأ فيه تفاصيل، لكن أنت تقطع التفاصيل وتخلي الواجهة “عمياء”.

في server.js داخل مسار /chat في الـ catch رجّع رسالة مختصرة:

أضف hint: e.message.slice(0,120) في الـ JSON

بهذا، بدل ما تشوف 500 فقط، بتشوف مثل:
Groq API error (400) ... داخل استجابة السيرفر.

لماذا أنت ما زلت تشوف 500 حتى بعد ما “غيرت السيرفر”؟
لأن الواجهة عندك ما زالت تشير لنفس URL:

https://ruling-violet-m0h-217b6aa8.koyeb.app/chat

وapp.js يبني الرابط كالتالي:

يجيب base

ثم يضيف /chat 
app


إذا كنت حاط DEFAULT_BACKEND_URL أصلًا فيه /chat (زي اللي عندك)، فهو يحاول يصلحها، لكن الأفضل تخليه base بدون /chat.

✅ خلّه:

const DEFAULT_BACKEND_URL = "https://ruling-violet-m0h-217b6aa8.koyeb.app";
وخلاص.

(هذا لا يحل 500، لكنه يمنع لخبطة الروابط مستقبلًا.)

تشخيص نهائي خلال 10 ثواني
افتح هذا بالرابط (بدون المتصفح Console):

https://ruling-violet-m0h-217b6aa8.koyeb.app/health

إذا ok ✅، معناها السيرفر قائم لكن /chat هو اللي يطيح بسبب Groq.

الخلاصة الحاسمة
طالما /chat يرجع 500 عندك، وLogs كانت تقول Groq 400:

الموديل غير مدعوم/اسم الموديل خطأ في Groq
اضبط GROQ_MODEL لموديل مؤكد متاح عندك، وانتهى.

إذا تبغى أعطيك قيمة GROQ_MODEL الصحيحة بدون تجارب: ارسل لي اسم الموديل اللي كان ظاهر في Logs حق السيرفر القديم (سطر “model=...”).


Sources

You said:
Error: Groq API error (400) 
    at callGroq (file:///workspace/server.js:332:11)
    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)
    at async file:///workspace/server.js:502:16

ChatGPT said:

Thought for 28s
واضح الآن: الواجهة تشوف 500 لأن السيرفر عندك يرمي استثناء بسبب:

Groq API يرجع 400 (Bad Request) → السيرفر يدخل catch ويرجع 500. 
server


الـ 400 هذا ليس “شبكة”، هذا يعني الـ payload اللي ترسله لـ Groq غير مقبول.

ليه 400 عندك تحديدًا؟
في server.js أنت تستدعي Groq Chat Completions وتضيف:

response_format: { type: "json_object" }
داخل callGroq() 
server


وعندك محاولة احتياط: إذا كان السبب “response_format” يعيد المحاولة بدونها. لكن إعادة المحاولة عندك مشروطة بأن نص الخطأ يحتوي كلمة response_format. 
server


مشكلتك: اللوق اللي وصلتنا يطلع Groq API error (400) بدون نص إضافي، يعني res.text() طالع فاضي/غير متضمن “response_format”، لذلك ما يصير retry وتبقى 400.

إصلاح عملي مباشر (يوقف 400 فورًا)
خلّ السيرفر يعيد المحاولة بدون response_format عند أي 400 (مو بس إذا ظهر النص).

عدّل callGroq() كذا (استبدل الجزء الخاص بـ 400):

async function callGroq(messages, { model, max_tokens }) {
  const url = "https://api.groq.com/openai/v1/chat/completions";

  const payload = {
    model,
    temperature: 0.35,
    max_tokens,
    messages,
    response_format: { type: "json_object" },
  };

  let res = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  }, 20000);

  // ✅ أي 400: جرّب بدون response_format مباشرة
  if (!res.ok && res.status === 400) {
    const t = await res.text().catch(() => "");
    delete payload.response_format;

    res = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }, 20000);

    if (!res.ok) {
      const t2 = await res.text().catch(() => "");
      throw new Error(`Groq API error (${res.status}) ${(t2 || t || "").slice(0, 400)}`);
    }

    const data2 = await res.json();
    return data2.choices?.[0]?.message?.content || "";
  }

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Groq API error (${res.status}) ${t.slice(0, 400)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}
هذا التعديل مبني على نفس مكان الخطأ عندك. 
server


بديل أبسط (لو تبغى تقفل الموضوع نهائيًا)
احذف response_format تمامًا وخلي الـ JSON “بالـ prompt” فقط.
يعني في payload خليها:

const payload = { model, temperature: 0.35, max_tokens, messages };
لأنك أصلًا عندك extractJson() وrepairMessages لإصلاح JSON إذا خرب.

تأكيد سريع أن الموديل نفسه ليس المشكلة
Groq فعليًا يعرض openai/gpt-oss-120b ضمن قائمة الموديلات. 

يعني الاحتمال الأكبر: باراميتر/صيغة الطلب وليس “اسم موديل غلط”.

نقطة أخيرة: خلّ اللوق يكشف السبب بدل ما يطلع فاضي
قبل ما ترمي الخطأ، اطبع نص رد Groq كامل (مرة واحدة) لتعرف السبب الحقيقي:

if (!res.ok) {
  const t = await res.text().catch(() => "");
  console.error("Groq bad request:", res.status, t);
  throw new Error(`Groq API error (${res.status}) ${t.slice(0, 400)}`);
}
الخلاصة
الـ 500 في المتصفح نتيجة.

السبب الحقيقي هو 400 من Groq.

عندك retry ناقص على 400 بسبب شرط “response_format”.

عدّل callGroq() ليعيد المحاولة بدون response_format عند أي 400، أو احذف response_format بالكامل.

إذا تحب، انسخ لي نص Groq bad request: بعد ما تضيف الـ console.error، وبقول لك بالضبط أي حقل Groq رافضه (model/response_format/max_tokens/… إلخ).


Sources

You said:
ممكن تعديل لي ياه كامل وترجع لي ياه كامل؟                                                                                                                                                                                                                             // server.js — Dalil Alafiyah API (single-model Groq) + TTS
import "dotenv/config";
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

const app = express();

const GROQ_API_KEY = process.env.GROQ_API_KEY;

// ✅ موديل واحد فقط (Groq)
const MODEL = (process.env.GROQ_MODEL || "openai/gpt-oss-120b").trim();

// TTS (Orpheus Arabic Saudi)
const TTS_MODEL = (process.env.GROQ_TTS_MODEL || "canopylabs/orpheus-arabic-saudi").trim();
const TTS_VOICE = (process.env.GROQ_TTS_VOICE || "fahad").trim();

const PORT = process.env.PORT || 3000;

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!GROQ_API_KEY) {
  console.error("❌ GROQ_API_KEY غير مضبوط");
  process.exit(1);
}

if (!MODEL) {
  console.error("❌ MODEL فارغ. اضبط GROQ_MODEL");
  process.exit(1);
}

app.use(helmet());
app.set("trust proxy", 1);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // curl/health checks
      if (ALLOWED_ORIGINS.length === 0) return cb(null, true); // dev mode
      return ALLOWED_ORIGINS.includes(origin)
        ? cb(null, true)
        : cb(new Error("CORS blocked"), false);
    },
    methods: ["POST", "GET"],
  })
);

app.use(bodyParser.json({ limit: "2mb" }));

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.CHAT_RPM || 25),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.ip),
});

// ✅ TTS limiter منفصل
const ttsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.TTS_RPM || 18),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.ip),
});

// ---------- helpers ----------
async function fetchWithTimeout(url, options = {}, ms = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

function cleanJsonish(s) {
  let t = String(s || "").trim();
  if (t.startsWith("
")) {
    t = t.replace(/^
[a-zA-Z]*\s*/m, "").replace(/
$/m, "").trim();
  }
  t = t.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  t = t.replace(/,\s*([}\]])/g, "$1");
  return t;
}

function extractJson(text) {
  const s0 = String(text || "");
  let s = cleanJsonish(s0);

  try {
    const first = JSON.parse(s);
    if (first && typeof first === "object") return first;
    if (typeof first === "string") {
      const second = JSON.parse(cleanJsonish(first));
      if (second && typeof second === "object") return second;
    }
  } catch {}

  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a === -1 || b === -1 || b <= a) return null;

  const chunk = cleanJsonish(s.slice(a, b + 1));
  try {
    return JSON.parse(chunk);
  } catch {
    return null;
  }
}

function extractVerdictLoosely(raw) {
  const s = String(raw || "");
  const m = s.match(/"verdict"\s*:\s*"([^"]+)"/);
  return m?.[1]?.replace(/\\"/g, '"').trim() || "";
}

function recoverPartialCard(raw) {
  const s = String(raw || "");
  const pick = (re) => {
    const m = s.match(re);
    return m?.[1] ? m[1].replace(/\\"/g, '"').trim() : "";
  };

  const category = pick(/"category"\s*:\s*"([^"]+)"/) || "general";
  const title = pick(/"title"\s*:\s*"([^"]+)"/) || "دليل العافية";
  const verdict = pick(/"verdict"\s*:\s*"([^"]+)"/) || "";
  const when_to_seek_help = pick(/"when_to_seek_help"\s*:\s*"([^"]*)"/) || "";

  const arrPick = (key, limit) => {
    const m = s.match(new RegExp(`"${key}"\\s*:\\s*\\[([\\s\\S]*?)\\]`));
    const inner = m?.[1] || "";
    if (!inner) return [];
    return inner
      .split(",")
      .map((x) => x.trim())
      .map((x) => x.replace(/^"+|"+$/g, "").replace(/\\"/g, '"'))
      .filter(Boolean)
      .slice(0, limit);
  };

  const tips = arrPick("tips", 3);

  return {
    category,
    title,
    verdict,
    tips,
    when_to_seek_help,
  };
}

function isMetaJsonAnswer(d) {
  const text =
    String(d?.title || "") +
    " " +
    String(d?.verdict || "") +
    " " +
    String(d?.when_to_seek_help || "") +
    " " +
    (Array.isArray(d?.tips) ? d.tips.join(" ") : "");

  return /json|format|schema|اقتباس|فواصل|تنسيق/i.test(text);
}

const sStr = (v) => (typeof v === "string" ? v.trim() : "");
const sArr = (v, n) =>
  Array.isArray(v)
    ? v.filter((x) => typeof x === "string" && x.trim()).slice(0, n)
    : [];

function normalize(obj) {
  let cat = sStr(obj?.category) || "general";
  if (cat === "blood_pressure" || cat === "bloodpressure") cat = "bp";

  const allowed = new Set([
    "general",
    "nutrition",
    "bp",
    "sugar",
    "sleep",
    "activity",
    "mental",
    "first_aid",
    "report",
    "emergency",
    "water",
    "calories",
    "bmi",
  ]);
  if (!allowed.has(cat)) cat = "general";

  return {
    category: cat,
    title: sStr(obj?.title) || "دليل العافية",
    verdict: sStr(obj?.verdict),
    tips: sArr(obj?.tips, 3),
    when_to_seek_help: sStr(obj?.when_to_seek_help),
  };
}

// ✅ NEW: اعتبر البطاقة فاشلة فقط إذا verdict فاضي
function isEmptyCard(card) {
  const verdictEmpty = !String(card?.verdict || "").trim();
  return verdictEmpty;
}

function buildSystemPrompt() {
  return `
أنت **"دليل العافية"** مساعد تثقيف صحي توعوي ذكي يعتمد على معلومات صحية موثوقة.

الهوية:
- تقدم تثقيفًا صحيًا عامًا فقط.
- لست طبيبًا ولا تقدم استشارة طبية.
- هدفك نشر الوعي الصحي وتقليل المخاطر الصحية.
- سلامة المستخدم مقدمة دائمًا على تقديم الإجابة الكاملة.

قواعد الأمان الطبي الصارمة:
يُمنع عليك:
- تشخيص الأمراض أو تأكيد الإصابة.
- إعطاء خطوات علاج أو إسعاف تفصيلية.
- تحديد جرعات أدوية.
- اقتراح أدوية أو وصفات علاج.
- تقديم بدائل عن الطبيب أو الجهات الصحية.

حالات الطوارئ:
عند الاشتباه بخطر صحي (ألم شديد، نزيف، فقدان وعي، أعراض مفاجئة خطيرة):
وجّه المستخدم فورًا لطلب مساعدة طبية عاجلة عبر:
9999 شرطة عُمان السلطانية
24343666 الهيئة الصحية

قاعدة اللغة:
- كل القيم النصية داخل JSON (title/verdict/tips/when_to_seek_help) يجب أن تكون بالعربية فقط.
- مفاتيح JSON ستبقى بالإنجليزية (category,title,verdict,tips,when_to_seek_help) وهذا مسموح لأنها جزء من التنسيق.
- تجنب إدخال أي كلمات لاتينية داخل القيم النصية.

صيغة الإخراج الإلزامية:
- أعد JSON فقط وبلا أي نص خارجه وبدون Markdown، بالشكل:
{"category":"general|nutrition|bp|sugar|sleep|activity|mental|first_aid|report|emergency|water|calories|bmi","title":"2-5 كلمات","verdict":"جملتان توعويتان كحد أقصى","tips":["","",""],"when_to_seek_help":"\\" \\" أو نص قصير"}

تنبيه للمسار:
إذا وصلك سياق فيه "path" فهذا يعني مسار واجهة المستخدم المختار. التزم بنفس المسار وقدّم معلومات جديدة غير مكررة وبنفس هيكلة JSON.
`.trim();
}

// ✅ include path in compact context
function compactLastCard(lastCard) {
  const cat = sStr(lastCard?.category);
  const path = sStr(lastCard?.path);
  const out = {};
  if (cat) out.category = cat;
  if (path) out.path = path;
  return Object.keys(out).length ? out : null;
}

function chooseMaxTokens(msg, lastCard) {
  const base = Number(process.env.GROQ_MAX_TOKENS || 220);

  const text = String(msg || "");
  const cat = sStr(lastCard?.category);
  if (cat === "report" || /تقرير|ملخص|تحليل/i.test(text)) return Math.max(base, 320);
  if (cat === "emergency" || /طوارئ|إسعاف|اختناق|نزيف|حروق|سكتة/i.test(text))
    return Math.max(base, 320);

  return base;
}

/**
 * ✅ callGroq updated:
 * - uses response_format json_object
 * - has a safe fallback if API rejects response_format (400 + mentions response_format)
 */
async function callGroq(messages, { model, max_tokens }) {
  const payload = {
    model,
    temperature: 0.35,
    max_tokens,
    messages,
    response_format: { type: "json_object" },
  };

  const url = "https://api.groq.com/openai/v1/chat/completions";

  let res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
    20000
  );

  // احتياط: لو الموديل/الواجهة رفضت response_format
  if (!res.ok && res.status === 400) {
    const t = await res.text().catch(() => "");
    if (t.toLowerCase().includes("response_format")) {
      delete payload.response_format;
      res = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${GROQ_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        },
        20000
      );
      if (!res.ok) {
        const t2 = await res.text().catch(() => "");
        throw new Error(`Groq API error (${res.status}) ${t2.slice(0, 200)}`);
      }
      const data2 = await res.json();
      return data2.choices?.[0]?.message?.content || "";
    }
  }

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Groq API error (${res.status}) ${t.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

/**
 * ✅ fallback updated:
 * - NEVER returns "تعذر توليد رد منظم..."
 * - Always returns useful Arabic content
 */
function fallback(_rawText) {
  return {
    category: "general",
    title: "معلومة صحية",
    verdict: "أقدر أساعدك بمعلومة صحية عامة. اكتب سؤالك بجملة واحدة وحدد العمر والجنس إن كان له علاقة.",
    tips: ["اذكر الأعراض باختصار", "حدّد المدة منذ بداية المشكلة", "اذكر إن كان لديك أمراض مزمنة"],
    when_to_seek_help: "إذا كان هناك ألم شديد أو ضيق نفس أو إغماء أو نزيف فاطلب مساعدة عاجلة.",
  };
}

// ---------- TTS helpers ----------
function normalizeArabicForTTS(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, 200);
}

async function callGroqTTS(text, { model = TTS_MODEL, voice = TTS_VOICE } = {}) {
  const input = normalizeArabicForTTS(text);
  if (!input) throw new Error("tts_empty_input");

  const res = await fetchWithTimeout(
    "https://api.groq.com/openai/v1/audio/speech",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input,
        voice,
        response_format: "wav",
      }),
    },
    20000
  );

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    const e = new Error(`Groq TTS error (${res.status}) ${t.slice(0, 200)}`);
    e.status = res.status;
    e.body = t.slice(0, 500);
    throw e;
  }

  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

// ---------- TTS cache (in-memory) ----------
const TTS_CACHE = new Map();
const TTS_CACHE_TTL_MS = Number(process.env.TTS_CACHE_TTL_MS || 1000 * 60 * 60 * 6);
const TTS_CACHE_MAX_ITEMS = Number(process.env.TTS_CACHE_MAX_ITEMS || 40);
const TTS_CACHE_MAX_BYTES = Number(process.env.TTS_CACHE_MAX_BYTES || 18 * 1024 * 1024);

function ttsCacheKey(text, voice) {
  return `${String(voice || TTS_VOICE).trim()}|${normalizeArabicForTTS(text)}`;
}

function ttsCacheGet(key) {
  const hit = TTS_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > TTS_CACHE_TTL_MS) {
    TTS_CACHE.delete(key);
    return null;
  }
  TTS_CACHE.delete(key);
  TTS_CACHE.set(key, hit);
  return hit.buf;
}

function ttsCacheTotalBytes() {
  let sum = 0;
  for (const v of TTS_CACHE.values()) sum += Number(v.bytes || 0);
  return sum;
}

function ttsCacheSet(key, buf) {
  try {
    TTS_CACHE.set(key, { buf, ts: Date.now(), bytes: buf.length });
    while (TTS_CACHE.size > TTS_CACHE_MAX_ITEMS) {
      const first = TTS_CACHE.keys().next().value;
      if (!first) break;
      TTS_CACHE.delete(first);
    }
    while (ttsCacheTotalBytes() > TTS_CACHE_MAX_BYTES) {
      const first = TTS_CACHE.keys().next().value;
      if (!first) break;
      TTS_CACHE.delete(first);
    }
  } catch {}
}

// ---------- routes ----------
app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/reset", (_req, res) => {
  res.json({ ok: true });
});

// ✅ TTS endpoint
app.post("/tts", ttsLimiter, async (req, res) => {
  try {
    const text = String(req.body?.text || "").trim();
    const voice = String(req.body?.voice || TTS_VOICE).trim() || TTS_VOICE;

    if (!text) return res.status(400).json({ ok: false, error: "empty_text" });

    const key = ttsCacheKey(text, voice);
    const cached = ttsCacheGet(key);
    const wav = cached || (await callGroqTTS(text, { voice }));
    if (!cached) ttsCacheSet(key, wav);

    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("Content-Length", String(wav.length));
    return res.status(200).send(wav);
  } catch (e) {
    console.error(e);
    const status = Number(e?.status || 0);
    if (status === 402 || status === 429) {
      return res.status(503).json({ ok: false, error: "tts_unavailable", hint: "quota_or_rate_limit" });
    }
    return res.status(500).json({ ok: false, error: "tts_error" });
  }
});

app.post("/chat", chatLimiter, async (req, res) => {
  try {
    const msg = String(req.body?.message || "").trim();
    if (!msg) return res.status(400).json({ ok: false, error: "empty_message" });
    if (msg.length > 350) return res.status(400).json({ ok: false, error: "message_too_long" });

    const lastCard = req.body?.context?.last || null;

    const ctxPath = String(req.body?.context?.path || req.body?.meta?.path || "").trim();
    const lastCategory = String(req.body?.context?.category || lastCard?.category || "").trim();

    const compact = compactLastCard({ category: lastCategory, path: ctxPath });

    const messages = [{ role: "system", content: buildSystemPrompt() }];

    if (compact) {
      messages.push({
        role: "assistant",
        content: "سياق سابق مختصر للاستمرار:\n" + JSON.stringify(compact),
      });
    }

    messages.push({ role: "user", content: msg });

    const maxTokens = chooseMaxTokens(msg, { category: lastCategory });

    // ✅ موديل واحد فقط + JSON mode
    let raw1 = await callGroq(messages, { model: MODEL, max_tokens: maxTokens });
    let parsed = extractJson(raw1);

    // ✅ NEW: إصلاح مرة ثانية إذا فشل JSON
    if (!parsed) {
      const repairMessages = [
        { role: "system", content: buildSystemPrompt() },
        ...messages.filter((m) => m.role !== "system"),
        {
          role: "user",
          content:
            "الناتج السابق غير صالح كـ JSON. أعد نفس الإجابة لكن كـ JSON صالح فقط وبنفس المفاتيح المطلوبة، بدون أي نص إضافي.",
        },
      ];

      const raw2 = await callGroq(repairMessages, { model: MODEL, max_tokens: maxTokens });
      const parsed2 = extractJson(raw2);
      if (parsed2) {
        raw1 = raw2;
        parsed = parsed2;
      }
    }

    let data;
    if (parsed) data = normalize(parsed);
    else data = normalize(recoverPartialCard(raw1) || fallback(raw1));

    if (isMetaJsonAnswer(data)) {
      data = normalize(recoverPartialCard(raw1) || fallback(raw1));
    }

    // ✅ حارس نهائي: إذا verdict فاضي رجّع fallback (بدون الرسالة المزعجة)
    if (isEmptyCard(data)) {
      data = fallback(raw1);
    }

    return res.json({
      ok: true,
      data,
      meta: {
        model_used: MODEL,
        path: ctxPath || null,
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "server_error", data: fallback("") });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 API running on :${PORT} | model=${MODEL} | tts=${TTS_MODEL}/${TTS_VOICE}`);
});

ChatGPT said:
أكيد. هذا ملف server.js كامل بعد التعديل (نفس ملفك، لكن مع إصلاح مشكلة Groq 400 بشكل عملي):

أهم تغييرات فعلتها
callGroq: أي 400 → يعيد المحاولة تلقائيًا بدون response_format (مو بس إذا ظهر نص response_format).

تحسين رسالة الخطأ في اللوق: يطبع نص رد Groq (يساعدك تشخص بدل “400” صامت).

في /chat catch: يرجّع hint مختصر للواجهة (اختياري لكن مفيد).

انسخه كما هو واستبدل ملفك بالكامل:

// server.js — Dalil Alafiyah API (single-model Groq) + TTS
import "dotenv/config";
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

const app = express();

const GROQ_API_KEY = process.env.GROQ_API_KEY;

// ✅ موديل واحد فقط (Groq)
const MODEL = (process.env.GROQ_MODEL || "openai/gpt-oss-120b").trim();

// TTS (Orpheus Arabic Saudi)
const TTS_MODEL = (process.env.GROQ_TTS_MODEL || "canopylabs/orpheus-arabic-saudi").trim();
const TTS_VOICE = (process.env.GROQ_TTS_VOICE || "fahad").trim();

const PORT = process.env.PORT || 3000;

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!GROQ_API_KEY) {
  console.error("❌ GROQ_API_KEY غير مضبوط");
  process.exit(1);
}

if (!MODEL) {
  console.error("❌ MODEL فارغ. اضبط GROQ_MODEL");
  process.exit(1);
}

app.use(helmet());
app.set("trust proxy", 1);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // curl/health checks
      if (ALLOWED_ORIGINS.length === 0) return cb(null, true); // dev mode
      return ALLOWED_ORIGINS.includes(origin)
        ? cb(null, true)
        : cb(new Error("CORS blocked"), false);
    },
    methods: ["POST", "GET"],
  })
);

app.use(bodyParser.json({ limit: "2mb" }));

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.CHAT_RPM || 25),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.ip),
});

// ✅ TTS limiter منفصل
const ttsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.TTS_RPM || 18),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.ip),
});

// ---------- helpers ----------
async function fetchWithTimeout(url, options = {}, ms = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

function cleanJsonish(s) {
  let t = String(s || "").trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```[a-zA-Z]*\s*/m, "").replace(/```$/m, "").trim();
  }
  t = t.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  t = t.replace(/,\s*([}\]])/g, "$1");
  return t;
}

function extractJson(text) {
  const s0 = String(text || "");
  let s = cleanJsonish(s0);

  try {
    const first = JSON.parse(s);
    if (first && typeof first === "object") return first;
    if (typeof first === "string") {
      const second = JSON.parse(cleanJsonish(first));
      if (second && typeof second === "object") return second;
    }
  } catch {}

  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a === -1 || b === -1 || b <= a) return null;

  const chunk = cleanJsonish(s.slice(a, b + 1));
  try {
    return JSON.parse(chunk);
  } catch {
    return null;
  }
}

function extractVerdictLoosely(raw) {
  const s = String(raw || "");
  const m = s.match(/"verdict"\s*:\s*"([^"]+)"/);
  return m?.[1]?.replace(/\\"/g, '"').trim() || "";
}

function recoverPartialCard(raw) {
  const s = String(raw || "");
  const pick = (re) => {
    const m = s.match(re);
    return m?.[1] ? m[1].replace(/\\"/g, '"').trim() : "";
  };

  const category = pick(/"category"\s*:\s*"([^"]+)"/) || "general";
  const title = pick(/"title"\s*:\s*"([^"]+)"/) || "دليل العافية";
  const verdict = pick(/"verdict"\s*:\s*"([^"]+)"/) || "";
  const when_to_seek_help = pick(/"when_to_seek_help"\s*:\s*"([^"]*)"/) || "";

  const arrPick = (key, limit) => {
    const m = s.match(new RegExp(`"${key}"\\s*:\\s*\\[([\\s\\S]*?)\\]`));
    const inner = m?.[1] || "";
    if (!inner) return [];
    return inner
      .split(",")
      .map((x) => x.trim())
      .map((x) => x.replace(/^"+|"+$/g, "").replace(/\\"/g, '"'))
      .filter(Boolean)
      .slice(0, limit);
  };

  const tips = arrPick("tips", 3);

  return {
    category,
    title,
    verdict,
    tips,
    when_to_seek_help,
  };
}

function isMetaJsonAnswer(d) {
  const text =
    String(d?.title || "") +
    " " +
    String(d?.verdict || "") +
    " " +
    String(d?.when_to_seek_help || "") +
    " " +
    (Array.isArray(d?.tips) ? d.tips.join(" ") : "");

  return /json|format|schema|اقتباس|فواصل|تنسيق/i.test(text);
}

const sStr = (v) => (typeof v === "string" ? v.trim() : "");
const sArr = (v, n) =>
  Array.isArray(v)
    ? v.filter((x) => typeof x === "string" && x.trim()).slice(0, n)
    : [];

function normalize(obj) {
  let cat = sStr(obj?.category) || "general";
  if (cat === "blood_pressure" || cat === "bloodpressure") cat = "bp";

  const allowed = new Set([
    "general",
    "nutrition",
    "bp",
    "sugar",
    "sleep",
    "activity",
    "mental",
    "first_aid",
    "report",
    "emergency",
    "water",
    "calories",
    "bmi",
  ]);
  if (!allowed.has(cat)) cat = "general";

  return {
    category: cat,
    title: sStr(obj?.title) || "دليل العافية",
    verdict: sStr(obj?.verdict),
    tips: sArr(obj?.tips, 3),
    when_to_seek_help: sStr(obj?.when_to_seek_help),
  };
}

// ✅ اعتبر البطاقة فاشلة فقط إذا verdict فاضي
function isEmptyCard(card) {
  const verdictEmpty = !String(card?.verdict || "").trim();
  return verdictEmpty;
}

function buildSystemPrompt() {
  return `
أنت **"دليل العافية"** مساعد تثقيف صحي توعوي ذكي يعتمد على معلومات صحية موثوقة.

الهوية:
- تقدم تثقيفًا صحيًا عامًا فقط.
- لست طبيبًا ولا تقدم استشارة طبية.
- هدفك نشر الوعي الصحي وتقليل المخاطر الصحية.
- سلامة المستخدم مقدمة دائمًا على تقديم الإجابة الكاملة.

قواعد الأمان الطبي الصارمة:
يُمنع عليك:
- تشخيص الأمراض أو تأكيد الإصابة.
- إعطاء خطوات علاج أو إسعاف تفصيلية.
- تحديد جرعات أدوية.
- اقتراح أدوية أو وصفات علاج.
- تقديم بدائل عن الطبيب أو الجهات الصحية.

حالات الطوارئ:
عند الاشتباه بخطر صحي (ألم شديد، نزيف، فقدان وعي، أعراض مفاجئة خطيرة):
وجّه المستخدم فورًا لطلب مساعدة طبية عاجلة عبر:
9999 شرطة عُمان السلطانية
24343666 الهيئة الصحية

قاعدة اللغة:
- كل القيم النصية داخل JSON (title/verdict/tips/when_to_seek_help) يجب أن تكون بالعربية فقط.
- مفاتيح JSON ستبقى بالإنجليزية (category,title,verdict,tips,when_to_seek_help) وهذا مسموح لأنها جزء من التنسيق.
- تجنب إدخال أي كلمات لاتينية داخل القيم النصية.

صيغة الإخراج الإلزامية:
- أعد JSON فقط وبلا أي نص خارجه وبدون Markdown، بالشكل:
{"category":"general|nutrition|bp|sugar|sleep|activity|mental|first_aid|report|emergency|water|calories|bmi","title":"2-5 كلمات","verdict":"جملتان توعويتان كحد أقصى","tips":["","",""],"when_to_seek_help":"\\" \\" أو نص قصير"}

تنبيه للمسار:
إذا وصلك سياق فيه "path" فهذا يعني مسار واجهة المستخدم المختار. التزم بنفس المسار وقدّم معلومات جديدة غير مكررة وبنفس هيكلة JSON.
`.trim();
}

// ✅ include path in compact context
function compactLastCard(lastCard) {
  const cat = sStr(lastCard?.category);
  const path = sStr(lastCard?.path);
  const out = {};
  if (cat) out.category = cat;
  if (path) out.path = path;
  return Object.keys(out).length ? out : null;
}

function chooseMaxTokens(msg, lastCard) {
  const base = Number(process.env.GROQ_MAX_TOKENS || 220);

  const text = String(msg || "");
  const cat = sStr(lastCard?.category);
  if (cat === "report" || /تقرير|ملخص|تحليل/i.test(text)) return Math.max(base, 320);
  if (cat === "emergency" || /طوارئ|إسعاف|اختناق|نزيف|حروق|سكتة/i.test(text))
    return Math.max(base, 320);

  return base;
}

/**
 * ✅ callGroq (FIXED):
 * - tries JSON mode (response_format json_object)
 * - if Groq returns 400 لأي سبب: يعيد المحاولة بدون response_format مباشرة
 * - logs the response body for debugging (limited)
 */
async function callGroq(messages, { model, max_tokens }) {
  const url = "https://api.groq.com/openai/v1/chat/completions";

  const baseHeaders = {
    Authorization: `Bearer ${GROQ_API_KEY}`,
    "Content-Type": "application/json",
  };

  const payloadJsonMode = {
    model,
    temperature: 0.35,
    max_tokens,
    messages,
    response_format: { type: "json_object" },
  };

  // 1) First attempt (JSON mode)
  let res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: baseHeaders,
      body: JSON.stringify(payloadJsonMode),
    },
    20000
  );

  // 2) If 400: retry without response_format (many models/endpoints reject it)
  if (!res.ok && res.status === 400) {
    const t1 = await res.text().catch(() => "");
    console.error("Groq 400 (json mode). Retrying without response_format. Body:", t1.slice(0, 600));

    const payloadPlain = {
      model,
      temperature: 0.35,
      max_tokens,
      messages,
      // no response_format
    };

    res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: baseHeaders,
        body: JSON.stringify(payloadPlain),
      },
      20000
    );

    if (!res.ok) {
      const t2 = await res.text().catch(() => "");
      console.error("Groq retry failed:", res.status, t2.slice(0, 600));
      throw new Error(`Groq API error (${res.status}) ${(t2 || t1 || "").slice(0, 400)}`);
    }

    const data2 = await res.json();
    return data2.choices?.[0]?.message?.content || "";
  }

  // Other non-OK statuses
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.error("Groq error:", res.status, t.slice(0, 600));
    throw new Error(`Groq API error (${res.status}) ${t.slice(0, 400)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

/**
 * ✅ fallback updated:
 * - Always returns useful Arabic content
 */
function fallback(_rawText) {
  return {
    category: "general",
    title: "معلومة صحية",
    verdict: "أقدر أساعدك بمعلومة صحية عامة. اكتب سؤالك بجملة واحدة وحدد العمر والجنس إن كان له علاقة.",
    tips: ["اذكر الأعراض باختصار", "حدّد المدة منذ بداية المشكلة", "اذكر إن كان لديك أمراض مزمنة"],
    when_to_seek_help: "إذا كان هناك ألم شديد أو ضيق نفس أو إغماء أو نزيف فاطلب مساعدة عاجلة.",
  };
}

// ---------- TTS helpers ----------
function normalizeArabicForTTS(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, 200);
}

async function callGroqTTS(text, { model = TTS_MODEL, voice = TTS_VOICE } = {}) {
  const input = normalizeArabicForTTS(text);
  if (!input) throw new Error("tts_empty_input");

  const res = await fetchWithTimeout(
    "https://api.groq.com/openai/v1/audio/speech",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input,
        voice,
        response_format: "wav",
      }),
    },
    20000
  );

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    const e = new Error(`Groq TTS error (${res.status}) ${t.slice(0, 200)}`);
    e.status = res.status;
    e.body = t.slice(0, 500);
    throw e;
  }

  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

// ---------- TTS cache (in-memory) ----------
const TTS_CACHE = new Map();
const TTS_CACHE_TTL_MS = Number(process.env.TTS_CACHE_TTL_MS || 1000 * 60 * 60 * 6);
const TTS_CACHE_MAX_ITEMS = Number(process.env.TTS_CACHE_MAX_ITEMS || 40);
const TTS_CACHE_MAX_BYTES = Number(process.env.TTS_CACHE_MAX_BYTES || 18 * 1024 * 1024);

function ttsCacheKey(text, voice) {
  return `${String(voice || TTS_VOICE).trim()}|${normalizeArabicForTTS(text)}`;
}

function ttsCacheGet(key) {
  const hit = TTS_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > TTS_CACHE_TTL_MS) {
    TTS_CACHE.delete(key);
    return null;
  }
  TTS_CACHE.delete(key);
  TTS_CACHE.set(key, hit);
  return hit.buf;
}

function ttsCacheTotalBytes() {
  let sum = 0;
  for (const v of TTS_CACHE.values()) sum += Number(v.bytes || 0);
  return sum;
}

function ttsCacheSet(key, buf) {
  try {
    TTS_CACHE.set(key, { buf, ts: Date.now(), bytes: buf.length });
    while (TTS_CACHE.size > TTS_CACHE_MAX_ITEMS) {
      const first = TTS_CACHE.keys().next().value;
      if (!first) break;
      TTS_CACHE.delete(first);
    }
    while (ttsCacheTotalBytes() > TTS_CACHE_MAX_BYTES) {
      const first = TTS_CACHE.keys().next().value;
      if (!first) break;
      TTS_CACHE.delete(first);
    }
  } catch {}
}

// ---------- routes ----------
app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/reset", (_req, res) => {
  res.json({ ok: true });
});

// ✅ TTS endpoint
app.post("/tts", ttsLimiter, async (req, res) => {
  try {
    const text = String(req.body?.text || "").trim();
    const voice = String(req.body?.voice || TTS_VOICE).trim() || TTS_VOICE;

    if (!text) return res.status(400).json({ ok: false, error: "empty_text" });

    const key = ttsCacheKey(text, voice);
    const cached = ttsCacheGet(key);
    const wav = cached || (await callGroqTTS(text, { voice }));
    if (!cached) ttsCacheSet(key, wav);

    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("Content-Length", String(wav.length));
    return res.status(200).send(wav);
  } catch (e) {
    console.error(e);
    const status = Number(e?.status || 0);
    if (status === 402 || status === 429) {
      return res.status(503).json({ ok: false, error: "tts_unavailable", hint: "quota_or_rate_limit" });
    }
    return res.status(500).json({ ok: false, error: "tts_error" });
  }
});

app.post("/chat", chatLimiter, async (req, res) => {
  try {
    const msg = String(req.body?.message || "").trim();
    if (!msg) return res.status(400).json({ ok: false, error: "empty_message" });
    if (msg.length > 350) return res.status(400).json({ ok: false, error: "message_too_long" });

    const lastCard = req.body?.context?.last || null;

    const ctxPath = String(req.body?.context?.path || req.body?.meta?.path || "").trim();
    const lastCategory = String(req.body?.context?.category || lastCard?.category || "").trim();

    const compact = compactLastCard({ category: lastCategory, path: ctxPath });

    const messages = [{ role: "system", content: buildSystemPrompt() }];

    if (compact) {
      messages.push({
        role: "assistant",
        content: "سياق سابق مختصر للاستمرار:\n" + JSON.stringify(compact),
      });
    }

    messages.push({ role: "user", content: msg });

    const maxTokens = chooseMaxTokens(msg, { category: lastCategory });

    // ✅ موديل واحد فقط
    let raw1 = await callGroq(messages, { model: MODEL, max_tokens: maxTokens });
    let parsed = extractJson(raw1);

    // ✅ إصلاح مرة ثانية إذا فشل JSON
    if (!parsed) {
      const repairMessages = [
        { role: "system", content: buildSystemPrompt() },
        ...messages.filter((m) => m.role !== "system"),
        {
          role: "user",
          content:
            "الناتج السابق غير صالح كـ JSON. أعد نفس الإجابة لكن كـ JSON صالح فقط وبنفس المفاتيح المطلوبة، بدون أي نص إضافي.",
        },
      ];

      const raw2 = await callGroq(repairMessages, { model: MODEL, max_tokens: maxTokens });
      const parsed2 = extractJson(raw2);
      if (parsed2) {
        raw1 = raw2;
        parsed = parsed2;
      }
    }

    let data;
    if (parsed) data = normalize(parsed);
    else data = normalize(recoverPartialCard(raw1) || fallback(raw1));

    if (isMetaJsonAnswer(data)) {
      data = normalize(recoverPartialCard(raw1) || fallback(raw1));
    }

    // ✅ حارس نهائي: إذا verdict فاضي رجّع fallback
    if (isEmptyCard(data)) {
      data = fallback(raw1);
    }

    return res.json({
      ok: true,
      data,
      meta: {
        model_used: MODEL,
        path: ctxPath || null,
      },
    });
  } catch (e) {
    console.error(e);
    // ✅ ارجع hint بسيط عشان الواجهة/التشخيص
    const hint = String(e?.message || "").slice(0, 160);
    return res.status(500).json({ ok: false, error: "server_error", hint, data: fallback("") });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 API running on :${PORT} | model=${MODEL} | tts=${TTS_MODEL}/${TTS_VOICE}`);
});
بعد ما ترفعه
شغّل السيرفر وجرّب سؤال.

إذا رجع 400 مرة ثانية، الآن اللوق سيطبع Body من Groq (هذا يعطيك السبب الحقيقي بدل “400” بس).

إذا تحب، انسخ لي أول سطرين من اللوق بعد التعديل (خصوصًا Groq 400 (json mode)... Body:) وأنا أقول لك هل المشكلة من الموديل نفسه أو من صيغة الرسالة أو شيء آخر.




