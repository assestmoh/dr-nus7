/* app.js — Dalil Alafiyah (Final) */
(() => {
  // ========= ضبط الروابط =========
  // تقدر تغيّر رابط الـ API بدون ما تلمس الكود:
  // 1) ?api=https://your-backend.example.com
  // 2) localStorage.setItem('dalil_api_base','https://...')
  const DEFAULT_BACKEND_URL = "https://ruling-violet-m0h-217b6aa8.koyeb.app/chat";

  function getApiBase() {
    try {
      const url = new URL(window.location.href);
      const qp = url.searchParams.get("api");
      if (qp && /^https?:\/\//i.test(qp)) return qp.replace(/\/+$/, "");
    } catch {}

    try {
      const saved = localStorage.getItem("dalil_api_base");
      if (saved && /^https?:\/\//i.test(saved)) return saved.replace(/\/+$/, "");
    } catch {}

    return DEFAULT_BACKEND_URL.replace(/\/chat\/?$/, "").replace(/\/+$/, "");
  }

  const BACKEND_BASE = getApiBase();
  const BACKEND_URL = `${BACKEND_BASE}/chat`;
  const BACKEND_RESET_URL = `${BACKEND_BASE}/reset`;
  const BACKEND_TTS_URL = `${BACKEND_BASE}/tts`;

  // ========= Google Sheet Feedback (Webhook) =========
  // رابط Google Apps Script Web App (منك)
  const SHEET_WEBHOOK_URL =
    "https://script.google.com/macros/s/AKfycbwy-kC2-CnKXFlntWJR80N3C9Y-RD_oi-Ul3y9nQC9vN9IkbPe_2HAfWX0vXe6-jwuS/exec";
  const SHEET_SECRET = "123456";

  // ========= عناصر الصفحة =========
  const chat = document.getElementById("chat");
  const input = document.getElementById("userInput");
  const sendBtn = document.getElementById("sendBtn");
  const resetBtn = document.getElementById("resetBtn");
  const themeBtn = document.getElementById("themeBtn");
  const installBtn = document.getElementById("installBtn");
  const installBackdrop = document.getElementById("installBackdrop");
  const installClose = document.getElementById("installClose");

  const statusText = document.getElementById("statusText");

  const toastEl = document.getElementById("toast");
  const toastTitle = document.getElementById("toastTitle");
  const toastMsg = document.getElementById("toastMsg");
  const toastClose = document.getElementById("toastClose");

  const welcomeEl = document.getElementById("welcome");
  const welcomeStart = document.getElementById("welcomeStart");
  const welcomePrivacy = document.getElementById("welcomePrivacy");

  const privacyBackdrop = document.getElementById("privacyBackdrop");
  const privacyClose = document.getElementById("privacyClose");

  // ========= حالة التطبيق =========
  let LAST_CARD = null;

  // install (PWA)
  let deferredInstallPrompt = null;

  // calc
  let calcMode = null;
  let calcStep = 0;
  let calcData = {};
  let pendingTips = null;

  // mood
  let moodMode = false;
  let moodStep = 0;
  let moodAnswers = [];

  // ========= utils =========
  function setStatus(mode, text) {
    const dot = document.querySelector(".dot");
    if (dot) {
      dot.classList.remove("ok", "warn");
      dot.classList.add(mode === "warn" ? "warn" : "ok");
    }
    if (statusText && text) statusText.textContent = text;
  }

  function lockSend(isLocked) {
    if (!sendBtn) return;
    sendBtn.disabled = !!isLocked;
    sendBtn.classList.toggle("disabled", !!isLocked);
  }

  function nowTime() {
    return new Date().toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" });
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function linkify(escapedText) {
    return escapedText.replace(/(https?:\/\/[^\s<]+)/g, (url) => {
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
    });
  }

  function renderMarkdown(text) {
    let t = escapeHtml(text);
    t = linkify(t);
    t = t.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/^-\s+/gm, "• ");
    t = t.replace(/\n/g, "<br>");
    return t;
  }



  function injectQuickStartStyles() {
    try {
      if (document.getElementById("qs-inline-style")) return;
      const st = document.createElement("style");
      st.id = "qs-inline-style";
      st.textContent = `
        .qs-title{
          font-size:13px;
          font-weight:600;
          margin:10px 0 4px;
          opacity:.7;
        }
        .chips-scroll::-webkit-scrollbar{height:6px}
        .chips-scroll::-webkit-scrollbar-thumb{background:rgba(0,0,0,.22);border-radius:10px}
      `;
      document.head.appendChild(st);
    } catch {}
  }


  // toast
  let toastTimer = null;
  function showToast(title, msg) {
    toastTitle.textContent = title || "تنبيه";
    toastMsg.textContent = msg || "";
    toastEl.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 2600);
  }
  function hideToast() {
    toastEl.classList.remove("show");
  }

  // fetch timeout
  function fetchWithTimeout(url, options = {}, ms = 14000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), ms);
    return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(id));
  }


  // ========= TTS (Orpheus Arabic Saudi) =========
  // يتطلب endpoint في السيرفر: POST /tts { text, voice } => audio/wav
  let currentAudio = null;

  function pickSpeechText(card) {
    const title = String(card?.title || "").trim();
    const verdict = String(card?.verdict || "").trim();
    const t = (title ? `${title}. ` : "") + verdict;
    // keep it short for faster TTS
    return t.length > 160 ? t.slice(0, 157) + "…" : t;
  }


  async function playTTSFromCard(card, voice = "fahad") {
    try {
      if (!BACKEND_TTS_URL) return;

      const text = pickSpeechText(card);
      if (!text) return;

      // أوقف أي صوت سابق
      try { if (currentAudio) currentAudio.pause(); } catch {}

      const res = await fetchWithTimeout(
        BACKEND_TTS_URL,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, voice }),
        },
        20000
      );

      if (!res.ok) throw new Error("HTTP_" + res.status);

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);

      const audio = new Audio(url);
      currentAudio = audio;

      audio.onended = () => { try { URL.revokeObjectURL(url); } catch {} };
      audio.onerror = () => { try { URL.revokeObjectURL(url); } catch {} };

      await audio.play();
    } catch {
      showToast("تنبيه", "تعذر تشغيل الصوت الآن.");
    }
  }


  // user id
  function getUserId() {
    try {
      const k = "wellness_uid_v1";
      let v = localStorage.getItem(k);
      if (v) return v;
      v = "u_" + Math.random().toString(16).slice(2) + "_" + Date.now().toString(16);
      localStorage.setItem(k, v);
      return v;
    } catch {
      return "u_" + Date.now();
    }
  }
  const USER_ID = getUserId();

  // ========= Feedback logger (Google Sheet) =========
  // ✅ التعديل الأخير: Image Beacon GET لتجاوز CORS نهائيًا
  function logFeedback(type) {
    try {
      if (!SHEET_WEBHOOK_URL) return;

      const qs = new URLSearchParams({
        secret: SHEET_SECRET,
        type: String(type || ""),        // up/down
        user_id: USER_ID,
        page: location.pathname,
        t: String(Date.now())            // cache buster
      });

      const img = new Image();
      img.src = `${SHEET_WEBHOOK_URL}?${qs.toString()}`;
    } catch {}
  }

  // digits
  function normalizeDigits(str) {
    const arabicIndic = "٠١٢٣٤٥٦٧٨٩";
    const easternIndic = "۰۱۲۳۴۵۶۷۸۹";
    let out = "";
    str = String(str || "");
    for (let i = 0; i < str.length; i++) {
      const ch = str.charAt(i);
      const idx1 = arabicIndic.indexOf(ch);
      const idx2 = easternIndic.indexOf(ch);
      if (idx1 !== -1) out += String(idx1);
      else if (idx2 !== -1) out += String(idx2);
      else out += ch;
    }
    return out;
  }

  function isYes(text) {
    const t = String(text || "").trim().toLowerCase();
    return ["نعم", "اي", "ايه", "ايوه", "أيوة", "ok", "yes", "تمام"].some((w) => t === w || t.includes(w));
  }
  function isNo(text) {
    const t = String(text || "").trim().toLowerCase();
    return ["لا", "مو", "مش", "no", "ماعندي", "مابي", "ما ابي"].some((w) => t === w || t.includes(w));
  }

  // emergency local fallback
  function normalizeText(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[^\u0600-\u06FFa-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  function isEmergency(text) {
    const t = normalizeText(text);
    const flags = [
      "الم شديد في الصدر",
      "ألم شديد في الصدر",
      "الم صدر",
      "ألم صدر",
      "ضيق نفس شديد",
      "صعوبة تنفس",
      "اختناق",
      "اغماء",
      "إغماء",
      "شلل",
      "ضعف مفاجئ",
      "تلعثم",
      "تشوش كلام",
      "نزيف شديد",
      "نزيف قوي",
      "تشنج",
      "نوبة",
      "افكار انتحارية",
      "أفكار انتحارية",
      "انتحار",
      "ايذاء النفس",
      "إيذاء النفس",
    ];
    return flags.some((f) => t.includes(normalizeText(f)));
  }
  function fallbackReply(userText) {
    if (isEmergency(userText)) {
      return "⚠️ **تنبيه**\nإذا لديك ألم صدر شديد/ضيق نفس شديد/إغماء/ضعف مفاجئ/نزيف شديد/تشنجات أو أفكار بإيذاء النفس: توجه للطوارئ فورًا أو اتصل بالإسعاف الآن.";
    }
    return "ℹ️ تعذر الاتصال بالذكاء الان. جرّب مرة ثانية.";
  }

  // ========= UI helpers =========
  function addMsg(text, from = "bot", options = {}) {
    const msg = document.createElement("div");
    msg.className = "msg " + from;

    const bubble = document.createElement("div");
    bubble.className = "bubble";

    if (options.html === true) bubble.innerHTML = text;
    else if (from === "bot") bubble.innerHTML = renderMarkdown(text);
    else bubble.textContent = text;

    const meta = document.createElement("div");
    meta.className = "msg-meta";
    meta.textContent = nowTime();

    msg.appendChild(bubble);

    if (from === "bot" && options.rate === true) {
      msg.appendChild(buildRatingRow());
    }

    msg.appendChild(meta);
    chat.appendChild(msg);
    chat.scrollTop = chat.scrollHeight;
    return msg;
  }

  function buildTypingHtml() {
    return '<span class="typing">يكتب الآن <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span></span>';
  }

  function buildRatingRow() {
    const row = document.createElement("div");
    row.className = "rating";
    row.innerHTML = '<span class="rate-hint">قيّم الرد:</span>';

    const up = document.createElement("button");
    up.className = "rate-btn";
    up.type = "button";
    up.innerHTML = "👍 <span>مفيد</span>";

    const down = document.createElement("button");
    down.className = "rate-btn";
    down.type = "button";
    down.innerHTML = "👎 <span>غير مفيد</span>";

    function lock() {
      up.disabled = true;
      down.disabled = true;
    }
    up.onclick = () => {
      lock();
      logFeedback("up"); // ✅ تسجيل مفيد
      showToast("تم", "شكرًا!");
    };
    down.onclick = () => {
      lock();
      logFeedback("down"); // ✅ تسجيل غير مفيد
      showToast("تم", "شكرًا لملاحظتك.");
    };

    row.appendChild(up);
    row.appendChild(down);
    return row;
  }

  // ========= Bot card renderer =========
  const CATEGORY_MAP = {
    mental: { label: "مزاج", icon: "🧠", color: "#2563eb" },
    report: { label: "تقرير", icon: "🧾", color: "#1d4ed8" },
    bmi: { label: "BMI", icon: "📏", color: "#2563eb" },
    bp: { label: "ضغط", icon: "💓", color: "#2563eb" },
    sugar: { label: "سكر", icon: "🩸", color: "#2563eb" },
    water: { label: "سوائل", icon: "💧", color: "#10b981" },
    calories: { label: "سعرات", icon: "🔥", color: "#2563eb" },
    nutrition: { label: "تغذية", icon: "🥗", color: "#2563eb" },
    sleep: { label: "نوم", icon: "😴", color: "#2563eb" },
    activity: { label: "نشاط", icon: "🏃", color: "#2563eb" },
    first_aid: { label: "إسعاف", icon: "⛑️", color: "#2563eb" },
    emergency: { label: "طارئ", icon: "🚨", color: "#ef4444" },
    general: { label: "عام", icon: "🩺", color: "#2563eb" },
  };

  function pickCategoryFromPayload(data) {
    const c = data && data.category;
    if (c && CATEGORY_MAP[c]) return CATEGORY_MAP[c];
    return CATEGORY_MAP.general;
  }

  function isDangerCard(data) {
    const t = String((data && data.title) || "");
    const v = String((data && data.verdict) || "");
    return /تنبيه|طارئ|خطر|🚨/.test(t) || /طوارئ|اتصل|فورًا/.test(v);
  }

  function renderStructuredCard(data) {
    data = data || {};
    const title = String(data.title || "دليل العافية");
    const verdict = String(data.verdict || "").trim();
    const tips = Array.isArray(data.tips) ? data.tips : [];
    const seek = String(data.when_to_seek_help || "").trim();
    const q = String(data.next_question || "").trim();
    const choices = Array.isArray(data.quick_choices) ? data.quick_choices : [];

    const badgeClass = isDangerCard(data) ? "danger" : "ok";
    const badgeText = isDangerCard(data) ? "تنبيه" : "إرشاد";

    const cat = pickCategoryFromPayload(data);
    const catHtml =
      '<span class="cat-badge" title="تصنيف">' +
      `<span class="cat-dot" style="background:${escapeHtml(cat.color)}"></span>` +
      `<span>${escapeHtml(cat.icon)}</span>` +
      `<span>${escapeHtml(cat.label)}</span>` +
      "</span>";

    let html = "";
    html += '<div class="bot-card">';
    html += '<div class="t">';
    html += `<b>${escapeHtml(title)}</b>`;
    html += `<span style="display:inline-flex; gap:8px; align-items:center;">${catHtml}<span class="badge ${badgeClass}">${escapeHtml(
      badgeText
    )}</span></span>`;
html += `<button type="button" class="tts-btn" title="استماع" aria-label="استماع">🔊 استماع</button>`;
    html += "</div>";

    if (verdict) html += `<div class="kv">${renderMarkdown(verdict)}</div>`;

    if (tips.length) {
      html += '<div class="kv"><span class="label">نصائح قصيرة</span><ul>';
      for (const tip of tips) html += `<li>${renderMarkdown(tip)}</li>`;
      html += "</ul></div>";
    }

    if (seek) html += `<div class="kv"><span class="label">متى تراجع الطبيب</span>${renderMarkdown(seek)}</div>`;
    if (q) html += `<div class="kv"><span class="label">سؤال سريع</span>${renderMarkdown(q)}</div>`;

    // ✅ أزرار quick_choices
    if (q && choices.length) {
      html += '<div class="choice-wrap">';
      for (const c of choices) {
        if (!c) continue;
        html += `<button type="button" class="choice-btn" data-choice="${escapeHtml(c)}">${escapeHtml(c)}</button>`;
      }
      html += "</div>";
    }

    html += "</div>";
    return html;
  }

  function addBotCard(data, opts = {}) {
    LAST_CARD = data || null;

    const msg = addMsg(renderStructuredCard(data), "bot", {
      html: true,
      rate: opts.rate === true,
    });

    try {
      const buttons = msg.querySelectorAll(".choice-btn");
      buttons.forEach((btn) => {
        btn.addEventListener("click", () => {
          const choice = (btn.getAttribute("data-choice") || btn.textContent || "").trim();
          if (!choice) return;
          addMsg(choice, "user");
          sendToBackend(choice, { is_choice: true });
        });
      });
    } catch {}

    try {
      const ttsBtn = msg.querySelector(".tts-btn");
      if (ttsBtn) {
        ttsBtn.addEventListener("click", () => playTTSFromCard(data));
      }
    } catch {}

    return msg;
  }

  // ========= Mood check =========
  const moodChoices = [
    { v: 0, label: "0) أبدًا" },
    { v: 1, label: "1) عدة أيام" },
    { v: 2, label: "2) أكثر من نصف الأيام" },
    { v: 3, label: "3) تقريبًا كل يوم" },
  ];

  const moodQuestions = [
    { scale: "GAD", text: "خلال آخر أسبوعين: كم مرة شعرت بالتوتر أو القلق أو العصبية؟" },
    { scale: "GAD", text: "كم مرة لم تستطع إيقاف القلق أو التحكم فيه؟" },
    { scale: "GAD", text: "كم مرة قلقت كثيرًا حول أمور مختلفة؟" },
    { scale: "GAD", text: "كم مرة واجهت صعوبة في الاسترخاء؟" },
    { scale: "GAD", text: "كم مرة شعرت أنك لا تستطيع الجلوس بهدوء (تململ/توتر)؟" },
    { scale: "GAD", text: "كم مرة شعرت بالانزعاج أو الاستثارة بسرعة؟" },
    { scale: "GAD", text: "كم مرة شعرت بالخوف وكأن شيئًا سيئًا قد يحدث؟" },

    { scale: "PHQ", text: "خلال آخر أسبوعين: كم مرة قلّ اهتمامك أو متعتك بالأشياء؟" },
    { scale: "PHQ", text: "كم مرة شعرت بالحزن أو الإحباط أو اليأس؟" },
    { scale: "PHQ", text: "كم مرة واجهت صعوبة في النوم أو نمت أكثر من المعتاد؟" },
    { scale: "PHQ", text: "كم مرة شعرت بتعب أو نقص طاقة؟" },
    { scale: "PHQ", text: "كم مرة قلّت شهيتك للأكل أو زادت بشكل ملحوظ؟" },
    { scale: "PHQ", text: "كم مرة شعرت أنك فاشل/تلوم نفسك كثيرًا؟" },
    { scale: "PHQ", text: "كم مرة واجهت صعوبة في التركيز (قراءة/عمل/مشاهدة)؟" },
    { scale: "PHQ", text: "كم مرة لاحظت بطء شديد بالحركة أو العكس: توتر زائد وحركة أكثر؟" },
    { scale: "PHQ", text: "كم مرة راودتك أفكار بإيذاء نفسك أو أن الحياة لا تستحق؟" },
  ];

  function startMoodCheck() {
    moodMode = true;
    moodStep = 0;
    moodAnswers = [];
    addMsg(
      "**طمّنا على مزاجك** 🧠\nاستبيان قصير (تحرّي أولي) — ليس تشخيصًا.\nاختر إجابة واحدة لكل سؤال.",
      "bot",
      { rate: false }
    );
    askMoodQuestion();
  }

  function askMoodQuestion() {
    if (!moodMode) return;

    if (moodStep >= moodQuestions.length) {
      finishMoodCheck();
      return;
    }

    const q = moodQuestions[moodStep];
    const title = q.scale === "GAD" ? "قسم القلق (GAD-7)" : "قسم المزاج (PHQ-9)";

    const msg = document.createElement("div");
    msg.className = "msg bot";

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.innerHTML = renderMarkdown(
      `**${title}**\nسؤال ${moodStep + 1} من ${moodQuestions.length}:\n${q.text}\n\nاختر إجابة واحدة:`
    );

    const wrap = document.createElement("div");
    wrap.className = "chips";

    moodChoices.forEach((c) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip-btn";
      b.textContent = c.label;
      b.onclick = () => {
        addMsg(c.label, "user");
        moodAnswers.push(c.v);
        moodStep += 1;
        askMoodQuestion();
      };
      wrap.appendChild(b);
    });

    bubble.appendChild(wrap);
    msg.appendChild(bubble);

    const meta = document.createElement("div");
    meta.className = "msg-meta";
    meta.textContent = nowTime();
    msg.appendChild(meta);

    chat.appendChild(msg);
    chat.scrollTop = chat.scrollHeight;
  }

  function sum(arr) {
    return arr.reduce((a, b) => a + Number(b || 0), 0);
  }

  function interpretGAD(score) {
    if (score <= 4) return { level: "منخفض جدًا", hint: "غالبًا لا يشير لمشكلة كبيرة." };
    if (score <= 9) return { level: "خفيف", hint: "قد يفيد تنظيم النوم وتقليل المنبهات وتمارين التنفس." };
    if (score <= 14) return { level: "متوسط", hint: "قد يفيد دعم نفسي/استشارة مختص إذا استمر التأثير." };
    return { level: "مرتفع", hint: "يفضّل استشارة مختص قريبًا خاصة إن أثّر على حياتك." };
  }

  function interpretPHQ(score) {
    if (score <= 4) return { level: "منخفض جدًا", hint: "غالبًا لا يشير لمشكلة كبيرة." };
    if (score <= 9) return { level: "خفيف", hint: "قد يفيد نشاط بسيط يوميًا + روتين نوم + تواصل اجتماعي." };
    if (score <= 14) return { level: "متوسط", hint: "قد يفيد التحدث مع مختص إذا استمر لأكثر من أسبوعين." };
    if (score <= 19) return { level: "مرتفع", hint: "يفضّل استشارة مختص قريبًا، خاصة إذا أثّر على الأداء اليومي." };
    return { level: "مرتفع جدًا", hint: "يفضّل طلب تقييم من مختص بأقرب وقت." };
  }

  function finishMoodCheck() {
    moodMode = false;

    const gad = sum(moodAnswers.slice(0, 7));
    const phq = sum(moodAnswers.slice(7, 16));
    const gadI = interpretGAD(gad);
    const phqI = interpretPHQ(phq);

    const selfHarmItem = moodAnswers[15] || 0;

    addMsg(
      `**النتيجة (تحرّي أولي فقط):**\n• مؤشر القلق: **${gad}** → ${gadI.level}\n• مؤشر المزاج: **${phq}** → ${phqI.level}\n\n• ${gadI.hint}\n• ${phqI.hint}`,
      "bot",
      { rate: true }
    );

    if (selfHarmItem > 0) {
      addMsg(
        "⚠️ **تنبيه مهم**\nإذا كان هناك خطر حالي أو أفكار قوية: اطلب مساعدة فورية من أقرب جهة صحية/الطوارئ أو تواصل مع شخص تثق به الآن.",
        "bot",
        { rate: false }
      );
    }

    showToast("تم", "اكتمل الاستبيان.");
  }

  // ========= Calculators =========
  function startCalc(mode) {
    calcMode = mode;
    calcStep = 0;
    calcData = {};
    pendingTips = null;

    if (mode === "bmi") addMsg("تمام. اكتب **وزنك بالكيلوغرام** (مثال: 75).", "bot", { rate: false });
    else if (mode === "bp") addMsg("تمام. اكتب **الضغط الانقباضي** (الرقم الأعلى) مثل: 120", "bot", { rate: false });
    else if (mode === "sugar") addMsg("هل القياس **صائم** أم **بعد الأكل**؟ اكتب: صائم / بعد الأكل", "bot", { rate: false });    else addMsg("الأداة غير معروفة.", "bot", { rate: false });

    input.focus();
  }

  function finishCalc(resultText, topicLabel, aiContext) {
    addMsg(resultText, "bot", { rate: true });
    pendingTips = { topicLabel, aiContext: aiContext || "" };
    addMsg(`هل تريد نصائح حول **${topicLabel}**؟ (نعم / لا)`, "bot", { rate: false });
  }

  function handleCalc(text) {
    const norm = normalizeDigits(text);

    // BMI
    if (calcMode === "bmi") {
      if (calcStep === 0) {
        calcData.weight = Number(norm);
        if (!calcData.weight || calcData.weight <= 0) return addMsg("اكتب وزن صحيح (مثال: 75).", "bot", { rate: false });
        calcStep = 1;
        return addMsg("الآن اكتب **طولك بالسنتيمتر** (مثال: 170).", "bot", { rate: false });
      }
      if (calcStep === 1) {
        calcData.height = Number(norm);
        if (!calcData.height || calcData.height <= 0) return addMsg("اكتب طول صحيح بالسنتيمتر.", "bot", { rate: false });

        const h = calcData.height / 100;
        const bmi = (calcData.weight / (h * h)).toFixed(1);
        let status = "";
        if (bmi < 18.5) status = "أقل من الوزن الطبيعي.";
        else if (bmi < 25) status = "ضمن الطبيعي تقريبًا.";
        else if (bmi < 30) status = "زيادة في الوزن.";
        else status = "سمنة تقريبية.";

        calcMode = null;
        calcStep = 0;

        return finishCalc(
          `**مؤشر كتلة الجسم**\n• BMI: ${bmi}\n• التقدير: ${status}`,
          "مؤشر كتلة الجسم",
          `وزن: ${calcData.weight} كجم\nطول: ${calcData.height} سم\nBMI: ${bmi}\nالتقدير: ${status}`
        );
      }
    }

    // BP
    if (calcMode === "bp") {
      if (calcStep === 0) {
        calcData.systolic = Number(norm);
        if (!calcData.systolic || calcData.systolic <= 0) return addMsg("اكتب رقم صحيح (مثل: 120).", "bot", { rate: false });
        calcStep = 1;
        return addMsg("الآن اكتب **الضغط الانبساطي** (الرقم الأسفل) مثل: 80", "bot", { rate: false });
      }
      if (calcStep === 1) {
        calcData.diastolic = Number(norm);
        if (!calcData.diastolic || calcData.diastolic <= 0) return addMsg("اكتب رقم صحيح (مثل: 80).", "bot", { rate: false });

        const s = calcData.systolic, d = calcData.diastolic;
        let category = "";
        if (s < 90 || d < 60) category = "يميل للانخفاض.";
        else if (s < 120 && d < 80) category = "في المجال الطبيعي تقريبًا.";
        else if (s >= 120 && s <= 129 && d < 80) category = "ارتفاع بسيط.";
        else if ((s >= 130 && s <= 139) || (d >= 80 && d <= 89)) category = "ارتفاع درجة أولى (تقريبي).";
        else if (s >= 140 || d >= 90) category = "ارتفاع واضح.";
        else category = "لا يمكن تصنيفه بدقة من هذه القراءة فقط.";

        calcMode = null;
        calcStep = 0;

        return finishCalc(
          `**تقييم الضغط**\n• القراءة: ${s}/${d} ملم زئبقي\n• التقدير: ${category}`,
          "تقييم ضغط الدم",
          `قراءة الضغط: ${s}/${d}\nالتقدير: ${category}`
        );
      }
    }

    // Sugar
    if (calcMode === "sugar") {
      if (calcStep === 0) {
        const t = String(text || "").trim();
        if (t.includes("صائم")) calcData.context = "fasting";
        else if (t.includes("بعد")) calcData.context = "post";
        else calcData.context = "unknown";
        calcStep = 1;
        return addMsg("اكتب قيمة السكر **بالمليغرام/ديسيلتر** (مثال: 95 أو 160).", "bot", { rate: false });
      }
      if (calcStep === 1) {
        const value = Number(norm);
        if (!value || value <= 0) return addMsg("اكتب رقم صحيح (مثال: 95).", "bot", { rate: false });

        let evaluation = "";
        let typeLabel = "غير محدد";
        if (calcData.context === "fasting") {
          typeLabel = "صائم";
          if (value < 70) evaluation = "منخفض عن الطبيعي.";
          else if (value < 100) evaluation = "طبيعي تقريبًا للصائم.";
          else if (value < 126) evaluation = "ارتفاع بسيط.";
          else evaluation = "ارتفاع واضح يحتاج تقييم طبي.";
        } else if (calcData.context === "post") {
          typeLabel = "بعد الأكل";
          if (value < 140) evaluation = "ضمن الطبيعي التقريبي بعد الأكل.";
          else if (value < 200) evaluation = "ارتفاع بسيط بعد الأكل.";
          else evaluation = "ارتفاع واضح بعد الأكل.";
        } else {
          evaluation = "تقدير عام لأن نوع القياس غير واضح.";
        }

        calcMode = null;
        calcStep = 0;

        return finishCalc(
          `**تقدير السكر**\n• النوع: ${typeLabel}\n• القيمة: ${value} ملغ/ديسيلتر\n• التقدير: ${evaluation}`,
          "تقييم السكر",
          `نوع القياس: ${typeLabel}\nالقيمة: ${value} mg/dL\nالتقدير: ${evaluation}`
        );
      }
    }

    addMsg("ما فهمت إدخالك. جرّب تكتب رقم/إجابة مناسبة.", "bot", { rate: false });
  }

  // ========= Backend =========
  function addTyping() {
    return addMsg(buildTypingHtml(), "bot", { html: true, rate: false });
  }

  async function sendToBackend(message, meta = {}) {
    if (!BACKEND_URL) {
      addMsg("لم يتم ضبط رابط الخادم.", "bot", { rate: false });
      return;
    }

    const typingMsg = addTyping();
    lockSend(true);

    const payloadToSend = {
      message,
      meta,
      context: { last: LAST_CARD },
    };

    try {
      const res = await fetchWithTimeout(
        BACKEND_URL,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-user-id": USER_ID,
          },
          body: JSON.stringify(payloadToSend),
        },
        16000
      );

      if (!res.ok) throw new Error("HTTP_" + res.status);
      const payload = await res.json();

      if (typingMsg && chat.contains(typingMsg)) chat.removeChild(typingMsg);

      if (payload && payload.ok === true && payload.data) {
        addBotCard(payload.data, { rate: true }); // ✅ تقييم فقط إذا رد حقيقي
        setStatus("ok", "متصل — تم الرد من الخادم");
        return;
      }

      // أي شيء غير واضح: بدون تقييم
      addMsg("تعذر الحصول على رد واضح.", "bot", { rate: false });
      setStatus("warn", "رد غير واضح");
    } catch {
      if (typingMsg && chat.contains(typingMsg)) chat.removeChild(typingMsg);

      // ✅ fallback بدون تقييم
      addMsg(fallbackReply(message), "bot", { rate: false });
      setStatus("warn", "تعذر الاتصال بالخادم");
      showToast("تنبيه", "تعذر الاتصال بالخادم الآن.");
    } finally {
      lockSend(false);
    }
  }

  // ========= Quick Start =========
    function showQuickStart() {
    const msg = document.createElement("div");
    msg.className = "msg bot";

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.innerHTML = renderMarkdown("**مسارات سريعة:** اختر ما يناسبك 👇");

    // ===== عنوان + أدوات سريعة =====
    const toolsTitle = document.createElement("div");
    toolsTitle.className = "qs-title";
    toolsTitle.textContent = "أدوات سريعة";
    bubble.appendChild(toolsTitle);

    const wrapTools = document.createElement("div");
    wrapTools.className = "chips chips-scroll";
    // تحسين تجربة التمرير بدون الاعتماد على CSS خارجي
    wrapTools.style.cssText =
      "display:flex;gap:10px;overflow-x:auto;overflow-y:hidden;padding:6px 2px 10px;scroll-behavior:smooth;-webkit-overflow-scrolling:touch;white-space:nowrap;";

    const actionsTools = [
      { label: "🧠 طمّنا على مزاجك", kind: "mood" },
      { label: "📏 كتلة الجسم (BMI)", kind: "calc", value: "bmi" },
      { label: "💓 الضغط", kind: "calc", value: "bp" },
      { label: "🩸 السكر", kind: "calc", value: "sugar" },    ];

    actionsTools.forEach((a) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip-btn";
      btn.textContent = a.label;

      // منع تكسير النص + تحسين شكل الزر بدون CSS
      btn.style.whiteSpace = "nowrap";
      btn.style.display = "inline-flex";
      btn.style.alignItems = "center";
      btn.style.gap = "6px";
      btn.style.padding = "10px 14px";
      btn.style.borderRadius = "16px";

      btn.onclick = () => {
        if (a.kind === "mood") startMoodCheck();
        else if (a.kind === "calc") startCalc(a.value);
      };

      wrapTools.appendChild(btn);
    });

    bubble.appendChild(wrapTools);

    // ===== عنوان + مسارات إرشادية =====
    const pathsTitle = document.createElement("div");
    pathsTitle.className = "qs-title";
    pathsTitle.textContent = "مسارات إرشادية";
    bubble.appendChild(pathsTitle);

    const wrapPaths = document.createElement("div");
    wrapPaths.className = "chips chips-scroll";
    wrapPaths.style.cssText =
      "display:flex;gap:10px;overflow-x:auto;overflow-y:hidden;padding:6px 2px 2px;scroll-behavior:smooth;-webkit-overflow-scrolling:touch;white-space:nowrap;";

    const presetPrompts = {
      lifestyle:
        "ابدأ معي مسار نمط الحياة الصحي. قدم (1) 3 خطوات صغيرة اليوم للتغذية والنشاط والنوم، (2) تحذيرات عامة، (3) سؤال واحد فقط للمتابعة.",
      women:
        "ابدأ مسار صحة النساء. قدم إرشادات عامة آمنة ومختصرة (بدون أدوية/جرعات)، وركّز على الوقاية ومتى أراجع الطبيب، ثم اسأل سؤال متابعة واحد فقط.",
      children:
        "ابدأ مسار صحة الأطفال. أعطني نقاط وقائية عامة + علامات تستدعي مراجعة الطبيب/الطوارئ، ثم سؤال متابعة واحد فقط.",
      elderly:
        "ابدأ مسار صحة كبار السن. أعطني نصائح عامة للوقاية والسلامة (سقوط/تغذية/سوائل/أدوية) ومتى أراجع الطبيب، ثم سؤال متابعة واحد فقط.",
      adolescents:
        "ابدأ مسار صحة اليافعين. أعطني نصائح عامة للنوم والتغذية والنشاط والصحة النفسية بشكل آمن، ثم سؤال متابعة واحد فقط.",
      mental_health:
        "ابدأ مسار الصحة النفسية. أعطني أدوات بسيطة يومية (تنفس/نوم/نشاط/دعم اجتماعي) ومتى أطلب مساعدة عاجلة، ثم سؤال متابعة واحد فقط.",
      ncd:
        "ابدأ مسار الأمراض غير المعدية. اشرح باختصار أهمها وكيف نقلل المخاطر (غذاء/نشاط/تدخين/فحوصات) ثم سؤال متابعة واحد فقط.",
      infection_control:
        "ابدأ مسار مكافحة الأمراض والعدوى. أعطني إرشادات عامة للوقاية (نظافة/عزل/لقاحات/كمامة عند اللزوم) ومتى أراجع الطبيب، ثم سؤال متابعة واحد فقط.",
      medication_safety:
        "ابدأ مسار السلامة الدوائية. أعطني قواعد عامة للاستخدام الآمن (تعارضات/حساسية/حمل/جرعات منسية/تخزين) بدون وصف جرعات، ثم سؤال متابعة واحد فقط.",
      emergency:
        "ابدأ مسار الحالات الطارئة. اذكر أهم العلامات الحمراء التي تستدعي الطوارئ فورًا وكيف أتصرف أوليًا بشكل عام، ثم سؤال متابعة واحد فقط.",
    };

    const actionsPaths = [
      { label: "🌿 نمط الحياة الصحي", value: "lifestyle" },
      { label: "👩 صحة النساء", value: "women" },
      { label: "👶 صحة الأطفال", value: "children" },
      { label: "🧓 صحة المسنين", value: "elderly" },
      { label: "🧑‍🎓 صحة اليافعين", value: "adolescents" },
      { label: "🧠 الصحة النفسية", value: "mental_health" },
      { label: "🫀 الأمراض غير المعدية", value: "ncd" },
      { label: "🦠 مكافحة الأمراض", value: "infection_control" },
      { label: "💊 السلامة الدوائية", value: "medication_safety" },
      { label: "🚨 الحالات الطارئة", value: "emergency" },
    ];

    actionsPaths.forEach((a) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip-btn";
      btn.textContent = a.label;

      btn.style.whiteSpace = "nowrap";
      btn.style.display = "inline-flex";
      btn.style.alignItems = "center";
      btn.style.gap = "6px";
      btn.style.padding = "10px 14px";
      btn.style.borderRadius = "16px";

      btn.onclick = () => {
        const prompt = presetPrompts[a.value];
        if (!prompt) return;
        addMsg(a.label, "user");
        sendToBackend(prompt);
      };

      wrapPaths.appendChild(btn);
    });

    bubble.appendChild(wrapPaths);

    msg.appendChild(bubble);

    const meta = document.createElement("div");
    meta.className = "msg-meta";
    meta.textContent = nowTime();
    msg.appendChild(meta);

    chat.appendChild(msg);
    chat.scrollTop = chat.scrollHeight;
  }

  // ========= Reset =========
  async function resetChat() {
    chat.innerHTML = "";
    LAST_CARD = null;

    calcMode = null;
    calcStep = 0;
    calcData = {};
    pendingTips = null;

    moodMode = false;
    moodStep = 0;
    moodAnswers = [];

    // reset server silently
    try {
      await fetchWithTimeout(
        BACKEND_RESET_URL,
        { method: "POST", headers: { "Content-Type": "application/json", "x-user-id": USER_ID }, body: "{}" },
        8000
      );
    } catch {}

    setStatus("ok", "متصل — جاهز");
    addMsg("مرحبًا بك في **دليل العافية** 🌿\nاختر مسار من الأسفل أو اكتب سؤالك مباشرة.", "bot", { rate: false });
    showQuickStart();
    input.focus();
  }

  // ========= Theme =========
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("wellness_theme", theme); } catch {}
  }
  function toggleTheme() {
    const cur = document.documentElement.getAttribute("data-theme") || "dark";
    applyTheme(cur === "dark" ? "light" : "dark");
    showToast("تم", "تم تبديل المظهر.");
  }
  function initTheme() {
    let saved = null;
    try { saved = localStorage.getItem("wellness_theme"); } catch {}
    if (saved === "light" || saved === "dark") applyTheme(saved);
    else applyTheme("light");
  }

  // ========= Welcome / Privacy =========
  function openPrivacy() {
    privacyBackdrop.style.display = "flex";
  }
  function closePrivacy() {
    privacyBackdrop.style.display = "none";
  }

  // ========= Install (PWA) =========
  function openInstallHelp() {
    if (installBackdrop) installBackdrop.style.display = "flex";
  }
  function closeInstallHelp() {
    if (installBackdrop) installBackdrop.style.display = "none";
  }

  function isIos() {
    const ua = navigator.userAgent || "";
    return /iphone|ipad|ipod/i.test(ua) && !window.MSStream;
  }
  function isStandalone() {
    // iOS: navigator.standalone
    // Others: display-mode
    return window.matchMedia && window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  }

  async function handleInstallClick() {
    // already installed
    if (isStandalone()) {
      showToast("موجود", "التطبيق مثبت بالفعل.");
      return;
    }

    // iOS has no prompt
    if (isIos()) {
      openInstallHelp();
      return;
    }

    // Chromium install prompt
    if (deferredInstallPrompt) {
      try {
        deferredInstallPrompt.prompt();
        const choice = await deferredInstallPrompt.userChoice;
        deferredInstallPrompt = null;
        if (choice && choice.outcome === "accepted") showToast("تم", "جارٍ تثبيت التطبيق.");
        else showToast("تمام", "تم إلغاء التثبيت.");
      } catch {
        openInstallHelp();
      }
      return;
    }

    // fallback
    openInstallHelp();
  }

  function startApp() {
    try { localStorage.setItem("wellness_started", "1"); } catch {}
    welcomeEl.style.display = "none";
    input.focus();
  }
  function initWelcome() {
    let started = null;
    try { started = localStorage.getItem("wellness_started"); } catch {}
    welcomeEl.style.display = started === "1" ? "none" : "flex";
  }

  // ========= Sending =========
  function sendMsg() {
    const text = String(input.value || "").trim();
    if (!text) return;

    addMsg(text, "user");
    input.value = "";

    // أثناء استبيان المزاج
    if (moodMode) {
      addMsg("فضلاً اختر إجابتك من الأزرار تحت السؤال.", "bot", { rate: false });
      return;
    }

    // بعد سؤال "تبي نصائح؟"
    if (pendingTips && !calcMode) {
      if (isYes(text)) {
        const prompt =
          "أريد نصائح عملية وآمنة حول: " + pendingTips.topicLabel + ".\n" +
          "السياق/النتيجة:\n" + pendingTips.aiContext + "\n" +
          "اكتب نصائح مختصرة وواضحة + متى أراجع الطبيب. بدون تشخيص.";
        pendingTips = null;
        sendToBackend(prompt);
        return;
      }
      if (isNo(text)) {
        addMsg("تمام.", "bot", { rate: false });
        pendingTips = null;
        return;
      }
      addMsg(`أجب **بنعم أو لا**: هل تريد نصائح حول ${pendingTips.topicLabel}؟`, "bot", { rate: false });
      return;
    }

    // أثناء الحاسبة
    if (calcMode) {
      handleCalc(text);
      return;
    }

    // رسالة عادية
    sendToBackend(text);
  }

  // ========= Attach events =========
  function bindEvents() {
    // viewport vh fix
    const setVhUnit = () => {
      const vh = window.innerHeight * 0.01;
      document.documentElement.style.setProperty("--vh", vh + "px");
    };
    setVhUnit();
    window.addEventListener("resize", setVhUnit);

    // PWA install prompt (Chromium)
    window.addEventListener("beforeinstallprompt", (e) => {
      // Prevent the mini-infobar
      e.preventDefault();
      deferredInstallPrompt = e;
    });

    // PWA SW
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => {
        navigator.serviceWorker.register("./sw.js").catch(() => {});
      });
    }

    // toast
    toastClose.addEventListener("click", hideToast);

    // welcome
    welcomeStart.addEventListener("click", startApp);
    welcomePrivacy.addEventListener("click", openPrivacy);

    // privacy
    privacyClose.addEventListener("click", closePrivacy);
    privacyBackdrop.addEventListener("click", (e) => {
      if (e.target === privacyBackdrop) closePrivacy();
    });

    // install modal
    if (installClose) installClose.addEventListener("click", closeInstallHelp);
    if (installBackdrop) {
      installBackdrop.addEventListener("click", (e) => {
        if (e.target === installBackdrop) closeInstallHelp();
      });
    }

    // header actions
    resetBtn.addEventListener("click", resetChat);
    themeBtn.addEventListener("click", toggleTheme);
    if (installBtn) installBtn.addEventListener("click", handleInstallClick);

    // send
    sendBtn.addEventListener("click", sendMsg);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        sendMsg();
      }
    });
  }

  // ========= Init =========
  function init() {
    initTheme();
    initWelcome();
    bindEvents();
    injectQuickStartStyles();
    setStatus("ok", "متصل — استخدم الحاسبات ");
    resetChat();
  }

  // start
  document.addEventListener("DOMContentLoaded", init);
})();
