// ===============================
// server.js — Dalil Alafiyah API
// + Calculators Path (No LLM tokens)
// ===============================

import "dotenv/config";
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import helmet from "helmet";
import multer from "multer";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
let pdfParse = null;
try { pdfParse = require("pdf-parse"); } catch {}

let createWorker = null;
try { ({ createWorker } = await import("tesseract.js")); } catch {}

const app = express();
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });

// ===============================
// ENV
// ===============================
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const MODEL_ID = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const PORT = process.env.PORT || 3000;

app.use(helmet());
app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-user-id", "X-User-Id"],
  })
);
app.use(bodyParser.json({ limit: "2mb" }));

// ===============================
// Card helpers
// ===============================
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
    quick_choices: Array.isArray(quick_choices) ? quick_choices.slice(0, 6) : [],
    tips: Array.isArray(tips) ? tips.slice(0, 6) : [],
    when_to_seek_help,
  };
}

function isCancel(t) {
  return /^(إلغاء|الغاء|cancel|مسح|ابدأ من جديد|ابدأ جديد|رجوع|عودة|القائمة)$/i.test(
    String(t || "").trim()
  );
}

function clampNum(n, min, max) {
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

function parseNumber(text) {
  const m = String(text || "").match(/(\d+(\.\d+)?)/);
  return m ? Number(m[1]) : null;
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
  // لو المستخدم كتب mmol/L أو mmol
  if (/mmol/i.test(String(text || ""))) return "mmol";
  return "mgdl";
}

function sugarToMgdl(value, unit) {
  if (unit === "mmol") return Math.round(value * 18);
  return Math.round(value);
}

// ===============================
// Sessions (in-memory)
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

// تنظيف جلسات قديمة
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) {
    if (now - (v.ts || 0) > 24 * 60 * 60 * 1000) sessions.delete(k);
  }
}, 30 * 60 * 1000);

// ===============================
// Report entry card (مثل صورتك)
// ===============================
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
// Calculators Path
// ===============================
function calculatorsMenuCard() {
  return card({
    category: "calculators",
    title: "🧮 الحاسبات",
    verdict: "اختر الحاسبة اللي تبيها (كلها ردود جاهزة لتوفير التوكنز):",
    next_question: "أي حاسبة نبدأ؟",
    quick_choices: [
      "🔥 حاسبة السعرات",
      "⚖️ حاسبة كتلة الجسم BMI",
      "💧 حاسبة الماء",
      "💓 حاسبة الضغط",
      "🩸 حاسبة السكر",
      "🧠 حاسبة المزاج",
      "إلغاء",
    ],
    tips: ["النتائج تقديرية للتثقيف العام فقط."],
    when_to_seek_help: "",
  });
}

function startCalc(session, name) {
  session.calc = { name, step: 1, data: {} };

  if (name === "bmi") {
    return card({
      category: "calculators",
      title: "⚖️ حاسبة BMI",
      verdict: "أعطني وزنك بالكيلو:",
      next_question: "كم وزنك؟",
      quick_choices: ["إلغاء"],
      tips: ["مثال: 70"],
      when_to_seek_help: "",
    });
  }

  if (name === "calories") {
    return card({
      category: "calculators",
      title: "🔥 حاسبة السعرات",
      verdict: "اختر الجنس:",
      next_question: "ذكر أم أنثى؟",
      quick_choices: ["ذكر", "أنثى", "إلغاء"],
      tips: ["الحساب تقديري (Mifflin-St Jeor)."],
      when_to_seek_help: "",
    });
  }

  if (name === "water") {
    return card({
      category: "calculators",
      title: "💧 حاسبة الماء",
      verdict: "اكتب وزنك بالكيلو:",
      next_question: "كم وزنك؟",
      quick_choices: ["إلغاء"],
      tips: ["مثال: 70"],
      when_to_seek_help: "",
    });
  }

  if (name === "bp") {
    return card({
      category: "calculators",
      title: "💓 حاسبة الضغط",
      verdict: "اكتب قراءة الضغط بالشكل 120/80:",
      next_question: "ما هي القراءة؟",
      quick_choices: ["إلغاء"],
      tips: ["إذا عندك دوخة شديدة/ألم صدر/ضيق نفس: طوارئ فورًا."],
      when_to_seek_help: "",
    });
  }

  if (name === "sugar") {
    return card({
      category: "calculators",
      title: "🩸 حاسبة السكر",
      verdict: "اختر نوع القياس:",
      next_question: "القياس كان متى؟",
      quick_choices: ["صائم", "بعد الأكل بساعتين", "عشوائي", "إلغاء"],
      tips: ["اكتب القيمة لاحقًا (mg/dL أو mmol/L)."],
      when_to_seek_help: "",
    });
  }

  if (name === "mood") {
    return card({
      category: "calculators",
      title: "🧠 حاسبة المزاج",
      verdict: "قيّم مزاجك آخر 7 أيام:",
      next_question: "اختيار واحد:",
      quick_choices: ["ممتاز", "جيد", "متوسط", "سيئ", "سيئ جدًا", "إلغاء"],
      tips: ["هذا فحص ذاتي بسيط وليس تشخيصًا."],
      when_to_seek_help: "",
    });
  }

  session.calc = null;
  return calculatorsMenuCard();
}

