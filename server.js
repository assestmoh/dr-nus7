*** Begin Patch
*** Update File: server.js
@@
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
+  pathCount: Object.create(null),
+  skipEvalCount: 0,
+  usefulCountU1: 0,
+  usefulCountU0: 0,
   flows: Object.fromEntries(
     [
       "sugar",
       "bp",
       "bmi",
@@
 function updateAvgLatency(ms) {
   const alpha = 0.2;
   METRICS.avgLatencyMs =
     METRICS.avgLatencyMs === 0 ? ms : Math.round(alpha * ms + (1 - alpha) * METRICS.avgLatencyMs);
 }
 
+function bumpPath(pathCode) {
+  const k = String(pathCode || "");
+  if (!k) return;
+  METRICS.pathCount[k] = (METRICS.pathCount[k] || 0) + 1;
+}
+
 /* =========================
    Sessions (in-memory) + TTL
 ========================= */
 const sessions = new Map(); // userId -> { history, lastCard, flow, step, profile, ts }
@@
 function resetFlow(session) {
   session.flow = null;
   session.step = 0;
   session.profile = {};
 }
 
@@
 function clampText(s, maxChars) {
   const t = String(s || "").trim();
   if (t.length <= maxChars) return t;
   return t.slice(0, maxChars) + "\n...[تم قص النص لتفادي الأخطاء]";
 }
 
+function normalizeFlowKey(k) {
+  const v = String(k || "").trim().toLowerCase();
+  if (!v) return null;
+  const allowed = new Set([
+    "sugar",
+    "bp",
+    "bmi",
+    "water",
+    "calories",
+    "mental",
+    "first_aid",
+    "general",
+    "report",
+    "appointments",
+    "emergency",
+  ]);
+  return allowed.has(v) ? v : null;
+}
+
+function isSafetyRefusalCard(card) {
+  const combined =
+    (card?.title || "") +
+    "\n" +
+    (card?.verdict || "") +
+    "\n" +
+    (Array.isArray(card?.tips) ? card.tips.join("\n") : "") +
+    "\n" +
+    (card?.when_to_seek_help || "");
+  return /أنا\s+للتثقيف\s+الصحي\s+فقط/i.test(combined) && /أدوية|جرعات|دواء/i.test(combined);
+}
+
+function isActionableCard(card) {
+  const tips = Array.isArray(card?.tips) ? card.tips.filter(Boolean) : [];
+  const verdict = String(card?.verdict || "");
+  const combined = `${verdict}\n${tips.join("\n")}`;
+  if (tips.length >= 2) return true;
+  // crude heuristic: actionable verbs/steps
+  return /(جرّب|حاول|ابدأ|قلّل|زد|اشرب|نم|سجّل|قس|قسّم|اختر|ابتعد|تواصل|اتصل|اذهب)/i.test(combined);
+}
+
+function finalizeData(payload, meta) {
+  const route_code = meta?.route_code === "REPORT" ? "REPORT" : "CHAT";
+  const flow_key = normalizeFlowKey(meta?.flow_key);
+  const path_code = String(meta?.path_code || "LLM");
+
+  const skip_eval = Boolean(meta?.skip_eval);
+  let useful_code = String(meta?.useful_code || "");
+  let useless_reason = meta?.useless_reason ?? null;
+
+  // If not provided, infer useful_code for cards/objects
+  if (useful_code !== "U0" && useful_code !== "U1") {
+    const actionable = payload && typeof payload === "object" ? isActionableCard(payload) : false;
+    useful_code = actionable ? "U1" : "U0";
+    if (useful_code === "U0") useless_reason = useless_reason || "no_practical_guidance";
+  }
+
+  // Metrics
+  bumpPath(path_code);
+  if (skip_eval) METRICS.skipEvalCount++;
+  if (useful_code === "U1") METRICS.usefulCountU1++;
+  if (useful_code === "U0") METRICS.usefulCountU0++;
+
+  // Keep backward compatibility: merge fields into the same data object
+  const base = payload && typeof payload === "object" ? payload : { message: String(payload || "") };
+  return {
+    ...base,
+    useful_code,
+    useless_reason,
+    skip_eval,
+    route_code,
+    flow_key,
+    path_code,
+  };
+}
+
 function looksLikeAppointments(text) {
   const t = String(text || "");
   return /موعد|مواعيد|حجز|احجز|حجوزات|حجزت|حجزي|appointment|booking|شفاء/i.test(t);
 }
 
@@
 function chatSystemPrompt() {
   return (
-    "أنت أداة تثقيف صحي فقط، ولست طبيبًا ولا بديلاً عن الاستشارة الطبية.\n" +
-    "قدّم معلومات عامة عن الصحة ونمط الحياة بأسلوب عربي واضح ومختصر.\n" +
-    "ممنوع منعًا باتًا: التشخيص، وصف الأدوية، الجرعات، أو خطة علاج.\n" +
-    "اذكر متى يجب مراجعة الطبيب/الطوارئ عند أعراض خطيرة.\n" +
-    "إذا لم تكن متأكدًا، قل: لا أعلم.\n" +
-    "التزم بسؤال المستخدم وبيانات التخصيص فقط.\n" +
-    "أخرج JSON فقط بالمفاتيح المحددة.\n"
+    "قدّم معلومات صحية عامة بأسلوب عربي واضح ومباشر.\n" +
+    "لا تبدأ الرد بتبرؤ طويل.\n" +
+    "إذا طُلب منك تشخيص صريح، أو علاج، أو وصف دواء/جرعات، أو قرار طبي قطعي: ارفض بلطف وباختصار، وقدّم بدائل مفيدة (خطوات عامة/نمط حياة/أسئلة للطبيب) + متى يراجع الطبيب/الطوارئ.\n" +
+    "إذا ظهرت مؤشرات طوارئ: أعط توجيه سلامة واضح للطوارئ فورًا.\n" +
+    "ممنوع: تشخيص مؤكد، وصف أدوية، جرعات، أو خطة علاج تفصيلية.\n" +
+    "إذا لم تكن متأكدًا، قل: لا أعلم.\n" +
+    "أخرج JSON فقط بالمفاتيح المحددة.\n"
   );
 }
 
 function reportSystemPrompt() {
   return (
-    "أنت مساعد تثقيف صحي عربي لشرح نتائج التحاليل/التقارير.\n" +
-    "المدخل نص مُستخرج من صورة/ملف.\n" +
-    "اشرح بالعربية بشكل عام + نصائح عامة + متى يراجع الطبيب.\n" +
-    "ممنوع: تشخيص مؤكد، جرعات، وصف علاج.\n" +
-    "أخرج JSON فقط بنفس مفاتيح البطاقة.\n"
+    "أنت مساعد تثقيف صحي عربي لشرح نتائج التحاليل/التقارير للمواطن غير المختص.\n" +
+    "المدخل نص مُستخرج من صورة/ملف.\n" +
+    "استخدم لغة مبسطة جدًا وتجنب المصطلحات المعقدة، وإذا اضطررت فاشرحها بكلمات سهلة.\n" +
+    "في verdict اكتب أقسام واضحة بعناوين:\n" +
+    "1) ملخص بسيط\n" +
+    "2) ما الذي يعنيه غالبًا\n" +
+    "3) نصائح عامة\n" +
+    "4) متى تراجع الطبيب\n" +
+    "وفي tips ضع نقاط قصيرة عملية ومفهومة.\n" +
+    "ممنوع: تشخيص مؤكد، جرعات، وصف علاج.\n" +
+    "أخرج JSON فقط بنفس مفاتيح البطاقة.\n"
   );
 }
 
 async function callGroqJSON({ system, user, maxTokens = 1400 }) {
   if (!GROQ_API_KEY) throw new Error("Missing GROQ_API_KEY");
@@
 function postFilterCard(card) {
   const bad =
     /(خذ|خذي|جرعة|مرتين يوميًا|مرتين يوميا|ثلاث مرات|حبوب|دواء|انسولين|metformin|ibuprofen|paracetamol)/i;
@@
   if (bad.test(combined)) {
     return makeCard({
       title: "تنبيه",
       category: card?.category || "general",
       verdict:
-        "أنا للتثقيف الصحي فقط. ما أقدر أوصف أدوية أو جرعات.\n" +
-        "إذا سؤالك علاجي أو دوائي، راجع طبيب/صيدلي.",
+        "لا أقدر أوصف أدوية أو جرعات أو أقرر علاج.\n" +
+        "لكن أقدر أعطيك بدائل عامة وآمنة تساعدك تفهم الوضع وتجهّز أسئلتك للطبيب.",
       tips: [
-        "اكتب للطبيب الأعراض ومدة المشكلة والأدوية الحالية إن وجدت.",
-        "إذا أعراض شديدة: طوارئ.",
+        "اشرح للطبيب: الأعراض + مدتها + أي أمراض مزمنة + الأدوية الحالية/الحساسية.",
+        "إذا الهدف تخفيف الأعراض بشكل عام: ركّز على الراحة، شرب سوائل كفاية، ونوم كافٍ (حسب حالتك).",
+        "إذا الألم/الحرارة/الأعراض تتفاقم أو تمنعك من أداء يومك: راجع طبيب/صيدلي لتقييم مناسب.",
+        "إذا أعراض شديدة أو مفاجئة: طوارئ فورًا.",
       ],
       when_to_seek_help: "ألم صدر/ضيق نفس/إغماء/نزيف شديد: طوارئ فورًا.",
       next_question: "هل تريد نصائح نمط حياة بدل العلاج؟",
       quick_choices: ["نعم", "لا"],
     });
   }
   return card;
 }
@@
 app.post("/chat", async (req, res) => {
   const t0 = Date.now();
   METRICS.chatRequests++;
 
   const userId = req.header("x-user-id") || "anon";
   const session = getSession(userId);
 
   const message = String(req.body?.message || "").trim();
   if (!message) return res.status(400).json({ ok: false, error: "empty_message" });
 
   // “مسح/إلغاء”
   if (/^(إلغاء|الغاء|cancel|مسح|مسح المحادثة|ابدأ من جديد|ابدأ جديد)$/i.test(message)) {
     resetFlow(session);
     const card = menuCard();
     session.lastCard = card;
     METRICS.chatOk++;
     updateAvgLatency(Date.now() - t0);
-    return res.json({ ok: true, data: card });
+    return res.json({
+      ok: true,
+      data: finalizeData(card, {
+        route_code: "CHAT",
+        flow_key: "general",
+        path_code: "FLOW_START",
+        skip_eval: false,
+        useful_code: "U1",
+      }),
+    });
   }
 
   // طوارئ: نزيد العدّاد ونرجع بطاقة واضحة
   if (isEmergencyText(message)) {
     METRICS.emergencyTriggers++;
     const card = makeCard({
       title: "⚠️ تنبيه طارئ",
       category: "emergency",
@@
     session.lastCard = card;
     bumpCategory("emergency");
     METRICS.chatOk++;
     updateAvgLatency(Date.now() - t0);
-    return res.json({ ok: true, data: card });
+    return res.json({
+      ok: true,
+      data: finalizeData(card, {
+        route_code: "CHAT",
+        flow_key: "emergency",
+        path_code: "EMERGENCY",
+        skip_eval: false,
+        useful_code: "U1",
+      }),
+    });
   }
 
   // مواعيد شفاء (ثابت)
   if (looksLikeAppointments(message)) {
     const card = appointmentsCard();
     session.lastCard = card;
     bumpCategory("appointments");
     METRICS.chatOk++;
     updateAvgLatency(Date.now() - t0);
-    return res.json({ ok: true, data: card });
+    return res.json({
+      ok: true,
+      data: finalizeData(card, {
+        route_code: "CHAT",
+        flow_key: "appointments",
+        path_code: "STATIC_APPOINTMENTS",
+        skip_eval: true,
+        useful_code: "U1",
+      }),
+    });
   }
 
   // إذا المستخدم كتب "افهم تقريرك" -> نوجّه للمرفق (الواجهة سترفع PDF/صورة)
   if (/افهم\s*تقريرك|تقرير|تحاليل/i.test(message) && message.length <= 30) {
-    const card = makeCard({
-      title: "📄 افهم تقريرك",
-      category: "report",
-      verdict: "تمام. اضغط زر 📎 (إضافة مرفق) وارفع صورة أو PDF للتقرير، وأنا أشرح لك بشكل عام.",
-      tips: ["لا ترفع بيانات شخصية حساسة إن أمكن."],
-      when_to_seek_help: "إذا أعراض شديدة مع التقرير: راجع الطبيب/الطوارئ.",
-      next_question: "جاهز ترفع التقرير؟",
-      quick_choices: ["📎 إضافة مرفق", "إلغاء"],
-    });
-    session.lastCard = card;
+    const gate = {
+      message: "ارفق ملف PDF/صورة للتقرير عبر زر 📎 ثم أشرح لك بلغة مبسطة.",
+    };
+    session.lastCard = gate;
     bumpCategory("report");
     METRICS.chatOk++;
     updateAvgLatency(Date.now() - t0);
-    return res.json({ ok: true, data: card });
+    return res.json({
+      ok: true,
+      data: finalizeData(gate, {
+        route_code: "CHAT",
+        flow_key: "report",
+        path_code: "REPORT_UPLOAD_GATE",
+        skip_eval: true,
+        useful_code: "U1",
+      }),
+    });
   }
@@
   if (!session.flow) {
     const short = message.length <= 40;
     const matched = startMap.find((x) => x.match.test(message));
     if (short && matched) {
       const card = startFlow(session, matched.key);
       session.lastCard = card;
       METRICS.chatOk++;
       updateAvgLatency(Date.now() - t0);
-      return res.json({ ok: true, data: card });
+      return res.json({
+        ok: true,
+        data: finalizeData(card, {
+          route_code: "CHAT",
+          flow_key: matched.key,
+          path_code: "FLOW_START",
+          skip_eval: false,
+          useful_code: "U1",
+        }),
+      });
     }
 
     // fallback: infer category auto-start if message is short
     if (short && ["sugar", "bp", "bmi", "water", "calories", "mental", "first_aid"].includes(inferred)) {
       const card = startFlow(session, inferred);
       session.lastCard = card;
       METRICS.chatOk++;
       updateAvgLatency(Date.now() - t0);
-      return res.json({ ok: true, data: card });
+      return res.json({
+        ok: true,
+        data: finalizeData(card, {
+          route_code: "CHAT",
+          flow_key: inferred,
+          path_code: "FLOW_START",
+          skip_eval: false,
+          useful_code: "U1",
+        }),
+      });
     }
   }
 
   // متابعة مسار (سؤال/اختيار)
   if (session.flow && session.step > 0 && session.step < 4) {
     const card = continueFlow(session, message);
     if (card) {
       session.lastCard = card;
       METRICS.chatOk++;
       updateAvgLatency(Date.now() - t0);
-      return res.json({ ok: true, data: card });
+      return res.json({
+        ok: true,
+        data: finalizeData(card, {
+          route_code: "CHAT",
+          flow_key: session.flow,
+          path_code: "FLOW_STEP",
+          skip_eval: false,
+          useful_code: "U1",
+        }),
+      });
     }
     // إذا رجع null معناها step=4 وجاهزين للتوليد
   }
@@
   try {
     const obj = await callGroqJSON({
       system: chatSystemPrompt(),
       user: userPrompt,
       maxTokens: 1200,
     });
@@
     const card = makeCard({ ...obj, category: finalCategory });
     const safeCard = postFilterCard(card);
 
     session.lastCard = safeCard;
     session.history.push({ role: "assistant", content: JSON.stringify(safeCard) });
     session.history = trimHistory(session.history, 10);
 
     bumpCategory(safeCard.category);
     METRICS.chatOk++;
     updateAvgLatency(Date.now() - t0);
 
-    return res.json({ ok: true, data: safeCard });
+    const safetyRefusal = isSafetyRefusalCard(safeCard);
+    const useful = safetyRefusal ? (isActionableCard(safeCard) ? "U1" : "U0") : "U1";
+    const skipEval = safetyRefusal ? true : false;
+    return res.json({
+      ok: true,
+      data: finalizeData(safeCard, {
+        route_code: "CHAT",
+        flow_key: forcedCategory || inferred || "general",
+        path_code: safetyRefusal ? "SAFETY_REFUSAL" : "LLM",
+        skip_eval: skipEval,
+        useful_code: useful,
+        useless_reason: useful === "U0" ? "safety_refusal_only" : null,
+      }),
+    });
   } catch (err) {
     console.error("[chat] FAILED:", err?.message || err);
     METRICS.chatFail++;
+    bumpPath("ERROR_MODEL");
+    METRICS.skipEvalCount++;
     updateAvgLatency(Date.now() - t0);
     return res.status(502).json({ ok: false, error: "model_error" });
   }
 });
 
 app.post("/report", upload.single("file"), async (req, res) => {
   const t0 = Date.now();
   METRICS.reportRequests++;
@@
   const file = req.file;
-  if (!file) return res.status(400).json({ ok: false, error: "missing_file" });
+  if (!file) {
+    METRICS.reportFail++;
+    bumpPath("ERROR_OFFLINE");
+    METRICS.skipEvalCount++;
+    updateAvgLatency(Date.now() - t0);
+    return res.status(400).json({ ok: false, error: "missing_file" });
+  }
 
   try {
     let extracted = "";
 
     if (file.mimetype === "application/pdf") {
@@
       if (extracted.length < 40) {
         METRICS.reportFail++;
+        bumpPath("REPORT_UPLOAD_GATE");
+        METRICS.skipEvalCount++;
         updateAvgLatency(Date.now() - t0);
         return res.json({
           ok: false,
           error: "pdf_no_text",
@@
       if (extracted.length < 25) {
         METRICS.reportFail++;
+        bumpPath("REPORT_UPLOAD_GATE");
+        METRICS.skipEvalCount++;
         updateAvgLatency(Date.now() - t0);
         return res.json({
           ok: false,
           error: "ocr_failed",
@@
     } else {
       METRICS.reportFail++;
+      bumpPath("ERROR_OFFLINE");
+      METRICS.skipEvalCount++;
       updateAvgLatency(Date.now() - t0);
       return res.status(400).json({ ok: false, error: "unsupported_type" });
     }
@@
     const card = postFilterCard(makeCard({ ...obj, category: "report" }));
     session.lastCard = card;
 
     bumpCategory("report");
     METRICS.reportOk++;
     updateAvgLatency(Date.now() - t0);
 
-    return res.json({ ok: true, data: card });
+    const safetyRefusal = isSafetyRefusalCard(card);
+    const useful = safetyRefusal ? (isActionableCard(card) ? "U1" : "U0") : "U1";
+    const skipEval = safetyRefusal ? true : false;
+    return res.json({
+      ok: true,
+      data: finalizeData(card, {
+        route_code: "REPORT",
+        flow_key: "report",
+        path_code: safetyRefusal ? "SAFETY_REFUSAL" : "LLM",
+        skip_eval: skipEval,
+        useful_code: useful,
+        useless_reason: useful === "U0" ? "safety_refusal_only" : null,
+      }),
+    });
   } catch (err) {
     console.error("[report] FAILED:", err?.message || err);
     METRICS.reportFail++;
+    bumpPath("ERROR_MODEL");
+    METRICS.skipEvalCount++;
     updateAvgLatency(Date.now() - t0);
     return res.status(502).json({
       ok: false,
       error: "report_error",
       message: "تعذر تحليل التقرير الآن. جرّب صورة أوضح أو الصق النص.",
     });
   }
 });
*** End Patch
