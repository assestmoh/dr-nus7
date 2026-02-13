// server.fixed7.js
// هدف هذه النسخة: حل CORS + منع سقوط Service Worker بسبب 404 + توفير endpoints /chat و /api/chat بدون لمس الواجهة.

import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";

const app = express();

// CORS + preflight (works on Express 5 / path-to-regexp v6)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});


// ====== إعدادات عامة ======
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

// CORS: افتحها بالكامل لأن الواجهة عندك قد تكون على localhost وتستدعي API من Koyeb.
// (بدون credentials)
const corsMw = cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400,
});
app.use(corsMw);

// ====== ثوابت مسارات الملفات الثابتة ======
const ROOT = process.cwd();
const PUBLIC_DIR = ROOT; // ملفاتك (index.html, app.js, sw.js) موجودة بجذر المشروع حسب رفعك

function sendIfExists(res, absPath, contentType) {
  if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
    if (contentType) res.type(contentType);
    return res.send(fs.readFileSync(absPath));
  }
  return false;
}

// ====== Endpoints صحية/فحص ======
const okPayload = { ok: true, ts: new Date().toISOString() };
app.get(["/health", "/healthz", "/api/health", "/api/healthz"], (req, res) => res.json(okPayload));

// ====== ملفات PWA المطلوبة (Fallback لمنع 404) ======
app.get("/icon.svg", (req, res) => {
  const p = path.join(PUBLIC_DIR, "icon.svg");
  if (sendIfExists(res, p, "image/svg+xml")) return;
  // fallback SVG بسيط
  res.type("image/svg+xml").send(
    `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
      <rect width="256" height="256" rx="48" fill="#111"/>
      <text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" font-size="92" fill="#fff" font-family="Arial">DR</text>
    </svg>`
  );
});

app.get("/manifest.webmanifest", (req, res) => {
  const p = path.join(PUBLIC_DIR, "manifest.webmanifest");
  if (sendIfExists(res, p, "application/manifest+json")) return;
  // fallback manifest
  res.json({
    name: "DR",
    short_name: "DR",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#111111",
    icons: [{ src: "/icon.svg", sizes: "256x256", type: "image/svg+xml" }],
  });
});

app.get("/sw.js", (req, res) => {
  const p = path.join(PUBLIC_DIR, "sw.js");
  if (sendIfExists(res, p, "application/javascript")) return;

  // fallback SW: ما يستخدم cache.addAll (عشان ما ينهار بسبب 404)
  res.type("application/javascript").send(`
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', (e) => { /* passthrough */ });
`);
});

// ====== تقديم ملفات الواجهة الأساسية ======
app.get("/app.js", (req, res) => {
  const p = path.join(PUBLIC_DIR, "app.js");
  if (sendIfExists(res, p, "application/javascript")) return;
  res.status(404).send("app.js not found");
});

app.get("/", (req, res) => {
  const p = path.join(PUBLIC_DIR, "index.html");
  if (sendIfExists(res, p, "text/html")) return;
  res.status(404).send("index.html not found");
});

// ====== منطق /chat (نسخة بسيطة + آمنة) ======
// ملاحظة: هنا نخلي الذكاء الحقيقي من مزودك (Groq/OpenAI...) حسب ENV.
// لو ما عندك مفتاح، نعطي رد محلي مُنظّم بدل 500.
function buildQuickChoices(intent) {
  const presets = {
    general: ["أعراض عامة", "نصائح وقاية", "متى أراجع طبيب؟", "تلخيص سريع"],
    report: ["تلخيص التقرير", "أهم المؤشرات", "أسئلة للطبيب", "نصائح متابعة"],
    meds: ["بدائل آمنة", "آثار جانبية", "تداخلات محتملة", "متى أتوقف؟"],
    urgent: ["إسعافات أولية", "علامات الخطر", "متى الطوارئ؟", "خطوات الآن"],
  };
  return presets[intent] || presets.general;
}

function inferIntent(text = "") {
  const t = String(text).toLowerCase();
  if (/(تقرير|تحاليل|نتيجة|cbc|hba1c|ضغط|سكر)/i.test(text)) return "report";
  if (/(دواء|حبوب|جرعة|صيدلية|antibiotic|ibuprofen|paracetamol)/i.test(text)) return "meds";
  if (/(نزيف|ضيق نفس|ألم صدر|إغماء|شلل|سكتة|انتحار|جرح عميق)/i.test(text)) return "urgent";
  return "general";
}

function makeCard({ title, body, quick_choices }) {
  return {
    title: title || "مساعدة صحية",
    body: body || "",
    quick_choices: Array.isArray(quick_choices) ? quick_choices.slice(0, 6) : [],
  };
}

async function callLLMOrFallback(userText) {
  // لو عندك مزود فعلي، اربطه هنا.
  // حاليا fallback منظم لتجنب 500 وتخريب UX.
  const intent = inferIntent(userText);
  const card = makeCard({
    title: intent === "report" ? "تقرير" : "إجابة",
    body:
      intent === "urgent"
        ? "إذا عندك علامة خطر (ألم صدر/ضيق نفس/إغماء/نزيف شديد)، توجه للطوارئ فورًا. إذا تقدر، اذكر العمر والأعراض ومدة ظهورها."
        : "اكتب سؤالك بشكل أدق (العمر، الأعراض، المدة، أمراض مزمنة). وسأرد عليك بمعلومات عامة وخطوات عملية.",
    quick_choices: buildQuickChoices(intent),
  });

  return { message: card.body, card, intent };
}

async function handleChat(req, res) {
  try {
    const text = (req.body && (req.body.message || req.body.text || req.body.q)) ?? "";
    const out = await callLLMOrFallback(text);

    // الشكل المتوقع عادة: { message, card }
    res.json({
      message: out.message,
      card: out.card,
      intent: out.intent,
    });
  } catch (err) {
    console.error("CHAT_ERROR", err);
    res.status(500).json({ error: "server_error", message: "حدث خطأ في السيرفر" });
  }
}

app.post(["/chat", "/api/chat"], handleChat);

// ====== SPA fallback (لو عندك مسارات داخلية) ======
app.get(/.*/, (req, res) => {
  // لا تكسر مسارات API
  if (req.path.startsWith("/api/") || req.path === "/chat") return res.status(404).end();
  const p = path.join(PUBLIC_DIR, "index.html");
  if (sendIfExists(res, p, "text/html")) return;
  res.status(404).send("Not Found");
});

// ====== تشغيل ======
const PORT = Number(process.env.PORT || 8000);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on 0.0.0.0:${PORT}`);
});