function finishCalcCard() {
  return card({
    category: "calculators",
    title: "🧮 الحاسبات",
    verdict: "تحب حاسبة ثانية؟",
    next_question: "",
    quick_choices: ["🧮 الحاسبات", "إلغاء"],
    tips: [],
    when_to_seek_help: "",
  });
}

function continueCalc(session, message) {
  const c = session.calc;
  const m = String(message || "").trim();

  if (!c) return null;

  if (isCancel(m)) {
    session.calc = null;
    return calculatorsMenuCard();
  }

  // ---------- BMI ----------
  if (c.name === "bmi") {
    if (c.step === 1) {
      const w = clampNum(parseNumber(m), 25, 250);
      if (!w) return card({
        category: "calculators",
        title: "⚖️ حاسبة BMI",
        verdict: "ما فهمت الوزن. اكتب رقم بالكيلو (مثال 70).",
        next_question: "كم وزنك؟",
        quick_choices: ["إلغاء"],
        tips: [],
      });
      c.data.w = w;
      c.step = 2;
      return card({
        category: "calculators",
        title: "⚖️ حاسبة BMI",
        verdict: "الآن اكتب طولك بالسنتيمتر:",
        next_question: "كم طولك؟",
        quick_choices: ["إلغاء"],
        tips: ["مثال: 170"],
      });
    }
    if (c.step === 2) {
      const h = clampNum(parseNumber(m), 120, 220);
      if (!h) return card({
        category: "calculators",
        title: "⚖️ حاسبة BMI",
        verdict: "ما فهمت الطول. اكتب رقم بالسنتيمتر (مثال 170).",
        next_question: "كم طولك؟",
        quick_choices: ["إلغاء"],
        tips: [],
      });

      const bmi = Math.round((c.data.w / Math.pow(h / 100, 2)) * 10) / 10;

      let label = "ضمن الطبيعي";
      if (bmi < 18.5) label = "نحافة";
      else if (bmi < 25) label = "طبيعي";
      else if (bmi < 30) label = "زيادة وزن";
      else label = "سمنة";

      session.calc = null;
      return card({
        category: "calculators",
        title: "⚖️ نتيجة BMI",
        verdict: `BMI = **${bmi}** (${label})`,
        next_question: "تبغى نصائح لنمط الحياة حسب النتيجة؟",
        quick_choices: ["نعم", "لا", "🧮 الحاسبات"],
        tips: [
          "النتيجة تقديرية ولا تكفي وحدها لتقييم الصحة.",
          "حاول توازن الغذاء + نشاط بدني منتظم.",
        ],
        when_to_seek_help: "إذا فقدان وزن شديد/تعب مستمر: راجع الطبيب.",
      });
    }
  }

  // ---------- Calories ----------
  if (c.name === "calories") {
    if (c.step === 1) {
      if (!/^(ذكر|أنثى)$/i.test(m)) return card({
        category: "calculators",
        title: "🔥 حاسبة السعرات",
        verdict: "اختر (ذكر) أو (أنثى).",
        next_question: "الجنس؟",
        quick_choices: ["ذكر", "أنثى", "إلغاء"],
      });
      c.data.sex = m;
      c.step = 2;
      return card({
        category: "calculators",
        title: "🔥 حاسبة السعرات",
        verdict: "اكتب عمرك بالسنوات:",
        next_question: "كم عمرك؟",
        quick_choices: ["إلغاء"],
        tips: ["مثال: 28"],
      });
    }
    if (c.step === 2) {
      const age = clampNum(parseNumber(m), 10, 90);
      if (!age) return card({
        category: "calculators",
        title: "🔥 حاسبة السعرات",
        verdict: "اكتب العمر رقم (مثال 28).",
        next_question: "كم عمرك؟",
        quick_choices: ["إلغاء"],
      });
      c.data.age = age;
      c.step = 3;
      return card({
        category: "calculators",
        title: "🔥 حاسبة السعرات",
        verdict: "اكتب طولك بالسنتيمتر:",
        next_question: "كم طولك؟",
        quick_choices: ["إلغاء"],
        tips: ["مثال: 170"],
      });
    }
    if (c.step === 3) {
      const h = clampNum(parseNumber(m), 120, 220);
      if (!h) return card({
        category: "calculators",
        title: "🔥 حاسبة السعرات",
        verdict: "اكتب الطول رقم (مثال 170).",
        next_question: "كم طولك؟",
        quick_choices: ["إلغاء"],
      });
      c.data.h = h;
      c.step = 4;
      return card({
        category: "calculators",
        title: "🔥 حاسبة السعرات",
        verdict: "اكتب وزنك بالكيلو:",
        next_question: "كم وزنك؟",
        quick_choices: ["إلغاء"],
        tips: ["مثال: 70"],
      });
    }
    if (c.step === 4) {
      const w = clampNum(parseNumber(m), 25, 250);
      if (!w) return card({
        category: "calculators",
        title: "🔥 حاسبة السعرات",
        verdict: "اكتب الوزن رقم (مثال 70).",
        next_question: "كم وزنك؟",
        quick_choices: ["إلغاء"],
      });
      c.data.w = w;
      c.step = 5;
      return card({
        category: "calculators",
        title: "🔥 حاسبة السعرات",
        verdict: "اختر نشاطك اليومي:",
        next_question: "",
        quick_choices: ["خفيف", "متوسط", "عالي", "إلغاء"],
        tips: ["خفيف: عمل مكتبي", "متوسط: مشي/رياضة 3 أيام", "عالي: نشاط يومي قوي"],
      });
    }
    if (c.step === 5) {
      const actMap = { خفيف: 1.2, متوسط: 1.55, عالي: 1.725 };
      if (!actMap[m]) return card({
        category: "calculators",
        title: "🔥 حاسبة السعرات",
        verdict: "اختر: خفيف / متوسط / عالي",
        next_question: "",
        quick_choices: ["خفيف", "متوسط", "عالي", "إلغاء"],
      });
      c.data.act = actMap[m];
      c.step = 6;
      return card({
        category: "calculators",
        title: "🔥 حاسبة السعرات",
        verdict: "اختر هدفك:",
        next_question: "",
        quick_choices: ["تثبيت", "تنحيف", "زيادة", "إلغاء"],
        tips: [],
      });
    }
    if (c.step === 6) {
      const goal = m;
      if (!/^(تثبيت|تنحيف|زيادة)$/i.test(goal)) return card({
        category: "calculators",
        title: "🔥 حاسبة السعرات",
        verdict: "اختر: تثبيت / تنحيف / زيادة",
        next_question: "",
        quick_choices: ["تثبيت", "تنحيف", "زيادة", "إلغاء"],
      });

      const sex = c.data.sex;
      const age = c.data.age;
      const h = c.data.h;
      const w = c.data.w;
      const act = c.data.act;

      // Mifflin-St Jeor
      let bmr = 10 * w + 6.25 * h - 5 * age;
      bmr += /أنثى/i.test(sex) ? -161 : 5;

      const tdee = Math.round(bmr * act);

      let target = tdee;
      let note = "تثبيت الوزن";
      if (/تنحيف/i.test(goal)) { target = tdee - 400; note = "تنحيف (تقريبًا -400)"; }
      if (/زيادة/i.test(goal)) { target = tdee + 300; note = "زيادة (تقريبًا +300)"; }

      session.calc = null;
      return card({
        category: "calculators",
        title: "🔥 نتيجة السعرات",
        verdict: `احتياجك اليومي التقريبي = **${tdee}** سعرة/يوم.\nالهدف (${note}) ≈ **${target}** سعرة/يوم.`,
        next_question: "تبغى نصائح سريعة للأكل؟",
        quick_choices: ["نعم", "لا", "🧮 الحاسبات"],
        tips: ["الأرقام تقديرية وقد تختلف حسب الحالة الصحية.", "قسّم البروتين/الخضار/الكربوهيدرات بشكل متوازن."],
        when_to_seek_help: "إذا لديك مرض مزمن أو فقدان وزن غير مبرر: استشر الطبيب/أخصائي تغذية.",
      });
    }
  }

  // ---------- Water ----------
  if (c.name === "water") {
    if (c.step === 1) {
      const w = clampNum(parseNumber(m), 25, 250);
      if (!w) return card({
        category: "calculators",
        title: "💧 حاسبة الماء",
        verdict: "اكتب الوزن رقم بالكيلو (مثال 70).",
        next_question: "كم وزنك؟",
        quick_choices: ["إلغاء"],
      });
      c.data.w = w;
      c.step = 2;
      return card({
        category: "calculators",
        title: "💧 حاسبة الماء",
        verdict: "نشاطك اليومي؟",
        next_question: "",
        quick_choices: ["خفيف", "متوسط", "عالي", "إلغاء"],
        tips: [],
      });
    }
    if (c.step === 2) {
      if (!/^(خفيف|متوسط|عالي)$/i.test(m)) return card({
        category: "calculators",
        title: "💧 حاسبة الماء",
        verdict: "اختر: خفيف / متوسط / عالي",
        next_question: "",
        quick_choices: ["خفيف", "متوسط", "عالي", "إلغاء"],
      });
      c.data.act = m;
      c.step = 3;
      return card({
        category: "calculators",
        title: "💧 حاسبة الماء",
        verdict: "كيف الجو غالبًا؟",
        next_question: "",
        quick_choices: ["معتدل", "حار", "مكيف أغلب الوقت", "إلغاء"],
        tips: [],
      });
    }
    if (c.step === 3) {
      if (!/^(معتدل|حار|مكيف أغلب الوقت)$/i.test(m)) return card({
        category: "calculators",
        title: "💧 حاسبة الماء",
        verdict: "اختر: معتدل / حار / مكيف أغلب الوقت",
        next_question: "",
        quick_choices: ["معتدل", "حار", "مكيف أغلب الوقت", "إلغاء"],
      });

      const w = c.data.w;
      // قاعدة بسيطة: 35ml/kg
      let ml = w * 35;

      if (/متوسط/i.test(c.data.act)) ml += 300;
      if (/عالي/i.test(c.data.act)) ml += 600;

      if (/حار/i.test(m)) ml += 500;
      if (/مكيف/i.test(m)) ml -= 200;

      const liters = Math.max(1.5, Math.round((ml / 1000) * 10) / 10);

      session.calc = null;
      return card({
        category: "calculators",
        title: "💧 نتيجة الماء",
        verdict: `احتياجك التقريبي من الماء ≈ **${liters} لتر/يوم**.`,
        next_question: "تبغى طريقة توزيعها خلال اليوم؟",
        quick_choices: ["نعم", "لا", "🧮 الحاسبات"],
        tips: ["لون البول الفاتح غالبًا علامة ترطيب جيد.", "زد الماء مع الرياضة/الحر."],
        when_to_seek_help: "إذا لديك فشل كلوي/قصور قلب: استشر طبيبك قبل زيادة السوائل.",
      });
    }
  }

  // ---------- BP ----------
  if (c.name === "bp") {
    if (c.step === 1) {
      const bp = parseBP(m);
      if (!bp) return card({
        category: "calculators",
        title: "💓 حاسبة الضغط",
        verdict: "اكتبها مثل: 120/80",
        next_question: "ما هي القراءة؟",
        quick_choices: ["إلغاء"],
        tips: [],
      });

      const { s, d } = bp;

      let cls = "طبيعي";
      let seek = "";
      if (s >= 180 || d >= 120) { cls = "أزمة ضغط (طارئ)"; seek = "إذا مع أعراض (ألم صدر/ضيق نفس/صداع شديد/تشوش): طوارئ فورًا."; }
      else if (s >= 140 || d >= 90) cls = "مرحلة ثانية";
      else if (s >= 130 || d >= 80) cls = "مرحلة أولى";
      else if (s >= 120 && d < 80) cls = "مرتفع";
      else cls = "طبيعي";

      session.calc = null;
      return card({
        category: s >= 180 || d >= 120 ? "emergency" : "calculators",
        title: "💓 نتيجة الضغط",
        verdict: `قراءتك **${s}/${d}** وتصنيفها: **${cls}**.`,
        next_question: "هل تريد نصائح لقياس الضغط بشكل صحيح؟",
        quick_choices: ["نعم", "لا", "🧮 الحاسبات"],
        tips: ["قِس بعد راحة 5 دقائق.", "تجنب القهوة/التدخين 30 دقيقة قبل القياس."],
        when_to_seek_help: seek || "إذا تكرر ≥140/90 أو مع أعراض مزعجة: راجع الطبيب.",
      });
    }
  }

  // ---------- Sugar ----------
  if (c.name === "sugar") {
    if (c.step === 1) {
      if (!/^(صائم|بعد الأكل بساعتين|عشوائي)$/i.test(m)) {
        return card({
          category: "calculators",
          title: "🩸 حاسبة السكر",
          verdict: "اختر نوع القياس:",
          next_question: "",
          quick_choices: ["صائم", "بعد الأكل بساعتين", "عشوائي", "إلغاء"],
        });
      }
      c.data.type = m;
      c.step = 2;
      return card({
        category: "calculators",
        title: "🩸 حاسبة السكر",
        verdict: "اكتب قيمة السكر:",
        next_question: "مثال: 95 أو 7.2 mmol",
        quick_choices: ["إلغاء"],
        tips: ["إذا تكتب mmol اكتب معها mmol لتتحول تلقائيًا."],
      });
    }
    if (c.step === 2) {
      const v = parseNumber(m);
      if (!v) return card({
        category: "calculators",
        title: "🩸 حاسبة السكر",
        verdict: "اكتب رقم واضح.",
        next_question: "كم القراءة؟",
        quick_choices: ["إلغاء"],
      });

      const unit = detectSugarUnit(m);
      const mg = sugarToMgdl(v, unit);

      const type = c.data.type;
      let cls = "ضمن الطبيعي";
      let note = "";

      if (/صائم/i.test(type)) {
        if (mg < 70) { cls = "منخفض"; note = "إذا أعراض هبوط: اتبع إرشادات طبيبك/اطلب مساعدة."; }
        else if (mg <= 99) cls = "طبيعي";
        else if (mg <= 125) cls = "مرتفع (ما قبل السكري)";
        else cls = "مرتفع جدًا (يحتاج تأكيد طبي)";
      } else if (/بعد الأكل/i.test(type)) {
        if (mg < 70) { cls = "منخفض"; note = "إذا أعراض هبوط: اطلب مساعدة."; }
        else if (mg < 140) cls = "طبيعي";
        else if (mg <= 199) cls = "مرتفع (ما قبل السكري)";
        else cls = "مرتفع جدًا (يحتاج تقييم طبي)";
      } else {
        // عشوائي
        if (mg < 70) { cls = "منخفض"; note = "إذا أعراض هبوط: اطلب مساعدة."; }
        else if (mg < 200) cls = "قد يكون طبيعي/مرتفع حسب الأكل";
        else cls = "مرتفع جدًا (خصوصًا مع أعراض)";
      }

      session.calc = null;
      return card({
        category: cls.includes("مرتفع جدًا") ? "calculators" : "calculators",
        title: "🩸 نتيجة السكر",
        verdict: `قراءة السكر ≈ **${mg} mg/dL** (${cls}).`,
        next_question: "تبغى نصائح غذائية قصيرة؟",
        quick_choices: ["نعم", "لا", "🧮 الحاسبات"],
        tips: [
          "القراءة الواحدة لا تكفي للتشخيص.",
          "كرّر القياس في أوقات مختلفة وسجّل النتائج.",
          note || "قلّل السكريات السريعة وزد الألياف والمشي.",
        ].filter(Boolean),
        when_to_seek_help:
          "إذا القراءة عالية جدًا مع عطش شديد/تبوّل كثير/تقيؤ/دوخة: راجع الطوارئ. وللتقييم الدقيق: راجع الطبيب.",
      });
    }
  }

  // ---------- Mood ----------
  if (c.name === "mood") {
    if (c.step === 1) {
      if (!/^(ممتاز|جيد|متوسط|سيئ|سيئ جدًا)$/i.test(m)) return card({
        category: "calculators",
        title: "🧠 حاسبة المزاج",
        verdict: "اختر خيار واحد:",
        next_question: "",
        quick_choices: ["ممتاز", "جيد", "متوسط", "سيئ", "سيئ جدًا", "إلغاء"],
      });
      c.data.mood = m;
      c.step = 2;
      return card({
        category: "calculators",
        title: "🧠 حاسبة المزاج",
        verdict: "كم ساعة تنام غالبًا؟",
        next_question: "اكتب رقم (مثال 7)",
        quick_choices: ["إلغاء"],
        tips: [],
      });
    }
    if (c.step === 2) {
      const hrs = clampNum(parseNumber(m), 0, 14);
      if (hrs === null) return card({
        category: "calculators",
        title: "🧠 حاسبة المزاج",
        verdict: "اكتب رقم للساعات (مثال 7).",
        next_question: "",
        quick_choices: ["إلغاء"],
      });

      const mood = c.data.mood;
      session.calc = null;

      const tips = [];
      if (hrs < 6) tips.push("حاول تثبيت موعد النوم وتقليل الشاشة قبل النوم بساعة.");
      if (/سيئ|سيئ جدًا/i.test(mood)) tips.push("جرّب نشاط بسيط يوميًا + تواصل مع شخص تثق به.");
      if (/متوسط/i.test(mood)) tips.push("قسّم يومك لمهام صغيرة واهتم بالأكل والنوم.");

      const seek =
        "إذا عندك أفكار لإيذاء النفس/انتحار أو انهيار شديد: اطلب مساعدة فورًا (طوارئ/خط دعم).";

      return card({
        category: "calculators",
        title: "🧠 نتيجة المزاج",
        verdict: `مزاجك: **${mood}** — نومك: **${hrs} ساعة**.`,
        next_question: "تبغى خطة بسيطة لليوم؟",
        quick_choices: ["نعم", "لا", "🧮 الحاسبات"],
        tips: tips.length ? tips : ["حافظ على ماء/أكل منتظم + مشي 10 دقائق."],
        when_to_seek_help: seek,
      });
    }
  }

  // fallback
  session.calc = null;
  return calculatorsMenuCard();
}

