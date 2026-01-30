import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { createRequire } from "module";
import { createWorker } from "tesseract.js";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

const app = express();
const upload = multer({ limits: { fileSize: 8 * 1024 * 1024 } });

/* =========================
   Config
========================= */
const PORT = process.env.PORT || 8000;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || "";

/* Official Shifaa links */
const SHIFAA_ANDROID =
  "https://play.google.com/store/apps/details?id=om.gov.moh.phr&pcampaignid=web_share";
const SHIFAA_IOS =
  "https://apps.apple.com/us/app/%D8%B4-%D9%81-%D8%A7%D8%A1/id1455936672?l=ar";

/* =========================
   Middleware
========================= */
app.use(helmet({ crossOriginResourcePolicy: false }));

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

function requireApiKey(req, res, next) {
  if (!INTERNAL_API_KEY) return next();
  const key = req.header("x-api-key");
  if (key !== INTERNAL_API_KEY) return res.status(401).json({ ok: false, error: "unauthorized" });
  next();
}
app.use(requireApiKey);

// عدّلها حسب نطاقك
const ALLOWED_ORIGINS = new Set([
  "https://alafya.netlify.app",
  "http://localhost:5173",
  "http://localhost:3000",
  "http://localhost:8000",
  "http://192.168.0.182:8000",
]);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.has(origin)) return cb(null, true);
      return cb(new Error("CORS blocked: " + origin));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-user-id", "x-api-key"],
  })
);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

/* =========================
   Metrics
========================= */
const METRICS = {
  startedAt: new Date().toISOString(),
  chatRequests: 0,
  chatOk: 0,
  chatFail: 0,
  reportRequests: 0,
  reportOk: 0,
  reportFail: 0,
  emergencyTriggers: 0,
  avgLatencyMs: 0,
  categoryCount: Object.create(null),
  flows: Object.fromEntries(
    ["sugar", "bp", "bmi", "water", "calories", "mental", "first_aid", "general"].flatMap((k) => [
      [`${k}Started`, 0],
      [`${k}Completed`, 0],
    ])
  ),
};

function bumpCategory(cat) {
  if (!cat) return;
  METRICS.categoryCount[cat] = (METRICS.categoryCount[cat] || 0) + 1;
}
function updateAvgLatency(ms) {
  const alpha = 0.2;
  METRICS.avgLatencyMs =
    METRICS.avgLatencyMs === 0 ? ms : Math.round(alpha * ms + (1 - alpha) * METRICS.avgLatencyMs);
}

/* =========================
   Sessions (in-memory) + TTL
========================= */
const sessions = new Map(); // userId -> { lastCard, flow, step, profile, ts }

function getSession(userId) {
  const id = userId || "anon";
  if (!sessions.has(id)) {
    sessions.set(id, {
      lastCard: null,
      flow: null,
      step: 0,
      profile: {},
      ts: Date.now(),
    });
  }
  const s = sessions.get(id);
  s.ts = Date.now();
  return s;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) {
    if (now - (v.ts || 0) > 24 * 60 * 60 * 1000) sessions.delete(k);
  }
}, 30 * 60 * 1000);

function resetFlow(session) {
  session.flow = null;
  session.step = 0;
  session.profile = {};
}

/* =========================
   OCR (tesseract.js)
========================= */
let ocrWorkerPromise = null;

async function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => {
      const worker = await createWorker("eng+ara");
      return worker;
    })();
  }
  return ocrWorkerPromise;
}

async function ocrImageBuffer(buffer) {
  const worker = await getOcrWorker();
  const { data } = await worker.recognize(buffer);
  return data?.text ? String(data.text) : "";
}

/* =========================
   Helpers
========================= */
function clampText(s, maxChars) {
  const t = String(s || "").trim();
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars) + "\n...[تم قص النص لتفادي الأخطاء]";
}

function looksLikeAppointments(text) {
  return /موعد|مواعيد|حجز|احجز|حجوزات|حجزت|حجزي|appointment|booking|شفاء/i.test(String(text || ""));
}

function isEmergencyText(text) {
  return /(ألم صدر|الم صدر|ضيق نفس|صعوبة تنفس|اختناق|إغماء|اغماء|شلل|ضعف مفاجئ|نزيف شديد|تشنج|نوبة|افكار انتحارية|أفكار انتحارية|انتحار|ايذاء النفس|إيذاء النفس)/i.test(
    String(text || "")
  );
}

function inferCategoryFromMessage(message) {
  const t = String(message || "");

  if (isEmergencyText(t)) return "emergency";
  if (looksLikeAppointments(t)) return "appointments";
  // زر افهم تقريرك "غبي": نلتقطها فقط لو الرسالة قصيرة/زر
  if (/^(\s*📄\s*)?افهم\s*تقريرك\s*$/i.test(t) || /^📄\s*افهم\s*تقريرك\s*$/i.test(t)) return "report_button";

  if (/(قلق|توتر|اكتئاب|مزاج|نوم|أرق|panic|anxiety|depress)/i.test(t)) return "mental";
  if (/(bmi|كتلة الجسم|مؤشر كتلة|وزني|طولي)/i.test(t)) return "bmi";
  if (/(ضغط|ضغط الدم|systolic|diastolic|mmhg|ملم زئبقي)/i.test(t)) return "bp";
  if (/(سكر|سكري|glucose|mg\/dl|صائم|بعد الأكل|بعد الاكل|hba1c)/i.test(t)) return "sugar";
  if (/(ماء|سوائل|شرب|ترطيب|hydration)/i.test(t)) return "water";
  if (/(سعرات|calories|دايت|رجيم|تخسيس|تنحيف|زيادة وزن|نظام غذائي)/i.test(t)) return "calories";
  if (/(اسعافات|إسعافات|حروق|جرح|اختناق|إغماء|نزيف|كسر|first aid)/i.test(t)) return "first_aid";
  return "general";
}

function makeCard({
  title,
  category,
  verdict,
  tips,
  when_to_seek_help,
  next_question,
  quick_choices,
}) {
  return {
    title: title || "دليل العافية",
    category: category || "general",
    verdict: verdict || "",
    tips: Array.isArray(tips) ? tips : [],
    when_to_seek_help: when_to_seek_help || "",
    next_question: next_question || "",
    quick_choices: Array.isArray(quick_choices) ? quick_choices : [],
  };
}

