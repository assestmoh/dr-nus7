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
+  if (!pathCode) return;
+  METRICS.pathCount[pathCode] = (METRICS.pathCount[pathCode] || 0) + 1;
+}
+
 /* =========================
    Sessions (in-memory) + TTL
 ========================= */
@@
 function clampText(s, maxChars) {
   const t = String(s || "").trim();
   if (t.length <= maxChars) return t;
   return t.slice(0, maxChars) + "\n...[تم قص النص لتفادي الأخطاء]";
 }
 
+function normalizeFlowKey(k) {
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
+  if (!k) return null;
+  const s = String(k).trim().toLowerCase();
+  return allowed.has(s) ? s : null;
+}
+
+function isTherapeuticOrDrugRequest(text) {
+  const t = String(text || "");
+  return /(شخّص|شخص|تشخيص|علاج|عالج|وصف(?:ة)?|روشتة|صرف دواء|اعط(?:ني|يني) دواء|جرعة|جرعات|كم(?:ية)?|mg|ملغ|ملجم|مرتين|ثلاث مرات|كل\s*\d+\s*ساعات|antibiotic|مضاد|مسكن|حبوب|دواء|انسولين|metformin|ibuprofen|paracetamol)/i.test(
+    t
+  );
+}
+
+function computeUsefulness({ data, forceU0 = false }) {
+  if (forceU0) {
+    const reason = "SAFETY_REFUSAL";
+    return { useful_code: "U0", useless_reason: reason };
+  }
+  const message = String(data?.message || "");
+  const verdict = String(data?.verdict || "");
+  const tips = Array.isArray(data?.tips) ? data.tips.filter(Boolean) : [];
+  const hasContent =
+    message.trim().length > 0 || verdict.trim().length > 0 || tips.length > 0 || data?.when_to_seek_help;
+  if (hasContent) return { useful_code: "U1", useless_reason: null };
+  return { useful_code: "U0", useless_reason: "EMPTY_OR_REFUSAL_ONLY" };
+}
+
+function shouldSkipEval({ path_code, isError = false, isOffline = false, isStatic = false, isRefusal = false }) {
+  if (isError || isOffline) return true;
+  if (isStatic) return true;
+  if (isRefusal) return true;
+  if (path_code === "REPORT_UPLOAD_GATE" || path_code === "STATIC_APPOINTMENTS") return true;
+  return false;
+}
+
+function attachEvalMeta({
+  route_code,
+  flow_key,
+  path_code,
+  data,
+  forceU0 = false,
+  isError = false,
+  isOffline = false,
+  isStatic = false,
+  isRefusal = false,
+}) {
+  const fk = normalizeFlowKey(flow_key);
+  const { useful_code, useless_reason } = computeUsefulness({ data, forceU0 });
+  const skip_eval = shouldSkipEval({ path_code, isError, isOffline, isStatic, isRefusal });
+  const meta = {
+    useful_code,
+    useless_reason: useful_code === "U0" ? useless_reason : null,
+    skip_eval: !!skip_eval,
+    route_code,
+    flow_key: fk,
+    path_code,
+  };
+
+  // metrics
+  bumpPath(path_code);
+  if (meta.skip_eval) METRICS.skipEvalCount++;
+  if (meta.useful_code === "U1") METRICS.usefulCountU1++;
+  if (meta.useful_code === "U0") METRICS.usefulCountU0++;
+
+  // merge into data (minimal diff; keep old fields intact)
+  if (data && typeof data === "object" && !Array.isArray(data)) {
+    return { ...data, ...meta };
+  }
+  return { message: String(data || ""), ...meta };
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
+    "قدّم معلومات صحية عامة بأسلوب عربي واضح ومباشر (بدون تبرؤ طويل كبداية).\n" +
+    "إذا طُلِب تشخيص صريح/خطة علاج/وصف أدوية أو جرعات: ارفض بلطف ثم قدّم بدائل مفيدة (نصائح نمط حياة/أسئلة توضيحية/متى يراجع الطبيب).\n" +
+    "في الحالات العادية: أجب مباشرة وبشكل عملي.\n" +
+    "اذكر مراجعة الطبيب/الطوارئ فقط عند وجود مؤشرات تستدعي ذلك.\n" +
+    "ممنوع: تشخيص مؤكد، وصف أدوية، جرعات، أو خطة علاج.\n" +
+    "إذا لم تكن متأكدًا، قل: لا أعلم.\n" +
+    "التزم بسؤال المستخدم وبيانات التخصيص فقط.\n" +
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
+    "اكتب بطريقة مبسطة جدًا وتجنب المصطلحات الطبية المعقدة، واشرح أي مصطلح ضروري بكلمات سهلة.\n" +
+    "قسّم الشرح داخل verdict/tips إلى أقسام واضحة بعنوان:\n" +
+    "- ملخص بسيط\n" +
+    "- ما الذي يعنيه غالبًا\n" +
+    "- نصائح عامة\n" +
+    "- متى تراجع الطبيب\n" +
+    "ممنوع: تشخيص مؤكد، جرعات، وصف علاج.\n" +
+    "أخرج JSON فقط بنفس مفاتيح البطاقة.\n"
   );
 }
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
+        "ما أقدر أوصف أدوية أو جرعات أو أعطي قرار علاجي.\n" +
+        "أقدر أساعدك بخيارات آمنة: فهم الحالة بشكل عام + خطوات نمط حياة + متى تراجع الطبيب.",
       tips: [
-        "اكتب للطبيب الأعراض ومدة المشكلة والأدوية الحالية إن وجدت.",
-        "إذا أعراض شديدة: طوارئ.",
+        "لو تقدر: اكتب عمرك، الأعراض ومدتها، وهل لديك أمراض مزمنة أو أدوية حالية/حساسية.",
+        "لألم/حمّى خفيفة: راحة، سوائل، وراقب التحسن خلال 24–48 ساعة (بدون أدوية/جرعات هنا).",
+        "إذا المشكلة مزمنة أو تتكرر: احجز موعدًا لتقييم السبب بدل الاكتفاء بالمسكنات.",
+        "اطلب رعاية عاجلة إذا ظهرت علامات خطورة (ألم صدر/ضيق نفس/إغماء/نزيف شديد/ضعف مفاجئ).",
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
+    const data = attachEvalMeta({
+      route_code: "CHAT",
+      flow_key: "general",
+      path_code: "FLOW_START",
+      data: card,
+      isStatic: false,
+    });
+    return res.json({ ok: true, data });
   }
 
   // طوارئ: نزيد العدّاد ونرجع بطاقة واضحة
   if (isEmergencyText(message)) {
     METRICS.emergencyTriggers++;
     const card = makeCard({
       title: "⚠️ تنبيه طارئ",
       category: "emergency",
       verdict:
         "الأعراض المذكورة قد تكون خطيرة.\n" +
         "يُنصح بالتوجه لأقرب طوارئ أو الاتصال بالإسعاف فورًا.",
       tips: ["لا تنتظر.", "إذا معك شخص، اطلب مساعدته فورًا."],
       when_to_seek_help: "الآن.",
       next_question: "هل أنت في أمان الآن؟",
       quick_choices: ["نعم", "لا"],
     });
     session.lastCard = card;
     bumpCategory("emergency");
     METRICS.chatOk++;
     updateAvgLatency(Date.now() - t0);
-    return res.json({ ok: true, data: card });
+    const data = attachEvalMeta({
+      route_code: "CHAT",
+      flow_key: "emergency",
+      path_code: "EMERGENCY",
+      data: card,
+      isStatic: false,
+    });
+    return res.json({ ok: true, data });
   }
 
   // مواعيد شفاء (ثابت)
   if (looksLikeAppointments(message)) {
     const card = appointmentsCard();
     session.lastCard = card;
     bumpCategory("appointments");
     METRICS.chatOk++;
     updateAvgLatency(Date.now() - t0);
-    return res.json({ ok: true, data: card });
+    const data = attachEvalMeta({
+      route_code: "CHAT",
+      flow_key: "appointments",
+      path_code: "STATIC_APPOINTMENTS",
+      data: card,
+      isStatic: true,
+    });
+    return res.json({ ok: true, data });
   }
 
   // إذا المستخدم كتب "افهم تقريرك" -> نوجّه للمرفق (الواجهة سترفع PDF/صورة)