// اختيار الحاسبة من نص الزر
function pickCalcFromChoice(text) {
  const t = String(text || "");
  if (/BMI|كتلة الجسم|⚖️/i.test(t)) return "bmi";
  if (/سعرات|🔥/i.test(t)) return "calories";
  if (/ماء|💧/i.test(t)) return "water";
  if (/ضغط|💓/i.test(t)) return "bp";
  if (/سكر|🩸/i.test(t)) return "sugar";
  if (/مزاج|🧠/i.test(t)) return "mood";
  return null;
}

function isCalculatorsIntent(text) {
  return /حاسبات|الحاسبات|🧮/i.test(String(text || ""));
}

// ===============================
// LLM (fallback فقط لغير الحاسبات/التقرير)
// ===============================
function buildSystemPrompt() {
  return `
أنت "دليل العافية" — مرافق صحي عربي للتثقيف الصحي فقط.
أخرج JSON فقط:
{
 "category":"general|sugar|bp|nutrition|sleep|activity|mental|first_aid|report|emergency",
 "title":"عنوان قصير",
 "verdict":"جملة واحدة",
 "next_question":"سؤال واحد أو \"\"",
 "quick_choices":["..."],
 "tips":["..."],
 "when_to_seek_help":"..."
}
قواعد: لا تشخيص، لا أدوية، لا جرعات. لغة بسيطة.
`.trim();
}

