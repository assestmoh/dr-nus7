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
    allowedHeaders: ["Content-Type","Authorization","x-user-id","X-User-Id","x-api-key","X-Api-Key"],
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
    verdict: "اختر الحاسبة التي تريدها (كلها ردود جاهزة لتوفير التوكنز):",
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
        next_question: "تريد نصائح لنمط الحياة حسب النتيجة؟",
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
        next_question: "تريد نصائح سريعة للأكل؟",
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
        next_question: "تريد طريقة توزيعها خلال اليوم؟",
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
        category: "calculators",
        title: "🩸 نتيجة السكر",
        verdict: `قراءة السكر ≈ **${mg} mg/dL** (${cls}).`,
        next_question: "تريد نصائح غذائية قصيرة؟",
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
        next_question: "تريد خطة بسيطة لليوم؟",
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
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || "";
  return text;
}

function extractJson(text) {
  try {
    return JSON.parse(text);
  } catch {}
  // fallback: حاول استخراج أول { ... }
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {}
  return null;
}

function normalize(x) {
  const v = x || {};
  return card({
    category: v.category || "general",
    title: v.title || "دليل العافية",
    verdict: v.verdict || "",
    next_question: v.next_question || "",
    quick_choices: Array.isArray(v.quick_choices) ? v.quick_choices : [],
    tips: Array.isArray(v.tips) ? v.tips : [],
    when_to_seek_help: v.when_to_seek_help || "",
  });
}

function fallbackCard() {
  return card({
    category: "general",
    title: "دليل العافية",
    verdict: "تعذر الحصول على رد واضح الآن. اكتب سؤالك بصيغة أبسط.",
    next_question: "ما هو سؤالك؟",
    quick_choices: ["🧮 الحاسبات", "📄 افهم تقريرك", "🩹 إسعافات أولية"],
    tips: ["اذكر العمر/الأعراض/المدة بدون معلومات حساسة."],
    when_to_seek_help: "إذا كانت أعراضك شديدة أو مفاجئة: راجع الطبيب/الطوارئ.",
  });
}

// ===============================
// Routes
// ===============================
app.get("/", (_req, res) => res.send("OK"));

app.post("/reset", (req, res) => {
  const userId = getUserId(req);
  sessions.delete(userId);
  return res.json({ ok: true });
});

