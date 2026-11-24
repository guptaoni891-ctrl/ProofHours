// Arabic, right to left (Stage 6): the app shell (navigation, top bar, page titles) and the Verify page.
// Other screens stay in English for now. Layout mirrors through CSS logical properties.
// shortcut: translations written in-house; have a native Arabic speaker review them before public use.
(() => {
  const AR = {
    "nav.overview": "الرئيسية", "nav.verify": "التحقق من سجل", "nav.opps": "الفرص التطوعية", "nav.reports": "تقارير الأثر", "nav.impact": "أثري",
    "nav.passport": "جوازي التطوعي", "nav.checkin": "تسجيل حضور المناوبة", "nav.coord": "المنسّق", "nav.admin": "الإدارة", "nav.issue2": "إصدار الساعات",
    "nav.attend": "الحضور", "nav.audit": "التدقيق", "nav.demo": "قواعد العقد", "nav.network": "حالة الشبكة",
    "label.public": "عام", "label.workspaces": "مساحات العمل", "label.system": "النظام",
    "top.search": "بحث", "top.connect": "ربط المحفظة", "foot.testnet": "شبكة اختبار · بيانات تجريبية وهمية",
    "title.overview": "الرئيسية", "title.verify": "التحقق من سجل", "title.opps": "الفرص التطوعية", "title.reports": "تقارير الأثر", "title.impact": "أثري",
    "title.passport": "جوازي التطوعي", "title.checkin": "تسجيل حضور المناوبة", "title.coord": "المنسّق", "title.admin": "الإدارة", "title.issue2": "إصدار الساعات",
    "title.attend": "الحضور", "title.audit": "التدقيق", "title.demo": "قواعد العقد", "title.network": "حالة الشبكة",
    "verify.h2": "التحقق من سجل",
    "verify.lead": "تأكّد من أن ساعات الطالب سجّلتها منظمة غير ربحية معتمدة، واطّلع على كل تعديل منذ ذلك الحين. لا حاجة إلى محفظة أو حساب.",
    "verify.h3": "البحث عن سجل", "verify.demo": "جرّب طالبًا تجريبيًا", "verify.id": "رقم الطالب", "verify.salt": "الملح السري",
    "verify.saltHelp": "تبدأ بـ 0x وتليها 64 خانة ست عشرية. يحتفظ بها الطالب سرًّا.",
    "verify.claimed": "الساعات التي يدّعيها الطالب <em>اختياري</em>", "verify.button": "تحقّق على السلسلة",
    "verify.privacy": "تُحسب البصمة في متصفحك. يُبحث عن البصمة فقط؛ ولا يغادر رقم الطالب والملح هذه الصفحة.",
    "verify.emptyH": "تظهر النتائج هنا", "verify.emptyP": "اختر طالبًا تجريبيًا أو أدخل رقمًا وملحًا. سترى الحكم، والمنظمة المُصدِرة، والسجل الكامل على السلسلة.",
  };
  const KEY = "proofhours-lang";
  function apply(lang) {
    const ar = lang === "ar";
    document.documentElement.lang = ar ? "ar" : "en";
    document.documentElement.dir = ar ? "rtl" : "ltr";
    for (const el of document.querySelectorAll("[data-i18n]")) {
      if (!("en" in el.dataset)) el.dataset.en = el.innerHTML; // our own markup, restored when switching back
      el.innerHTML = ar && AR[el.dataset.i18n] ? AR[el.dataset.i18n] : el.dataset.en;
    }
    for (const s of document.querySelectorAll(".page[data-title]")) {
      s.dataset.titleEn ??= s.dataset.title;
      s.dataset.title = ar && AR["title." + s.id] ? AR["title." + s.id] : s.dataset.titleEn;
    }
    const cur = document.querySelector(".page:not([hidden])");
    if (cur) $("pageTitle").textContent = cur.dataset.title;
    $("langBtn").textContent = ar ? "English" : "عربي";
    $("langBtn").lang = ar ? "en" : "ar";
    localStorage.setItem(KEY, ar ? "ar" : "en");
  }
  $("langBtn").onclick = () => apply(document.documentElement.lang === "ar" ? "en" : "ar");
  if (localStorage.getItem(KEY) === "ar") apply("ar");
})();