async function callGroq(messages) {
  if (!GROQ_API_KEY) throw new Error("Missing GROQ_API_KEY");

  const payload = {
    model: MODEL_ID,
    temperature: 0.35,
    max_tokens: 450,
    messages,
    response_format: { type: "json_object" },
  };

  // محاولة مع response_format ثم بدونها
  let res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const payload2 = { ...payload };
    delete payload2.response_format;
    res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload2),
    });
    if (!res.ok) throw new Error("Groq API error");
  }

  const data = await res.json().catch(() => ({}));
  const txt = data.choices?.[0]?.message?.content || "";
  return txt;
}

function extractJson(text) {
  let s = String(text || "").trim();
  s = s.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try { return JSON.parse(s); } catch {}
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a === -1 || b === -1 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
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

function fallbackCard() {
  return card({
    category: "general",
    title: "دليل العافية",
    verdict: "لم أفهم سؤالك بالكامل. اكتب عرضك ومدة الأعراض.",
    next_question: "ما هو العرض الأساسي؟ وكم له؟",
    quick_choices: ["🧮 الحاسبات", "📄 افهم تقريرك", "إلغاء"],
    tips: [],
    when_to_seek_help: "إذا ألم صدر/ضيق نفس/إغماء/نزيف شديد: طوارئ فورًا.",
  });
}

// ===============================
// OCR + Report
// ===============================
let ocrWorkerPromise = null;
async function getOcrWorker() {
  if (!createWorker) return null;
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => await createWorker("eng+ara"))();
  }
  return ocrWorkerPromise;
}
async function ocrImage(buffer) {
  const w = await getOcrWorker();
  if (!w) return "";
  const { data } = await w.recognize(buffer);
  return data?.text ? String(data.text) : "";
}