-  if (/افهم\s*تقريرك|تقرير|تحاليل/i.test(message) && message.length <= 30) {
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
+  if (
+    /(افهم\s*تقريرك|افهم\s*التقرير|شرح\s*تقرير|فسر\s*تقرير|قراءة\s*تقرير)/i.test(message) &&
+    message.length <= 30
+  ) {
+    const gate = {
+      message: "ارفق ملف PDF/صورة للتقرير عبر زر 📎 ثم أشرح لك بلغة مبسطة.",
+    };
+    const data = attachEvalMeta({
+      route_code: "CHAT",
+      flow_key: "report",
+      path_code: "REPORT_UPLOAD_GATE",
+      data: gate,
+      isStatic: true,
+    });
+    session.lastCard = gate;
     bumpCategory("report");
     METRICS.chatOk++;
     updateAvgLatency(Date.now() - t0);
-    return res.json({ ok: true, data: card });
+    return res.json({ ok: true, data });
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
+      const data = attachEvalMeta({
+        route_code: "CHAT",
+        flow_key: matched.key,
+        path_code: "FLOW_START",
+        data: card,
+      });
+      return res.json({ ok: true, data });
     }
 
     // fallback: infer category auto-start if message is short
     if (short && ["sugar", "bp", "bmi", "water", "calories", "mental", "first_aid"].includes(inferred)) {
       const card = startFlow(session, inferred);
       session.lastCard = card;
       METRICS.chatOk++;
       updateAvgLatency(Date.now() - t0);
-      return res.json({ ok: true, data: card });
+      const data = attachEvalMeta({
+        route_code: "CHAT",
+        flow_key: inferred,
+        path_code: "FLOW_START",
+        data: card,
+      });
+      return res.json({ ok: true, data });
     }
   }
