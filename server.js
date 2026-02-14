
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const PORT = Number(process.env.PORT || 8000);
const HOST = "0.0.0.0";

// --- CORS (allow custom header x-user-id used by your UI) ---
const corsOptions = {
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-user-id", "X-User-Id"],
  exposedHeaders: ["Content-Type"],
  maxAge: 86400,
};

// Apply CORS early
app.use(cors(corsOptions));

// Preflight handler WITHOUT app.options('*')
app.use((req, res, next) => {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-user-id, X-User-Id");
    res.setHeader("Access-Control-Max-Age", "86400");
    return res.sendStatus(204);
  }
  next();
});

// Body parsing
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// --- Simple in-memory session store (lightweight, token-friendly) ---
const sessions = new Map(); // userId -> { history: [{role,content}], updatedAt }
const MAX_HISTORY = 8;      // keep small to save tokens

function getUserId(req) {
  return (
    req.get("x-user-id") ||
    req.get("X-User-Id") ||
    req.body?.userId ||
    req.query?.userId ||
    "anonymous"
  );
}

function getSession(userId) {
  let s = sessions.get(userId);
  if (!s) {
    s = { history: [], updatedAt: Date.now() };
    sessions.set(userId, s);
  }
  s.updatedAt = Date.now();
  return s;
}

function resetSession(userId) {
  sessions.delete(userId);
}

// --- Health ---
function healthHandler(_req, res) {
  res.json({ ok: true, time: new Date().toISOString() });
}
app.get("/health", healthHandler);
app.get("/healthz", healthHandler);
app.get("/api/health", healthHandler);
app.get("/api/healthz", healthHandler);

// --- PWA asset fallbacks to prevent SW cache.addAll failures ---
function sendIfExists(res, absPath, contentType) {
  try {
    if (fs.existsSync(absPath)) {
      if (contentType) res.type(contentType);
      return res.send(fs.readFileSync(absPath));
    }
  } catch {}
  return null;
}

app.get("/icon.svg", (req, res) => {
  const abs = path.join(__dirname, "icon.svg");
  const sent = sendIfExists(res, abs, "image/svg+xml");
  if (sent) return;
  // Fallback SVG (avoids 404)
  res.type("image/svg+xml").send(
    `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
      <rect width="256" height="256" rx="56" fill="#111"/>
      <text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" font-size="110" fill="#fff">D</text>
    </svg>`
  );
});

app.get("/manifest.webmanifest", (req, res) => {
  const abs = path.join(__dirname, "manifest.webmanifest");
  const sent = sendIfExists(res, abs, "application/manifest+json");
  if (sent) return;
  res.json({
    name: "DR",
    short_name: "DR",
    start_url: "/",
    display: "standalone",
    background_color: "#111111",
    theme_color: "#111111",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  });
});

app.get("/sw.js", (req, res) => {
  const abs = path.join(__dirname, "sw.js");
  const sent = sendIfExists(res, abs, "application/javascript");
  if (sent) return;
  // Minimal SW that won't crash if cached resources are missing
  res.type("application/javascript").send(`
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', (e) => { /* passthrough */ });
`);
});

// --- Serve static files if present (index.html/app.js/etc.) ---
app.use(express.static(__dirname, { extensions: ["html"] }));

// --- API stubs (replace with your smarter logic if needed) ---
function buildDefaultCard(text, quick = []) {
  return {
    role: "assistant",
    message: text,
    card: {
      title: "مساعد",
      body: text,
      quick_choices: quick.length ? quick : ["متابعة", "أمثلة", "نصائح"],
      intent: "general",
    },
  };
}

// POST /reset
function resetHandler(req, res) {
  const userId = getUserId(req);
  resetSession(userId);
  res.json({ ok: true });
}
app.post("/reset", resetHandler);
app.post("/api/reset", resetHandler);

// POST /chat
async function chatHandler(req, res) {
  const userId = getUserId(req);
  const session = getSession(userId);

  const userText = String(req.body?.message ?? req.body?.text ?? "").trim();
  if (!userText) return res.status(400).json({ ok: false, error: "Missing message" });

  session.history.push({ role: "user", content: userText });
  if (session.history.length > MAX_HISTORY) session.history.splice(0, session.history.length - MAX_HISTORY);

  // Lightweight local intent hints (saves tokens if you later connect LLM)
  const t = userText.toLowerCase();
  let quick = ["شرح مبسط", "متى أراجع طبيب؟", "نصائح عامة"];
  if (/(سكر|سكري|glucose|diabetes)/i.test(userText)) quick = ["أعراض شائعة", "مضاعفات", "نمط حياة"];
  if (/(ضغط|ضغط الدم|hypertension|bp)/i.test(userText)) quick = ["قياس صحيح", "أسباب", "نصائح"];
  if (/(تحاليل|تحليل|مختبر|lab)/i.test(userText)) quick = ["كيف أستعد؟", "قراءة النتائج", "أسئلة للطبيب"];

  const reply = buildDefaultCard("وصلت رسالتك. اكتب سؤالك بتفصيل بسيط وسأرتّب لك إجابة واضحة.", quick);

  session.history.push({ role: "assistant", content: reply.message });
  if (session.history.length > MAX_HISTORY) session.history.splice(0, session.history.length - MAX_HISTORY);

  res.json(reply);
}
app.post("/chat", chatHandler);
app.post("/api/chat", chatHandler);

// --- SPA fallback WITHOUT app.get('*') ---
app.use((req, res, next) => {
  // If it's an API route not found, return 404 JSON
  if (req.path.startsWith("/api/") || req.path === "/chat" || req.path === "/reset") {
    return res.status(404).json({ ok: false, error: "Not found" });
  }
  const indexPath = path.join(__dirname, "index.html");
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  return res.status(404).send("Not Found");
});

app.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
});
