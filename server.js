// ===============================
// server.js — Dalil Alafiyah API
// - Calculators return PLAIN (no cards)
// - Other replies use CARD JSON
// - Compatible with app.js: /chat /report /reset
// ===============================

import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import multer from "multer";
import rateLimit from "express-rate-limit";
import fetch from "node-fetch";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
let pdfParse = null;
try {
  pdfParse = require("pdf-parse");
} catch {}

let createWorker = null;
try {
  ({ createWorker } = await import("tesseract.js"));
} catch {}

const app = express();
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });

// ===============================
// ENV
// ===============================
const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

// Optional: internal key
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || "";

// ===============================
// Middleware
// ===============================
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

app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-user-id", "x-api-key"],
  })
);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

// ===============================
// Helpers
// ===============================
function plain(text) {
  // ✅ For calculators: app.js will render with addMsg() (no card)
  return { mode: "plain", text: String(text || "").trim() };
}

function card({
  category = "general",
  title = "دليل العافية",
  verdict = "",
  next_question = "",
  quick_choices = [],
  tips = [],
  when_to_seek_help = "",
}) {
  return {
    category,
    title,
    verdict,
    next_question,
    quick_choices: Array.isArray(quick_choices) ? quick_choices : [],
    tips: Array.isArray(tips) ? tips : [],
    when_to_seek_help,
  };
}

function clampText(s, maxChars) {
  const t = String(s || "").trim();
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars) + "\n...[تم قص النص]";
}