// ===============================
// Routes
// ===============================
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "Dalil Alafiyah API", routes: ["/chat", "/report"] });
});

app.post("/chat", async (req, res) => {
  const userId = getUserId(req);
  const session = getSession(userId);

  const msg = String(req.body?.message || "").trim();
  if (!msg) return res.status(400).json({ ok: false, error: "empty_message" });

  // ====== تقرير (ثابت) ======
  if (isReportIntent(msg) && msg.length <= 40) {
    session.calc = null;
    return res.json({ ok: true, data: reportEntryCard() });
  }

  // ====== الحاسبات ======
  // إذا داخل حاسبة -> تابع الخطوات
  if (session.calc) {
    const out = continueCalc(session, msg);
    return res.json({ ok: true, data: out || calculatorsMenuCard() });
  }

  // بدء مسار الحاسبات (قائمة)
  if (isCalculatorsIntent(msg)) {
    return res.json({ ok: true, data: calculatorsMenuCard() });
  }

  // اختيار حاسبة من قائمة
  const picked = pickCalcFromChoice(msg);
  if (picked) {
    return res.json({ ok: true, data: startCalc(session, picked) });
  }

  // لو المستخدم كتب "حاسبة الضغط" مباشرة
  if (/حاسبة\s*الضغط/i.test(msg)) return res.json({ ok: true, data: startCalc(session, "bp") });
  if (/حاسبة\s*السكر/i.test(msg)) return res.json({ ok: true, data: startCalc(session, "sugar") });
  if (/حاسبة\s*الماء/i.test(msg)) return res.json({ ok: true, data: startCalc(session, "water") });
  if (/حاسبة\s*السعرات/i.test(msg)) return res.json({ ok: true, data: startCalc(session, "calories") });
  if (/حاسبة\s*كتلة|حاسبة\s*bmi/i.test(msg)) return res.json({ ok: true, data: startCalc(session, "bmi") });
  if (/حاسبة\s*المزاج/i.test(msg)) return res.json({ ok: true, data: startCalc(session, "mood") });

  // ====== fallback إلى LLM (فقط لغير الحاسبات) ======
  try {
    const raw = await callGroq([
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: msg },
    ]);
    const parsed = extractJson(raw);
    const data = parsed ? normalize(parsed) : fallbackCard();
    return res.json({ ok: true, data });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "server_error", data: fallbackCard() });
  }
});