@@
   if (session.flow && session.step > 0 && session.step < 4) {
     const card = continueFlow(session, message);
     if (card) {
       session.lastCard = card;
       METRICS.chatOk++;
       updateAvgLatency(Date.now() - t0);
-      return res.json({ ok: true, data: card });
+      const data = attachEvalMeta({
+        route_code: "CHAT",
+        flow_key: session.flow,
+        path_code: "FLOW_STEP",
+        data: card,
+      });
+      return res.json({ ok: true, data });
     }
     // إذا رجع null معناها step=4 وجاهزين للتوليد
   }
@@
   const userPrompt =
     (profileStr ? `بيانات تخصيص (اختيارات المستخدم):\n${profileStr}\n\n` : "") +
     (last ? `سياق آخر رد (استخدمه فقط إذا مرتبط):\n${lastStr}\n\n` : "") +
     `سؤال المستخدم:\n${msgStr}\n\n` +
-    "الالتزام: لا تشخيص، لا أدوية، لا جرعات.\n" +
-    "قدّم نصائح عامة عملية + متى يراجع الطبيب/الطوارئ.\n";
+    "الالتزام: لا تشخيص مؤكد، لا أدوية، لا جرعات.\n" +
+    "قدّم إجابة عملية مباشرة. اذكر مراجعة الطبيب/الطوارئ فقط عند الحاجة.\n";
 
   try {
     const obj = await callGroqJSON({
       system: chatSystemPrompt(),
       user: userPrompt,
       maxTokens: 1200,
     });
@@
 
     const card = makeCard({ ...obj, category: finalCategory });
-    const safeCard = postFilterCard(card);
+    const safeCard = postFilterCard(card);
 
     session.lastCard = safeCard;
     session.history.push({ role: "assistant", content: JSON.stringify(safeCard) });
     session.history = trimHistory(session.history, 10);
 
     bumpCategory(safeCard.category);
     METRICS.chatOk++;
     updateAvgLatency(Date.now() - t0);
 
-    return res.json({ ok: true, data: safeCard });
+    const isRefusal = safeCard?.title === "تنبيه" && isTherapeuticOrDrugRequest(message);
+    const path_code = isRefusal ? "SAFETY_REFUSAL" : "LLM";
+    // If it's a refusal-only style, mark skip_eval=true (handled by helper)
+    // useful_code: keep U1 if we added helpful alternatives, otherwise U0
+    const forceU0 = path_code === "SAFETY_REFUSAL" && (!Array.isArray(safeCard?.tips) || safeCard.tips.length < 3);
+    const data = attachEvalMeta({
+      route_code: "CHAT",
+      flow_key: forcedCategory || session.flow || inferred || "general",
+      path_code,
+      data: safeCard,
+      forceU0,
+      isRefusal: path_code === "SAFETY_REFUSAL",
+    });
+    return res.json({ ok: true, data });
   } catch (err) {
     console.error("[chat] FAILED:", err?.message || err);
     METRICS.chatFail++;
     updateAvgLatency(Date.now() - t0);
-    return res.status(502).json({ ok: false, error: "model_error" });
+    const data = attachEvalMeta({
+      route_code: "CHAT",
+      flow_key: inferred || session.flow || "general",
+      path_code: "ERROR_MODEL",
+      data: { message: "تعذر الرد الآن بسبب خطأ في النموذج." },
+      isError: true,
+    });
+    return res.status(502).json({ ok: false, error: "model_error", data });
   }
 });
 
 app.post("/report", upload.single("file"), async (req, res) => {
   const t0 = Date.now();
   METRICS.reportRequests++;
@@
   const file = req.file;
   if (!file) return res.status(400).json({ ok: false, error: "missing_file" });
 
   try {
     let extracted = "";
@@
       if (extracted.length < 40) {
         METRICS.reportFail++;
         updateAvgLatency(Date.now() - t0);
-        return res.json({
+        const data = attachEvalMeta({
+          route_code: "REPORT",
+          flow_key: "report",
+          path_code: "ERROR_MODEL",
+          data: {
+            message:
+              "هذا PDF يبدو ممسوح (Scan) ولا يحتوي نصًا قابلًا للنسخ. ارفع صورة واضحة للتقرير أو الصق النص.",
+          },
+          isError: true,
+        });
+        return res.json({
           ok: false,
           error: "pdf_no_text",
-          message:
-            "هذا PDF يبدو ممسوح (Scan) ولا يحتوي نصًا قابلًا للنسخ. ارفع صورة واضحة للتقرير أو الصق النص.",
+          message:
+            "هذا PDF يبدو ممسوح (Scan) ولا يحتوي نصًا قابلًا للنسخ. ارفع صورة واضحة للتقرير أو الصق النص.",
+          data,
         });
       }
     } else if (file.mimetype.startsWith("image/")) {
       extracted = await ocrImageBuffer(file.buffer);
       extracted = extracted.replace(/\s+/g, " ").trim();
 
       if (extracted.length < 25) {
         METRICS.reportFail++;
         updateAvgLatency(Date.now() - t0);
-        return res.json({
+        const data = attachEvalMeta({
+          route_code: "REPORT",
+          flow_key: "report",
+          path_code: "ERROR_MODEL",
+          data: { message: "الصورة لم تُقرأ بوضوح. حاول صورة أوضح." },
+          isError: true,
+        });
+        return res.json({
           ok: false,
           error: "ocr_failed",
-          message: "الصورة لم تُقرأ بوضوح. حاول صورة أوضح.",
+          message: "الصورة لم تُقرأ بوضوح. حاول صورة أوضح.",
+          data,
         });
       }
     } else {
       METRICS.reportFail++;
       updateAvgLatency(Date.now() - t0);
       return res.status(400).json({ ok: false, error: "unsupported_type" });
     }
@@
     const userPrompt =
       "نص مستخرج من تقرير/تحاليل:\n" +
       extractedClamped +
       "\n\n" +
-      "اشرح بالعربية بشكل عام: ماذا يعني + نصائح عامة + متى يراجع الطبيب.\n" +
+      "اشرح بالعربية للمواطن غير المختص وبأقسام واضحة: ملخص بسيط / ما الذي يعنيه غالبًا / نصائح عامة / متى تراجع الطبيب.\n" +
       "التزم بما ورد في التقرير فقط.\n" +
       "ممنوع تشخيص مؤكد أو جرعات أو وصف علاج.";
 
     const obj = await callGroqJSON({
       system: reportSystemPrompt(),
       user: userPrompt,
       maxTokens: 1600,
     });
 
     const card = postFilterCard(makeCard({ ...obj, category: "report" }));
     session.lastCard = card;
 
     bumpCategory("report");
     METRICS.reportOk++;
     updateAvgLatency(Date.now() - t0);
 
-    return res.json({ ok: true, data: card });
+    const data = attachEvalMeta({
+      route_code: "REPORT",
+      flow_key: "report",
+      path_code: "LLM",
+      data: card,
+      isRefusal: card?.title === "تنبيه",
+      forceU0: card?.title === "تنبيه" && (!Array.isArray(card?.tips) || card.tips.length < 3),
+    });
+    return res.json({ ok: true, data });
   } catch (err) {
     console.error("[report] FAILED:", err?.message || err);
     METRICS.reportFail++;
     updateAvgLatency(Date.now() - t0);
-    return res.status(502).json({
+    const data = attachEvalMeta({
+      route_code: "REPORT",
+      flow_key: "report",
+      path_code: "ERROR_MODEL",
+      data: { message: "تعذر تحليل التقرير الآن. جرّب صورة أوضح أو الصق النص." },
+      isError: true,
+    });
+    return res.status(502).json({
       ok: false,
       error: "report_error",
       message: "تعذر تحليل التقرير الآن. جرّب صورة أوضح أو الصق النص.",
+      data,
     });
   }
 });
*** End Patch
