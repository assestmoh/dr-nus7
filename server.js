<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="theme-color" content="#0b1220" />
  <meta name="color-scheme" content="dark light" />
  <title>دليل العافية</title>

  <!-- PWA -->
  <link rel="manifest" href="manifest.webmanifest">
  <link rel="icon" href="icon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="icon.svg">
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />

  <style>
    :root{
      --radius-xl: 24px;
      --radius-lg: 18px;

      --shadow-1: 0 10px 30px rgba(0,0,0,.28);
      --shadow-2: 0 18px 55px rgba(0,0,0,.35);
      --ring: 0 0 0 3px rgba(34,197,94,.25);

      --vh: 1vh;

      /* Light */
      --page-bg: #f6f7fb;
      --page-grad-1: rgba(34,197,94,.10);
      --page-grad-2: rgba(56,189,248,.10);

      --surface: rgba(255,255,255,.82);
      --surface-2: rgba(255,255,255,.65);
      --border: rgba(15,23,42,.12);
      --text: #0f172a;
      --muted: rgba(15,23,42,.62);

      --card: rgba(255,255,255,.9);
      --chip: rgba(15,23,42,.06);

      --bot: rgba(15,23,42,.05);
      --user1: #0d9488;
      --user2: #22c55e;

      --ok: #22c55e;
      --danger: #ef4444;
    }

    /* Dark theme */
    [data-theme="dark"]{
      --page-bg: #070b12;
      --page-grad-1: rgba(34,197,94,.14);
      --page-grad-2: rgba(56,189,248,.14);

      --surface: rgba(2,6,23,.78);
      --surface-2: rgba(2,6,23,.62);
      --border: rgba(148,163,184,.22);
      --text: #f8fafc;
      --muted: rgba(148,163,184,.80);

      --card: rgba(2,6,23,.82);
      --chip: rgba(148,163,184,.12);

      --bot: rgba(148,163,184,.10);
    }

    *{ box-sizing:border-box; -webkit-tap-highlight-color: transparent; }
    html,body{ height:100%; margin:0; font-family: system-ui,-apple-system,"Segoe UI",sans-serif; }
    body{
      color: var(--text);
      background:
        radial-gradient(circle at top, var(--page-grad-1) 0, transparent 55%),
        radial-gradient(circle at bottom, var(--page-grad-2) 0, transparent 60%),
        linear-gradient(180deg, var(--page-bg) 0%, rgba(255,255,255,0) 100%);
      display:flex; justify-content:center; align-items:stretch;
    }

    .app{
      width:100%;
      max-width: 560px;
      min-height: 100dvh;
      height: calc(var(--vh) * 100);
      padding: 14px;
      padding-top: max(14px, env(safe-area-inset-top));
      padding-bottom: max(14px, env(safe-area-inset-bottom));
      padding-left: max(14px, env(safe-area-inset-left));
      padding-right: max(14px, env(safe-area-inset-right));
      position:relative;
    }

    .shell{
      height:100%;
      border-radius: var(--radius-xl);
      border: 1px solid var(--border);
      background: linear-gradient(180deg, var(--surface) 0%, var(--surface-2) 100%);
      box-shadow: var(--shadow-2);
      backdrop-filter: blur(18px);
      -webkit-backdrop-filter: blur(18px);
      overflow:hidden;
      display:flex; flex-direction:column;
    }

    header{
      display:flex; align-items:center; gap:10px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--border);
      background:
        radial-gradient(circle at 20% 20%, rgba(34,197,94,.16), transparent 55%),
        radial-gradient(circle at 90% 0%, rgba(56,189,248,.16), transparent 60%);
    }

    .brand{ display:flex; align-items:center; gap:10px; min-width:0; flex:1; }
    .logo{
      width:44px; height:44px; border-radius: 999px;
      display:flex; align-items:center; justify-content:center;
      font-size: 22px;
      background: radial-gradient(circle at 30% 25%, rgba(187,247,208,1) 0, rgba(34,197,94,1) 38%, rgba(2,6,23,1) 110%);
      box-shadow: 0 10px 28px rgba(34,197,94,.30), 0 0 0 1px rgba(34,197,94,.35);
      flex: 0 0 auto;
    }
    .brand h1{ margin:0; font-size: 15px; letter-spacing:.2px; }
    .brand p{
      margin:2px 0 0;
      font-size: 11px;
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .body{
      flex:1; min-height:0;
      display:flex; flex-direction:column;
      padding: 12px;
      gap: 10px;
    }

    .chat-head{
      display:flex; align-items:center; justify-content:space-between;
      gap:10px;
      padding: 10px 12px;
      border-radius: var(--radius-lg);
      border: 1px solid var(--border);
      background: var(--card);
      box-shadow: var(--shadow-1);
    }

    .chat-title{
      display:flex; align-items:center; gap:10px;
      min-width:0;
    }
    .dot{
      width: 9px; height: 9px; border-radius: 999px;
      flex: 0 0 auto;
    }
    .dot.ok{
      background: var(--ok);
      box-shadow: 0 0 14px rgba(34,197,94,.55);
    }
    .dot.warn{
      background: #f59e0b;
      box-shadow: 0 0 14px rgba(245,158,11,.55);
    }

    .chat-title b{ font-size: 12px; }
    .chat-title span{
      display:block;
      font-size: 10px;
      color: var(--muted);
      margin-top: 2px;
      white-space: nowrap; overflow:hidden; text-overflow: ellipsis;
      max-width: 360px;
    }

    #chat{
      flex:1; min-height:0;
      border-radius: var(--radius-xl);
      border: 1px solid var(--border);
      background:
        radial-gradient(circle at top, rgba(15,23,42,.03) 0, transparent 60%),
        radial-gradient(circle at bottom, rgba(34,197,94,.05) 0, transparent 55%),
        var(--card);
      box-shadow: var(--shadow-1);
      overflow-y:auto;
      padding: 12px;
      scroll-behavior:smooth;
    }

    .msg{ display:flex; flex-direction:column; margin: 0 0 10px; max-width: 92%; }
    .msg.user{ margin-inline-start:auto; align-items:flex-end; }
    .msg.bot{ align-items:flex-start; }

    .bubble{
      padding: 10px 12px;
      border-radius: 16px;
      line-height: 1.7;
      font-size: 14px;
      overflow-wrap: anywhere;
      border: 1px solid var(--border);
    }
    .bot .bubble{ background: var(--bot); }
    .user .bubble{
      background: linear-gradient(135deg, var(--user1), var(--user2));
      color: #ecfdf5;
      border: 1px solid rgba(16,185,129,.35);
      box-shadow: 0 10px 22px rgba(34,197,94,.20);
    }

    .msg-meta{
      margin-top: 4px;
      font-size: 10px;
      color: var(--muted);
      opacity: .9;
    }

    .bubble a{
      color: inherit;
      text-decoration: underline;
      text-underline-offset: 3px;
    }

    .typing{ display:inline-flex; align-items:center; gap:6px; }
    .dots{ display:inline-flex; gap:4px; align-items:center; }
    .dots i{
      width:6px; height:6px; border-radius:999px;
      background: rgba(148,163,184,.9);
      display:inline-block;
      animation: bounce 1.05s infinite ease-in-out;
      opacity: .9;
    }
    .dots i:nth-child(2){ animation-delay: .15s; }
    .dots i:nth-child(3){ animation-delay: .30s; }
    @keyframes bounce{
      0%, 80%, 100% { transform: translateY(0); opacity:.55; }
      40% { transform: translateY(-5px); opacity:1; }
    }

    .rating{
      margin-top: 6px;
      display:flex;
      gap:8px;
      align-items:center;
      font-size: 12px;
      color: var(--muted);
      flex-wrap: wrap;
    }
    .rate-btn{
      border: 1px solid var(--border);
      background: transparent;
      color: var(--text);
      border-radius: 999px;
      padding: 6px 10px;
      cursor:pointer;
      display:inline-flex;
      gap:6px;
      align-items:center;
      font-size: 12px;
    }
    .rate-btn:active{ transform: scale(.98); }
    .rate-btn[disabled]{ opacity:.6; cursor: default; }
    .rate-hint{ font-size: 11px; color: var(--muted); }

    .chips{
      margin-top: 10px;
      display:flex;
      flex-wrap:wrap;
      gap: 8px;
    }
    .chip-btn{
      border: 1px solid var(--border);
      background: var(--chip);
      color: var(--text);
      border-radius: 999px;
      padding: 8px 10px;
      font-size: 12px;
      cursor:pointer;
      transition: transform .08s ease;
      user-select: none;
    }
    .chip-btn:active{ transform: scale(.98); }

    .composer{
      border-radius: var(--radius-xl);
      border: 1px solid var(--border);
      background: var(--card);
      box-shadow: var(--shadow-1);
      padding: 10px;
      position: sticky;
      bottom: 0;
    }

    .row{ display:flex; gap:8px; align-items:center; }

    #userInput{
      flex:1;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: rgba(255,255,255,.55);
      color: var(--text);
      padding: 12px 14px;
      font-size: 16px;
      outline:none;
    }
    [data-theme="dark"] #userInput{ background: rgba(2,6,23,.45); }
    #userInput:focus{
      box-shadow: var(--ring);
      border-color: rgba(34,197,94,.55);
    }
    #userInput::placeholder{ color: var(--muted); }

    #sendBtn{
      border:none;
      border-radius: 999px;
      padding: 12px 14px;
      cursor:pointer;
      font-size: 13px;
      font-weight: 700;
      color: #ecfdf5;
      background: linear-gradient(135deg, var(--user1), var(--user2));
      box-shadow: 0 12px 26px rgba(34,197,94,.22);
      white-space: nowrap;
      display:flex; align-items:center; gap:6px;
    }
    #sendBtn.disabled{ opacity:.55; cursor:default; box-shadow:none; }
    #sendBtn:active{ transform: scale(.98); }

    .sub-actions{
      display:flex;
      gap:8px;
      margin-top: 8px;
    }
    .sub-actions .icon-btn{
      flex:1;
      justify-content:center;
      box-shadow:none;
      background: transparent;
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 10px 10px;
      cursor:pointer;
      color: var(--text);
      display:flex;
      align-items:center;
      justify-content:center;
      gap:8px;
      font-size: 12px;
    }
    .sub-actions .icon-btn:active{ transform: scale(.98); }

    .disclaimer{
      margin-top: 8px;
      font-size: 11px;
      color: var(--muted);
      line-height: 1.55;
    }

    .toast{
      position: fixed;
      inset-inline: 0;
      bottom: max(16px, env(safe-area-inset-bottom));
      display:flex;
      justify-content:center;
      pointer-events:none;
      z-index: 9999;
      padding: 0 14px;
    }
    .toast .box{
      pointer-events: all;
      max-width: 560px;
      width: 100%;
      border-radius: 14px;
      border: 1px solid var(--border);
      background: var(--card);
      box-shadow: var(--shadow-2);
      padding: 10px 12px;
      font-size: 12px;
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap: 10px;
      transform: translateY(18px);
      opacity: 0;
      transition: all .22s ease;
    }
    .toast.show .box{ transform: translateY(0); opacity: 1; }
    .toast .box .x{
      border:none;
      background: transparent;
      color: var(--text);
      cursor:pointer;
      font-size: 16px;
    }

    .modal-backdrop{
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,.45);
      display:none;
      align-items:center;
      justify-content:center;
      z-index: 9998;
      padding: 16px;
      padding-top: max(16px, env(safe-area-inset-top));
      padding-bottom: max(16px, env(safe-area-inset-bottom));
    }
    .modal{
      max-width: 560px;
      width: 100%;
      border-radius: 18px;
      border: 1px solid var(--border);
      background: var(--card);
      box-shadow: var(--shadow-2);
      overflow:hidden;
    }
    .modal-head{
      padding: 12px 14px;
      display:flex;
      justify-content:space-between;
      align-items:center;
      border-bottom: 1px solid var(--border);
    }
    .modal-head b{ font-size: 13px; }
    .modal-close{
      border:none; background: transparent;
      cursor:pointer; font-size: 18px;
      color: var(--text);
    }
    .modal-body{
      padding: 12px 14px;
      color: var(--text);
      font-size: 13px;
      line-height: 1.8;
    }
    .modal-body ul{ margin: 8px 0 0; padding-inline-start: 18px; }
    .modal-body li{ margin-bottom: 6px; }

    .welcome{
      position: fixed;
      inset: 0;
      z-index: 9997;
      display:flex;
      align-items:center;
      justify-content:center;
      padding: 16px;
      padding-top: max(16px, env(safe-area-inset-top));
      padding-bottom: max(16px, env(safe-area-inset-bottom));
      background:
        radial-gradient(circle at top, rgba(34,197,94,.18) 0, transparent 60%),
        radial-gradient(circle at bottom, rgba(56,189,248,.18) 0, transparent 60%),
        rgba(0,0,0,.35);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
    }
    .welcome-card{
      max-width: 560px;
      width: 100%;
      border-radius: 22px;
      border: 1px solid var(--border);
      background: var(--card);
      box-shadow: var(--shadow-2);
      overflow:hidden;
    }
    .welcome-top{
      padding: 16px 14px 12px;
      border-bottom: 1px solid var(--border);
      background:
        radial-gradient(circle at 20% 20%, rgba(34,197,94,.16), transparent 55%),
        radial-gradient(circle at 90% 0%, rgba(56,189,248,.14), transparent 60%);
      display:flex; gap:12px; align-items:center;
    }
    .welcome-icon{
      width:52px; height:52px; border-radius: 16px;
      display:flex; align-items:center; justify-content:center;
      font-size: 26px;
      background: radial-gradient(circle at 30% 25%, rgba(187,247,208,1) 0, rgba(34,197,94,1) 38%, rgba(2,6,23,1) 110%);
      box-shadow: 0 14px 30px rgba(34,197,94,.20);
      flex: 0 0 auto;
    }
    .welcome-top h2{ margin:0; font-size: 16px; }
    .welcome-top p{ margin:3px 0 0; font-size: 12px; color: var(--muted); }

    .welcome-body{
      padding: 14px;
      font-size: 13px;
      line-height: 1.8;
      color: var(--text);
    }
    .welcome-body .mini{
      color: var(--muted);
      font-size: 12px;
      margin-top: 10px;
    }
    .welcome-actions{
      padding: 12px 14px 14px;
      display:flex;
      gap:10px;
    }
    .btn-primary{
      flex:1;
      border:none;
      border-radius: 999px;
      padding: 12px 14px;
      cursor:pointer;
      font-weight: 800;
      color: #ecfdf5;
      background: linear-gradient(135deg, var(--user1), var(--user2));
      box-shadow: 0 12px 26px rgba(34,197,94,.22);
    }
    .btn-ghost{
      border: 1px solid var(--border);
      background: transparent;
      color: var(--text);
      border-radius: 999px;
      padding: 12px 14px;
      cursor:pointer;
      flex:1;
    }
    .btn-primary:active, .btn-ghost:active{ transform: scale(.98); }

    @media (prefers-reduced-motion: reduce){
      *{ transition:none !important; scroll-behavior:auto !important; animation:none !important; }
    }

    @media (max-width: 600px){
      .app{ padding: 0; }
      .shell{ border-radius: 0; }
    }

    /* Bot cards */
    .bot-card{
      width: 100%;
      border-radius: 18px;
      border: 1px solid var(--border);
      background: var(--card);
      padding: 12px;
      box-shadow: var(--shadow-1);
    }
    .bot-card .t{
      display:flex; align-items:center; justify-content:space-between; gap:10px;
      margin-bottom: 8px;
    }
    .bot-card .t b{ font-size: 13px; }

    .badge{
      font-size: 11px;
      padding: 4px 8px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: var(--chip);
      color: var(--muted);
      white-space: nowrap;
      display:inline-flex;
      gap:6px;
      align-items:center;
    }
    .badge.danger{ color: #fff; border-color: rgba(239,68,68,.35); background: rgba(239,68,68,.18); }
    .badge.ok{ color: #fff; border-color: rgba(34,197,94,.35); background: rgba(34,197,94,.18); }

    .cat-badge{
      border: 1px solid var(--border);
      background: var(--chip);
      border-radius: 999px;
      padding: 4px 8px;
      font-size: 11px;
      display:inline-flex;
      align-items:center;
      gap:6px;
      white-space: nowrap;
    }
    .cat-dot{
      width:10px; height:10px; border-radius:999px;
      display:inline-block;
      box-shadow: 0 0 0 2px rgba(0,0,0,.06);
    }

    .kv{
      margin-top: 8px;
      line-height: 1.7;
      font-size: 13px;
    }
    .kv .label{ color: var(--muted); font-size: 11px; display:block; margin-top: 10px; }
    .kv ul{ margin: 6px 0 0; padding-inline-start: 18px; }
    .kv li{ margin-bottom: 4px; }

    .choice-wrap{
      margin-top: 10px;
      display:flex;
      flex-wrap:wrap;
      gap: 8px;
    }
    .choice-btn{
      border: 1px solid var(--border);
      background: var(--chip);
      color: var(--text);
      border-radius: 999px;
      padding: 8px 10px;
      font-size: 12px;
      cursor:pointer;
    }
    .choice-btn:active{ transform: scale(.98); }
  </style>
</head>

<body>
  <!-- Welcome Screen -->
  <div id="welcome" class="welcome" aria-hidden="false">
    <div class="welcome-card" role="dialog" aria-modal="true" aria-label="شاشة الترحيب">
      <div class="welcome-top">
        <div class="welcome-icon" aria-hidden="true">🩺</div>
        <div style="min-width:0">
          <h2>دليل العافية</h2>
          <p>مساعد تثقيفي صحي — سريع وبسيط ومناسب للجوال</p>
        </div>
      </div>
      <div class="welcome-body">
        <b>قبل البدء:</b>
        <ul>
          <li>المحتوى للتوعية العامة وليس تشخيصًا أو وصف علاج.</li>
          <li>إذا كانت الحالة طارئة أو خطيرة: راجع أقرب جهة صحية فورًا.</li>
          <li>لا يتم تخزين بياناتك الطبية الشخصية.</li>
        </ul>
        <div class="mini">
          بالضغط على “ابدأ” أنت توافق على الاطلاع على سياسة الخصوصية.
        </div>
      </div>
      <div class="welcome-actions">
        <button class="btn-primary" type="button" onclick="startApp()">ابدأ</button>
        <button class="btn-ghost" type="button" onclick="openPrivacy()">سياسة الخصوصية</button>
      </div>
    </div>
  </div>

  <div class="app">
    <div class="shell">
      <header>
        <div class="brand">
          <div class="logo" aria-hidden="true">🩺</div>
          <div style="min-width:0">
            <h1>دليل العافية</h1>
            <p>منصة توعوية تقدم معلومات صحية عامة لدعم نمط حياة أفضل.</p>
          </div>
        </div>
      </header>

      <div class="body">
        <div class="chat-head">
          <div class="chat-title">
            <span class="dot ok" aria-hidden="true"></span>
            <div style="min-width:0">
              <b>محادثة تثقيفية عامة</b>
              <span>متصل — استخدم الحاسبات أو اسأل سؤالًا عامًا</span>
            </div>
          </div>
        </div>

        <div id="chat" role="log" aria-live="polite" aria-relevant="additions"></div>

        <div class="composer">
          <div class="row">
            <input id="userInput" inputmode="text" autocomplete="off" placeholder="اكتب سؤالك هنا…" aria-label="حقل كتابة الرسالة" />
            <button id="sendBtn" type="button" onclick="sendMsg()">
              <span>إرسال</span><span aria-hidden="true">📨</span>
            </button>
          </div>

          <div class="sub-actions">
            <button class="icon-btn" type="button" onclick="resetChat()">
              <span aria-hidden="true">🧹</span><span>مسح المحادثة</span>
            </button>

            <button class="icon-btn" type="button" onclick="toggleTheme()" aria-label="تبديل المظهر">
              <span aria-hidden="true">🌓</span><span>المظهر</span>
            </button>

            <button class="icon-btn" type="button" onclick="openAttachmentPicker()" aria-label="إضافة مرفق">
              <span aria-hidden="true">📎</span><span>إضافة مرفق</span>
            </button>
          </div>

          <input id="attachmentFile" type="file" accept="image/*,application/pdf" style="display:none" />

          <div class="disclaimer">
            مبادرة قسم تقنية المعلومات – مستشفى جعلان بني بو حسن
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Privacy Modal -->
  <div id="privacyBackdrop" class="modal-backdrop" onclick="closePrivacy(event)">
    <div class="modal" role="dialog" aria-modal="true" aria-label="سياسة الخصوصية" onclick="event.stopPropagation()">
      <div class="modal-head">
        <b>سياسة الخصوصية</b>
        <button class="modal-close" type="button" onclick="closePrivacy()">✕</button>
      </div>
      <div class="modal-body">
        <b>ملخص سريع:</b>
        <ul>
          <li>الهدف: تقديم معلومات تثقيفية عامة فقط.</li>
          <li><b>لا يتم تخزين</b> بياناتك الطبية الشخصية داخل هذه الصفحة.</li>
          <li>قد يتم إرسال نص سؤالك أو نص التقرير للخادم لمعالجة الرد.</li>
          <li>لا تشارك معلومات حساسة (رقم ملف/هوية/تفاصيل خاصة) داخل المحادثة.</li>
          <li>في الحالات الطارئة أو الأعراض الخطيرة: راجع أقرب جهة صحية فورًا.</li>
        </ul>
      </div>
    </div>
  </div>

  <!-- Toast -->
  <div id="toast" class="toast" aria-live="polite" aria-atomic="true">
    <div class="box">
      <div>
        <b id="toastTitle">تنبيه</b>
        <div id="toastMsg" style="margin-top:2px; color:var(--muted)"></div>
      </div>
      <button class="x" onclick="hideToast()" aria-label="إغلاق">✕</button>
    </div>
  </div>

  <script>
    // ✅ خادم الدردشة
    var BACKEND_URL = "https://ruling-violet-m0h-217b6aa8.koyeb.app/chat";

    // مشتقات
    var BACKEND_REPORT_URL = (function(){
      try{
        var u = (BACKEND_URL || "").trim();
        if (!u) return "";
        if (/\/chat\/?$/.test(u)) return u.replace(/\/chat\/?$/, "/report");
        return u.replace(/\/+$/, "") + "/report";
      }catch(e){ return ""; }
    })();

    var BACKEND_RESET_URL = (function(){
      try{
        var u = (BACKEND_URL || "").trim();
        if (!u) return "";
        if (/\/chat\/?$/.test(u)) return u.replace(/\/chat\/?$/, "/reset");
        return u.replace(/\/+$/, "") + "/reset";
      }catch(e){ return ""; }
    })();

    var chat = document.getElementById("chat");
    var input = document.getElementById("userInput");
    var sendBtn = document.getElementById("sendBtn");

    var attachmentFile = document.getElementById("attachmentFile");
    var toastEl = document.getElementById("toast");
    var toastTitle = document.getElementById("toastTitle");
    var toastMsg = document.getElementById("toastMsg");

    var welcomeEl = document.getElementById("welcome");
    var privacyBackdrop = document.getElementById("privacyBackdrop");

    // أدوات الحساب
    var calcMode = null;
    var calcStep = 0;
    var calcData = {};
    var pendingTips = null;

    // وضع شرح التقرير
    var reportMode = false;

    // ✅ سياق آخر كرت للخادم
    var LAST_CARD = null;

    // ============================
    // ثابت مستخدم (x-user-id)
    // ============================
    function getUserId(){
      try{
        var k = "wellness_uid_v1";
        var v = localStorage.getItem(k);
        if (v) return v;
        v = "u_" + Math.random().toString(16).slice(2) + "_" + Date.now().toString(16);
        localStorage.setItem(k, v);
        return v;
      }catch(e){
        return "u_" + Date.now();
      }
    }
    var USER_ID = getUserId();

    // ------------------------------
    // Status
    // ------------------------------
    var statusDot = document.querySelector(".dot");
    var statusSubtitle = document.querySelector(".chat-title span");

    function setStatus(mode, text){
      if (!statusDot || !statusSubtitle) return;
      statusDot.classList.remove("ok","warn");
      statusDot.classList.add(mode === "warn" ? "warn" : "ok");
      if (text) statusSubtitle.textContent = text;
    }
    function lockSend(isLocked){
      try{
        if (!sendBtn) return;
        sendBtn.disabled = !!isLocked;
        sendBtn.classList.toggle("disabled", !!isLocked);
      }catch(e){}
    }
    setStatus("ok", "متصل — استخدم الحاسبات أو اسأل سؤالًا عامًا");

    // ==============================
    // Local fallback
    // ==============================
    function normalizeText(s){
      return (s || "")
        .toLowerCase()
        .replace(/[^\u0600-\u06FFa-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }
    function isEmergency(text){
      var t = normalizeText(text);
      var flags = [
        "الم شديد في الصدر","ألم شديد في الصدر","الم صدر","ألم صدر",
        "ضيق نفس شديد","صعوبة تنفس","اختناق",
        "اغماء","إغماء",
        "شلل","ضعف مفاجئ","تلعثم","تشوش كلام",
        "نزيف شديد","نزيف قوي",
        "تشنج","نوبة",
        "افكار انتحارية","أفكار انتحارية","انتحار","ايذاء النفس","إيذاء النفس"
      ];
      for (var i=0;i<flags.length;i++){
        if (t.indexOf(normalizeText(flags[i])) !== -1) return true;
      }
      return false;
    }

    function fallbackReply(userText){
      if (isEmergency(userText)){
        return "⚠️ **تنبيه**\nإذا لديك ألم صدر شديد/ضيق نفس شديد/إغماء/ضعف مفاجئ/نزيف شديد/تشنجات أو أفكار بإيذاء النفس: توجه للطوارئ فورًا أو اتصل بالإسعاف الآن.";
      }
      return "ℹ️ تعذر الاتصال بالخادم الآن. جرّب مرة ثانية.";
    }

    // ------------------------------
    // Timeout fetch
    // ------------------------------
    function fetchWithTimeout(url, options, ms){
      ms = ms || 12000;
      var controller = new AbortController();
      var id = setTimeout(function(){ controller.abort(); }, ms);
      options = options || {};
      options.signal = controller.signal;
      return fetch(url, options).finally(function(){ clearTimeout(id); });
    }

    // ------------------------------
    // PWA service worker
    // ------------------------------
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", function(){
        navigator.serviceWorker.register("./sw.js").catch(function(){});
      });
    }

    // ------------------------------
    // Viewport height fix
    // ------------------------------
    function setVhUnit() {
      var vh = window.innerHeight * 0.01;
      document.documentElement.style.setProperty('--vh', vh + 'px');
    }
    setVhUnit();
    window.addEventListener('resize', setVhUnit);

    // ------------------------------
    // Theme
    // ------------------------------
    function applyTheme(theme){
      document.documentElement.setAttribute("data-theme", theme);
      try{ localStorage.setItem("wellness_theme", theme); }catch(e){}
    }
    function toggleTheme(){
      var cur = document.documentElement.getAttribute("data-theme") || "dark";
      applyTheme(cur === "dark" ? "light" : "dark");
      showToast("تم", "تم تبديل المظهر.");
    }
    (function initTheme(){
      var saved = null;
      try{ saved = localStorage.getItem("wellness_theme"); }catch(e){}
      if (saved === "light" || saved === "dark") applyTheme(saved);
      else applyTheme("dark");
    })();

    // ------------------------------
    // Toast
    // ------------------------------
    var toastTimer = null;
    function showToast(title, msg){
      toastTitle.textContent = title || "تنبيه";
      toastMsg.textContent = msg || "";
      toastEl.classList.add("show");
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(hideToast, 2600);
    }
    function hideToast(){ toastEl.classList.remove("show"); }

    // ------------------------------
    // Privacy modal
    // ------------------------------
    function openPrivacy(){ privacyBackdrop.style.display = "flex"; }
    function closePrivacy(e){
      if (e && e.target && e.target !== privacyBackdrop) return;
      privacyBackdrop.style.display = "none";
    }

    // ------------------------------
    // Welcome
    // ------------------------------
    function startApp(){
      try{ localStorage.setItem("wellness_started", "1"); }catch(e){}
      welcomeEl.style.display = "none";
      input.focus();
    }
    (function initWelcome(){
      var started = null;
      try{ started = localStorage.getItem("wellness_started"); }catch(e){}
      if (started === "1") welcomeEl.style.display = "none";
      else welcomeEl.style.display = "flex";
    })();

    // ------------------------------
    // Markdown-ish rendering (safe) + LINKS
    // ------------------------------
    function escapeHtml(s){
      return (s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }
    function renderMarkdown(text) {
      var t = escapeHtml(text);

      // [text](url) -> link
      t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, function(_, label, url){
        return '<a href="'+url+'" target="_blank" rel="noopener noreferrer">'+label+'</a>';
      });

      t = t.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
      t = t.replace(/^-\s+/gm, "• ");
      t = t.replace(/\n/g, "<br>");
      return t;
    }
    function nowTime(){
      return new Date().toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" });
    }

    // ==============================
    // Report mode
    // ==============================
    function buildReportPrompt(pasted){
      return "نص التقرير:\n" + (pasted || "");
    }

    function startReportExplain(){
      reportMode = true;
      addBot(
        "🧾 **افهم تقريرك**\n" +
        "الصق نص التقرير/التحاليل هنا.\n" +
        "أو ارفع **PDF/صورة** من زر (إضافة مرفق).",
        { rate:false }
      );
      input.focus();
    }

    // ==============================
    // Attachment -> /report
    // ==============================
    function openAttachmentPicker(){
      if (!BACKEND_REPORT_URL){
        showToast("تنبيه", "مسار رفع التقارير غير مضبوط. تأكد أن BACKEND_URL صحيح.");
        return;
      }
      attachmentFile.value = "";
      attachmentFile.click();
    }

    attachmentFile.addEventListener("change", function(){
      var file = attachmentFile.files && attachmentFile.files[0];
      if (!file) return;

      var isOk = (file.type && (file.type.indexOf("image/") === 0 || file.type === "application/pdf"));
      if (!isOk){ showToast("غير مدعوم", "ارفع صورة أو PDF فقط."); return; }
      if (file.size > 8 * 1024 * 1024){ showToast("الحجم كبير", "الملف أكبر من 8MB."); return; }

      addBot("📎 تم إرفاق: **" + file.name + "**\nجارٍ قراءة الملف…", { rate:false });
      uploadReportFile(file);
    });

    function uploadReportFile(file){
      var typingMsg = addMsg(buildTypingHtml(), "bot", { html:true });
      setStatus("warn", "جاري قراءة التقرير…");
      lockSend(true);

      var fd = new FormData();
      fd.append("file", file);

      fetchWithTimeout(BACKEND_REPORT_URL, { method:"POST", body: fd }, 90000)
      .then(function(res){
        if (!res.ok) throw new Error("HTTP_" + res.status);
        return res.json();
      })
      .then(function(data){
        if (typingMsg && chat.contains(typingMsg)) chat.removeChild(typingMsg);
        var reply = (data && data.reply) ? data.reply : "لم يصلني رد واضح.";
        addBot(reply, { rate:true });
        setStatus("ok", "تم — إذا عندك سؤال عن نتيجة محددة اكتبها.");
      })
      .catch(function(){
        if (typingMsg && chat.contains(typingMsg)) chat.removeChild(typingMsg);
        addBot("تعذّر قراءة التقرير الآن. جرّب صورة أوضح أو الصق النص.", { rate:false });
        setStatus("warn", "فشل قراءة التقرير");
      })
      .finally(function(){
        lockSend(false);
      });
    }

    // ------------------------------
    // Chat UI helpers
    // ------------------------------
    function addMsg(text, from, options) {
      options = options || {};
      if (!from) from = "bot";

      var msg = document.createElement("div");
      msg.className = "msg " + from;

      var bubble = document.createElement("div");
      bubble.className = "bubble";

      if (options.html === true) bubble.innerHTML = text;
      else if (from === "bot") bubble.innerHTML = renderMarkdown(text);
      else bubble.textContent = text;

      var meta = document.createElement("div");
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

    function addBot(text, opts){ return addMsg(text, "bot", opts); }

    function buildTypingHtml(){
      return '<span class="typing">يكتب الآن <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span></span>';
    }

    function buildRatingRow(){
      var row = document.createElement("div");
      row.className = "rating";
      row.innerHTML = '<span class="rate-hint">قيّم الرد:</span>';

      var up = document.createElement("button");
      up.className = "rate-btn";
      up.type = "button";
      up.innerHTML = "👍 <span>مفيد</span>";

      var down = document.createElement("button");
      down.className = "rate-btn";
      down.type = "button";
      down.innerHTML = "👎 <span>غير مفيد</span>";

      function lock(){ up.disabled = true; down.disabled = true; }

      up.onclick = function(){ lock(); showToast("تم", "شكرًا!"); };
      down.onclick = function(){ lock(); showToast("تم", "شكرًا لملاحظتك."); };

      row.appendChild(up);
      row.appendChild(down);
      return row;
    }

    // ============================
    // Category badges (match backend)
    // ============================
    var CATEGORY_MAP = {
      mental:   { key:"mental",   label:"مزاج",     icon:"🧠", color:"#8b5cf6" },
      report:   { key:"report",   label:"تقرير",    icon:"🧾", color:"#38bdf8" },
      bmi:      { key:"bmi",      label:"BMI",      icon:"📏", color:"#22c55e" },
      bp:       { key:"bp",       label:"ضغط",      icon:"💓", color:"#f43f5e" },
      sugar:    { key:"sugar",    label:"سكر",      icon:"🩸", color:"#f59e0b" },
      water:    { key:"water",    label:"سوائل",    icon:"💧", color:"#06b6d4" },
      calories: { key:"calories", label:"سعرات",    icon:"🔥", color:"#fb7185" },
      emergency:{ key:"emergency",label:"طارئ",     icon:"🚨", color:"#ef4444" },
      general:  { key:"general",  label:"عام",      icon:"🩺", color:"#94a3b8" }
    };

    function pickCategoryFromPayload(data){
      if (data && data.category && CATEGORY_MAP[data.category]) return CATEGORY_MAP[data.category];
      return CATEGORY_MAP.general;
    }

    function isDangerCard(data){
      var t = (data && (data.title || "")).toString();
      var v = (data && (data.verdict || "")).toString();
      return /تنبيه|طارئ|خطر|🚨/.test(t) || /طوارئ|اتصل|فورًا/.test(v);
    }

    function normalizeSection(text){
      return (text || "").toString().trim();
    }

    function renderStructuredCard(data){
      data = data || {};
      var title = (data.title || "دليل العافية").toString();
      var verdict = normalizeSection(data.verdict || "");
      var q = normalizeSection(data.next_question || "");
      var tips = Array.isArray(data.tips) ? data.tips : [];
      var choices = Array.isArray(data.quick_choices) ? data.quick_choices : [];
      var seek = normalizeSection(data.when_to_seek_help || "");

      var badgeClass = isDangerCard(data) ? "danger" : "ok";
      var badgeText = isDangerCard(data) ? "تنبيه" : "إرشاد";

      var cat = pickCategoryFromPayload(data);
      var catHtml =
        '<span class="cat-badge" title="تصنيف">' +
          '<span class="cat-dot" style="background:'+escapeHtml(cat.color)+'"></span>' +
          '<span>'+escapeHtml(cat.icon)+'</span>' +
          '<span>'+escapeHtml(cat.label)+'</span>' +
        '</span>';

      var html = '';
      html += '<div class="bot-card">';
      html +=   '<div class="t">';
      html +=     '<b>' + escapeHtml(title) + '</b>';
      html +=     '<span style="display:inline-flex; gap:8px; align-items:center;">' + catHtml + '<span class="badge '+badgeClass+'">'+escapeHtml(badgeText)+'</span></span>';
      html +=   '</div>';

      if (verdict){
        html += '<div class="kv">' + renderMarkdown(verdict) + '</div>';
      }

      if (tips && tips.length){
        html += '<div class="kv"><span class="label">نصائح قصيرة</span><ul>';
        for (var i=0;i<tips.length;i++){
          html += '<li>' + renderMarkdown(tips[i]) + '</li>';
        }
        html += '</ul></div>';
      }

      if (seek){
        html += '<div class="kv"><span class="label">متى تراجع الطبيب</span>' + renderMarkdown(seek) + '</div>';
      }

      if (q){
        html += '<div class="kv"><span class="label">سؤال سريع</span>' + renderMarkdown(q) + '</div>';
      }

      if (q && choices && choices.length){
        html += '<div class="choice-wrap">';
        for (var j=0;j<choices.length;j++){
          var c = choices[j];
          if (!c) continue;
          html += '<button type="button" class="choice-btn" data-choice="'+escapeHtml(c)+'">'+escapeHtml(c)+'</button>';
        }
        html += '</div>';
      }

      html += '</div>';
      return html;
    }

    function addBotCard(data, opts){
      opts = opts || {};
      LAST_CARD = data || null;

      var msg = addMsg(renderStructuredCard(data), "bot", { html:true, rate: opts.rate === true });

      try{
        var buttons = msg.querySelectorAll(".choice-btn");
        buttons.forEach(function(btn){
          btn.addEventListener("click", function(){
            var choice = btn.getAttribute("data-choice") || btn.textContent || "";
            choice = choice.trim();
            if (!choice) return;
            addMsg(choice, "user");
            sendToBackend(choice, { is_choice: true });
          });
        });
      }catch(e){}
      return msg;
    }

    // ==============================
    // Digits helper
    // ==============================
    function normalizeDigits(str) {
      var arabicIndic = "٠١٢٣٤٥٦٧٨٩";
      var easternIndic = "۰۱۲۳۴۵۶۷۸۹";
      var out = "";
      str = String(str || "");
      for (var i = 0; i < str.length; i++) {
        var ch = str.charAt(i);
        var idx1 = arabicIndic.indexOf(ch);
        var idx2 = easternIndic.indexOf(ch);
        if (idx1 !== -1) out += String(idx1);
        else if (idx2 !== -1) out += String(idx2);
        else out += ch;
      }
      return out;
    }

    function isYes(text) {
      var t = (text || "").trim().toLowerCase();
      var yesWords = ["نعم","اي","ايه","أيه","ايوه","أيوة","yes","ok","اوكي","تمام"];
      for (var i = 0; i < yesWords.length; i++) {
        if (t === yesWords[i] || t.indexOf(yesWords[i]) !== -1) return true;
      }
      return false;
    }
    function isNo(text) {
      var t = (text || "").trim().toLowerCase();
      var noWords = ["لا","لأ","مو","مش","no","ماعندي","ما ابي","مابي"];
      for (var i = 0; i < noWords.length; i++) {
        if (t === noWords[i] || t.indexOf(noWords[i]) !== -1) return true;
      }
      return false;
    }

    // ==============================
    // Mood check (GAD-7 + PHQ-9)
    // ==============================
    var moodMode = false;
    var moodStep = 0;
    var moodAnswers = [];

    var moodChoices = [
      { v:0, label:"0) أبدًا" },
      { v:1, label:"1) عدة أيام" },
      { v:2, label:"2) أكثر من نصف الأيام" },
      { v:3, label:"3) تقريبًا كل يوم" }
    ];

    var moodQuestions = [
      { scale:"GAD", text:"خلال آخر أسبوعين: كم مرة شعرت بالتوتر أو القلق أو العصبية؟" },
      { scale:"GAD", text:"كم مرة لم تستطع إيقاف القلق أو التحكم فيه؟" },
      { scale:"GAD", text:"كم مرة قلقت كثيرًا حول أمور مختلفة؟" },
      { scale:"GAD", text:"كم مرة واجهت صعوبة في الاسترخاء؟" },
      { scale:"GAD", text:"كم مرة شعرت أنك لا تستطيع الجلوس بهدوء (تململ/توتر)؟" },
      { scale:"GAD", text:"كم مرة شعرت بالانزعاج أو الاستثارة بسرعة؟" },
      { scale:"GAD", text:"كم مرة شعرت بالخوف وكأن شيئًا سيئًا قد يحدث؟" },

      { scale:"PHQ", text:"خلال آخر أسبوعين: كم مرة قلّ اهتمامك أو متعتك بالأشياء؟" },
      { scale:"PHQ", text:"كم مرة شعرت بالحزن أو الإحباط أو اليأس؟" },
      { scale:"PHQ", text:"كم مرة واجهت صعوبة في النوم أو نمت أكثر من المعتاد؟" },
      { scale:"PHQ", text:"كم مرة شعرت بتعب أو نقص طاقة؟" },
      { scale:"PHQ", text:"كم مرة قلّت شهيتك للأكل أو زادت بشكل ملحوظ؟" },
      { scale:"PHQ", text:"كم مرة شعرت أنك فاشل/تلوم نفسك كثيرًا؟" },
      { scale:"PHQ", text:"كم مرة واجهت صعوبة في التركيز (قراءة/عمل/مشاهدة)؟" },
      { scale:"PHQ", text:"كم مرة لاحظت بطء شديد بالحركة أو العكس: توتر زائد وحركة أكثر؟" },
      { scale:"PHQ", text:"كم مرة راودتك أفكار بإيذاء نفسك أو أن الحياة لا تستحق؟" }
    ];

    function startMoodCheck(){
      moodMode = true;
      moodStep = 0;
      moodAnswers = [];
      addBot(
        "**طمّنا على مزاجك** 🧠\n" +
        "استبيان قصير (تحرّي أولي) — ليس تشخيصًا.\n" +
        "اختر الإجابة من الأزرار تحت كل سؤال.",
        { rate:false }
      );
      askMoodQuestion();
    }

    function askMoodQuestion(){
      if (!moodMode) return;

      if (moodStep >= moodQuestions.length){
        finishMoodCheck();
        return;
      }

      var q = moodQuestions[moodStep];
      var title = (q.scale === "GAD" ? "قسم القلق (GAD-7)" : "قسم المزاج (PHQ-9)");
      var header =
        "**" + title + "**\n" +
        "سؤال " + (moodStep + 1) + " من " + moodQuestions.length + ":\n" +
        q.text + "\n\n" +
        "اختر إجابة واحدة:";

      var msg = document.createElement("div");
      msg.className = "msg bot";
      var bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.innerHTML = renderMarkdown(header);

      var wrap = document.createElement("div");
      wrap.className = "chips";

      moodChoices.forEach(function(c){
        var b = document.createElement("button");
        b.type = "button";
        b.className = "chip-btn";
        b.textContent = c.label;
        b.onclick = function(){
          addMsg(c.label, "user");
          moodAnswers.push(c.v);
          moodStep += 1;
          askMoodQuestion();
        };
        wrap.appendChild(b);
      });

      bubble.appendChild(wrap);
      msg.appendChild(bubble);

      var meta = document.createElement("div");
      meta.className = "msg-meta";
      meta.textContent = nowTime();
      msg.appendChild(meta);

      chat.appendChild(msg);
      chat.scrollTop = chat.scrollHeight;
    }

    function sum(arr){ var s=0; for(var i=0;i<arr.length;i++) s+=Number(arr[i]||0); return s; }

    function interpretGAD(score){
      if (score <= 4) return { level:"منخفض جدًا", hint:"غالبًا لا يشير لمشكلة كبيرة." };
      if (score <= 9) return { level:"خفيف", hint:"قد يفيد تنظيم النوم وتقليل المنبهات وتمارين التنفس." };
      if (score <= 14) return { level:"متوسط", hint:"قد يفيد دعم نفسي/استشارة مختص إذا استمر التأثير." };
      return { level:"مرتفع", hint:"يُفضّل استشارة مختص قريبًا خاصة إن أثّر على حياتك." };
    }

    function interpretPHQ(score){
      if (score <= 4) return { level:"منخفض جدًا", hint:"غالبًا لا يشير لمشكلة كبيرة." };
      if (score <= 9) return { level:"خفيف", hint:"قد يفيد نشاط بسيط يوميًا + روتين نوم + تواصل اجتماعي." };
      if (score <= 14) return { level:"متوسط", hint:"قد يفيد التحدث مع مختص إذا استمر لأكثر من أسبوعين." };
      if (score <= 19) return { level:"مرتفع", hint:"يُفضّل استشارة مختص قريبًا، خاصة إذا أثّر على الأداء اليومي." };
      return { level:"مرتفع جدًا", hint:"يُفضّل طلب تقييم من مختص بأقرب وقت." };
    }

    function finishMoodCheck(){
      moodMode = false;

      var gad = sum(moodAnswers.slice(0,7));
      var phq = sum(moodAnswers.slice(7,16));
      var gadI = interpretGAD(gad);
      var phqI = interpretPHQ(phq);

      var selfHarmItem = moodAnswers[15] || 0;

      var result =
        "**النتيجة (تحرّي أولي فقط):**\n" +
        "• مؤشر القلق: **" + gad + "** → " + gadI.level + "\n" +
        "• مؤشر المزاج: **" + phq + "** → " + phqI.level + "\n\n" +
        "**ملاحظات:**\n" +
        "• " + gadI.hint + "\n" +
        "• " + phqI.hint + "\n\n" +
        "إذا الأعراض تؤثر على حياتك أو مستمرة، فمراجعة مختص خطوة ممتازة.";

      addBot(result, { rate:true });

      if (selfHarmItem > 0){
        addBot(
          "⚠️ **تنبيه مهم**\n" +
          "ذكرت وجود أفكار بإيذاء النفس.\n" +
          "إذا كان هناك خطر حالي أو أفكار قوية: اطلب مساعدة فورية من أقرب جهة صحية/الطوارئ أو تواصل مع شخص تثق به الآن.",
          { rate:false }
        );
      }

      showToast("تم", "اكتمل الاستبيان (تحرّي أولي فقط).");
    }

    // ==============================
    // Calculators
    // ==============================
    function startCalc(mode) {
      calcMode = mode;
      calcStep = 0;
      calcData = {};
      pendingTips = null;

      if (mode === "bmi") addBot("تمام. اكتب **وزنك بالكيلوغرام** (مثال: 75).", { rate:false });
      else if (mode === "bp") addBot("تمام. اكتب **الضغط الانقباضي** (الرقم الأعلى) مثل: 120", { rate:false });
      else if (mode === "sugar") addBot("هل القياس **صائم** أم **بعد الأكل**؟ اكتب: صائم / بعد الأكل", { rate:false });
      else if (mode === "water") addBot("تمام. اكتب **وزنك بالكيلوغرام** لحساب احتياج السوائل (مثال: 70).", { rate:false });
      else if (mode === "calories") addBot("تمام. اكتب **وزنك بالكيلوغرام** (مثال: 70).", { rate:false });
      else addBot("الأداة غير معروفة.", { rate:false });

      input.focus();
    }

    function finishCalc(resultText, topicLabel, aiContext) {
      addBot(resultText, { rate:true });
      pendingTips = { topicLabel: topicLabel, aiContext: aiContext || "" };
      addBot("هل تريد نصائح حول **" + topicLabel + "**؟ (نعم / لا)", { rate:false });
    }

    function handleCalc(text) {
      var norm = normalizeDigits(text);

      // BMI
      if (calcMode === "bmi") {
        if (calcStep === 0) {
          calcData.weight = Number(norm);
          if (!calcData.weight || calcData.weight <= 0) { addBot("اكتب وزن صحيح بالكيلوغرام (مثال: 75).", { rate:false }); return; }
          calcStep = 1;
          addBot("الآن اكتب **طولك بالسنتيمتر** (مثال: 170).", { rate:false });
          return;
        }
        if (calcStep === 1) {
          calcData.height = Number(norm);
          if (!calcData.height || calcData.height <= 0) { addBot("اكتب طول صحيح بالسنتيمتر.", { rate:false }); return; }

          var h = calcData.height / 100;
          var bmi = (calcData.weight / (h * h)).toFixed(1);
          var status = "";
          if (bmi < 18.5) status = "أقل من الوزن الطبيعي.";
          else if (bmi < 25) status = "ضمن الطبيعي تقريبًا.";
          else if (bmi < 30) status = "زيادة في الوزن.";
          else status = "سمنة تقريبية.";

          var result =
            "**مؤشر كتلة الجسم**\n" +
            "• BMI: " + bmi + "\n" +
            "• التقدير: " + status;

          var ctx =
            "وزن: " + calcData.weight + " كجم\n" +
            "طول: " + calcData.height + " سم\n" +
            "BMI: " + bmi + "\n" +
            "التقدير: " + status;

          calcMode = null; calcStep = 0;
          finishCalc(result, "مؤشر كتلة الجسم", ctx);
          return;
        }
      }

      // ضغط
      if (calcMode === "bp") {
        if (calcStep === 0) {
          calcData.systolic = Number(norm);
          if (!calcData.systolic || calcData.systolic <= 0) { addBot("اكتب رقم صحيح للضغط الانقباضي (مثل: 120).", { rate:false }); return; }
          calcStep = 1;
          addBot("الآن اكتب **الضغط الانبساطي** (الرقم الأسفل) مثل: 80", { rate:false });
          return;
        }
        if (calcStep === 1) {
          calcData.diastolic = Number(norm);
          if (!calcData.diastolic || calcData.diastolic <= 0) { addBot("اكتب رقم صحيح للضغط الانبساطي (مثل: 80).", { rate:false }); return; }

          var s = calcData.systolic, d = calcData.diastolic;
          var category = "";
          if (s < 90 || d < 60) category = "يميل للانخفاض.";
          else if (s < 120 && d < 80) category = "في المجال الطبيعي تقريبًا.";
          else if (s >= 120 && s <= 129 && d < 80) category = "ارتفاع بسيط.";
          else if ((s >= 130 && s <= 139) || (d >= 80 && d <= 89)) category = "ارتفاع درجة أولى (تقريبي).";
          else if (s >= 140 || d >= 90) category = "ارتفاع واضح.";
          else category = "لا يمكن تصنيفه بدقة من هذه القراءة فقط.";

          var result =
            "**تقييم الضغط**\n" +
            "• القراءة: " + s + "/" + d + " ملم زئبقي\n" +
            "• التقدير: " + category;

          var ctx =
            "قراءة الضغط: " + s + "/" + d + " ملم زئبقي\n" +
            "التقدير: " + category;

          calcMode = null; calcStep = 0;
          finishCalc(result, "تقييم ضغط الدم", ctx);
          return;
        }
      }

      // سكر
      if (calcMode === "sugar") {
        if (calcStep === 0) {
          var t = (text || "").trim();
          if (t.indexOf("صائم") !== -1) calcData.context = "fasting";
          else if (t.indexOf("بعد") !== -1) calcData.context = "post";
          else calcData.context = "unknown";
          calcStep = 1;
          addBot("اكتب قيمة السكر **بالمليغرام/ديسيلتر** (مثال: 95 أو 160).", { rate:false });
          return;
        }
        if (calcStep === 1) {
          var value = Number(norm);
          if (!value || value <= 0) { addBot("اكتب رقم صحيح لقيمة السكر (مثال: 95).", { rate:false }); return; }

          var evaluation = "";
          var typeLabel = "غير محدد";
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

          var result =
            "**تقدير السكر**\n" +
            "• النوع: " + typeLabel + "\n" +
            "• القيمة: " + value + " ملغ/ديسيلتر\n" +
            "• التقدير: " + evaluation;

          var ctx =
            "نوع القياس: " + typeLabel + "\n" +
            "قيمة السكر: " + value + " mg/dL\n" +
            "التقدير: " + evaluation;

          calcMode = null; calcStep = 0;
          finishCalc(result, "تقييم السكر", ctx);
          return;
        }
      }

      // سوائل
      if (calcMode === "water") {
        if (calcStep === 0) {
          calcData.weight = Number(norm);
          if (!calcData.weight || calcData.weight <= 0) { addBot("اكتب وزن صحيح بالكيلوغرام (مثال: 70).", { rate:false }); return; }

          var totalMl = calcData.weight * 30;
          var liters = (totalMl / 1000).toFixed(1);

          var result =
            "**احتياج السوائل التقريبي**\n" +
            "• حوالي " + totalMl + " مل يوميًا (≈ " + liters + " لتر).";

          var ctx =
            "وزن: " + calcData.weight + " كجم\n" +
            "تقدير السوائل: " + totalMl + " مل/يوم (" + liters + " لتر تقريبًا)";

          calcMode = null; calcStep = 0;
          finishCalc(result, "احتياج السوائل", ctx);
          return;
        }
      }

      // سعرات
      if (calcMode === "calories") {
        if (calcStep === 0) {
          calcData.weight = Number(norm);
          if (!calcData.weight || calcData.weight <= 0) { addBot("اكتب وزن صحيح بالكيلوغرام (مثال: 70).", { rate:false }); return; }
          calcStep = 1;
          addBot("ما مستوى نشاطك اليومي؟\nاكتب: **خفيف / متوسط / عالي** (أو 1 / 2 / 3).", { rate:false });
          return;
        }
        if (calcStep === 1) {
          var t2 = (text || "").trim();
          var factor = 30;
          var level = "متوسط";
          if (t2.indexOf("خفيف") !== -1 || t2.indexOf("قليل") !== -1 || t2.indexOf("1") !== -1) { factor = 25; level = "خفيف"; }
          else if (t2.indexOf("عالي") !== -1 || t2.indexOf("شديد") !== -1 || t2.indexOf("3") !== -1) { factor = 35; level = "عالي"; }
          else { factor = 30; level = "متوسط"; }

          var calories = Math.round(calcData.weight * factor);

          var result =
            "**سعراتك اليومية التقريبية**\n" +
            "• حوالي " + calories + " سعرة حرارية يوميًا.";

          var ctx =
            "وزن: " + calcData.weight + " كجم\n" +
            "مستوى النشاط: " + level + "\n" +
            "تقدير السعرات: " + calories + " سعرة/يوم (تقريبي)";

          calcMode = null; calcStep = 0;
          finishCalc(result, "حاسبة السعرات", ctx);
          return;
        }
      }

      addBot("ما فهمت إدخالك للأداة. جرّب تكتب رقم/إجابة مناسبة.", { rate:false });
    }

    // ==============================
    // sendToBackend
    // ==============================
    function addTyping(){
      return addMsg(buildTypingHtml(), "bot", { html:true, rate:false });
    }

    function sendToBackend(message, meta) {
      if (!BACKEND_URL) { addBot("لم يتم ضبط رابط الخادم BACKEND_URL.", { rate:false }); return; }

      var typingMsg = addTyping();
      lockSend(true);

      var payloadToSend = {
        message: message,
        meta: meta || {},
        context: { last: LAST_CARD }
      };

      fetchWithTimeout(BACKEND_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-id": USER_ID
        },
        body: JSON.stringify(payloadToSend)
      }, 15000)
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP_" + res.status);
        return res.json();
      })
      .then(function (payload) {
        if (typingMsg && chat.contains(typingMsg)) chat.removeChild(typingMsg);

        if (payload && payload.ok === true && payload.data) {
          addBotCard(payload.data, { rate:true });
          setStatus("ok", "متصل — تم الرد");
          return;
        }

        throw new Error("BAD_RESPONSE");
      })
      .catch(function () {
        if (typingMsg && chat.contains(typingMsg)) chat.removeChild(typingMsg);
        // ✅ بدون تقييم على الفولباك
        addBot(fallbackReply(message), { rate:false });
        setStatus("warn", "انقطع الاتصال بالخادم");
        showToast("تنبيه", "تعذر الاتصال بالخادم الآن.");
      })
      .finally(function(){
        lockSend(false);
      });
    }

    // ==============================
    // Reset (واجهة + سيرفر)
    // ==============================
    function resetServerSession(){
      if (!BACKEND_RESET_URL) return;
      fetchWithTimeout(BACKEND_RESET_URL, {
        method:"POST",
        headers:{
          "Content-Type":"application/json",
          "x-user-id": USER_ID
        },
        body: JSON.stringify({ reset:true })
      }, 8000).catch(function(){});
    }

    function resetChat() {
      // امسح جلسة السيرفر عشان ما “يلخبط” على مواضيع قديمة
      resetServerSession();

      chat.innerHTML = "";
      calcMode = null; calcStep = 0; calcData = {};
      pendingTips = null;
      reportMode = false;

      moodMode = false;
      moodStep = 0;
      moodAnswers = [];

      LAST_CARD = null;

      setStatus("ok", "متصل — استخدم الحاسبات أو اسأل سؤالًا عامًا");
      addBot("مرحبًا بك في **دليل العافية** 🌿\nاختر أداة من المسارات السريعة أو اكتب سؤالك.", { rate:false });
      showQuickStart();
      input.focus();
    }

    function showQuickStart() {
      var msg = document.createElement("div");
      msg.className = "msg bot";

      var bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.innerHTML = renderMarkdown("**مسارات سريعة:** اختر ما يناسبك 👇");

      var wrap = document.createElement("div");
      wrap.className = "chips";

      var actions = [
        { label: "🧠 طمّنا على مزاجك", kind:"mood", cat:"mental" },
        { label: "🧾 افهم تقريرك", kind:"report", cat:"report" },

        { label: "📏 BMI", kind:"calc", value:"bmi", cat:"bmi" },
        { label: "💓 الضغط", kind:"calc", value:"bp", cat:"bp" },
        { label: "🩸 السكر", kind:"calc", value:"sugar", cat:"sugar" },
        { label: "💧 السوائل", kind:"calc", value:"water", cat:"water" },
        { label: "🔥 السعرات", kind:"calc", value:"calories", cat:"calories" }
      ];

      actions.forEach(function(a){
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "chip-btn";
        btn.textContent = a.label;

        try{
          var c = CATEGORY_MAP[a.cat] || CATEGORY_MAP.general;
          btn.style.borderColor = (c.color + "55");
          btn.style.boxShadow = "0 0 0 3px " + (c.color + "22");
        }catch(e){}

        btn.onclick = function(){
          if (a.kind === "mood") startMoodCheck();
          else if (a.kind === "report") startReportExplain();
          else if (a.kind === "calc") startCalc(a.value);
        };
        wrap.appendChild(btn);
      });

      bubble.appendChild(wrap);
      msg.appendChild(bubble);

      var meta = document.createElement("div");
      meta.className = "msg-meta";
      meta.textContent = nowTime();
      msg.appendChild(meta);

      chat.appendChild(msg);
      chat.scrollTop = chat.scrollHeight;
    }

    // ==============================
    // Sending (يدعم الحاسبات + المزاج + التقرير + نصائح بعد الحاسبة)
    // ==============================
    function sendMsg() {
      var text = (input.value || "").trim();
      if (!text) return;

      addMsg(text, "user");
      input.value = "";

      // لصق تقرير
      if (reportMode){
        reportMode = false;
        sendToBackend(buildReportPrompt(text));
        return;
      }

      // أثناء استبيان المزاج
      if (moodMode){
        addBot("فضلاً اختر إجابتك من الأزرار تحت السؤال.", { rate:false });
        return;
      }

      // بعد سؤال: تريد نصائح؟
      if (pendingTips && !calcMode) {
        if (isYes(text)) {
          var prompt =
            "أريد نصائح عملية وآمنة حول: " + pendingTips.topicLabel + ".\n" +
            "السياق/النتيجة:\n" + pendingTips.aiContext + "\n" +
            "اكتب نصائح مختصرة وواضحة (عادات يومية + أخطاء شائعة + متى أراجع الطبيب). بدون تشخيص.";
          pendingTips = null;
          sendToBackend(prompt);
          return;
        }
        if (isNo(text)) { addBot("تمام.", { rate:false }); pendingTips = null; return; }
        addBot("أجب **بنعم أو لا**: هل تريد نصائح حول " + pendingTips.topicLabel + "؟", { rate:false });
        return;
      }

      // الحاسبات
      if (calcMode){ handleCalc(text); return; }

      // رسالة عادية
      sendToBackend(text);
    }

    input.addEventListener("keydown", function(e){
      if (e.key === "Enter") {
        e.preventDefault();
        sendMsg();
      }
    });

    // ------------------------------
    // Init
    // ------------------------------
    window.onload = function() {
      resetChat();
    };
  </script>
</body>
</html>
