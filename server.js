// server.js — Dalil Alafiyah API (clean + hardened + cheaper routing) + TTS + Gemini

import "dotenv/config";
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();

/* ================= Gemini ================= */
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const genAI = GEMINI_API_KEY
  ? new GoogleGenerativeAI(GEMINI_API_KEY)
  : null;

/* ================= Groq ================= */
const GROQ_API_KEY = process.env.GROQ_API_KEY;

/* Small-first / Big-fallback (LLM) */
const SMALL_MODEL =
  process.env.GROQ_SMALL_MODEL || "openai/gpt-oss-120b";

const BIG_MODEL =
  (process.env.GROQ_BIG_MODEL ||
    process.env.GROQ_MODEL ||
    "llama-3.3-70b-versatile").trim();

/* ================= TTS ================= */
const TTS_MODEL =
  (process.env.GROQ_TTS_MODEL ||
    "canopylabs/orpheus-arabic-saudi").trim();

const TTS_VOICE =
  (process.env.GROQ_TTS_VOICE || "fahad").trim();

const PORT = process.env.PORT || 3000;

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/* ================= Security ================= */

app.use(helmet());
app.set("trust proxy", 1);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.length === 0) return cb(null, true);
      return ALLOWED_ORIGINS.includes(origin)
        ? cb(null, true)
        : cb(new Error("CORS blocked"), false);
    },
    methods: ["POST", "GET"],
  })
);

app.use(bodyParser.json({ limit: "2mb" }));

const chatLimiter = rateLimit({
  windowMs: 60000,
  max: Number(process.env.CHAT_RPM || 25),
});

const ttsLimiter = rateLimit({
  windowMs: 60000,
  max: Number(process.env.TTS_RPM || 18),
});

/* ================= Helpers ================= */

async function fetchWithTimeout(url, options = {}, ms = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

/* ================= Gemini Call ================= */

async function callGemini(messages, maxTokens) {

  if (!genAI) throw new Error("Gemini disabled");

  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
    generationConfig: {
      temperature: 0.35,
      maxOutputTokens: maxTokens,
    },
  });

  const prompt = messages
    .map(m => `${m.role}: ${m.content}`)
    .join("\n");

  const result =
    await model.generateContent(prompt);

  return result.response.text();
}

/* ================= Groq Call ================= */

async function callGroq(messages, { model, max_tokens }) {

  const res = await fetchWithTimeout(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.35,
        max_tokens,
        messages,
      }),
    },
    20000
  );

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

/* ================= JSON Tools ================= */

function cleanJsonish(s){
 let t=String(s||"").trim();
 const a=t.indexOf("{");
 const b=t.lastIndexOf("}");
 if(a===-1||b===-1) return null;
 try{
  return JSON.parse(t.slice(a,b+1));
 }catch{
  return null;
 }
}

function normalize(o){
 return{
  category:o?.category||"general",
  title:o?.title||"دليل العافية",
  verdict:o?.verdict||"",
  tips:Array.isArray(o?.tips)?o.tips.slice(0,3):[],
  when_to_seek_help:o?.when_to_seek_help||""
 };
}

function buildSystemPrompt(){
return `أنت "دليل العافية" مساعد تثقيف صحي توعوي.
أعد JSON فقط.`;
}

/* ================= Routes ================= */

app.get("/health",(_,res)=>res.json({ok:true}));

app.post("/chat",chatLimiter,async(req,res)=>{

try{

const msg=String(req.body?.message||"").trim();
if(!msg) return res.status(400).json({ok:false});

const messages=[
 {role:"system",content:buildSystemPrompt()},
 {role:"user",content:msg}
];

const maxTokens=220;

let raw;

/* ===== Gemini First ===== */

try{
 raw=await callGemini(messages,maxTokens);
}
catch(e){
 console.log("Gemini failed → Groq fallback");
 raw=await callGroq(messages,{
  model:SMALL_MODEL,
  max_tokens:maxTokens
 });
}

/* ===== Parsing ===== */

let parsed=cleanJsonish(raw);

if(!parsed){
 parsed={
  title:"معلومة صحية",
  verdict:raw.slice(0,200),
  tips:[]
 };
}

return res.json({
 ok:true,
 data:normalize(parsed)
});

}catch(e){

console.error(e);

return res.status(500).json({
 ok:false,
 error:"server_error"
});

}
});

/* ================= START ================= */

app.listen(PORT,()=>{
 console.log(`🚀 API running on :${PORT}`);
});