function menuCard() {
  return makeCard({
    title: "دليل العافية",
    category: "general",
    verdict: "اختر خدمة:",
    tips: [],
    when_to_seek_help: "إذا أعراض خطيرة (ألم صدر/ضيق نفس/إغماء/نزيف شديد): طوارئ فورًا.",
    next_question: "وش تحب تبدأ فيه؟",
    quick_choices: [
      "🩸 السكر",
      "🫀 الضغط",
      "⚖️ BMI",
      "💧 شرب الماء",
      "🔥 السعرات",
      "🧠 المزاج",
      "🩹 إسعافات أولية",
      "📄 افهم تقريرك",
      "📅 مواعيد شفاء",
    ],
  });
}

function appointmentsCard() {
  return makeCard({
    title: "مواعيد شفاء",
    category: "appointments",
    verdict: "الحجز وإدارة المواعيد في سلطنة عُمان عبر تطبيق **شفاء** الرسمي:",
    tips: [`أندرويد: ${SHIFAA_ANDROID}`, `آيفون: ${SHIFAA_IOS}`],
    when_to_seek_help:
      "إذا أعراض طارئة أو شديدة (ألم صدر/ضيق نفس شديد/إغماء/ضعف مفاجئ): راجع الطوارئ فورًا.",
    next_question: "تبغاني أشرح خطوات الحجز داخل التطبيق؟",
    quick_choices: ["نعم", "لا"],
  });
}

function reportButtonCard() {
  return makeCard({
    title: "📄 افهم تقريرك",
    category: "report",
    verdict: "تمام. اضغط زر **📎 إرفاق ملف** وارفع **صورة أو PDF** للتقرير، وبعدها سأشرح لك النتائج **بلغة بسيطة**.",
    tips: ["حاول تغطي البيانات الشخصية إن أمكن."],
    when_to_seek_help: "إذا عندك أعراض قوية مع النتائج: راجع الطبيب/الطوارئ.",
    next_question: "جاهز ترفع التقرير؟",
    quick_choices: ["📎 إرفاق ملف", "إلغاء"],
  });
}

/* =========================
   Parsing inputs
========================= */
function parseBP(text) {
  // 120/80
  const m = String(text || "").match(/(\d{2,3})\s*\/\s*(\d{2,3})/);
  if (!m) return null;
  const sys = Number(m[1]);
  const dia = Number(m[2]);
  if (sys < 70 || sys > 260 || dia < 40 || dia > 160) return null;
  return { sys, dia };
}

