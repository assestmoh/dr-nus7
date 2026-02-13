/**
 * server.fixed9.js
 * - Fix CORS preflight to allow x-user-id
 * - Serve icon.svg (and SW/manifest fallbacks) to stop service worker cache.addAll() failures
 * - Keep existing API surface: /chat, /reset, /health (+ /api/* aliases)
 *
 * NOTE: This file assumes Express is installed (as in your project).
 */
import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";

const app = express();

// ====== Config ======
const PORT = Number(process.env.PORT || 8000);
const HOST = "0.0.0.0";
const ROOT = process.cwd();

// ====== Body parsers ======
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// ====== CORS (FIX: allow x-user-id) ======
const corsOptions = {
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "X-User-Id",
    "x-user-id",
    "Accept",
    "Origin"
  ],
  exposedHeaders: ["Content-Type"],
  maxAge: 86400
};
app.use(cors(corsOptions));

// Robust preflight handling without app.options('*') (Express/path-to-regexp v8 compatibility)
app.use((req, res, next) => {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      corsOptions.allowedHeaders.join(", ")
    );
    res.setHeader("Access-Control-Max-Age", String(corsOptions.maxAge));
    return res.status(204).end();
  }
  next();
});

// ====== Static hosting + fallbacks for PWA assets ======
app.use(express.static(ROOT, { extensions: ["html"] }));

function sendFileIfExists(res, filepath, contentType) {
  if (fs.existsSync(filepath)) {
    if (contentType) res.type(contentType);
    return res.sendFile(filepath);
  }
  return false;
}

app.get("/icon.svg", (req, res) => {
  const ok = sendFileIfExists(res, path.join(ROOT, "icon.svg"), "image/svg+xml");
  if (ok) return;
  // Fallback SVG to avoid 404 (prevents SW cache.addAll failure)
  res.type("image/svg+xml").send(
    `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
      <rect width="512" height="512" rx="96" fill="#111"/>
      <text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" font-size="180" fill="#fff" font-family="Arial, sans-serif">DR</text>
    </svg>`
  );
});

app.get("/manifest.webmanifest", (req, res) => {
  const ok = sendFileIfExists(res, path.join(ROOT, "manifest.webmanifest"), "application/manifest+json");
  if (ok) return;
  res.json({
    name: "DR",
    short_name: "DR",
    start_url: "/",
    display: "standalone",
    background_color: "#111111",
    theme_color: "#111111",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }]
  });
});

app.get("/sw.js", (req, res) => {
  const ok = sendFileIfExists(res, path.join(ROOT, "sw.js"), "application/javascript");
  if (ok) return;
  // Minimal SW fallback that won't crash if assets missing
  res.type("application/javascript").send(`
self.addEventListener('install', (event) => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', (event) => { /* passthrough */ });
`);
});

// ====== Health ======
function health(req, res) {
  res.json({ ok: true, now: new Date().toISOString() });
}
app.get("/health", health);
app.get("/healthz", health);
app.get("/api/health", health);
app.get("/api/healthz", health);

// ====== In-memory session store (simple) ======
const sessions = new Map(); // userId -> { messages: [...], updatedAt: number }

function getUserId(req) {
  return (
    req.headers["x-user-id"] ||
    req.headers["X-User-Id"] ||
    req.body?.userId ||
    req.query?.userId ||
    "anon"
  );
}

// ====== API: reset ======
function doReset(req, res) {
  const userId = String(getUserId(req));
  sessions.delete(userId);
  res.json({ ok: true, userId, reset: true });
}
app.post("/reset", doReset);
app.post("/api/reset", doReset);

// ====== API: chat ======
// IMPORTANT: This is a safe stub if your original AI logic isn't present in this file.
// If you already have your full AI logic in your existing server.js, merge ONLY the CORS + asset fixes above.
async function doChat(req, res) {
  const userId = String(getUserId(req));
  const text = String(req.body?.message ?? req.body?.text ?? "").trim();

  if (!text) {
    return res.status(400).json({
      ok: false,
      error: "missing_message",
      message: "أرسل نص السؤال في الحقل message"
    });
  }

  const session = sessions.get(userId) || { messages: [], updatedAt: Date.now() };
  session.messages.push({ role: "user", content: text, ts: Date.now() });
  session.updatedAt = Date.now();
  sessions.set(userId, session);

  // Replace with your real LLM call; keeping response shape compatible:
  return res.json({
    ok: true,
    message: "تم استلام سؤالك. (هذا رد تجريبي) — اربط منطق الذكاء هنا.",
    card: {
      title: "خيارات سريعة",
      body: "اختر التالي أو اكتب سؤالك بالتفصيل",
      quick_choices: [
        "أعراض شائعة",
        "نصائح عامة",
        "متى أراجع طبيب؟",
        "تقرير مختصر"
      ]
    }
  });
}
app.post("/chat", doChat);
app.post("/api/chat", doChat);

// ====== SPA fallback (keeps API intact) ======
app.get("*", (req, res) => {
  const indexPath = path.join(ROOT, "index.html");
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  res.status(404).send("Not Found");
});

// ====== Start ======
app.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
});