app.post("/report", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ ok: false, error: "missing_file" });

    const mime = String(file.mimetype || "");
    let extractedText = "";

    if (mime === "application/pdf") {
      if (!pdfParse) {
        return res.json({
          ok: true,
          data: card({
            category: "report",
            title: "افهم تقريرك",
            verdict: "استلمت PDF لكن الخادم لا يدعم قراءة PDF حالياً.",
            next_question: "هل تقدر تلصق نص التقرير هنا؟",
            quick_choices: ["ألصق النص", "إلغاء"],
            tips: ["إذا PDF صورة (scan) الأفضل ترفع صورة واضحة."],
            when_to_seek_help: "إذا أعراض شديدة: راجع الطبيب/الطوارئ.",
          }),
        });
      }
      const parsed = await pdfParse(file.buffer).catch(() => null);
      extractedText = (parsed?.text || "").replace(/\s+/g, " ").trim();
    } else if (mime.startsWith("image/")) {
      extractedText = (await ocrImage(file.buffer)).replace(/\s+/g, " ").trim();
    } else {
      return res.status(400).json({ ok: false, error: "unsupported_type" });
    }

    if (!extractedText || extractedText.length < 40) {
      return res.json({
        ok: true,
        data: card({
          category: "report",
          title: "افهم تقريرك",
          verdict: "استلمت الملف لكن ما قدرت أقرأ نص كافي (قد يكون غير واضح).",
          next_question: "تقدر ترفع صورة أوضح أو تلصق أهم النتائج هنا؟",
          quick_choices: ["📎 إضافة مرفق", "ألصق النتائج"],
          tips: ["صوّر النتائج بإضاءة جيدة وبدون قصّ.", "اخفِ البيانات الشخصية إن أمكن."],
          when_to_seek_help: "إذا أعراض شديدة: راجع الطبيب/الطوارئ.",
        }),
      });
    }

    // لتقليل التوكنز: قص النص
    const clipped = extractedText.slice(0, 5000);

    // شرح عام بالـ LLM (اختياري)
    if (!GROQ_API_KEY) {
      return res.json({
        ok: true,
        data: card({
          category: "report",
          title: "افهم تقريرك",
          verdict: "تم استخراج نص من التقرير، لكن مفتاح GROQ غير مضبوط لتحليل النص.",
          next_question: "الصق أهم سطرين من النتائج وسأشرحها بشكل عام.",
          quick_choices: ["ألصق النتائج", "إلغاء"],
          tips: ["لا ترفع بيانات حساسة."],
          when_to_seek_help: "إذا أعراض شديدة: راجع الطبيب/الطوارئ.",
        }),
      });
    }

    const raw = await callGroq([
      { role: "system", content: `أنت مساعد تثقيف صحي عربي لشرح تقارير التحاليل بشكل عام. ممنوع: تشخيص/أدوية/جرعات. أخرج JSON بنفس مفاتيح البطاقة.` },
      { role: "user", content: "نص التقرير:\n" + clipped + "\n\nاشرح بشكل عام وباختصار." },
    ]);

    const parsed = extractJson(raw);
    const out = parsed
      ? normalize({ ...parsed, category: "report" })
      : card({
          category: "report",
          title: "افهم تقريرك",
          verdict: "تعذر تحليل التقرير الآن.",
          next_question: "جرّب صورة أوضح أو الصق النص.",
          quick_choices: ["📎 إضافة مرفق", "إلغاء"],
          tips: ["لا ترفع بيانات حساسة."],
          when_to_seek_help: "إذا أعراض شديدة: راجع الطبيب/الطوارئ.",
        });

    return res.json({ ok: true, data: out });
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      ok: false,
      error: "report_error",
      data: card({
        category: "report",
        title: "افهم تقريرك",
        verdict: "تعذر تحليل التقرير الآن.",
        next_question: "جرّب صورة أوضح أو الصق النص.",
        quick_choices: ["📎 إضافة مرفق", "إلغاء"],
        tips: [],
        when_to_seek_help: "إذا أعراض شديدة: راجع الطبيب/الطوارئ.",
      }),
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Dalil Alafiyah API يعمل على ${PORT}`);
});