function parseNumber(text) {
  const m = String(text || "").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function parseWeightHeight(text) {
  const t = String(text || "").toLowerCase();
  const w2 = t.match(/وزن\s*[:=]?\s*(\d{2,3})/i);
  const h2 = t.match(/طول\s*[:=]?\s*(\d{2,3})/i);

  // fallback: any kg/cm-ish numbers (weak)
  const w = w2 ? Number(w2[1]) : null;
  const h = h2 ? Number(h2[1]) : null;

  const W = w && w >= 25 && w <= 250 ? w : null;
  const H = h && h >= 100 && h <= 220 ? h : null;
  return { weightKg: W, heightCm: H };
}

function bmiFrom(weightKg, heightCm) {
  const h = heightCm / 100;
  const bmi = weightKg / (h * h);
  return Math.round(bmi * 10) / 10;
}

/* =========================
   Fixed logic (NO LLM)
========================= */

// ---------- SUGAR (flow)
function sugarStart(session) {
  session.flow = "sugar";
  session.step = 1;
  session.profile = {};
  METRICS.flows.sugarStarted++;
  bumpCategory("sugar");

  return makeCard({
    title: "🩸 مسار السكر",
    category: "sugar",
    verdict: "هذا مسار توعوي (بدون تشخيص).",
    tips: ["إذا عندك قراءة سكر حديثة قلّي الرقم (mg/dL) ووقتها (صائم/بعد الأكل/عشوائي)."],
    when_to_seek_help: "ألم صدر/ضيق نفس/إغماء/تشوش شديد: طوارئ فورًا.",
    next_question: "هل عندك **قراءة سكر** الآن أو خلال آخر يومين؟",
    quick_choices: ["نعم عندي رقم", "لا ما عندي"],
  });
}

function sugarContinue(session, message) {
  const m = String(message || "").trim();

  // Step 1 -> have reading?
  if (session.step === 1) {
    if (/لا/i.test(m)) {
      session.profile.hasReading = false;
      session.step = 2;
      return makeCard({
        title: "🩸 مسار السكر",
        category: "sugar",
        verdict: "تمام.",
        tips: [],
        when_to_seek_help: "",
        next_question: "وش هدفك الآن؟",
        quick_choices: ["تقليل الارتفاعات", "أكل مناسب", "نشاط يومي بسيط", "متابعة عامة"],
      });
    }
    session.profile.hasReading = true;
    session.step = 11;
    return makeCard({
      title: "🩸 مسار السكر",
      category: "sugar",
      verdict: "اكتب قراءة السكر ورمز الوقت.",
      tips: ["مثال: 110 صائم", "مثال: 180 بعد الأكل", "مثال: 140 عشوائي"],
      when_to_seek_help: "",
      next_question: "اكتبها الآن:",
      quick_choices: ["إلغاء"],
    });
  }

  // Step 11 -> parse reading
  if (session.step === 11) {
    const n = parseNumber(m);
    const when =
      /صائم/i.test(m) ? "fasting" : /بعد/i.test(m) ? "post" : /عشوائي|random/i.test(m) ? "random" : "unknown";

    if (!n || n < 30 || n > 800) {
      return makeCard({
        title: "🩸 مسار السكر",
        category: "sugar",
        verdict: "ما قدرت أفهم الرقم. اكتبها مثل: 110 صائم أو 180 بعد الأكل.",
        tips: [],
        when_to_seek_help: "",
        next_question: "جرّب مرة ثانية:",
        quick_choices: ["إلغاء"],
      });
    }

    session.profile.reading = { value: n, when };
    session.step = 2;

    return makeCard({
      title: "🩸 مسار السكر",
      category: "sugar",
      verdict: "تم.",
      tips: [],
      when_to_seek_help: "",
      next_question: "وش هدفك الآن؟",
      quick_choices: ["فهم القراءة", "تقليل الارتفاعات", "أكل مناسب", "نشاط يومي بسيط"],
    });
  }

  // Step 2 -> choose goal
  if (session.step === 2) {
    session.profile.goal = m;
    session.step = 3;
    return makeCard({
      title: "🩸 مسار السكر",
      category: "sugar",
      verdict: "سؤال أخير عشان أعطيك نصائح أدق:",
      tips: [],
      when_to_seek_help: "",
      next_question: "كيف نشاطك عادة؟",
      quick_choices: ["قليل", "متوسط", "نشط"],
    });
  }

  // Step 3 -> activity then final
  if (session.step === 3) {
    session.profile.activity = m;

    const card = sugarFinalCard(session.profile);
    METRICS.flows.sugarCompleted++;
    resetFlow(session);
    return card;
  }

  return null;
}

function sugarFinalCard(p) {
  const tips = [];

  // Reading interpretation (educational)
  if (p?.reading?.value) {
    const v = p.reading.value;
    const when = p.reading.when;

    if (when === "fasting") {
      tips.push("قراءة صائم غالبًا تكون أفضل عندما تكون ضمن نطاقات طبيعية. إذا تتكرر مرتفعة، ناقشها مع الطبيب.");
    } else if (when === "post") {
      tips.push("قراءة بعد الأكل تتأثر بنوع وكمية الكربوهيدرات وحجم الوجبة والمشي بعدها.");
    } else {
      tips.push("القراءة العشوائية تتأثر بآخر وجبة/نشاط/توتر. الأفضل تحديد: صائم أو بعد الأكل بساعتين.");
    }

    // safety triggers (no diagnosis)
    if (v >= 300) {
      tips.push("إذا قراءاتك تتكرر فوق 300 أو مع أعراض قوية (عطش شديد/تكرر التبول/غثيان/تشوش): راجع الطبيب فورًا وقد تحتاج طوارئ.");
    } else if (v <= 60) {
      tips.push("إذا القراءة منخفضة جدًا أو مع دوخة/تعرّق/رجفة: تعامل معها كحالة عاجلة واطلب مساعدة طبية.");
    }
  }

  // Goal-based advice
  const g = String(p?.goal || "");
  const act = String(p?.activity || "");

  if (/أكل/i.test(g) || /مناسب/i.test(g)) {
    tips.push("قسّم الكربوهيدرات على اليوم بدل وجبة واحدة كبيرة.");
    tips.push("قدّم البروتين والخضار أولًا في الوجبة، ثم النشويات (يساعد على تقليل الارتفاع السريع).");
    tips.push("اختر كربوهيدرات بطيئة: خبز أسمر/شوفان/بقوليات بدل الحلويات والمشروبات السكرية.");
  }

  if (/تقليل/i.test(g) || /الارتفاعات/i.test(g)) {
    tips.push("مشي خفيف 10–15 دقيقة بعد الأكل من أفضل الطرق لتقليل ارتفاع السكر (إذا وضعك الصحي يسمح).");
    tips.push("قلّل العصائر حتى لو “طبيعية” لأنها ترفع السكر بسرعة مقارنة بأكل الفاكهة كاملة.");
  }

  if (/نشاط/i.test(g) || /يومي/i.test(g) || /بسيط/i.test(g)) {
    tips.push("ابدأ بـ 5–10 دقائق مشي بعد وجبتين يوميًا ثم زد تدريجيًا.");
    tips.push("إذا ما تقدر رياضة: قف كل ساعة 2–3 دقائق، وتمشّى داخل البيت/المكتب.");
  }

  if (/فهم/i.test(g) || /القراءة/i.test(g)) {
    tips.push("أفضل مقارنة تكون لنفس النوع من القياس: صائم مقابل صائم، وبعد الأكل مقابل بعد الأكل.");
    tips.push("سجّل: الوقت + آخر وجبة + النشاط + النوم/الضغط النفسي. هذا يساعدك تفهم السبب.");
  }

  // Activity-level tweak
  if (/قليل/i.test(act)) {
    tips.push("ابدأ بتغيير واحد فقط لمدة أسبوع: مشي بعد وجبة واحدة يوميًا + تقليل العصائر.");
  } else if (/متوسط/i.test(act)) {
    tips.push("ثبّت روتين: 150 دقيقة نشاط أسبوعيًا (مشي موزع) لو تقدر، وركز على المشي بعد الأكل.");
  } else if (/نشط/i.test(act)) {
    tips.push("ممتاز. ركّز على توقيت الكربوهيدرات حول النشاط وراقب تأثيرها على قراءاتك.");
  }

  return makeCard({
    title: "🩸 مسار السكر",
    category: "sugar",
    verdict: "هذه نصائح عامة لتحسين التحكم بالسكر بدون تشخيص أو علاج:",
    tips,
    when_to_seek_help:
      "طوارئ فورًا إذا: تشوش شديد/إغماء/صعوبة تنفس/ألم صدر، أو قيء متكرر مع عطش شديد، أو قراءات عالية جدًا متكررة مع أعراض.",
    next_question: "تبغى نركز على (الأكل) ولا (النشاط)؟",
    quick_choices: ["الأكل", "النشاط", "رجوع للقائمة"],
  });
}

// ---------- BP (flow)
function bpStart(session) {
  session.flow = "bp";
  session.step = 1;
  session.profile = {};
  METRICS.flows.bpStarted++;
  bumpCategory("bp");

  return makeCard({
    title: "🫀 مسار الضغط",
    category: "bp",
    verdict: "مسار توعوي (بدون تشخيص).",
    tips: ["إذا عندك قراءة ضغط اكتبها مثل: 120/80."],
    when_to_seek_help: "ألم صدر/ضيق نفس/ضعف مفاجئ: طوارئ.",
    next_question: "هل عندك قراءة ضغط الآن/مؤخرًا؟",
    quick_choices: ["نعم عندي", "لا ما عندي"],
  });
}

function bpContinue(session, message) {
  const m = String(message || "").trim();

  if (session.step === 1) {
    if (/لا/i.test(m)) {
      session.profile.hasReading = false;
      session.step = 2;
      return makeCard({
        title: "🫀 مسار الضغط",
        category: "bp",
        verdict: "تمام.",
        tips: [],
        when_to_seek_help: "",
        next_question: "وش تبغى؟",
        quick_choices: ["نصائح عامة", "تقليل الملح", "نمط حياة", "رجوع للقائمة"],
      });
    }
    session.profile.hasReading = true;
    session.step = 11;
    return makeCard({
      title: "🫀 مسار الضغط",
      category: "bp",
      verdict: "اكتب القراءة مثل: 120/80",
      tips: [],
      when_to_seek_help: "",
      next_question: "اكتبها الآن:",
      quick_choices: ["إلغاء"],
    });
  }

  if (session.step === 11) {
    const bp = parseBP(m);
    if (!bp) {
      return makeCard({
        title: "🫀 مسار الضغط",
        category: "bp",
        verdict: "ما فهمت القراءة. اكتبها مثل: 120/80",
        tips: [],
        when_to_seek_help: "",
        next_question: "جرّب مرة ثانية:",
        quick_choices: ["إلغاء"],
      });
    }
    session.profile.bp = bp;
    session.step = 2;
    return makeCard({
      title: "🫀 مسار الضغط",
      category: "bp",
      verdict: "تم تسجيل القراءة.",
      tips: [],
      when_to_seek_help: "",
      next_question: "هل تحس بأعراض الآن؟",
      quick_choices: ["لا", "صداع شديد", "دوخة قوية", "ألم صدر/ضيق نفس"],
    });
  }

  if (session.step === 2) {
    session.profile.symptoms = m;
    const card = bpFinalCard(session.profile);
    METRICS.flows.bpCompleted++;
    resetFlow(session);
    return card;
  }

  return null;
}

function bpFinalCard(p) {
  const tips = [];
  const bp = p?.bp;

  if (bp) {
    tips.push(`قراءتك: ${bp.sys}/${bp.dia}. (هذا تفسير توعوي وليس تشخيص).`);
    if (bp.sys >= 180 || bp.dia >= 120) {
      tips.push("هذه قراءة عالية جدًا. إذا تتكرر أو مع أعراض قوية: توجّه للطوارئ.");
    } else if (bp.sys >= 140 || bp.dia >= 90) {
      tips.push("إذا تتكرر قراءات مرتفعة في أيام مختلفة، الأفضل مراجعة طبيب لتنظيم المتابعة.");
    } else if (bp.sys < 90 || bp.dia < 60) {
      tips.push("إذا القراءة منخفضة مع دوخة/إغماء: اطلب تقييم طبي.");
    } else {
      tips.push("عمومًا القراءة ضمن نطاقات مقبولة عند كثير من الناس، والمتابعة تكون حسب وضعك الصحي.");
    }
  }

  tips.push("قلّل الملح: ابتعد عن المعلبات/الوجبات السريعة/الشيبس.");
  tips.push("زد البوتاسيوم من الطعام (خضار/فاكهة) إذا ما عندك موانع طبية.");
  tips.push("امشِ 20–30 دقيقة أغلب الأيام لو تقدر.");
  tips.push("نوم كافي وتقليل التوتر يساعد كثير.");

  const s = String(p?.symptoms || "");
  let when = "راجع الطبيب إذا: قراءات مرتفعة متكررة، أو صداع/دوخة مستمرة.";
  if (/ألم|ضيق/i.test(s)) {
    when = "ألم صدر/ضيق نفس/ضعف مفاجئ: طوارئ فورًا.";
  } else if (/صداع|دوخة/i.test(s)) {
    when = "إذا صداع شديد جدًا أو دوخة قوية مع قراءة عالية: راجع الطوارئ.";
  }

  return makeCard({
    title: "🫀 مسار الضغط",
    category: "bp",
    verdict: "نصائح عامة للضغط (بدون علاج/أدوية):",
    tips,
    when_to_seek_help: when,
    next_question: "تبغى خطة أسبوعية بسيطة لتقليل الملح؟",
    quick_choices: ["نعم", "لا", "رجوع للقائمة"],
  });
}

// ---------- BMI (flow)
function bmiStart(session) {
  session.flow = "bmi";
  session.step = 1;
  session.profile = {};
  METRICS.flows.bmiStarted++;
  bumpCategory("bmi");

  return makeCard({
    title: "⚖️ مسار BMI",
    category: "bmi",
    verdict: "مسار توعوي. نقدر نحسب BMI لو عطيتني وزن وطول.",
    tips: ["مثال: وزن 70 طول 170"],
    when_to_seek_help: "",
    next_question: "هل تريد حساب BMI الآن؟",
    quick_choices: ["أحسب", "بدون حساب"],
  });
}

function bmiContinue(session, message) {
  const m = String(message || "").trim();

  if (session.step === 1) {
    if (/بدون/i.test(m)) {
      session.profile.calc = false;
      session.step = 2;
      return makeCard({
        title: "⚖️ مسار BMI",
        category: "bmi",
        verdict: "تمام.",
        tips: [],
        when_to_seek_help: "",
        next_question: "وش هدفك؟",
        quick_choices: ["إنقاص وزن", "زيادة وزن", "تحسين لياقة", "متابعة عامة"],
      });
    }
    session.profile.calc = true;
    session.step = 11;
    return makeCard({
      title: "⚖️ مسار BMI",
      category: "bmi",
      verdict: "اكتب الوزن والطول مثل: وزن 70 طول 170",
      tips: [],
      when_to_seek_help: "",
      next_question: "اكتبها الآن:",
      quick_choices: ["إلغاء"],
    });
  }

  if (session.step === 11) {
    const { weightKg, heightCm } = parseWeightHeight(m);
    if (!weightKg || !heightCm) {
      return makeCard({
        title: "⚖️ مسار BMI",
        category: "bmi",
        verdict: "ما قدرت أطلع وزن وطول. اكتبها مثل: وزن 70 طول 170",
        tips: [],
        when_to_seek_help: "",
        next_question: "جرّب مرة ثانية:",
        quick_choices: ["إلغاء"],
      });
    }
    session.profile.weightKg = weightKg;
    session.profile.heightCm = heightCm;
    session.profile.bmi = bmiFrom(weightKg, heightCm);
    session.step = 2;
    return makeCard({
      title: "⚖️ مسار BMI",
      category: "bmi",
      verdict: `BMI لديك تقريبًا: ${session.profile.bmi}`,
      tips: ["هذا رقم توعوي عام وليس تشخيص."],
      when_to_seek_help: "",
      next_question: "وش هدفك؟",
      quick_choices: ["إنقاص وزن", "زيادة وزن", "تحسين لياقة", "متابعة عامة"],
    });
  }

  if (session.step === 2) {
    session.profile.goal = m;
    const card = bmiFinalCard(session.profile);
    METRICS.flows.bmiCompleted++;
    resetFlow(session);
    return card;
  }

  return null;
}

function bmiFinalCard(p) {
  const tips = [];
  const goal = String(p?.goal || "");
  if (p?.bmi) tips.push(`BMI التقريبي: ${p.bmi} (مؤشر عام).`);

  if (/إنقاص/i.test(goal)) {
    tips.push("ابدأ بتقليل المشروبات السكرية/العصائر أولًا (أكبر فرق بأقل مجهود).");
    tips.push("نص الوجبة خضار، ربع بروتين، ربع نشويات.");
    tips.push("مشي خفيف 20 دقيقة أغلب الأيام لو تقدر.");
  } else if (/زيادة/i.test(goal)) {
    tips.push("زد السعرات بطريقة صحية: مكسرات/زبدة فول/أفوكادو/حليب/بيض.");
    tips.push("أضف وجبة خفيفة بين الوجبات (ساندويتش بروتين/زبادي).");
  } else if (/لياقة/i.test(goal)) {
    tips.push("ركز على الاستمرارية: 3 أيام حركة خفيفة أسبوعيًا أفضل من دفعة قوية ثم توقف.");
    tips.push("تمارين مقاومة بسيطة بالبيت تفيد (بدون وصف برامج علاجية).");
  } else {
    tips.push("راقب الوزن مرة أسبوعيًا وليس يوميًا.");
    tips.push("نوم 7–8 ساعات يقلل الشهية ويضبط العادات.");
  }

  return makeCard({
    title: "⚖️ مسار BMI",
    category: "bmi",
    verdict: "نصائح عامة حسب هدفك:",
    tips,
    when_to_seek_help: "إذا عندك فقدان وزن سريع غير مبرر، أو تعب شديد مستمر: راجع الطبيب.",
    next_question: "تبغى خطة أسبوعية بسيطة للأكل؟",
    quick_choices: ["نعم", "لا", "رجوع للقائمة"],
  });
}

// ---------- WATER (flow)
function waterStart(session) {
  session.flow = "water";
  session.step = 1;
  session.profile = {};
  METRICS.flows.waterStarted++;
  bumpCategory("water");

  return makeCard({
    title: "💧 مسار شرب الماء",
    category: "water",
    verdict: "خلّنا نطلع لك هدف شرب تقريبي (توعوي).",
    tips: ["إذا عندك أمراض كلى/قلب أو منع سوائل: لازم تسأل طبيبك قبل زيادة كبيرة."],
    when_to_seek_help: "",
    next_question: "وش نشاطك اليومي غالبًا؟",
    quick_choices: ["خفيف (مكتبي)", "متوسط", "عالي/رياضة"],
  });
}

function waterContinue(session, message) {
  const m = String(message || "").trim();

  if (session.step === 1) {
    session.profile.activity = m;
    session.step = 2;
    return makeCard({
      title: "💧 مسار شرب الماء",
      category: "water",
      verdict: "كيف الجو عندك غالبًا؟",
      tips: [],
      when_to_seek_help: "",
      next_question: "",
      quick_choices: ["معتدل", "حار", "مكيف أغلب الوقت"],
    });
  }

  if (session.step === 2) {
    session.profile.climate = m;
    session.step = 3;
    return makeCard({
      title: "💧 مسار شرب الماء",
      category: "water",
      verdict: "اكتب وزنك بالكيلو (اختياري) أو اكتب: تخطي",
      tips: ["مثال: 70"],
      when_to_seek_help: "",
      next_question: "",
      quick_choices: ["تخطي"],
    });
  }

  if (session.step === 3) {
    if (/تخطي/i.test(m)) {
      session.profile.weightKg = null;
    } else {
      const n = parseNumber(m);
      session.profile.weightKg = n && n >= 25 && n <= 250 ? n : null;
    }

    const card = waterFinalCard(session.profile);
    METRICS.flows.waterCompleted++;
    resetFlow(session);
    return card;
  }

  return null;
}

function waterFinalCard(p) {
  // تقدير بسيط: 30ml/kg base (حد أدنى)، ثم تعديل للنشاط والحر
  const w = p?.weightKg;
  let baseL = w ? (w * 30) / 1000 : 2.0; // إذا ما عنده وزن نعطي 2 لتر كبداية عامة
  let extra = 0;

  if (/عالي/i.test(p?.activity || "")) extra += 0.7;
  else if (/متوسط/i.test(p?.activity || "")) extra += 0.4;

  if (/حار/i.test(p?.climate || "")) extra += 0.5;
  if (/مكيف/i.test(p?.climate || "")) extra += 0.2;

  let target = Math.round((baseL + extra) * 10) / 10;
  if (target < 1.5) target = 1.5;
  if (target > 4.5) target = 4.5;

  const tips = [
    `هدف تقريبي: حوالي **${target} لتر/اليوم** (توعوي).`,
    "وزّعها: كوب بعد الاستيقاظ + كوب مع كل وجبة + كوب بين الوجبات.",
    "لون البول الفاتح غالبًا علامة ترطيب جيد (مع استثناءات).",
    "قلّل القهوة إذا تلاحظ أنها تقلل شرب الماء عندك.",
  ];

  return makeCard({
    title: "💧 مسار شرب الماء",
    category: "water",
    verdict: "خطة شرب ماء مبسطة:",
    tips,
    when_to_seek_help: "إذا عندك تورم شديد/ضيق نفس/أمراض كلى أو قلب: استشر الطبيب قبل زيادة السوائل.",
    next_question: "تبغى تذكير بسيط (متى تشرب خلال اليوم)؟",
    quick_choices: ["نعم", "لا", "رجوع للقائمة"],
  });
}

// ---------- CALORIES (flow)
function caloriesStart(session) {
  session.flow = "calories";
  session.step = 1;
  session.profile = {};
  METRICS.flows.caloriesStarted++;
  bumpCategory("calories");

  return makeCard({
    title: "🔥 مسار الأكل والسعرات",
    category: "calories",
    verdict: "هذا مسار توعوي للأكل الصحي (بدون خطط علاجية).",
    tips: [],
    when_to_seek_help: "",
    next_question: "وش هدفك؟",
    quick_choices: ["إنقاص وزن", "تثبيت وزن", "زيادة وزن", "أكل صحي"],
  });
}

function caloriesContinue(session, message) {
  const m = String(message || "").trim();

  if (session.step === 1) {
    session.profile.goal = m;
    session.step = 2;
    return makeCard({
      title: "🔥 مسار الأكل والسعرات",
      category: "calories",
      verdict: "وش مستوى نشاطك؟",
      tips: [],
      when_to_seek_help: "",
      next_question: "",
      quick_choices: ["خفيف", "متوسط", "عالي"],
    });
  }

  if (session.step === 2) {
    session.profile.activity = m;
    const card = caloriesFinalCard(session.profile);
    METRICS.flows.caloriesCompleted++;
    resetFlow(session);
    return card;
  }

  return null;
}

function caloriesFinalCard(p) {
  const goal = String(p?.goal || "");
  const tips = [];

  tips.push("قاعدة سهلة: نصف الطبق خضار، ربع بروتين، ربع نشويات.");
  tips.push("ابدأ بتغيير واحد فقط أسبوعيًا (أسهل للاستمرار).");

  if (/إنقاص/i.test(goal)) {
    tips.push("احذف/قلّل: العصائر والمشروبات الغازية والحلويات السائلة أولًا.");
    tips.push("زد البروتين في الفطور يقلل الجوع بقية اليوم.");
  } else if (/زيادة/i.test(goal)) {
    tips.push("زِد السعرات من مصادر مفيدة: مكسرات/زبدة فول/زيت زيتون/حليب/بيض.");
    tips.push("أضف وجبة خفيفة ثابتة يوميًا.");
  } else if (/تثبيت/i.test(goal)) {
    tips.push("حافظ على مواعيد ثابتة للأكل وتجنب الأكل العشوائي ليلًا.");
  } else {
    tips.push("اختر وجبة صحية جاهزة عند الجوع: زبادي + فاكهة + مكسرات.");
  }

  if (/عالي/i.test(String(p?.activity || ""))) {
    tips.push("مع النشاط العالي: ركّز على وجبات متوازنة، واشرب ماء كفاية.");
  }

  return makeCard({
    title: "🔥 مسار الأكل والسعرات",
    category: "calories",
    verdict: "نصائح أكل عملية:",
    tips,
    when_to_seek_help: "إذا عندك دوخة شديدة/ضعف عام/نقص وزن سريع غير مبرر: راجع الطبيب.",
    next_question: "تبغى أمثلة وجبات (فطور/غداء/عشاء)؟",
    quick_choices: ["نعم", "لا", "رجوع للقائمة"],
  });
}

// ---------- MENTAL (flow)
function mentalStart(session) {
  session.flow = "mental";
  session.step = 1;
  session.profile = {};
  METRICS.flows.mentalStarted++;
  bumpCategory("mental");

  return makeCard({
    title: "🧠 مسار المزاج",
    category: "mental",
    verdict: "هذا دعم توعوي وليس علاج نفسي.",
    tips: [],
    when_to_seek_help: "إذا أفكار إيذاء النفس: اطلب مساعدة فورية.",
    next_question: "خلال آخر أسبوع، مزاجك غالبًا؟",
    quick_choices: ["ممتاز", "جيد", "متعب", "سيئ"],
  });
}

function mentalContinue(session, message) {
  const m = String(message || "").trim();

  if (session.step === 1) {
    session.profile.mood = m;
    session.step = 2;
    return makeCard({
      title: "🧠 مسار المزاج",
      category: "mental",
      verdict: "كيف نومك؟",
      tips: [],
      when_to_seek_help: "",
      next_question: "",
      quick_choices: ["جيد", "متوسط", "سيئ", "أرق شديد"],
    });
  }

  if (session.step === 2) {
    session.profile.sleep = m;
    session.step = 3;
    return makeCard({
      title: "🧠 مسار المزاج",
      category: "mental",
      verdict: "وش أكثر شيء يضغط عليك؟",
      tips: [],
      when_to_seek_help: "",
      next_question: "",
      quick_choices: ["قلق", "توتر", "حزن", "ضغط عمل", "أفكار كثيرة"],
    });
  }

  if (session.step === 3) {
    session.profile.stress = m;
    const card = mentalFinalCard(session.profile);
    METRICS.flows.mentalCompleted++;
    resetFlow(session);
    return card;
  }

  return null;
}

function mentalFinalCard(p) {
  const tips = [
    "تنفّس 4-6: شهيق 4 ثواني، زفير 6 ثواني لمدة دقيقتين.",
    "قلّل الكافيين بعد العصر.",
    "نوم: نفس وقت النوم/الاستيقاظ قدر الإمكان.",
    "اكتب 3 نقاط: (وش مقلقني؟ وش أقدر أسوي الآن؟ وش بخليه لبعدين؟).",
    "لو تقدر: مشي خفيف 10 دقائق يخفف التوتر.",
  ];

  return makeCard({
    title: "🧠 مسار المزاج",
    category: "mental",
    verdict: "خطوات بسيطة تساعد غالبًا:",
    tips,
    when_to_seek_help:
      "إذا أعراض اكتئاب شديدة لأكثر من أسبوعين، أو نوبات هلع متكررة، أو أفكار إيذاء النفس: اطلب مساعدة مختص فورًا.",
    next_question: "تبغى تمارين تهدئة لمدة دقيقتين الآن؟",
    quick_choices: ["نعم", "لا", "رجوع للقائمة"],
  });
}

// ---------- FIRST AID (flow)
function firstAidStart(session) {
  session.flow = "first_aid";
  session.step = 1;
  session.profile = {};
  METRICS.flows.first_aidStarted++;
  bumpCategory("first_aid");

  return makeCard({
    title: "🩹 إسعافات أولية",
    category: "general",
    verdict: "اختر الحالة:",
    tips: [],
    when_to_seek_help: "فقدان وعي/نزيف شديد/صعوبة تنفس: طوارئ فورًا.",
    next_question: "",
    quick_choices: ["حروق بسيطة", "جرح/نزيف بسيط", "اختناق", "إغماء", "التواء/كدمة"],
  });
}

function firstAidContinue(session, message) {
  const m = String(message || "").trim();
  if (session.step === 1) {
    const card = firstAidFinalCard(m);
    METRICS.flows.first_aidCompleted++;
    resetFlow(session);
    return card;
  }
  return null;
}

function firstAidFinalCard(scenario) {
  const s = String(scenario || "");

  if (/حروق/i.test(s)) {
    return makeCard({
      title: "🩹 إسعافات: حروق بسيطة",
      category: "general",
      verdict: "إرشاد عام:",
      tips: [
        "برّد مكان الحرق بماء فاتر/بارد لمدة 10–20 دقيقة.",
        "لا تضع معجون/زيوت/معجون أسنان.",
        "غطّه بشاش نظيف غير لاصق.",
        "إذا ظهرت فقاعات كبيرة أو الألم شديد: راجع الطبيب.",
      ],
      when_to_seek_help: "حروق بالوجه/اليدين/الأعضاء الحساسة أو مساحة كبيرة: طوارئ/مستشفى.",
      next_question: "تبغى ترجع للقائمة؟",
      quick_choices: ["رجوع للقائمة"],
    });
  }

  if (/جرح|نزيف/i.test(s)) {
    return makeCard({
      title: "🩹 إسعافات: جرح/نزيف بسيط",
      category: "general",
      verdict: "إرشاد عام:",
      tips: [
        "اضغط على الجرح بقطعة نظيفة 10 دقائق.",
        "ارفع الطرف المصاب إن أمكن.",
        "نظف حول الجرح بماء وصابون (بدون فرك داخل الجرح بقوة).",
        "إذا النزيف ما وقف أو الجرح عميق: راجع الطوارئ.",
      ],
      when_to_seek_help: "نزيف لا يتوقف/جرح عميق/علامات عدوى (احمرار شديد/صديد/حمى): راجع الطبيب.",
      next_question: "تبغى ترجع للقائمة؟",
      quick_choices: ["رجوع للقائمة"],
    });
  }

  if (/اختناق/i.test(s)) {
    return makeCard({
      title: "🩹 إسعافات: اختناق",
      category: "general",
      verdict: "إرشاد عام (إذا الشخص واعي وما يقدر يتنفس/يتكلم):",
      tips: [
        "اطلب الإسعاف فورًا.",
        "نفّذ مناورة دفع البطن (Heimlich) إذا كنت مدربًا.",
        "إذا فقد الوعي: ابدأ إنعاش/CPR إن كنت تعرف.",
      ],
      when_to_seek_help: "الآن — طوارئ فورًا.",
      next_question: "هل الشخص واعي؟",
      quick_choices: ["نعم", "لا"],
    });
  }

  if (/إغماء/i.test(s)) {
    return makeCard({
      title: "🩹 إسعافات: إغماء",
      category: "general",
      verdict: "إرشاد عام:",
      tips: [
        "مدده على الأرض وارفع رجليه قليلًا إذا أمكن.",
        "افتح مجرى التنفس وتأكد أنه يتنفس.",
        "لا تعطه أكل/شرب وهو غير واعي.",
        "إذا استمر أكثر من دقيقة أو مع تشنج/ألم صدر: طوارئ.",
      ],
      when_to_seek_help: "ألم صدر/ضيق نفس/تشنج/إصابة بالرأس: طوارئ فورًا.",
      next_question: "تبغى ترجع للقائمة؟",
      quick_choices: ["رجوع للقائمة"],
    });
  }

  // التواء/كدمة
  return makeCard({
    title: "🩹 إسعافات: التواء/كدمة",
    category: "general",
    verdict: "إرشاد عام:",
    tips: [
      "راحة + تبريد 10–15 دقيقة كل عدة ساعات أول يوم.",
      "رفع الطرف المصاب إن أمكن.",
      "رباط ضاغط خفيف (بدون قطع الدورة).",
      "إذا ألم شديد جدًا أو تشوه أو عدم القدرة على المشي: راجع الطوارئ.",
    ],
    when_to_seek_help: "تشوه/ألم شديد/تنميل/ازرقاق: طوارئ/مستشفى.",
    next_question: "تبغى ترجع للقائمة؟",
    quick_choices: ["رجوع للقائمة"],
  });
}

/* =========================
   Flow router
========================= */
function startFlow(session, key) {
  if (key === "sugar") return sugarStart(session);
  if (key === "bp") return bpStart(session);
  if (key === "bmi") return bmiStart(session);
  if (key === "water") return waterStart(session);
  if (key === "calories") return caloriesStart(session);
  if (key === "mental") return mentalStart(session);
  if (key === "first_aid") return firstAidStart(session);
  return menuCard();
}

function continueFlow(session, message) {
  const flow = session.flow;
  if (flow === "sugar") return sugarContinue(session, message);
  if (flow === "bp") return bpContinue(session, message);
  if (flow === "bmi") return bmiContinue(session, message);
  if (flow === "water") return waterContinue(session, message);
  if (flow === "calories") return caloriesContinue(session, message);
  if (flow === "mental") return mentalContinue(session, message);
  if (flow === "first_aid") return firstAidContinue(session, message);
  return null;
}

/* =========================
   REPORT parsing + simple explanation
========================= */
function simplifyLabText(text) {
  // تبسيط كلمات شائعة
  const dict = [
    [/hemoglobin|hb\b|hgb\b/gi, "الهيموغلوبين (بروتين يحمل الأكسجين في الدم)"],
    [/wbc/gi, "كريات الدم البيضاء (مناعة)"],
    [/rbc/gi, "كريات الدم الحمراء"],
    [/platelets|plt/gi, "الصفائح الدموية (تجلّط الدم)"],
    [/hba1c/gi, "السكر التراكمي (متوسط السكر خلال 3 أشهر)"],
    [/glucose/gi, "سكر الدم"],
    [/cholesterol/gi, "الكوليسترول"],
    [/triglycerides/gi, "الدهون الثلاثية"],
    [/creatinine/gi, "الكرياتينين (مؤشر لوظائف الكلى)"],
    [/alt\b/gi, "ALT (إنزيم من الكبد)"],
    [/ast\b/gi, "AST (إنزيم من الكبد)"],
    [/vitamin d|vit d/gi, "فيتامين د"],
    [/uric acid/gi, "حمض اليوريك"],
    [/tsh/gi, "TSH (هرمون الغدة الدرقية)"],
  ];

  let out = String(text || "");
  for (const [re, rep] of dict) out = out.replace(re, rep);
  // تنظيف المسافات
  out = out.replace(/\s+/g, " ").trim();
  return out;
}

function extractLikelyResults(text) {
  // نحاول نلقط سطور فيها "اسم + رقم"
  const t = String(text || "");
  const lines = t.split(/\n+/).map((x) => x.trim()).filter(Boolean);
  const picked = [];
  for (const line of lines) {
    if (picked.length >= 12) break;
    if (/[A-Za-z]{2,}.*\d/.test(line) || /[اأإء-ي].*\d/.test(line)) {
      // avoid super long
      if (line.length <= 120) picked.push(line);
    }
  }
  return picked;
}

function buildReportCard(extractedText) {
  const raw = clampText(extractedText, 6000);
  const simplified = simplifyLabText(raw);
  const likely = extractLikelyResults(raw);

  const tips = [];
  if (likely.length) {
    tips.push("هذه أبرز البنود التي ظهرت في التقرير (كما هي تقريبًا):");
    for (const l of likely.slice(0, 8)) tips.push("• " + simplifyLabText(l));
  } else {
    tips.push("لم أستطع استخراج بنود واضحة بالأرقام. حاول صورة أوضح أو PDF نصي.");
  }

  tips.push("ملاحظة: الشرح هنا مبسط وعام، والقرار الطبي يعتمد على حالتك وأعراضك وتاريخك الصحي.");

  return makeCard({
    title: "📄 شرح مبسط للتقرير",
    category: "report",
    verdict:
      "سأشرح لك المصطلحات بلغة سهلة قدر الإمكان. إذا عندك أعراض أو قلق من نتيجة معينة، الأفضل تعرض التقرير على طبيب.",
    tips,
    when_to_seek_help:
      "راجع الطبيب فورًا إذا: إغماء/ضيق نفس/ألم صدر/نزيف غير مبرر/حمى شديدة، أو إذا أوصى التقرير بمراجعة عاجلة.",
    next_question: "إذا تبغى: اكتب لي أي رقم/سطر تقلق منه وسأشرحه بشكل أبسط.",
    quick_choices: ["رجوع للقائمة"],
  });
}

/* =========================
   Routes
========================= */
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "Dalil Alafiyah API (Fixed Logic)",
    routes: ["/chat", "/report", "/reset", "/metrics"],
  });
});