app.post("/chat", async (req, res) => {
  const userId = getUserId(req);
  const session = getSession(userId);

  const msg = String(req.body?.message || "").trim();
  if (!msg) return res.status(400).json({ ok: false, error: "empty_message" });

  const metaRoute = String(req.body?.meta?.route || "").trim();

  // ====== مسارات مؤسسية (بطاقات جاهزة بدون LLM) ======
  // (هذه المسارات تُرسل من الواجهة عبر meta.route)
  if (metaRoute === "medication_general_guidance") {
    session.calc = null;
    return res.json({
      ok: true,
      data: card({
        category: "general",
        title: "💊 تثقيف أدوية عام",
        verdict:
          "اختصار مفيد قبل استخدام أي دواء: اقرأ النشرة، التزم بالجرعة الموصوفة، ولا تجمع أدوية متعددة لنفس العرض بدون استشارة مختص.",
        next_question: "تريد تثقيف عام عن أي نقطة؟",
        quick_choices: ["✅ استخدام آمن", "⚠️ آثار جانبية شائعة", "🔁 تداخلات دوائية", "⛔ متى أتجنب الدواء؟", "إلغاء"],
        tips: [
          "لا أقدّم جرعات أو وصفات علاج.",
          "للحامل/المرضع/الأطفال/الأمراض المزمنة: اسأل الطبيب/الصيدلي قبل أي دواء.",
        ],
        when_to_seek_help: "إذا ظهرت حساسية شديدة (تورّم/ضيق نفس/طفح منتشر): طوارئ فورًا.",
      }),
    });
  }

  if (metaRoute === "common_conditions_education") {
    session.calc = null;
    return res.json({
      ok: true,
      data: card({
        category: "general",
        title: "🩺 تثقيف عن أمراض شائعة",
        verdict: "اختر موضوعًا شائعًا للتثقيف العام:",
        next_question: "أي موضوع تختار؟",
        quick_choices: ["الضغط", "السكر", "الزكام/الإنفلونزا", "الربو", "آلام الظهر", "إلغاء"],
        tips: ["الشرح للتوعية العامة وليس تشخيصًا."],
        when_to_seek_help: "إذا أعراض شديدة أو مفاجئة: راجع الطبيب/الطوارئ.",
      }),
    });
  }

  if (metaRoute === "prevention_lifestyle") {
    session.calc = null;
    return res.json({
      ok: true,
      data: card({
        category: "general",
        title: "🌿 نمط الحياة",
        verdict: "اختر محورًا لنصائح نمط الحياة:",
        next_question: "نبدأ بأي محور؟",
        quick_choices: ["🍽️ تغذية", "🏃 نشاط بدني", "😴 نوم", "🧘 ضغط نفسي", "🚭 إقلاع عن التدخين", "إلغاء"],
        tips: ["نصائح عملية قصيرة وقابلة للتطبيق."],
        when_to_seek_help: "",
      }),
    });
  }

  // ====== إسعافات أولية (جاهز بدون LLM) ======
  if (/إسعافات\s*أولية|🩹/i.test(msg)) {
    session.calc = null;
    return res.json({
      ok: true,
      data: card({
        category: "first_aid",
        title: "🩹 إسعافات أولية",
        verdict: "اختر الحالة للحصول على خطوات إسعاف أولي عامة:",
        next_question: "أي حالة؟",
        quick_choices: ["🔥 حروق بسيطة", "🩸 نزيف/جرح", "🤕 التواء/كدمة", "😵 إغماء", "🧒 اختناق", "إلغاء"],
        tips: ["إذا الحالة خطيرة أو تتدهور: اطلب طوارئ فورًا."],
        when_to_seek_help: "ضيق نفس/ألم صدر/نزيف شديد/فقدان وعي طويل: طوارئ فورًا.",
      }),
    });
  }

  // ردود إسعاف أولي جاهزة (تُستدعى من أزرار القائمة)
  if (/^🔥\s*حروق بسيطة$/i.test(msg)) {
    return res.json({
      ok: true,
      data: card({
        category: "first_aid",
        title: "🔥 حروق بسيطة",
        verdict:
          "1) برّد مكان الحرق بماء جارٍ فاتر/بارد لمدة 10–20 دقيقة.\n2) انزع الإكسسوارات القريبة (خواتم) إذا ممكن قبل التورّم.\n3) غطِّ الحرق بضماد/شاش نظيف غير لاصق.\n4) لا تضع معجون/زيوت/ثلج مباشر.\n5) لا تفقع الفقاعات.",
        next_question: "هل الحرق كبير أو في الوجه/اليد/الأعضاء التناسلية؟",
        quick_choices: ["نعم", "لا", "🩹 إسعافات أولية", "إلغاء"],
        tips: ["إذا الألم شديد: يمكن مسكن مناسب حسب الإرشادات العامة (بدون جرعات هنا)."],
        when_to_seek_help:
          "إذا الحرق كبير، أو كيميائي/كهربائي، أو مع فقاعات واسعة، أو على الوجه/المفاصل/اليدين: راجع الطوارئ.",
      }),
    });
  }

  if (/^🩸\s*نزيف\/جرح$/i.test(msg)) {
    return res.json({
      ok: true,
      data: card({
        category: "first_aid",
        title: "🩸 نزيف/جرح",
        verdict:
          "1) اضغط بقطعة قماش/شاش نظيف مباشرة على الجرح 10 دقائق دون رفعها.\n2) ارفع الطرف المصاب إن أمكن.\n3) إذا تشبّع الشاش: أضف طبقة فوقه ولا تنزع الأولى.\n4) بعد توقف النزيف: نظّف حول الجرح وغطّه بضماد.",
        next_question: "هل النزيف غزير أو لا يتوقف بعد 10 دقائق ضغط؟",
        quick_choices: ["نعم", "لا", "🩹 إسعافات أولية", "إلغاء"],
        tips: ["للجروح العميقة/المتسخة قد تحتاج تطعيم كزاز."],
        when_to_seek_help: "نزيف غزير/جرح عميق/أجسام مغروسة/دوخة شديدة: طوارئ فورًا.",
      }),
    });
  }

  if (/^🤕\s*التواء\/كدمة$/i.test(msg)) {
    return res.json({
      ok: true,
      data: card({
        category: "first_aid",
        title: "🤕 التواء/كدمة",
        verdict:
          "قاعدة RICE خلال 24–48 ساعة:\n- Rest: راحة\n- Ice: كمادات باردة 15–20 دقيقة كل 2–3 ساعات\n- Compression: رباط ضاغط خفيف\n- Elevation: رفع الطرف\nتجنب التدليك القوي أول يوم.",
        next_question: "هل يوجد تشوّه واضح أو عدم قدرة على المشي/استخدام الطرف؟",
        quick_choices: ["نعم", "لا", "🩹 إسعافات أولية", "إلغاء"],
        tips: ["إذا الألم يزيد أو تورّم شديد: قيّم لدى طبيب."],
        when_to_seek_help: "تشوه/خدر/ألم شديد جدًا/اشتباه كسر: طوارئ أو أشعة.",
      }),
    });
  }

  if (/^😵\s*إغماء$/i.test(msg)) {
    return res.json({
      ok: true,
      data: card({
        category: "first_aid",
        title: "😵 إغماء",
        verdict:
          "1) مدد الشخص على ظهره وارفع قدميه قليلًا.\n2) فكّ الملابس الضيقة وتأكد من التهوية.\n3) إذا استعاد وعيه: اجعله يجلس تدريجيًا واشرب ماء إذا قادر.\n4) إذا لا يستجيب أو لا يتنفس: اتصل بالطوارئ وابدأ إنعاش قلبي رئوي إن كنت مدرّبًا.",
        next_question: "هل فقد الوعي أكثر من دقيقة أو حدث مع ألم صدر/ضيق نفس؟",
        quick_choices: ["نعم", "لا", "🩹 إسعافات أولية", "إلغاء"],
        tips: ["لا تُعطه شيئًا بالفم إذا غير واعٍ."],
        when_to_seek_help: "فقدان وعي مطوّل/تشنجات/ألم صدر/ضيق نفس/إصابة رأس: طوارئ فورًا.",
      }),
    });
  }

  if (/^🧒\s*اختناق$/i.test(msg)) {
    return res.json({
      ok: true,
      data: card({
        category: "first_aid",
        title: "🧒 اختناق",
        verdict:
          "إذا كان الشخص يسعل بقوة: شجّعه على السعال.\nإذا لا يستطيع الكلام/التنفس: اطلب طوارئ فورًا وابدأ مناورة هيمليك (للبالغين) أو ضربات ظهر/ضغطات صدر للرضع حسب التدريب.",
        next_question: "العمر: رضيع أم طفل/بالغ؟",
        quick_choices: ["رضيع", "طفل/بالغ", "🩹 إسعافات أولية", "إلغاء"],
        tips: ["التدريب العملي على الإسعافات مهم جدًا."],
        when_to_seek_help: "اختناق شديد دائمًا حالة طارئة.",
      }),
    });
  }

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

  // ====== fallback إلى LLM (فقط لغير الحاسبات/التقرير) ======
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
    if (!file) return res.status(400).json({ ok: false, error: "no_file" });

    // محتوى التقرير: PDF parse أو OCR للصورة
    let text = "";

    // PDF
    const isPdf = /pdf/i.test(file.mimetype) || /\.pdf$/i.test(file.originalname);
    if (isPdf && pdfParse) {
      const pdf = await pdfParse(file.buffer);
      text = String(pdf?.text || "").trim();
    }

    // Image OCR
    if (!text) {
      if (!createWorker) throw new Error("OCR_unavailable");
      const worker = await createWorker("eng");
      const out = await worker.recognize(file.buffer);
      await worker.terminate();
      text = String(out?.data?.text || "").trim();
    }

    // إذا فاضي
    if (!text) {
      return res.json({
        ok: true,
        data: card({
          category: "report",
          title: "افهم تقريرك",
          verdict: "لم أتمكن من قراءة محتوى واضح من الملف.",
          next_question: "جرّب صورة أوضح أو PDF نصّي قابل للنسخ.",
          quick_choices: ["📎 إضافة مرفق", "إلغاء"],
          tips: ["تصوير مباشر بإضاءة جيدة يساعد كثيرًا."],
          when_to_seek_help: "إذا أعراض شديدة: راجع الطبيب/الطوارئ.",
        }),
      });
    }

    // رد عام بسيط (بدون LLM): أعط المستخدم مسار “الصق النص” أو “حدد التحليل”
    return res.json({
      ok: true,
      data: card({
        category: "report",
        title: "افهم تقريرك",
        verdict: "تم استخراج نص من التقرير. (شرح عام)\nالصق اسم التحليل الذي تريد فهمه مثل: HbA1c أو Cholesterol أو CBC.",
        next_question: "ما اسم التحليل الذي تريد شرحه؟",
        quick_choices: ["إلغاء"],
        tips: ["للدقة: اذكر القيم + الوحدة + المرجع إن وجد."],
        when_to_seek_help: "إذا القيم عالية جدًا مع أعراض: راجع الطبيب.",
      }),
    });
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