function parseNumber(text) {
  const m = String(text || "").match(/(\d+(\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

function clampNum(n, min, max) {
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

function parseBP(text) {
  const m = String(text || "").match(/(\d{2,3})\s*\/\s*(\d{2,3})/);
  if (!m) return null;
  const s = Number(m[1]);
  const d = Number(m[2]);
  if (!clampNum(s, 70, 260) || !clampNum(d, 40, 160)) return null;
  return { s, d };
}

function detectSugarUnit(text) {
  if (/mmol/i.test(String(text || ""))) return "mmol";
  return "mgdl";
}
function sugarToMgdl(value, unit) {
  if (unit === "mmol") return Math.round(value * 18);
  return Math.round(value);
}

function isCancel(t) {
  return /^(إلغاء|الغاء|cancel|مسح|ابدأ من جديد|ابدأ جديد|رجوع|عودة|القائمة)$/i.test(
    String(t || "").trim()
  );
}

function isCalculatorsIntent(t) {
  return /حاسبات|الحاسبات|🧮/i.test(String(t || ""));
}

function pickCalcFromText(t) {
  const s = String(t || "");
  if (/BMI|كتلة الجسم|⚖️/i.test(s)) return "bmi";
  if (/سعرات|🔥/i.test(s)) return "calories";
  if (/ماء|💧/i.test(s)) return "water";
  if (/ضغط|💓/i.test(s)) return "bp";
  if (/سكر|🩸/i.test(s)) return "sugar";
  if (/مزاج|🧠/i.test(s)) return "mood";
  return null;
}

function reportEntryCard() {
  return card({
    category: "report",
    title: "افهم تقريرك",
    verdict: "تمام. ارفع صورة أو PDF للتقرير في زر المرفق، وأنا أشرح بشكل عام.",
    tips: ["لا ترفع بيانات شخصية حساسة إن أمكن."],
    when_to_seek_help: "إذا أعراض شديدة مع التقرير: راجع الطبيب/الطوارئ.",
    next_question: "جاهز ترفع التقرير؟",
    quick_choices: ["📎 إضافة مرفق", "إلغاء"],
  });
}

function isReportIntent(text) {
  const t = String(text || "");
  return /(افهم\s*تقرير|تقرير|تحاليل|تحليل|نتيجة|lab|report|pdf)/i.test(t);
}

// ===============================
// Sessions (for calculators steps)
// ===============================
const sessions = new Map(); // userId -> { calc:{name,step,data}, ts }

function getUserId(req) {
  return req.header("x-user-id") || "anon";
}
function getSession(userId) {
  if (!sessions.has(userId)) sessions.set(userId, { calc: null, ts: Date.now() });
  const s = sessions.get(userId);
  s.ts = Date.now();
  return s;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) {
    if (now - (v.ts || 0) > 24 * 60 * 60 * 1000) sessions.delete(k);
  }
}, 30 * 60 * 1000);

// ===============================
// Calculators (PLAIN responses)
// ===============================
function calculatorsMenuPlain() {
  return plain(
    "🧮 الحاسبات (اكتب واحدة من الصيغ التالية):\n" +
      "• BMI وزن 70 طول 170\n" +
      "• ماء وزن 70 نشاط متوسط جو حار\n" +
      "• ضغط 120/80\n" +
      "• سكر صائم 95  (أو: سكر صائم 5.5 mmol)\n" +
      "• سعرات ذكر عمر 28 طول 170 وزن 70 نشاط متوسط هدف تنحيف\n" +
      "• مزاج جيد نوم 7\n" +
      "\nاكتب: إلغاء للرجوع."
  );
}

function startCalc(session, name) {
  session.calc = { name, step: 1, data: {} };

  // short interactive prompts to reduce errors (still plain)
  if (name === "bmi") return plain("⚖️ BMI: اكتب وزنك بالكيلو (مثال 70)");
  if (name === "water") return plain("💧 ماء: اكتب وزنك بالكيلو (مثال 70)");
  if (name === "bp") return plain("💓 ضغط: اكتب القراءة مثل 120/80");
  if (name === "sugar") return plain("🩸 سكر: اختر النوع (صائم/بعد الأكل بساعتين/عشوائي)");
  if (name === "calories")
    return plain("🔥 سعرات: اختر الجنس (ذكر/أنثى) ثم سأكمل معك بخطوات سريعة");
  if (name === "mood") return plain("🧠 مزاج: قيّم مزاجك (ممتاز/جيد/متوسط/سيئ/سيئ جدًا)");
  session.calc = null;
  return calculatorsMenuPlain();
}

function continueCalc(session, message) {
  const c = session.calc;
  const m = String(message || "").trim();

  if (!c) return null;
  if (isCancel(m)) {
    session.calc = null;
    return calculatorsMenuPlain();
  }

  // BMI interactive
  if (c.name === "bmi") {
    if (c.step === 1) {
      const w = clampNum(parseNumber(m), 25, 250);
      if (!w) return plain("اكتب وزن صحيح بالكيلو (مثال 70)");
      c.data.w = w;
      c.step = 2;
      return plain("اكتب طولك بالسنتيمتر (مثال 170)");
    }
    if (c.step === 2) {
      const h = clampNum(parseNumber(m), 120, 220);
      if (!h) return plain("اكتب طول صحيح بالسنتيمتر (مثال 170)");
      const bmi = Math.round((c.data.w / Math.pow(h / 100, 2)) * 10) / 10;

      let label = "طبيعي";
      if (bmi < 18.5) label = "نحافة";
      else if (bmi < 25) label = "طبيعي";
      else if (bmi < 30) label = "زيادة وزن";
      else label = "سمنة";

      session.calc = null;
      return plain(`BMI = ${bmi}\nالتصنيف: ${label}\nملاحظة: النتيجة تقديرية للتثقيف العام.`);
    }
  }

  // Water interactive
  if (c.name === "water") {
    if (c.step === 1) {
      const w = clampNum(parseNumber(m), 25, 250);
      if (!w) return plain("اكتب وزن صحيح بالكيلو (مثال 70)");
      c.data.w = w;
      c.step = 2;
      return plain("اختر النشاط: خفيف / متوسط / عالي");
    }
    if (c.step === 2) {
      if (!/^(خفيف|متوسط|عالي)$/i.test(m)) return plain("اكتب: خفيف أو متوسط أو عالي");
      c.data.act = m;
      c.step = 3;
      return plain("اختر الجو: معتدل / حار / مكيف");
    }
    if (c.step === 3) {
      if (!/^(معتدل|حار|مكيف)$/i.test(m)) return plain("اكتب: معتدل أو حار أو مكيف");
      const w = c.data.w;
      let ml = w * 35;
      if (/متوسط/i.test(c.data.act)) ml += 300;
      if (/عالي/i.test(c.data.act)) ml += 600;
      if (/حار/i.test(m)) ml += 500;
      if (/مكيف/i.test(m)) ml -= 200;

      const liters = Math.max(1.5, Math.round((ml / 1000) * 10) / 10);
      session.calc = null;
      return plain(`احتياج الماء التقريبي: ${liters} لتر/يوم\n(نشاط: ${c.data.act} — جو: ${m})`);
    }
  }

  // BP interactive
  if (c.name === "bp") {
    if (c.step === 1) {
      const bp = parseBP(m);
      if (!bp) return plain("اكتب الضغط مثل: 120/80");
      const { s, d } = bp;

      let cls = "طبيعي";
      if (s >= 180 || d >= 120) cls = "أزمة ضغط (طارئ)";
      else if (s >= 140 || d >= 90) cls = "مرحلة ثانية";
      else if (s >= 130 || d >= 80) cls = "مرحلة أولى";
      else if (s >= 120 && d < 80) cls = "مرتفع";

      const warn =
        s >= 180 || d >= 120
          ? "إذا مع أعراض (ألم صدر/ضيق نفس/صداع شديد/تشوش): طوارئ فورًا."
          : "إذا تكرر ≥140/90 أو مع أعراض مزعجة: راجع الطبيب.";

      session.calc = null;
      return plain(`قراءتك: ${s}/${d}\nالتصنيف: ${cls}\n${warn}`);
    }
  }

  // Sugar interactive
  if (c.name === "sugar") {
    if (c.step === 1) {
      if (!/^(صائم|بعد الأكل بساعتين|عشوائي)$/i.test(m))
        return plain("اكتب واحد: صائم / بعد الأكل بساعتين / عشوائي");
      c.data.type = m;
      c.step = 2;
      return plain("اكتب قراءة السكر (مثال: 95 أو 5.5 mmol)");
    }
    if (c.step === 2) {
      const v = parseNumber(m);
      if (!v) return plain("اكتب رقم واضح للسكر (مثال 95 أو 5.5 mmol)");
      const unit = detectSugarUnit(m);
      const mg = sugarToMgdl(v, unit);

      const type = c.data.type;
      let cls = "طبيعي";

      if (/صائم/i.test(type)) {
        if (mg < 70) cls = "منخفض";
        else if (mg <= 99) cls = "طبيعي";
        else if (mg <= 125) cls = "ما قبل السكري";
        else cls = "مرتفع جدًا (يحتاج تقييم)";
      } else if (/بعد الأكل/i.test(type)) {
        if (mg < 70) cls = "منخفض";
        else if (mg < 140) cls = "طبيعي";
        else if (mg <= 199) cls = "مرتفع";
        else cls = "مرتفع جدًا";
      } else {
        if (mg < 70) cls = "منخفض";
        else if (mg < 200) cls = "قد يكون طبيعي/مرتفع حسب الأكل";
        else cls = "مرتفع جدًا";
      }

      session.calc = null;
      return plain(
        `قراءة السكر ≈ ${mg} mg/dL\nالنوع: ${type}\nالتصنيف: ${cls}\nملاحظة: القراءة الواحدة لا تكفي للتشخيص.\nإذا مرتفع جدًا مع أعراض شديدة: طوارئ.`
      );
    }
  }

  // Calories interactive (simple steps)
  if (c.name === "calories") {
    if (c.step === 1) {
      if (!/^(ذكر|أنثى|انثى)$/i.test(m)) return plain("اكتب: ذكر أو أنثى");
      c.data.sex = /انثى/i.test(m) ? "أنثى" : m;
      c.step = 2;
      return plain("اكتب عمرك (مثال 28)");
    }
    if (c.step === 2) {
      const age = clampNum(parseNumber(m), 10, 90);
      if (!age) return plain("اكتب عمر صحيح (مثال 28)");
      c.data.age = age;
      c.step = 3;
      return plain("اكتب طولك بالسنتيمتر (مثال 170)");
    }
    if (c.step === 3) {
      const h = clampNum(parseNumber(m), 120, 220);
      if (!h) return plain("اكتب طول صحيح (مثال 170)");
      c.data.h = h;
      c.step = 4;
      return plain("اكتب وزنك بالكيلو (مثال 70)");
    }
    if (c.step === 4) {
      const w = clampNum(parseNumber(m), 25, 250);
      if (!w) return plain("اكتب وزن صحيح (مثال 70)");
      c.data.w = w;
      c.step = 5;
      return plain("اختر النشاط: خفيف / متوسط / عالي");
    }
    if (c.step === 5) {
      const act = /عالي/i.test(m) ? 1.725 : /متوسط/i.test(m) ? 1.55 : /خفيف/i.test(m) ? 1.2 : null;
      if (!act) return plain("اكتب: خفيف أو متوسط أو عالي");
      c.data.act = act;
      c.step = 6;
      return plain("اختر الهدف: تثبيت / تنحيف / زيادة");
    }
    if (c.step === 6) {
      const goal = /تنحيف/i.test(m) ? "تنحيف" : /زيادة/i.test(m) ? "زيادة" : /تثبيت/i.test(m) ? "تثبيت" : null;
      if (!goal) return plain("اكتب: تثبيت أو تنحيف أو زيادة");

      const { sex, age, h, w, act } = c.data;
      let bmr = 10 * w + 6.25 * h - 5 * age + (sex === "أنثى" ? -161 : 5);
      const tdee = Math.round(bmr * act);

      let target = tdee;
      if (goal === "تنحيف") target = tdee - 400;
      if (goal === "زيادة") target = tdee + 300;

      session.calc = null;
      return plain(
        `احتياجك التقريبي: ${tdee} سعرة/يوم\nهدف (${goal}): ${target} سعرة/يوم\nملاحظة: تقديري للتثقيف العام.`
      );
    }
  }

  // Mood interactive
  if (c.name === "mood") {
    if (c.step === 1) {
      if (!/^(ممتاز|جيد|متوسط|سيئ|سيئ جدًا|سيء|سيء جدا)$/i.test(m))
        return plain("اختر: ممتاز / جيد / متوسط / سيئ / سيئ جدًا");
      c.data.mood = m.replace("سيء", "سيئ");
      c.step = 2;
      return plain("كم ساعة تنام غالبًا؟ (مثال 7)");
    }
    if (c.step === 2) {
      const hrs = clampNum(parseNumber(m), 0, 14);
      if (hrs === null) return plain("اكتب رقم ساعات النوم (مثال 7)");
      const mood = c.data.mood;

      let note = "اقتراح: ماء + وجبة خفيفة متوازنة + مشي 10 دقائق.";
      if (hrs < 6) note = "اقتراح: ثبّت موعد النوم وقلّل الشاشة قبل النوم بساعة.";
      if (/سيئ/i.test(mood)) note += "\nإذا عندك أفكار لإيذاء النفس: اطلب مساعدة فورًا (طوارئ/خط دعم).";

      session.calc = null;
      return plain(`مزاجك: ${mood}\nنومك: ${hrs} ساعة\n${note}`);
    }
  }

  session.calc = null;
  return calculatorsMenuPlain();
}

// ===============================
// Groq (fallback لغير الحاسبات)
// ===============================
function buildSystemPrompt() {
  return `
أنت "دليل العافية" — مرافق صحي عربي للتثقيف الصحي فقط.
أخرج الرد بصيغة JSON فقط وبدون نص خارجها:
{
  "category": "general|sugar|bp|nutrition|sleep|activity|mental|first_aid|report|emergency",
  "title": "عنوان قصير",
  "verdict": "جملة واحدة",
  "next_question": "سؤال واحد أو \"\"",
  "quick_choices": ["..."],
  "tips": ["..."],
  "when_to_seek_help": "..."
}
قواعد:
- لا تشخيص
- لا أدوية
- لا جرعات
- لغة بسيطة
`.trim();
}

async function callGroq(messages) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.35,
      max_tokens: 450,
      messages,
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error("Groq API error");
  const data = await res.json().catch(() => ({}));
  return data.choices?.[0]?.message?.content || "";
}

function extractJson(text) {
  let s = String(text || "").trim();
  s = s.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
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

function sanitizeText(v) {
  let s = typeof v === "string" ? v : "";
  s = s.replace(/```[\s\S]*?```/g, "").replace(/`+/g, "").trim();
  return s;
}

function normalize(obj) {
  return card({
    category: sanitizeText(obj?.category) || "general",
    title: sanitizeText(obj?.title) || "دليل العافية",
    verdict: sanitizeText(obj?.verdict),
    next_question: sanitizeText(obj?.next_question),
    quick_choices: Array.isArray(obj?.quick_choices) ? obj.quick_choices.map(sanitizeText) : [],
    tips: Array.isArray(obj?.tips) ? obj.tips.map(sanitizeText) : [],
    when_to_seek_help: sanitizeText(obj?.when_to_seek_help),
  });
}

function fallbackCard(text) {
  return card({
    category: "general",
    title: "معلومة صحية",
    verdict: sanitizeText(text) || "لا تتوفر معلومات كافية.",
    next_question: "",
    quick_choices: [],
    tips: [],
    when_to_seek_help: "",
  });
}

// ===============================
// OCR / Report
// ===============================
let ocrWorkerPromise = null;

async function getOcrWorker() {
  if (!createWorker) return null;
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => {
      const w = await createWorker("eng+ara");
      return w;
    })();
  }
  return ocrWorkerPromise;
}

async function ocrImageBuffer(buffer) {
  const worker = await getOcrWorker();
  if (!worker) return "";
  const { data } = await worker.recognize(buffer);
  return data?.text ? String(data.text) : "";
}

// ===============================
// Routes
// ===============================
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "Dalil Alafiyah API", routes: ["/chat", "/report", "/reset"] });
});

app.post("/reset", (req, res) => {
  const userId = getUserId(req);
  sessions.delete(userId);
  res.json({ ok: true });
});

app.post("/chat", async (req, res) => {
  const userId = getUserId(req);
  const session = getSession(userId);

  const msg = String(req.body?.message || "").trim();
  if (!msg) return res.status(400).json({ ok: false, error: "empty_message" });

  // ✅ "افهم تقريرك" (بطاقة مثل قبل)
  if (isReportIntent(msg) && msg.length <= 40) {
    session.calc = null;
    return res.json({ ok: true, data: reportEntryCard() });
  }

  // ✅ الحاسبات: إذا داخل جلسة حاسبة
  if (session.calc) {
    const out = continueCalc(session, msg);
    return res.json({ ok: true, data: out || calculatorsMenuPlain() });
  }

  // ✅ فتح قائمة الحاسبات
  if (isCalculatorsIntent(msg)) {
    return res.json({ ok: true, data: calculatorsMenuPlain() });
  }

  // ✅ اختيار مباشر من كلمات المستخدم
  const picked = pickCalcFromText(msg);
  if (picked) {
    return res.json({ ok: true, data: startCalc(session, picked) });
  }

  // ✅ صيغ مباشرة (بدون جلسة)
  if (/^bmi\b/i.test(msg)) {
    const w = Number((msg.match(/وزن\s*(\d{2,3})/i) || [])[1]);
    const h = Number((msg.match(/طول\s*(\d{2,3})/i) || [])[1]);
    if (!w || !h) return res.json({ ok: true, data: plain("اكتبها مثل: BMI وزن 70 طول 170") });
    const bmi = Math.round((w / Math.pow(h / 100, 2)) * 10) / 10;
    let label = "طبيعي";
    if (bmi < 18.5) label = "نحافة";
    else if (bmi < 25) label = "طبيعي";
    else if (bmi < 30) label = "زيادة وزن";
    else label = "سمنة";
    return res.json({ ok: true, data: plain(`BMI = ${bmi}\nالتصنيف: ${label}`) });
  }

  // ✅ fallback LLM (لو تبي)
  if (!GROQ_API_KEY) {
    // بدون Groq: رجّع بطاقة عامة مختصرة
    return res.json({
      ok: true,
      data: card({
        category: "general",
        title: "دليل العافية",
        verdict: "اكتب سؤالك بشكل أوضح أو استخدم 🧮 الحاسبات.",
        next_question: "",
        quick_choices: ["🧮 الحاسبات", "📄 افهم تقريرك"],
        tips: [],
        when_to_seek_help: "إذا ألم صدر/ضيق نفس/إغماء/نزيف شديد: طوارئ فورًا.",
      }),
    });
  }

  try {
    const raw = await callGroq([
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: clampText(msg, 1200) },
    ]);
    const parsed = extractJson(raw);
    const data = parsed ? normalize(parsed) : fallbackCard(raw);
    return res.json({ ok: true, data });
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      ok: false,
      error: "server_error",
      data: fallbackCard("حدث خطأ غير متوقع. راجع الطبيب إذا الأعراض مقلقة."),
    });
  }
});

app.post("/report", upload.single("file"), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ ok: false, error: "missing_file" });

  try {
    let extracted = "";
    const mime = String(file.mimetype || "");

    if (mime === "application/pdf") {
      if (!pdfParse) {
        return res.json({
          ok: true,
          data: card({
            category: "report",
            title: "افهم تقريرك",
            verdict: "الخادم لا يدعم قراءة PDF حاليًا. جرّب صورة واضحة للتقرير.",
            next_question: "",
            quick_choices: ["📎 إضافة مرفق", "إلغاء"],
            tips: [],
            when_to_seek_help: "",
          }),
        });
      }
      const parsed = await pdfParse(file.buffer).catch(() => null);
      extracted = parsed?.text ? String(parsed.text) : "";
      extracted = extracted.replace(/\s+/g, " ").trim();
    } else if (mime.startsWith("image/")) {
      extracted = await ocrImageBuffer(file.buffer);
      extracted = extracted.replace(/\s+/g, " ").trim();
    } else {
      return res.status(400).json({ ok: false, error: "unsupported_type" });
    }

    if (!extracted || extracted.length < 30) {
      return res.json({
        ok: true,
        data: card({
          category: "report",
          title: "افهم تقريرك",
          verdict: "ما قدرت أقرأ نص كافي من الملف. جرّب صورة أوضح.",
          next_question: "",
          quick_choices: ["📎 إضافة مرفق", "إلغاء"],
          tips: ["صور بإضاءة جيدة وبدون انعكاس."],
          when_to_seek_help: "إذا أعراض شديدة: طوارئ.",
        }),
      });
    }

    // لو ما في Groq: رجّع ملخص ثابت
    if (!GROQ_API_KEY) {
      return res.json({
        ok: true,
        data: card({
          category: "report",
          title: "افهم تقريرك",
          verdict:
            "تم استخراج نص من التقرير، لكن التحليل الذكي غير مفعّل (GROQ_API_KEY غير موجود).",
          next_question: "الصق أهم سطرين من النتائج هنا وسأشرحها بشكل عام.",
          quick_choices: [],
          tips: ["لا ترفع بيانات حساسة."],
          when_to_seek_help: "إذا أعراض شديدة: طوارئ.",
        }),
      });
    }

    const clipped = clampText(extracted, 5000);

    const raw = await callGroq([
      {
        role: "system",
        content:
          "أنت مساعد تثقيف صحي عربي لشرح نتائج التحاليل بشكل عام. ممنوع: تشخيص/أدوية/جرعات. أخرج JSON بمفاتيح البطاقة.",
      },
      {
        role: "user",
        content:
          "نص التقرير:\n" +
          clipped +
          "\n\nاشرح بشكل عام وباختصار + نصائح عامة + متى يراجع الطبيب.",
      },
    ]);

    const parsed = extractJson(raw);
    const out = parsed ? normalize({ ...parsed, category: "report" }) : fallbackCard(raw);

    return res.json({ ok: true, data: out });
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      ok: false,
      error: "report_error",
      data: card({
        category: "report",
        title: "افهم تقريرك",
        verdict: "تعذر تحليل التقرير الآن. جرّب صورة أوضح أو الصق النص.",
        next_question: "",
        quick_choices: ["📎 إضافة مرفق", "إلغاء"],
        tips: [],
        when_to_seek_help: "",
      }),
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Dalil Alafiyah API يعمل على ${PORT}`);
});