app.get("/metrics", (req, res) => {
  res.json({ ok: true, data: METRICS });
});

app.post("/reset", (req, res) => {
  const userId = req.header("x-user-id") || "anon";
  sessions.delete(userId);
  res.json({ ok: true });
});

app.post("/chat", async (req, res) => {
  const t0 = Date.now();
  METRICS.chatRequests++;

  try {
    const userId = req.header("x-user-id") || "anon";
    const session = getSession(userId);

    const message = String(req.body?.message || "").trim();
    if (!message) return res.status(400).json({ ok: false, error: "empty_message" });

    // reset commands
    if (/^(إلغاء|الغاء|cancel|مسح|مسح المحادثة|ابدأ من جديد|ابدأ جديد)$/i.test(message)) {
      resetFlow(session);
      const card = menuCard();
      session.lastCard = card;
      METRICS.chatOk++;
      updateAvgLatency(Date.now() - t0);
      return res.json({ ok: true, data: card });
    }

    // emergency
    if (isEmergencyText(message)) {
      METRICS.emergencyTriggers++;
      const card = makeCard({
        title: "⚠️ تنبيه طارئ",
        category: "emergency",
        verdict: "الأعراض المذكورة قد تكون خطيرة. توجّه للطوارئ/اتصل بالإسعاف فورًا.",
        tips: ["لا تنتظر.", "إذا معك شخص، اطلب مساعدته فورًا."],
        when_to_seek_help: "الآن.",
        next_question: "هل أنت في أمان الآن؟",
        quick_choices: ["نعم", "لا"],
      });
      session.lastCard = card;
      bumpCategory("emergency");
      METRICS.chatOk++;
      updateAvgLatency(Date.now() - t0);
      return res.json({ ok: true, data: card });
    }

    // appointments
    if (looksLikeAppointments(message)) {
      const card = appointmentsCard();
      session.lastCard = card;
      bumpCategory("appointments");
      METRICS.chatOk++;
      updateAvgLatency(Date.now() - t0);
      return res.json({ ok: true, data: card });
    }

    // report button (dumb)
    if (inferCategoryFromMessage(message) === "report_button") {
      const card = reportButtonCard();
      session.lastCard = card;
      bumpCategory("report");
      METRICS.chatOk++;
      updateAvgLatency(Date.now() - t0);
      return res.json({ ok: true, data: card });
    }

    // handle "رجوع للقائمة"
    if (/رجوع\s*للقائمة|القائمة|منيو/i.test(message)) {
      resetFlow(session);
      const card = menuCard();
      session.lastCard = card;
      METRICS.chatOk++;
      updateAvgLatency(Date.now() - t0);
      return res.json({ ok: true, data: card });
    }

    // start flows
    const startMap = [
      { key: "sugar", match: /🩸|سكر|السكر/i },
      { key: "bp", match: /🫀|ضغط|الضغط/i },
      { key: "bmi", match: /⚖️|bmi|BMI|كتلة/i },
      { key: "water", match: /💧|ماء|شرب الماء|ترطيب/i },
      { key: "calories", match: /🔥|سعرات|calories|رجيم|دايت/i },
      { key: "mental", match: /🧠|مزاج|قلق|توتر|اكتئاب/i },
      { key: "first_aid", match: /🩹|اسعافات|إسعافات|حروق|جرح/i },
    ];

    if (!session.flow) {
      const matched = startMap.find((x) => x.match.test(message));
      if (matched) {
        const card = startFlow(session, matched.key);
        session.lastCard = card;
        METRICS.chatOk++;
        updateAvgLatency(Date.now() - t0);
        return res.json({ ok: true, data: card });
      }

      // default if user talks free-form: show menu (fixed)
      const card = menuCard();
      session.lastCard = card;
      METRICS.chatOk++;
      updateAvgLatency(Date.now() - t0);
      return res.json({ ok: true, data: card });
    }

    // continue active flow
    const card = continueFlow(session, message);
    if (card) {
      session.lastCard = card;
      METRICS.chatOk++;
      updateAvgLatency(Date.now() - t0);
      return res.json({ ok: true, data: card });
    }

    // if somehow no match: fallback menu
    resetFlow(session);
    const fallback = menuCard();
    session.lastCard = fallback;
    METRICS.chatOk++;
    updateAvgLatency(Date.now() - t0);
    return res.json({ ok: true, data: fallback });
  } catch (err) {
    console.error("[chat] FAILED:", err?.message || err);
    METRICS.chatFail++;
    updateAvgLatency(Date.now() - t0);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/report", upload.single("file"), async (req, res) => {
  const t0 = Date.now();
  METRICS.reportRequests++;

  try {
    const userId = req.header("x-user-id") || "anon";
    const session = getSession(userId);

    const file = req.file;
    if (!file) return res.status(400).json({ ok: false, error: "missing_file" });

    let extracted = "";

    if (file.mimetype === "application/pdf") {
      const parsed = await pdfParse(file.buffer).catch(() => null);
      extracted = parsed?.text ? String(parsed.text) : "";
      extracted = extracted.trim();

      if (extracted.replace(/\s+/g, "").length < 40) {
        METRICS.reportFail++;
        updateAvgLatency(Date.now() - t0);
        return res.json({
          ok: false,
          error: "pdf_no_text",
          message:
            "هذا PDF يبدو ممسوح (Scan) ولا يحتوي نصًا قابلًا للنسخ. ارفع صورة واضحة للتقرير أو PDF نصي.",
        });
      }
    } else if (file.mimetype.startsWith("image/")) {
      extracted = await ocrImageBuffer(file.buffer);
      extracted = extracted.trim();

      if (extracted.replace(/\s+/g, "").length < 25) {
        METRICS.reportFail++;
        updateAvgLatency(Date.now() - t0);
        return res.json({
          ok: false,
          error: "ocr_failed",
          message: "الصورة ما انقرت بوضوح. حاول صورة أوضح (إضاءة جيدة + قصّ منطقة النتائج).",
        });
      }
    } else {
      METRICS.reportFail++;
      updateAvgLatency(Date.now() - t0);
      return res.status(400).json({ ok: false, error: "unsupported_type" });
    }

    const card = buildReportCard(extracted);
    session.lastCard = card;

    bumpCategory("report");
    METRICS.reportOk++;
    updateAvgLatency(Date.now() - t0);

    return res.json({ ok: true, data: card });
  } catch (err) {
    console.error("[report] FAILED:", err?.message || err);
    METRICS.reportFail++;
    updateAvgLatency(Date.now() - t0);
    return res.status(502).json({
      ok: false,
      error: "report_error",
      message: "تعذر تحليل التقرير الآن. جرّب صورة أوضح أو PDF نصي.",
    });
  }
});

/* =========================
   Start
========================= */
app.listen(PORT, () => {
  console.log(`🚀 Dalil Alafiyah API يعمل على http://localhost:${PORT}`);
});
