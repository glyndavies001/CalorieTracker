/* Vitals (formerly CalorieTracker) — foods, dishes built from those foods, a daily diary with
   calories and macros, and body weight. Plain JavaScript with no build step.
   Data lives in Supabase (the ct_* tables). Foods and dishes are one list shared
   by the household; diary, weights and settings are private to each login.
   Barcodes are looked up in the household's foods first, then Open Food Facts. */
(function () {
  "use strict";

  const APP_VERSION = "2.1.0";
  const SUPABASE_URL = "https://yfbarahnwcrwewtpithb.supabase.co";
  const SUPABASE_KEY = "sb_publishable_ItUAbr04KIijWuO-JWgDNg_J5YCwaqK";
  const DIARY_DAYS = 120;   // diary history loaded up front; older days load when opened
  const OFF_URL = "https://world.openfoodfacts.org/api/v2/product/";   // free, open product database
  const OFF_FIELDS = "product_name,product_name_en,generic_name,brands,quantity,product_quantity,product_quantity_unit,serving_quantity,nutriments";

  const MEALS = [["breakfast", "Breakfast"], ["lunch", "Lunch"], ["dinner", "Dinner"], ["snacks", "Snacks"]];
  const mealName = k => (MEALS.find(m => m[0] === k) || [k, k])[1];

  // ── Nutrition maths ────────────────────────────────────────────────────────
  const zero = () => ({ kcal: 0, protein: 0, carbs: 0, fat: 0 });
  const addN = (a, b) => ({ kcal: a.kcal + (+b.kcal || 0), protein: a.protein + (+b.protein || 0), carbs: a.carbs + (+b.carbs || 0), fat: a.fat + (+b.fat || 0) });
  const scaleN = (a, f) => ({ kcal: (+a.kcal || 0) * f, protein: (+a.protein || 0) * f, carbs: (+a.carbs || 0) * f, fat: (+a.fat || 0) * f });
  const round1 = n => Math.round((+n || 0) * 10) / 10;
  const roundN = a => ({ kcal: round1(a.kcal), protein: round1(a.protein), carbs: round1(a.carbs), fat: round1(a.fat) });
  const sumN = list => list.reduce((a, e) => addN(a, e), zero());

  // Foods keep their values per 100 g / 100 ml, or per single item.
  const basisOf = unit => (unit === "item" ? 1 : 100);
  const foodFor = (food, amount) => scaleN(food, (+amount || 0) / basisOf(food.unit));
  // Label values for `basisAmount` (e.g. a 30 g serving) -> the stored per-100 / per-item values.
  function toStored(unit, basisAmount, values) {
    const b = +basisAmount;
    if (!(b > 0)) return null;
    return roundN(scaleN(values, basisOf(unit) / b));
  }
  // A dish is the sum of its ingredients, live from the foods list.
  function dishTotals(dish, foodsById) {
    let t = zero(), grams = 0, missing = 0;
    for (const it of dish.items || []) {
      const f = foodsById[it.food_id];
      if (!f) { missing++; continue; }
      const amt = +it.amount || 0;
      t = addN(t, foodFor(f, amt));
      if (f.unit !== "item") grams += amt;
    }
    return { ...t, grams, missing };
  }
  // Eaten by portion, or by weight once the cooked dish has been weighed.
  function dishFor(dish, foodsById, amount, unit) {
    const t = dishTotals(dish, foodsById);
    const amt = +amount || 0;
    if (unit === "g") return dish.cooked_grams ? scaleN(t, amt / +dish.cooked_grams) : zero();
    return scaleN(t, amt / (+dish.portions || 1));
  }

  // ── Weight ─────────────────────────────────────────────────────────────────
  const KG_PER_LB = 0.45359237;
  function kgToStLb(kg) {
    const total = (+kg || 0) / KG_PER_LB;
    let st = Math.floor(total / 14);
    let lb = Math.round((total - st * 14) * 10) / 10;
    if (lb >= 14) { st += 1; lb = 0; }
    return { st, lb };
  }
  const stLbToKg = (st, lb) => ((+st || 0) * 14 + (+lb || 0)) * KG_PER_LB;
  function fmtWeight(kg, unit) {
    if (unit === "stlb") { const { st, lb } = kgToStLb(kg); return `${st} st ${Math.round(lb * 10) / 10} lb`; }
    return `${(+kg).toFixed(1)} kg`;
  }
  function fmtDelta(kg, unit) {
    const v = unit === "stlb" ? kg / KG_PER_LB : kg;
    const sign = Math.abs(v) < 0.05 ? "±" : v < 0 ? "−" : "+";
    return `${sign}${Math.abs(v).toFixed(1)} ${unit === "stlb" ? "lb" : "kg"}`;
  }

  // ── Dates (local, never UTC) ──────────────────────────────────────────────
  const isoDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const parseIso = iso => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d); };
  const addDays = (iso, n) => { const d = parseIso(iso); d.setDate(d.getDate() + n); return isoDay(d); };
  function dayLabel(iso) {
    const t = isoDay();
    if (iso === t) return "Today";
    if (iso === addDays(t, -1)) return "Yesterday";
    if (iso === addDays(t, 1)) return "Tomorrow";
    return parseIso(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  }
  const longDate = iso => parseIso(iso).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const shortDate = iso => parseIso(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  // Months as "YYYY-MM".
  const daysIn = ym => { const [y, m] = ym.split("-").map(Number); return new Date(y, m, 0).getDate(); };
  const addMonths = (ym, n) => { const [y, m] = ym.split("-").map(Number); const d = new Date(y, m - 1 + n, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
  const monthLabel = ym => { const [y, m] = ym.split("-").map(Number); return new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" }); };

  // Every day of a month with its totals, and averages over the finished days that were logged
  // (today is still going, and a day with nothing logged would only drag the average down).
  // `burn` (day -> kcal burned, from the Fitbit) adds burned and deficit (burned - eaten);
  // `steps` (day -> steps) adds the average and how many days reached `stepGoal`.
  function monthStats(diary, ym, target, today, burn, steps, stepGoal) {
    const byDay = new Map();
    for (const e of diary) if (e.day && e.day.slice(0, 7) === ym) { const l = byDay.get(e.day); if (l) l.push(e); else byDay.set(e.day, [e]); }
    const days = [];
    for (let d = 1; d <= daysIn(ym); d++) {
      const iso = `${ym}-${String(d).padStart(2, "0")}`;
      const list = byDay.get(iso) || [];
      const b = burn && burn.has(iso) ? +burn.get(iso) : null;
      const s = steps && steps.has(iso) ? +steps.get(iso) : null;
      days.push({ day: iso, n: list.length, ...sumN(list), burned: b, steps: s, today: iso === today, future: iso > today });
    }
    const done = days.filter(x => x.n && x.day < today);
    const under = target ? done.filter(x => Math.round(x.kcal) <= target).length : 0;
    const burnt = days.filter(x => x.burned != null && x.day < today);
    const both = done.filter(x => x.burned != null);
    const deficit = both.reduce((s, x) => s + (Math.round(x.burned) - Math.round(x.kcal)), 0);
    const walked = days.filter(x => x.steps != null && x.day < today);
    return { days, done: done.length, logged: days.filter(x => x.n).length,
      avg: done.length ? scaleN(sumN(done), 1 / done.length) : null, under, over: target ? done.length - under : 0,
      avgBurn: burnt.length ? burnt.reduce((s, x) => s + x.burned, 0) / burnt.length : null,
      defDays: both.length, avgDeficit: both.length ? deficit / both.length : null, deficit,
      stepDays: walked.length, avgSteps: walked.length ? walked.reduce((s, x) => s + x.steps, 0) / walked.length : null,
      goalDays: walked.filter(x => x.steps >= (stepGoal || 10000)).length };
  }

  // ── Formatting ─────────────────────────────────────────────────────────────
  const fmtK = n => Math.round(+n || 0).toLocaleString("en-GB");
  const fmtG = n => { const v = +n || 0; return (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10) + "g"; };
  const fmtAmt = n => String(Math.round((+n || 0) * 100) / 100);
  const num = v => { const n = parseFloat(String(v == null ? "" : v).replace(",", ".")); return isFinite(n) ? n : NaN; };
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const basisText = unit => (unit === "item" ? "item" : `100 ${unit}`);
  const unitWord = (unit, n) => (unit === "portion" ? (n === 1 ? "portion" : "portions") : unit === "item" ? (n === 1 ? "item" : "items") : unit);
  const amountText = (amt, unit) => `${fmtAmt(amt)} ${unitWord(unit, +amt)}`;
  const macroLine = n => `<span class="p"><b>P</b> ${fmtG(n.protein)}</span> · <span class="c"><b>C</b> ${fmtG(n.carbs)}</span> · <span class="f"><b>F</b> ${fmtG(n.fat)}</span>`;
  const byName = list => [...list].sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));

  // ── Barcodes ──────────────────────────────────────────────────────────────
  // Digits only; a 12-digit UPC-A is kept as the same code's 13-digit EAN form.
  function normCode(raw) {
    const c = String(raw == null ? "" : raw).replace(/\D/g, "");
    return c.length === 12 ? "0" + c : c;
  }
  // EAN-8 / EAN-13 / GTIN-14 check digit.
  function validCode(c) {
    if (!/^(\d{8}|\d{13}|\d{14})$/.test(c)) return false;
    const d = c.split("").map(Number);
    const check = d.pop();
    const sum = d.reverse().reduce((s, n, i) => s + n * (i % 2 === 0 ? 3 : 1), 0);
    return (10 - (sum % 10)) % 10 === check;
  }
  // An Open Food Facts product -> what the food form needs (values per 100 g / 100 ml).
  function offToFood(p) {
    const n = (p && p.nutriments) || {};
    const val = k => { const v = parseFloat(n[k]); return isFinite(v) && v >= 0 ? v : null; };
    let kcal = val("energy-kcal_100g");
    if (kcal == null) { const kj = val("energy-kj_100g") != null ? val("energy-kj_100g") : val("energy_100g"); if (kj != null) kcal = kj / 4.184; }
    const brand = String((p && p.brands) || "").split(",")[0].trim();
    let name = String((p && (p.product_name_en || p.product_name || p.generic_name)) || "").replace(/\s+/g, " ").trim();
    if (brand && !name.toLowerCase().includes(brand.toLowerCase())) name = (brand + " " + name).trim();
    const unit = /^(ml|cl|l)$/i.test(String((p && p.product_quantity_unit) || "")) || /\d\s*(ml|cl|l|litres?|liters?)\b/i.test(String((p && p.quantity) || "")) ? "ml" : "g";
    const vals = kcal == null ? null
      : { kcal: round1(kcal), protein: round1(val("proteins_100g") || 0), carbs: round1(val("carbohydrates_100g") || 0), fat: round1(val("fat_100g") || 0) };
    // A pack that is exactly one serving (a pot, a bar, a noodle pack) makes a natural fixed portion.
    const pack = parseFloat(p && p.product_quantity), serving = parseFloat(p && p.serving_quantity);
    const fixed = pack > 0 && serving > 0 && Math.abs(pack - serving) < 0.5 ? round1(pack) : null;
    return { name: name.slice(0, 80), unit, vals, fixed };
  }

  // Exposed for tests.
  window.CT = { zero, addN, scaleN, sumN, basisOf, foodFor, toStored, dishTotals, dishFor, kgToStLb, stLbToKg, fmtWeight, fmtDelta, isoDay, addDays, dayLabel, esc, normCode, validCode, offToFood,
    daysIn, addMonths, monthStats, APP_VERSION };

  // Small per-device preferences, such as list order. Storage can be unavailable, so nothing depends on it.
  const pref = {
    get(k, d) { try { return window.localStorage.getItem("ct." + k) || d; } catch (e) { return d; } },
    set(k, v) { try { window.localStorage.setItem("ct." + k, v); } catch (e) { /* not saved on this device */ } },
  };

  // ── State ─────────────────────────────────────────────────────────────────
  const S = { user: null, loading: true, view: "home", lib: pref.get("lib", "foods") === "dishes" ? "dishes" : "foods", day: isoDay(), foods: [], dishes: [], diary: [], diaryFrom: null, weights: [], settings: {}, foodQuery: "",
    burn: new Map(), steps: new Map(), push: { checked: false },   // from the Fitbit: day -> kcal burned, day -> steps
    health: { page: null, live: null, sleep: null, heart: null, shown: null, cheer: null, nightSel: null, hrSel: null, restSel: null },
    sort: pref.get("sort", "az") === "used" ? "used" : "az",
    mode: "day", month: isoDay().slice(0, 7), mSel: null, mLoading: false };   // Food tab: one day, or a month at a time
  const foodsById = () => Object.fromEntries(S.foods.map(f => [f.id, f]));
  const STEP_GOAL = 10000;
  const stepGoal = () => (+S.settings.step_goal > 0 ? +S.settings.step_goal : STEP_GOAL);
  const remindHour = () => (S.settings.remind_hour != null ? +S.settings.remind_hour : 20);
  const hourText = h => (h === 0 ? "midnight" : h === 12 ? "noon" : h < 12 ? `${h}am` : `${h - 12}pm`);
  let sb = null;
  let ctx = null;   // what the open sheet is doing

  const $app = document.getElementById("app");
  const $sheet = document.getElementById("sheet");
  const $toast = document.getElementById("toast");

  // The on-screen keyboard covers the bottom of the screen without resizing the page,
  // so sheets and toasts follow the part that's still visible (see .veil and .toast).
  (function followKeyboard() {
    const vv = window.visualViewport;
    if (!vv) return;
    const css = document.documentElement.style;
    const fit = () => {
      css.setProperty("--vv-top", vv.offsetTop + "px");
      css.setProperty("--vv-h", vv.height + "px");
      css.setProperty("--kb", Math.max(0, window.innerHeight - vv.height - vv.offsetTop) + "px");
    };
    vv.addEventListener("resize", fit);
    vv.addEventListener("scroll", fit);
    fit();
  })();

  // ── Data ──────────────────────────────────────────────────────────────────
  const isNet = e => /failed to fetch|networkerror|load failed|network request failed/i.test((e && (e.message || String(e))) || "");
  // Run a query, retrying once after a dropped connection (e.g. the phone waking up).
  async function run(make) {
    let res = await make();
    if (res.error && isNet(res.error)) { await new Promise(r => setTimeout(r, 1200)); res = await make(); }
    if (res.error) throw res.error;
    return res.data;
  }
  const errText = e => (e && e.plain ? e.message : isNet(e) ? "No connection — try again." : "Couldn't save: " + ((e && e.message) || e));
  const oops = msg => Object.assign(new Error(msg), { plain: true });   // shown as it is

  async function loadAll() {
    const from = addDays(isoDay(), -DIARY_DAYS);
    const [foods, dishes, settings, weights, diary, burn] = await Promise.all([
      run(() => sb.from("ct_foods").select("*")),
      run(() => sb.from("ct_dishes").select("*")),
      run(() => sb.from("ct_settings").select("*").maybeSingle()),
      run(() => sb.from("ct_weights").select("*").order("day")),
      run(() => sb.from("ct_diary").select("*").gte("day", from).order("created_at")),
      run(() => sb.from("ct_burn").select("day,kcal,steps").gte("day", from)),
    ]);
    S.foods = foods || [];
    S.dishes = dishes || [];
    S.settings = settings || {};
    S.weights = weights || [];
    S.diary = diary || [];
    S.burn = new Map(); S.steps = new Map(); takeBurn(burn);
    S.diaryFrom = from;
  }
  // Rows from ct_burn (or the server's sync): either number can be missing for a day.
  function takeBurn(rows) {
    for (const b of rows || []) {
      if (b.kcal != null) S.burn.set(b.day, +b.kcal);
      if (b.steps != null) S.steps.set(b.day, +b.steps);
    }
  }
  const fitSig = () => JSON.stringify([S.settings.fit_status, [...S.burn], [...S.steps]]);

  // Calories burned and steps come from the Fitbit (Google Health) through the "fitbit" server
  // function: the last two weeks each time (a late watch sync can change earlier days), when the
  // app opens or comes back, and every couple of minutes while it's open.
  const SYNC_EVERY = 2 * 60 * 1000, FULL_EVERY = 30 * 60 * 1000;   // the whole two weeks: on opening, then every half hour
  let lastBurnSync = 0, lastFullSync = 0, burnSyncing = false;
  async function syncBurn(force) {
    if (!S.user || S.settings.fit_status !== "linked" || burnSyncing) return;
    if (!force && Date.now() - lastBurnSync < SYNC_EVERY) return;
    burnSyncing = true;
    try {
      const today = isoDay(), full = Date.now() - lastFullSync > FULL_EVERY;
      const { data, error } = await sb.functions.invoke("fitbit", { body: { action: "sync", today, from: addDays(today, full ? -13 : -1) } });
      if (error) throw error;
      lastBurnSync = Date.now();
      if (full) lastFullSync = lastBurnSync;
      const before = fitSig();
      if (data && data.reconnect) S.settings.fit_status = "reauth";
      else if (data && data.linked === false) S.settings.fit_status = null;
      takeBurn(data && data.days);
      if (data && data.syncedAt) S.settings.fit_synced_at = data.syncedAt;
      if (ctx || !S.user || S.health.page || (S.view !== "today" && S.view !== "home")) return;   // redrawn when you get there
      if (fitSig() !== before) render();
      else { const at = document.getElementById("fitAt"); if (at) at.textContent = syncedText(); }   // just the time
    } catch (e) { console.error(e); /* offline or Google hiccup: keep what we have */ }
    finally { burnSyncing = false; }
  }
  async function fitCall(action) {
    const { data, error } = await sb.functions.invoke("fitbit", { body: { action } });
    if (error) throw oops("The Fitbit link isn't responding — try again in a minute.");
    return data || {};
  }
  // Days older than the preloaded window are fetched when opened.
  async function ensureDay(day) {
    if (S.diaryFrom && day >= S.diaryFrom) return;
    const rows = await run(() => sb.from("ct_diary").select("*").eq("day", day).order("created_at"));
    S.diary = S.diary.filter(e => e.day !== day).concat(rows || []);
  }
  const loadedMonths = new Set();
  async function ensureMonth(ym) {
    const from = ym + "-01", to = `${ym}-${String(daysIn(ym)).padStart(2, "0")}`;
    if ((S.diaryFrom && from >= S.diaryFrom) || loadedMonths.has(ym)) return;
    const [rows, burn] = await Promise.all([
      run(() => sb.from("ct_diary").select("*").gte("day", from).lte("day", to).order("created_at")),
      run(() => sb.from("ct_burn").select("day,kcal,steps").gte("day", from).lte("day", to)),
    ]);
    S.diary = S.diary.filter(e => e.day < from || e.day > to).concat(rows || []);
    takeBurn(burn);
    loadedMonths.add(ym);
  }
  // Month view: older months load when opened; the view stays up, faded, meanwhile.
  async function loadMonth() {
    const ym = S.month;
    if ((S.diaryFrom && ym + "-01" >= S.diaryFrom) || loadedMonths.has(ym)) return;
    S.mLoading = true; render();
    try { await ensureMonth(ym); }
    finally { S.mLoading = false; if (S.month === ym && S.view === "today") render(); }
  }

  // ── Rendering ─────────────────────────────────────────────────────────────
  let homeShown = "";   // Home as last drawn
  function render() {
    if (!S.user) return renderLogin();
    let body = `<div class="empty">Loading…</div>`;
    if (!S.loading) body = S.view === "foods" ? viewFoods() : S.view === "dishes" ? viewDishes() : S.view === "weight" ? viewWeight() : S.view === "today" ? viewToday() : (homeShown = viewHome());
    const tab = (k, ic, l, on) => `<button data-act="tab" data-v="${k}" class="${on ? "on" : ""}"><span class="ic">${ic}</span>${l}</button>`;
    $app.innerHTML = `<header class="top"><h1 class="brand">${MARK}<span>VITALS</span></h1>
        <button class="iconbtn" data-act="settings" aria-label="Settings">⚙️</button></header>
      <main>${body}</main>
      <nav class="tabs">${tab("home", "🏠", "Home", S.view === "home")}${tab("today", "🍽️", "Food", S.view === "today")}${tab("library", "🥕", "Library", S.view === "foods" || S.view === "dishes")}${tab("weight", "⚖️", "Weight", S.view === "weight")}</nav>`;
  }
  // Refreshes redraw Home only when something on it changed: a redraw mid-tap can lose the tap.
  function renderHome() {
    if (!S.user || S.loading || S.view !== "home" || ctx || S.health.page) return;
    if (viewHome() !== homeShown) render();
    tickLive();
  }
  // The Vitals mark: a pulse line, violet to pink.
  const MARK = `<svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="vg" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#8b7cff"/><stop offset="1" stop-color="#ff6fa8"/></linearGradient></defs><path d="M2 13h4.5l2.2-6 4.3 11 2.8-7.5 1.7 2.5H22" fill="none" stroke="url(#vg)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  function renderLogin() {
    $app.innerHTML = `<div class="login"><div class="box">
      <div class="login-mark">${MARK}</div>
      <h1>VITALS</h1>
      <p class="dim" style="text-align:center;font-size:13px;margin:6px 0 26px">Sign in with your Vaulted account</p>
      <input class="inp" id="email" type="email" autocomplete="username" placeholder="Email">
      <input class="inp" id="pw" type="password" autocomplete="current-password" placeholder="Password">
      <button class="btn primary block" data-act="signIn">Sign in</button>
      <div class="msg" id="loginMsg"></div>
      <div style="text-align:right"><button class="iconbtn" style="font-size:12px" data-act="forgot">Forgot password?</button></div>
    </div></div>`;
  }

  function macroBar(total, key, label, cls, color) {
    const tgt = +S.settings[key + "_target"] || 0;
    const v = total[key];
    const w = tgt ? Math.min(100, (v / tgt) * 100) : 0;
    return `<div class="macro"><div class="row"><span class="grow ${cls}" style="font-weight:700">${label}</span>
      <span class="muted">${fmtG(v)}${tgt ? ` <span class="faint">/ ${fmtG(tgt)}</span>` : ""}</span></div>
      <div class="bar"><div style="width:${w}%;background:${color}"></div></div></div>`;
  }

  const modeBar = () => `<div class="sortbar">${segHtml([["day", "Day"], ["month", "Month"]], S.mode, "mode")}</div>`
    + (S.settings.fit_status === "reauth" ? `<div class="card row" style="padding:10px 12px;border-color:#5a4a1a">
        <span class="grow small">Your Fitbit link has run out, so calories burned and steps have stopped updating.</span>
        <button class="btn blue sm" data-act="fitConnect">Reconnect</button></div>` : "");
  // Burned (from the Fitbit) and what that leaves: a deficit when you burned more than you ate.
  function burnLine(day, eaten, logged) {
    const b = S.burn.get(day);
    if (b == null) return "";
    const today = day === isoDay();
    const net = Math.round(b) - eaten;
    const verdict = today || !logged ? "" : net >= 0 ? `<span class="down">▼ Deficit ${fmtK(net)}</span>` : `<span class="up">▲ Surplus ${fmtK(-net)}</span>`;
    return `<div class="row small" style="margin-top:10px"><span class="grow muted">Burned${today ? " so far" : ""} <b style="color:var(--soft)">${fmtK(b)}</b> kcal</span>${verdict}</div>`;
  }
  // Steps (from the Fitbit) against the step goal.
  function stepsLine(day) {
    const s = S.steps.get(day);
    if (s == null) return "";
    const goal = stepGoal(), done = s >= goal;
    const open = day === isoDay() ? ` tap" data-act="hopen" data-p="steps" role="button" tabindex="0" aria-label="Steps: open the Steps page` : "";
    return `<div class="steps${open}"><div class="row small"><span class="grow muted">Steps <b style="color:var(--soft)">${fmtK(s)}</b> <span class="faint">/ ${fmtK(goal)}</span></span>
        ${done ? `<span class="down">✓ Goal reached</span>` : `<span class="muted">${fmtK(goal - s)} ${day === isoDay() ? "to go" : "short"}</span>`}</div>
      <div class="bar thin"><div style="width:${Math.min(100, (s / goal) * 100)}%;background:${done ? "var(--green)" : "var(--blue)"}"></div></div>
      ${day === isoDay() && S.settings.fit_synced_at ? `<div class="tiny faint" id="fitAt" style="text-align:right;margin-top:4px">${syncedText()}</div>` : ""}</div>`;
  }
  function viewToday() {
    if (S.mode === "month") return modeBar() + viewMonth();
    const entries = S.diary.filter(e => e.day === S.day);
    const tot = sumN(entries);
    const eaten = Math.round(tot.kcal);   // round once, so eaten + left always adds up to the target
    const target = +S.settings.kcal_target || 0;
    const over = target > 0 && eaten > target;
    const pct = target ? Math.min(100, (tot.kcal / target) * 100) : 0;
    let html = modeBar() + `<div class="daynav">
      <button data-act="day" data-n="-1" aria-label="Previous day">‹</button>
      <div class="when" data-act="goToday"><div class="big">${esc(dayLabel(S.day))}</div><div class="tiny dim">${esc(longDate(S.day))}</div></div>
      <button data-act="day" data-n="1" aria-label="Next day">›</button></div>`;
    html += `<div class="card">
      <div class="row" style="align-items:flex-end">
        <div class="grow"><div class="label">Eaten</div><div class="ring-num">${fmtK(eaten)} <span class="small dim" style="font-weight:600">kcal</span></div></div>
        ${target
          ? `<div style="text-align:right"><div class="label">${over ? "Over" : "Left"}</div>
             <div style="font-size:20px;font-weight:800;color:${over ? "var(--red)" : "var(--green)"}">${fmtK(Math.abs(target - eaten))}</div>
             <div class="tiny faint">of ${fmtK(target)}</div></div>`
          : `<button class="btn ghost" data-act="settings" style="padding:8px 10px;font-size:12px">Set daily targets</button>`}
      </div>
      ${target ? `<div class="bar" style="margin-top:10px;height:9px"><div style="width:${pct}%;background:${over ? "var(--red)" : "var(--green)"}"></div></div>` : ""}
      ${burnLine(S.day, eaten, entries.length > 0)}${stepsLine(S.day)}
      ${macroBar(tot, "protein", "Protein", "p", "var(--protein)")}${macroBar(tot, "carbs", "Carbs", "c", "var(--carbs)")}${macroBar(tot, "fat", "Fat", "f", "var(--fat)")}
    </div>`;
    for (const [k, label] of MEALS) {
      const list = entries.filter(e => e.meal === k);
      const mt = sumN(list);
      html += `<div class="list"><div class="head"><span style="font-weight:700;font-size:13px">${label}</span>
        <span class="row" style="gap:8px"><span class="small muted">${list.length ? fmtK(mt.kcal) + " kcal" : ""}</span>
        <button class="add" data-act="addEntry" data-meal="${k}">+ Add</button></span></div>
        ${list.map(e => `<div class="item tap" data-act="editEntry" data-id="${e.id}">
          <div class="grow"><div class="name ellip">${esc(e.name)}</div><div class="sub">${esc(amountText(e.amount, e.amount_unit))}${e.kind === "dish" ? " · dish" : ""}</div></div>
          <div style="text-align:right"><div class="kcal">${fmtK(e.kcal)}</div><div class="macros">${macroLine(e)}</div></div></div>`).join("")}
      </div>`;
    }
    return html;
  }

  // ── Month: calories each day against the target, and the month's averages ──
  // Over/under always has an arrow and words as well as colour.
  function vsTarget(kcal, target) {
    const d = Math.round(kcal) - target;
    if (d === 0) return `<span class="muted">on target</span>`;
    return d > 0 ? `<span class="up">▲ ${fmtK(d)} over</span>` : `<span class="down">▼ ${fmtK(-d)} under</span>`;
  }
  function viewMonth() {
    const target = +S.settings.kcal_target || 0;
    const today = isoDay();
    const st = monthStats(S.diary, S.month, target, today, S.burn, S.steps, stepGoal());
    const dim = S.mLoading ? ' style="opacity:.5"' : "";
    const last = S.month >= today.slice(0, 7);
    let html = `<div class="daynav">
      <button data-act="month" data-n="-1" aria-label="Previous month">‹</button>
      <div class="when"><div class="big">${esc(monthLabel(S.month))}</div><div class="tiny dim">${S.mLoading ? "Loading…" : st.logged ? `${st.logged} day${st.logged === 1 ? "" : "s"} logged` : "Nothing logged"}</div></div>
      <button data-act="month" data-n="1" aria-label="Next month"${last ? ' disabled style="opacity:.3"' : ""}>›</button></div>`;

    const a = st.avg;
    html += `<div class="card"${dim}>`;
    if (!a) html += `<div class="small muted">${st.logged ? "Averages start once a day is finished — today is still going." : "Nothing logged this month."}</div>`;
    else {
      html += `<div class="row" style="align-items:flex-end">
          <div class="grow"><div class="label">Average day</div><div class="ring-num">${fmtK(a.kcal)} <span class="small dim" style="font-weight:600">kcal</span></div></div>
          ${target ? `<div style="text-align:right"><div class="label">Target ${fmtK(target)}</div><div style="font-size:15px;font-weight:800;margin-top:4px">${vsTarget(a.kcal, target)}</div></div>`
                   : `<button class="btn ghost" data-act="settings" style="padding:8px 10px;font-size:12px">Set daily targets</button>`}</div>`;
      if (target) html += `<div class="grid3" style="margin-top:12px">
          <div class="mstat"><div class="label">Days</div><div class="v">${st.done}</div></div>
          <div class="mstat"><div class="label">Under</div><div class="v down">▼ ${st.under}</div></div>
          <div class="mstat"><div class="label">Over</div><div class="v up">▲ ${st.over}</div></div></div>`;
      html += macroBar(a, "protein", "Protein", "p", "var(--protein)") + macroBar(a, "carbs", "Carbs", "c", "var(--carbs)") + macroBar(a, "fat", "Fat", "f", "var(--fat)");
    }
    if (st.avgBurn != null) {   // from the Fitbit
      const d = st.avgDeficit;
      html += `<div class="grid2" style="margin-top:12px">
          <div class="mstat"><div class="label">Avg burned</div><div class="v">${fmtK(st.avgBurn)}</div></div>
          ${d == null ? `<div class="mstat"><div class="label">Avg deficit</div><div class="v faint">–</div></div>`
            : `<div class="mstat"><div class="label">Avg ${d >= 0 ? "deficit" : "surplus"}</div><div class="v ${d >= 0 ? "down" : "up"}">${d >= 0 ? "▼" : "▲"} ${fmtK(Math.abs(d))}</div></div>`}</div>
        ${st.defDays ? `<div class="tiny faint" style="margin-top:6px">Burned minus eaten: ${fmtK(Math.abs(st.deficit))} kcal ${st.deficit >= 0 ? "deficit" : "surplus"} over ${st.defDays} day${st.defDays === 1 ? "" : "s"}</div>` : ""}`;
    }
    if (st.avgSteps != null) html += `<div class="grid2" style="margin-top:12px">
        <div class="mstat"><div class="label">Avg steps</div><div class="v">${fmtK(st.avgSteps)}</div></div>
        <div class="mstat"><div class="label">Step goal hit</div><div class="v">${st.goalDays} <span class="tiny faint">of ${st.stepDays} day${st.stepDays === 1 ? "" : "s"}</span></div></div></div>`;
    const unit = S.settings.weight_unit || "kg";
    const ws = S.weights.filter(w => w.day.slice(0, 7) === S.month).sort((x, y) => (x.day < y.day ? -1 : x.day > y.day ? 1 : 0));
    if (ws.length > 1) {
      const w0 = ws[0], w1 = ws[ws.length - 1];
      html += `<div class="row small" style="margin-top:12px;align-items:flex-start"><span class="grow muted">Weight</span>
        <div style="text-align:right"><b style="color:var(--soft)">${fmtDelta(w1.kg - w0.kg, unit)}</b>
          <div class="tiny faint">${esc(fmtWeight(w0.kg, unit))} → ${esc(fmtWeight(w1.kg, unit))}</div></div></div>`;
    }
    html += `</div>`;

    if (st.logged) {
      const burnKey = st.days.some(d => d.burned != null && !d.today) ? `<span><i class="line burn"></i>Burned</span>` : "";
      html += `<div class="card"${dim}><div class="label">Calories each day</div>${monthChartSvg(st, target)}
        ${target || burnKey ? `<div class="mkey">${target ? `<span><i style="background:var(--green)"></i>Under target</span><span><i style="background:var(--red)"></i>Over</span><span><i class="line"></i>Target</span>` : ""}${burnKey}</div>` : ""}
        <div class="mread">${monthReadout(st, target)}</div></div>`;
      // The same numbers as a list — tap a day to open it.
      html += `<div class="list"${dim}>${st.days.filter(d => d.n).reverse().map(d => `<div class="item tap" data-act="openDay" data-day="${d.day}">
          <div class="grow"><div class="name">${esc(dayLabel(d.day))}</div><div class="sub">${d.n} item${d.n === 1 ? "" : "s"}${d.today ? " · so far" : ""}${d.burned != null ? ` · burned ${fmtK(d.burned)}` : ""}${d.steps != null ? ` · ${fmtK(d.steps)} steps` : ""}</div></div>
          <div style="text-align:right"><div class="kcal">${fmtK(d.kcal)}</div>${target && !d.today ? `<div class="tiny">${vsTarget(d.kcal, target)}</div>` : ""}</div></div>`).join("")}</div>`;
    }
    return html;
  }
  function monthReadout(st, target) {
    const d = S.mSel && st.days.find(x => x.day === S.mSel);
    if (!d) return `<div class="tiny faint" style="text-align:center;padding-top:10px">Tap a day to see it</div>`;
    const net = d.burned != null && d.n && !d.today ? Math.round(d.burned) - Math.round(d.kcal) : null;
    const fit = [];
    if (d.burned != null) fit.push(`Burned ${fmtK(d.burned)}${d.today ? " so far" : ""}${net == null ? "" : net >= 0 ? ` · <span class="down">▼ ${fmtK(net)} deficit</span>` : ` · <span class="up">▲ ${fmtK(-net)} surplus</span>`}`);
    if (d.steps != null) fit.push(`${fmtK(d.steps)} steps${d.steps >= stepGoal() ? ` <span class="down">✓</span>` : ""}`);
    const burned = fit.length ? `<div class="tiny muted" style="margin-top:2px">${fit.join(" · ")}</div>` : "";
    return `<div class="row"><div class="grow"><b>${esc(shortDate(d.day))}</b>${d.today ? " (so far)" : ""} · ${d.n ? `${fmtK(d.kcal)} kcal${target && !d.today ? " · " + vsTarget(d.kcal, target) : ""}` : `<span class="muted">nothing logged</span>`}${burned}</div>
      <button class="btn ghost sm" data-act="openDay" data-day="${d.day}">Open ›</button></div>`;
  }
  // Columns grow from one baseline, 4px rounded tops; above the target the excess is red,
  // split from the green by a 2px gap on the dashed target line. Today (unfinished) is faded.
  function monthChartSvg(st, target) {
    const W = 320, H = 170, L = 32, R = 4, T = 12, B = 20;
    const pw = W - L - R, ph = H - T - B, base = T + ph;
    const days = st.days, n = days.length;
    const hi = Math.max(target, 500, ...days.map(d => d.kcal), ...days.map(d => (d.today ? 0 : d.burned || 0)));
    const raw = hi / 5, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(k => k * mag).find(s => s >= raw);
    const top = Math.ceil((hi * 1.04) / step) * step;
    const Y = v => T + ph - (v / top) * ph;
    const slot = pw / n, bw = Math.min(24, Math.max(2, slot - 2)), r = Math.min(4, bw / 2);
    const f = v => (Math.round(v * 10) / 10).toString();
    const col = (x, y0, y1, fill) => {
      const h = y0 - y1;
      if (h < 0.5) return "";
      const rr = Math.min(r, h);
      return `<path d="M${f(x)} ${f(y0)}V${f(y1 + rr)}A${f(rr)} ${f(rr)} 0 0 1 ${f(x + rr)} ${f(y1)}H${f(x + bw - rr)}A${f(rr)} ${f(rr)} 0 0 1 ${f(x + bw)} ${f(y1 + rr)}V${f(y0)}Z" fill="${fill}"/>`;
    };
    let svg = "";
    for (let v = 0; v <= top + 0.001; v += step) {
      svg += `<line x1="${L}" x2="${W - R}" y1="${f(Y(v))}" y2="${f(Y(v))}" stroke="#1e2535" stroke-width="1"/>`
        + `<text x="${L - 5}" y="${f(Y(v) + 3)}" fill="#5a6480" font-size="9" text-anchor="end">${fmtK(v)}</text>`;
    }
    days.forEach((d, i) => {
      if (d.day === S.mSel) svg += `<rect x="${f(L + i * slot)}" y="${T}" width="${f(slot)}" height="${ph}" fill="#ffffff" opacity=".08"/>`;
    });
    days.forEach((d, i) => {
      if (!d.n || !(d.kcal > 0)) return;
      const x = L + i * slot + (slot - bw) / 2;
      let g;
      if (!target) g = col(x, base, Y(d.kcal), "#4a9eff");
      else if (Math.round(d.kcal) <= target) g = col(x, base, Y(d.kcal), "#00c88c");
      else g = `<rect x="${f(x)}" y="${f(Y(target) + 1)}" width="${f(bw)}" height="${f(Math.max(0, base - Y(target) - 1))}" fill="#00c88c"/>` + col(x, Y(target) - 1, Y(d.kcal), "#ff4a6a");
      svg += d.today ? `<g opacity=".45">${g}</g>` : g;
    });
    if (target) svg += `<line x1="${L}" x2="${W - R}" y1="${f(Y(target))}" y2="${f(Y(target))}" stroke="#8892b0" stroke-width="1" stroke-dasharray="3 3"/>`;
    // Burned (from the Fitbit): a 2px line across the columns, broken where a day has no reading.
    let seg = [];
    const flush = () => {
      if (seg.length > 1) svg += `<polyline points="${seg.join(" ")}" fill="none" stroke="#c8cee0" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
      else if (seg.length === 1) { const [cx, cy] = seg[0].split(","); svg += `<circle cx="${cx}" cy="${cy}" r="3" fill="#c8cee0"/>`; }
      seg = [];
    };
    days.forEach((d, i) => { if (d.burned == null || d.today || d.future) flush(); else seg.push(`${f(L + (i + 0.5) * slot)},${f(Y(d.burned))}`); });
    flush();
    days.forEach((d, i) => {
      if (d.day === S.mSel && d.burned != null && !d.today) svg += `<circle cx="${f(L + (i + 0.5) * slot)}" cy="${f(Y(d.burned))}" r="4" fill="#c8cee0" stroke="#141824" stroke-width="2"/>`;
    });
    for (const d of [1, 8, 15, 22, 29]) if (d <= n) svg += `<text x="${f(L + (d - 0.5) * slot)}" y="${H - 5}" fill="#5a6480" font-size="9" text-anchor="middle">${d}</text>`;
    days.forEach((d, i) => {   // tap targets: the whole column, not just the bar
      if (d.future) return;
      const label = `${shortDate(d.day)}: ${d.n ? fmtK(d.kcal) + " kcal" : "nothing logged"}`;
      svg += `<rect x="${f(L + i * slot)}" y="${T}" width="${f(slot)}" height="${ph + B}" fill="transparent" data-act="mSel" data-day="${d.day}" tabindex="0" role="button" aria-label="${esc(label)}"/>`;
    });
    return `<svg class="mchart" viewBox="0 0 ${W} ${H}" role="group" aria-label="Calories each day">${svg}</svg>`;
  }

  // ── Health: live steps, sleep and heart rate (from the Fitbit, through the server) ──
  // The watch reaches Google every few minutes; in between, the Steps page counts on at
  // your last pace and corrects itself at each sync.
  const LIVE_CAP = 20;   // minutes past the last sync the count keeps climbing on its own
  // Steps a minute over the last few minutes Google has (0 once you've stopped).
  function paceOf(minutes, syncedAt, span = 3) {
    if (!syncedAt || !minutes || !minutes.length) return 0;
    const end = Date.parse(syncedAt), from = end - span * 60000;
    let n = 0;
    for (const m of minutes) { const t = Date.parse(m.t); if (t > from && t <= end) n += +m.n || 0; }
    return n / span;
  }
  function liveEstimate(base, pace, syncedAt, now) {
    if (!syncedAt || !(pace > 0)) return base;
    const mins = Math.min(LIVE_CAP, Math.max(0, (now - Date.parse(syncedAt)) / 60000));
    return Math.floor(base + pace * mins);
  }
  // Never backwards while walking: a small overshoot waits for the real count to catch up;
  // once you've stopped (or it ran well ahead) it shows the real count.
  function liveShown(prev, est, pace) {
    if (prev == null || est >= prev || !(pace > 0)) return est;
    return prev - est <= pace * 3 ? prev : est;
  }
  // One per night: the longest sleep (not a nap) ending on each day, oldest first.
  function nightsOf(sessions) {
    const by = new Map();
    for (const s of sessions || []) {
      if (s.nap) continue;
      const day = isoDay(new Date(s.end));
      const cur = by.get(day);
      if (!cur || s.asleep > cur.asleep) by.set(day, s);
    }
    return [...by.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, s]) => ({ day, ...s }));
  }
  Object.assign(window.CT, { paceOf, liveEstimate, liveShown, nightsOf });

  const fmtDur = m => { m = Math.round(+m || 0); const h = Math.floor(m / 60), r = m % 60; return h ? `${h}h ${r}m` : `${r}m`; };
  const clock = t => { const d = new Date(t), h = d.getHours(); return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")}${h < 12 ? "am" : "pm"}`; };
  const hourLabel = h => { h = ((h % 24) + 24) % 24; return h === 0 ? "12am" : h === 12 ? "12pm" : h < 12 ? `${h}am` : `${h - 12}pm`; };
  const ago = t => { const m = Math.max(0, Math.round((Date.now() - Date.parse(t)) / 60000)); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`; };
  const syncedText = () => (S.settings.fit_synced_at ? `Watch synced ${clock(S.settings.fit_synced_at)}` : "");
  const hasScope = k => String(S.settings.fit_scopes || "").split(" ").includes(k);
  const f1 = v => (Math.round(v * 10) / 10).toString();
  const reauthCard = () => `<div class="card row" style="padding:10px 12px;border-color:#5a4a1a">
      <span class="grow small">Your Fitbit link has run out, so calories burned, steps, sleep and heart rate have stopped updating.</span>
      <button class="btn blue sm" data-act="fitConnect">Reconnect</button></div>`;
  const allowCard = k => `<div class="card"><div class="small" style="margin-bottom:10px">${k === "sleep" ? "Sleep" : "Heart rate"} needs one more permission from Google.</div>
      <button class="btn blue block" data-act="fitConnect">Allow ${k === "sleep" ? "sleep" : "heart rate"}</button>
      <div class="tiny faint" style="margin-top:8px">You'll see Google's screen again. Leave sleep and heart rate ticked.</div></div>`;
  const errorCard = () => `<div class="card"><div class="small muted" style="margin-bottom:10px">Couldn't reach your Fitbit data just now.</div>
      <button class="btn ghost block" data-act="hretry">Try again</button></div>`;
  const loadingCard = `<div class="empty">Loading…</div>`;

  // ── Home: today at a glance; each tile opens its page ──
  // (the tile values that need the Fitbit data: last night's sleep, heart rate)
  function sleepSummary() {
    const sl = S.health.sleep, today = isoDay();
    if (!hasScope("sleep") || (sl && sl.needScope)) return ["—", "Tap to allow sleep"];
    if (sl && sl.err) return ["—", "Couldn't load it. Tap to try again"];
    if (!sl || !sl.sessions) return ["…", "Loading…"];
    const n = nightsOf(sl.sessions).pop();
    return n ? [fmtDur(n.asleep), `${n.day === today ? "" : shortDate(n.day) + " · "}${clock(n.start)} – ${clock(n.end)}`] : ["—", "No sleep recorded yet"];
  }
  function heartSummary() {
    const hr = S.health.heart;
    if (!hasScope("heart") || (hr && hr.needScope)) return ["—", "Tap to allow heart rate"];
    if (hr && hr.err) return ["—", "Couldn't load it. Tap to try again"];
    if (!hr || !hr.day) return ["…", "Loading…"];
    const r = (hr.resting || []).slice(-1)[0], last = hr.day[hr.day.length - 1];
    return [r ? `${r.bpm} <span class="small dim">bpm</span>` : last ? `${last.avg} <span class="small dim">bpm</span>` : "—",
      r ? `Resting${last ? ` · latest ${last.avg}` : ""}` : last ? `Latest, at ${clock(last.t)}` : "No heart rate yet today"];
  }
  function viewHome() {
    const today = isoDay(), name = (S.settings.display_name || "").trim(), h = new Date().getHours();
    const hello = h < 5 ? "Hello" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
    let html = `<div class="hello"><div class="hi">${hello}${name ? ", " + esc(name) : ""}</div><div class="small dim">${esc(longDate(today))}</div></div>`;
    const fit = S.settings.fit_status;
    if (fit === "reauth") html += reauthCard();
    const tile = (attrs, icon, label, body) => `<div class="card tile" ${attrs} role="button" tabindex="0">
      <div class="row tile-h"><span class="tic" aria-hidden="true">${icon}</span><span class="label grow">${label}</span><span class="chev" aria-hidden="true">›</span></div>${body}</div>`;
    // steps, counting on live between syncs
    const goal = stepGoal(), st = S.steps.get(today);
    if (fit) {
      html += tile(`data-act="hopen" data-p="steps" aria-label="Steps"`, "👟", "Steps",
        st == null ? `<div class="tval">–</div><div class="small muted">Waiting for the watch</div>`
          : `<div class="tval" id="homeSteps">${fmtK(st)}</div>
             <div class="bar thin"><div id="homeStepsBar" style="width:${Math.min(100, (st / goal) * 100)}%;background:${st >= goal ? "var(--green)" : "var(--blue)"}"></div></div>
             <div class="row small" style="margin-top:7px"><span class="grow muted" id="homeStepsSub">${st >= goal ? "✓ Goal reached" : `${fmtK(goal - st)} to go`}</span><span class="faint">${syncedText()}</span></div>`);
    } else {
      html += `<div class="card"><div class="row tile-h"><span class="tic" aria-hidden="true">👟</span><span class="label grow">Steps, sleep and heart rate</span></div>
        <p class="small muted" style="margin:6px 0 12px">Connect your Fitbit to see them here.</p><button class="btn blue block" data-act="fitConnect">Connect Fitbit</button></div>`;
    }
    // calories in, out, and what that leaves
    const eaten = Math.round(sumN(S.diary.filter(e => e.day === today)).kcal);
    const out = S.burn.has(today) ? Math.round(S.burn.get(today)) : null;
    const target = +S.settings.kcal_target || 0;
    const bal = out != null ? out - eaten : null;
    html += tile(`data-act="tab" data-v="today" aria-label="Calories today"`, "🍽️", "Calories today",
      `<div class="kc">
         <div><div class="tiny dim">In</div><div class="tv2">${fmtK(eaten)}</div></div>
         <div><div class="tiny dim">Out${out != null ? " so far" : ""}</div><div class="tv2">${out != null ? fmtK(out) : "–"}</div></div>
         <div><div class="tiny dim">${bal != null && bal < 0 ? "Surplus" : "Deficit"}</div><div class="tv2 ${bal == null ? "" : bal >= 0 ? "down" : "up"}">${bal == null ? "–" : `${bal >= 0 ? "▼" : "▲"} ${fmtK(Math.abs(bal))}`}</div></div>
       </div>
       ${target ? `<div class="bar thin" style="margin-top:12px"><div style="width:${Math.min(100, (eaten / target) * 100)}%;background:${eaten > target ? "var(--red)" : "var(--green)"}"></div></div>
         <div class="small muted" style="margin-top:7px">${eaten > target ? `${fmtK(eaten - target)} over your ${fmtK(target)} target` : `${fmtK(target - eaten)} left of your ${fmtK(target)} target`}</div>` : ""}`);
    // sleep and heart rate
    if (fit) {
      const [sv, ss] = sleepSummary(), [hv, hs] = heartSummary();
      html += `<div class="grid2 tiles2">${tile(`data-act="hopen" data-p="sleep" aria-label="Sleep"`, "😴", "Sleep", `<div class="tval sm">${sv}</div><div class="small muted">${ss}</div>`)}${tile(`data-act="hopen" data-p="heart" aria-label="Heart rate"`, "❤️", "Heart", `<div class="tval sm">${hv}</div><div class="small muted">${hs}</div>`)}</div>`;
    }
    // weight
    const unit = S.settings.weight_unit || "kg";
    const ws = S.weights.slice().sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    const lastW = ws[ws.length - 1];
    let wsub = "Tap to log your weight";
    if (lastW) {
      const first = ws.find(w => w.day >= addDays(today, -30));
      wsub = first && first !== lastW ? `${fmtDelta(lastW.kg - first.kg, unit)} in the last 30 days` : dayLabel(lastW.day);
    }
    html += tile(`data-act="tab" data-v="weight" aria-label="Weight"`, "⚖️", "Weight", `<div class="tval sm">${lastW ? esc(fmtWeight(lastW.kg, unit)) : "–"}</div><div class="small muted">${esc(wsub)}</div>`);
    return html;
  }

  // ── Hitting the step goal: a cheer (and confetti if it happens while you watch) ──
  const CHEERS = [
    "Well done {n}, you smashed it!", "Get in, {n}! Goal done!", "{n}, you absolute legend!", "{goal} steps! Take a bow, {n}.",
    "Boom! Goal smashed, {n}!", "That's the one, {n}! Goal reached.", "Nailed it, {n}! 👏", "Look at you go, {n}! Goal done.",
    "{n} 1, step goal 0. 🏆", "Champion stuff, {n}!", "You did it, {n}! Feet up time. 🛋️", "Absolutely flying, {n}!",
    "Step goal? Sorted. Nice one, {n}!", "Proud of you, {n}! Goal smashed.", "What a star, {n}! ⭐", "{goal} steps done. Unstoppable, {n}!",
    "High five, {n}! ✋", "Crushed it, {n}!", "Another goal in the bag, {n}!", "Top work, {n}! Your legs deserve a medal. 🏅",
    "{n} is on fire today! 🔥", "Knocked it out of the park, {n}!", "Well walked, {n}! Goal done.", "Cracking effort, {n}!",
    "Your step goal never stood a chance, {n}.", "Bravo, {n}! 👏", "Look who hit their goal! Well done, {n}.", "Goal reached. {n}, you're a machine!",
    "Every step counted, {n}. Brilliant!", "{n}, that's how it's done! 💪", "Stepping like a pro, {n}!", "Tick! Goal done, {n}. ✅",
    "Legs of steel, {n}! Goal smashed.", "Mission accomplished, {n}! 🚀", "You've earned a sit down, {n}!", "Sterling work, {n}! Goal reached.",
    "Hats off to you, {n}! 🎩", "{goal}! Nobody does it like {n}.", "Goal reached. Take the rest of the day off, {n}! 😄", "Outstanding, {n}! 🌟",
  ];
  const CHEERS_BIG = [   // well past the goal
    "{steps} steps? {n}, you're on another level!", "Way past your goal, {n}. Show-off! 😄", "Goal? What goal? Incredible, {n}!",
    "{n}, the treadmill's asking for a break! 😅", "Still going, {n}? Unstoppable! 🔥", "Overachiever alert: {n}! 🚨",
  ];
  function cheerLine(shown, goal) {
    const big = shown >= goal * 1.5, pool = big ? CHEERS_BIG : CHEERS, key = big ? "cheerBig" : "cheer";
    let i = Math.floor(Math.random() * pool.length);
    if (String(i) === pref.get(key, "") && pool.length > 1) i = (i + 1) % pool.length;   // not the same one twice running
    pref.set(key, String(i));
    const n = (S.settings.display_name || "").trim() || "superstar";
    return pool[i].replace(/\{n\}/g, n).replace(/\{goal\}/g, fmtK(goal)).replace(/\{steps\}/g, fmtK(shown));
  }
  Object.assign(window.CT, { CHEERS, CHEERS_BIG, cheerLine });
  function confetti() {
    try { if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return; } catch (e) { /* show it */ }
    const c = document.createElement("canvas");
    let g = null;
    try { g = c.getContext("2d"); } catch (e) { /* no canvas: no confetti */ }
    if (!g) return;
    c.className = "confetti";
    document.body.appendChild(c);
    const dpr = window.devicePixelRatio || 1, W = window.innerWidth, H = window.innerHeight;
    c.width = W * dpr; c.height = H * dpr; g.scale(dpr, dpr);
    const cols = ["#8b7cff", "#ff6fa8", "#4a9eff", "#00c88c", "#ffb84a"];
    const bits = Array.from({ length: 150 }, () => ({ x: W / 2 + (Math.random() - 0.5) * W * 0.4, y: H * 0.3, vx: (Math.random() - 0.5) * 10, vy: -Math.random() * 11 - 4,
      r: Math.random() * 6 + 5, a: Math.random() * 6, va: (Math.random() - 0.5) * 0.35, c: cols[Math.floor(Math.random() * cols.length)] }));
    const t0 = performance.now();
    (function frame(t) {
      const k = (t - t0) / 1000;
      g.clearRect(0, 0, W, H);
      for (const p of bits) {
        p.vy += 0.33; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.a += p.va;
        g.save(); g.translate(p.x, p.y); g.rotate(p.a); g.globalAlpha = Math.max(0, 1 - k / 3); g.fillStyle = p.c; g.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2); g.restore();
      }
      if (k < 3) requestAnimationFrame(frame); else c.remove();
    })(t0);
  }
  const buzz = () => { try { if (navigator.vibrate) navigator.vibrate([70, 50, 150]); } catch (e) { /* no buzz */ } };

  // Full-screen pages over the app (the phone's back gesture closes them too).
  const $page = document.getElementById("page");
  function renderPage() {
    const p = S.health.page;
    if (!p) { $page.innerHTML = ""; $page.classList.add("hidden"); return; }
    const y = $page.scrollTop;
    $page.classList.remove("hidden");
    const title = { steps: "Steps", sleep: "Sleep", heart: "Heart rate" }[p];
    const body = S.settings.fit_status === "reauth" ? reauthCard() : !S.settings.fit_status ? `<div class="card"><p class="small muted" style="margin:0 0 12px">Connect your Fitbit to see this.</p><button class="btn blue block" data-act="fitConnect">Connect Fitbit</button></div>`
      : p === "steps" ? pageSteps() : p === "sleep" ? pageSleep() : pageHeart();
    $page.innerHTML = `<div class="pg"><div class="pg-top"><button class="pg-back" data-act="pageBack" aria-label="Back">‹</button><h2>${title}</h2></div>${body}</div>`;
    $page.scrollTop = y;
    if (p === "steps") tickLive();
  }
  function openPage(p) {
    if (!["steps", "sleep", "heart"].includes(p)) return;
    Object.assign(S.health, { page: p, shown: null, cheer: null, nightSel: null, hrSel: null, restSel: null });
    if (p === "steps" && !S.health.live && S.steps.has(isoDay())) S.health.live = { steps: S.steps.get(isoDay()), minutes: [], syncedAt: S.settings.fit_synced_at || null, at: 0 };
    try { history.pushState({ ctPage: p }, ""); } catch (e) { /* not essential */ }
    renderPage();
    $page.scrollTop = 0;
    healthTimers();
    keepAwake(p === "steps");
    // Counting from old numbers, the first fresh ones could look like the goal being reached
    // right now: start from the fresh ones instead.
    const stale = p === "steps" && (!S.health.live || Date.now() - (S.health.live.at || 0) > 60000);
    const load = p === "steps" ? loadLive() : p === "sleep" ? loadSleep(false) : loadHeart(false);
    load.then(() => { if (S.health.page === p) { if (stale) S.health.shown = null; renderPage(); } });
  }
  function closePage(fromHistory) {
    if (!S.health.page) return;
    S.health.page = null;
    keepAwake(false);
    renderPage();
    healthTimers();
    if (!fromHistory && history.state && history.state.ctPage) { try { history.back(); } catch (e) { /* fine */ } }
    if (S.user && !ctx) render();
  }
  window.addEventListener("popstate", () => { if (S.health.page) closePage(true); });

  // Keep the screen on while the Steps page is open (for watching it on the treadmill).
  let wake = null;
  async function keepAwake(on) {
    try {
      if (on && !wake && "wakeLock" in navigator && !document.hidden) {
        wake = await navigator.wakeLock.request("screen");
        wake.addEventListener("release", () => { wake = null; });
      } else if (!on && wake) { const w = wake; wake = null; await w.release(); }
    } catch (e) { wake = null; }
  }

  // Refreshing: every 20 seconds while Home or a page is open, and the live
  // count ticks four times a second on Home and the Steps page.
  let hTimer = null, tTimer = null;
  function healthTimers() {
    clearInterval(hTimer); clearInterval(tTimer); hTimer = tTimer = null;
    if (document.hidden || !S.user || S.settings.fit_status !== "linked" || !(S.view === "home" || S.health.page)) return;
    hTimer = setInterval(healthPoll, 20000);
    if (S.health.page === "steps" || !S.health.page) tTimer = setInterval(tickLive, 250);
  }
  async function healthPoll() {
    const p = S.health.page;
    if (p === "heart") await loadHeart(false);
    else if (p === "sleep") await loadSleep(false);
    else await loadLive();
    if (S.health.page) { if (S.health.page === "steps" && document.getElementById("liveNum")) tickLive(); else renderPage(); }
    else renderHome();
  }
  async function enterHealth() {
    healthTimers();
    if (S.settings.fit_status !== "linked") return;
    // back on Home: nothing fetched again that's only just been fetched
    const lv = S.health.live, h = S.health.heart, recent = (x, ms) => x && Date.now() - (x.at || 0) < ms;
    await Promise.all([recent(lv, 20000) ? null : loadLive(), loadSleep(false), recent(h && h.day && h, 60000) ? null : loadHeart(false)]);
    renderHome();
  }
  async function hcall(action, extra) {
    const { data, error } = await sb.functions.invoke("fitbit", { body: { action, ...(extra || {}) } });
    if (error) throw oops("Couldn't reach your Fitbit data. Try again.");
    const d = data || {};
    if (d.reconnect) S.settings.fit_status = "reauth";
    else if (d.linked === false) S.settings.fit_status = null;
    if (d.syncedAt) S.settings.fit_synced_at = d.syncedAt;
    return d;
  }
  async function loadLive() {
    try {
      const d = await hcall("live");
      if (d.today) {
        S.health.live = { steps: +d.steps || 0, minutes: d.minutes || [], syncedAt: d.syncedAt || S.settings.fit_synced_at || null, day: d.today, at: Date.now() };
        S.steps.set(d.today, +d.steps || 0);
      }
    } catch (e) { console.error(e); }
  }
  async function loadSleep(force) {
    const s = S.health.sleep;
    if (!force && s && !s.err && Date.now() - s.at < 5 * 60000) return;
    if (!hasScope("sleep")) { S.health.sleep = { needScope: true, at: Date.now() }; return; }
    try {
      const d = await hcall("sleep", { days: 30 });
      S.health.sleep = d.needScope ? { needScope: true, at: Date.now() } : d.sessions ? { sessions: d.sessions, at: Date.now() } : s;
    } catch (e) { console.error(e); S.health.sleep = s && s.sessions ? s : { err: true, at: Date.now() }; }
  }
  async function loadHeart(force) {
    const h = S.health.heart;
    if (!hasScope("heart")) { S.health.heart = { needScope: true, at: Date.now() }; return; }
    const resting = force || !h || !h.resting || Date.now() - (h.restAt || 0) > 5 * 60000;
    try {
      const d = await hcall("heart", { resting });
      if (d.needScope) S.health.heart = { needScope: true, at: Date.now() };
      else if (d.day) S.health.heart = { day: d.day, resting: resting ? d.resting || [] : h.resting, restAt: resting ? Date.now() : h.restAt, at: Date.now() };
    } catch (e) { console.error(e); if (!h || !h.day) S.health.heart = { err: true, at: Date.now() }; }
  }

  // ── Steps page: a big number that climbs at your pace ──
  function pageSteps() {
    const lv = S.health.live, goal = stepGoal();
    if (!lv) return loadingCard;
    return `<div class="cheer" id="cheer" hidden><span class="cheer-e" aria-hidden="true">🎉</span><div id="cheerText" role="status" aria-live="polite"></div></div>
      <div class="card">
        <div class="label">Steps today</div>
        <div class="hero" id="liveNum">${fmtK(lv.steps)}</div>
        <div class="bar hero-bar"><div id="liveBar"></div></div>
        <div class="row small" style="margin-top:8px"><span class="grow muted" id="liveToGo"></span><span class="faint">Goal ${fmtK(goal)}</span></div>
      </div>
      <div class="grid2">
        <div class="mstat"><div class="label">Pace</div><div class="v" id="livePace">–</div></div>
        <div class="mstat"><div class="label">${fmtK(goal)} at</div><div class="v" id="liveEta">–</div></div>
      </div>
      <div class="small muted" id="liveSync" style="margin-top:12px"></div>
      <div class="tiny faint" id="liveNote" style="margin-top:4px"></div>`;
  }
  function tickLive() {
    const lv = S.health.live, el = id => document.getElementById(id);
    if (!lv || lv.day && lv.day !== isoDay()) return;
    const onPage = S.health.page === "steps" && el("liveNum"), onHome = !S.health.page && S.view === "home" && el("homeSteps");
    if (!onPage && !onHome) return;
    const now = Date.now(), goal = stepGoal();
    const pace = paceOf(lv.minutes, lv.syncedAt), prev = S.health.shown;
    const shown = S.health.shown = liveShown(prev, liveEstimate(lv.steps, pace, lv.syncedAt, now), pace);
    if (onHome) {
      if (el("homeSteps").textContent === fmtK(shown)) return;
      el("homeSteps").textContent = fmtK(shown);
      el("homeStepsBar").style.width = Math.min(100, (shown / goal) * 100) + "%";
      el("homeStepsBar").style.background = shown >= goal ? "var(--green)" : "var(--blue)";
      el("homeStepsSub").textContent = shown >= goal ? "✓ Goal reached" : `${fmtK(goal - shown)} to go`;
      return;
    }
    if (shown >= goal) {   // the goal: a cheer, with confetti if it happened while you watched
      const crossed = prev != null && prev < goal;
      if (!S.health.cheer || crossed) S.health.cheer = cheerLine(shown, goal);
      const c = el("cheer");
      if (c && (c.hidden || crossed || el("cheerText").textContent !== S.health.cheer)) {
        c.hidden = false;
        el("cheerText").textContent = S.health.cheer;
        if (crossed) { c.classList.remove("pop"); void c.offsetWidth; c.classList.add("pop"); confetti(); buzz(); }
      }
    }
    el("liveNum").textContent = fmtK(shown);
    el("liveBar").style.width = Math.min(100, (shown / goal) * 100) + "%";
    el("liveBar").style.background = shown >= goal ? "var(--green)" : "var(--blue)";
    el("liveToGo").textContent = shown >= goal ? "✓ Goal reached" : `${fmtK(goal - shown)} to go`;
    el("livePace").innerHTML = pace > 0 ? `${Math.round(pace)} <span class="tiny faint">steps/min</span>` : `<span class="dim small">Not walking</span>`;
    el("liveEta").textContent = shown >= goal ? "Done ✓" : pace > 0 ? clock(now + ((goal - shown) / pace) * 60000) : "–";
    el("liveSync").textContent = lv.syncedAt ? `Watch synced ${clock(lv.syncedAt)} · ${ago(lv.syncedAt)}` : "Waiting for the watch to sync";
    el("liveNote").textContent = pace > 0 && lv.syncedAt && now - Date.parse(lv.syncedAt) > 60000 ? "Counting on at your pace until the watch next syncs." : "";
  }

  // ── Sleep page: a night's stages, and recent nights ──
  const STAGE_COL = { awake: "#d95926", rem: "#86b6ef", light: "#3987e5", deep: "#1c5cab", restless: "#86b6ef", asleep: "#3987e5" };
  const STAGE_NAME = { awake: "Awake", rem: "REM", light: "Light", deep: "Deep", restless: "Restless", asleep: "Asleep" };
  const stageRows = n => (n.type === "classic" ? ["awake", "restless", "asleep"] : ["awake", "rem", "light", "deep"]);
  function pageSleep() {
    const sl = S.health.sleep;
    if (!hasScope("sleep") || (sl && sl.needScope)) return allowCard("sleep");
    if (!sl) return loadingCard;
    if (sl.err) return errorCard();
    const nights = nightsOf(sl.sessions);
    if (!nights.length) return `<div class="card small muted">No sleep recorded in the last month.</div>`;
    const i = S.health.nightSel != null && nights[S.health.nightSel] ? S.health.nightSel : nights.length - 1;
    const n = nights[i];
    const inBed = Math.round((Date.parse(n.end) - Date.parse(n.start)) / 60000);
    let html = `<div class="card">
      <div class="label">${n.day === isoDay() ? "Last night" : "Night to " + esc(shortDate(n.day))}</div>
      <div class="hero-sm">${fmtDur(n.asleep)} <span class="small dim">asleep</span></div>
      <div class="small muted">${clock(n.start)} – ${clock(n.end)} · ${fmtDur(inBed)} in bed</div>
      ${n.stages.length ? stagesSvg(n) + `<div class="skey">${stageRows(n).map(r => `<span><i style="background:${STAGE_COL[r]}"></i>${STAGE_NAME[r]} <b>${fmtDur(n.byStage[r] || 0)}</b></span>`).join("")}</div>` : ""}
    </div>`;
    const last = nights.slice(-14), off = nights.length - last.length;
    const avg = last.reduce((s, x) => s + x.asleep, 0) / last.length;
    html += `<div class="card"><div class="row"><span class="label grow">Last ${last.length} night${last.length === 1 ? "" : "s"}</span><span class="small muted">Average ${fmtDur(avg)}</span></div>
      ${nightsSvg(last, off, i, avg)}
      <div class="tiny faint" style="margin-top:6px">Tap a night to see it above.</div></div>`;
    html += `<details class="card tbl"><summary class="small">All nights (${nights.length})</summary>${nights.slice().reverse().map(x =>
      `<div class="row small tr"><span class="grow">${esc(shortDate(x.day))}</span><span class="muted">${clock(x.start)}–${clock(x.end)}</span><b class="tv">${fmtDur(x.asleep)}</b></div>`).join("")}</details>`;
    return html;
  }
  // Each stage on its own row across the night; the hours along the bottom.
  function stagesSvg(n) {
    const rows = stageRows(n);
    const W = 320, L = 52, R = 8, T = 4, rh = 18, gap = 8, B = 20;
    const t0 = Date.parse(n.start), t1 = Date.parse(n.end), total = Math.max(1, (t1 - t0) / 60000);
    const pw = W - L - R, bottom = T + rows.length * (rh + gap) - gap, H = bottom + B;
    const X = m => L + (m / total) * pw;
    let svg = "";
    rows.forEach((r, k) => {
      const y = T + k * (rh + gap);
      svg += `<rect x="${L}" y="${y}" width="${pw}" height="${rh}" rx="4" fill="#182033"/>`
        + `<text x="${L - 8}" y="${y + rh / 2 + 3.5}" text-anchor="end" font-size="10.5" fill="#8892b0">${STAGE_NAME[r]}</text>`;
    });
    for (const [type, at, len] of n.stages) {
      const k = rows.indexOf(type);
      if (k < 0 || !(len > 0)) continue;
      const y = T + k * (rh + gap), x = X(at), w = Math.max(1.5, X(at + len) - x);
      svg += `<rect x="${f1(x)}" y="${y}" width="${f1(w)}" height="${rh}" rx="${f1(Math.min(3, w / 2))}" fill="${STAGE_COL[type]}"/>`;
    }
    const first = new Date(t0); first.setMinutes(0, 0, 0);
    if (first.getTime() < t0) first.setHours(first.getHours() + 1);
    const every = (t1 - t0) / 3600000 > 6 ? 2 : 1;
    for (let t = first.getTime(), k = 0; t <= t1; t += 3600000, k++) {
      if (k % every) continue;
      const x = X((t - t0) / 60000), anchor = x < L + 12 ? "start" : x > W - 14 ? "end" : "middle";
      svg += `<line x1="${f1(x)}" x2="${f1(x)}" y1="${bottom + 2}" y2="${bottom + 6}" stroke="#3a4460" stroke-width="1"/>`
        + `<text x="${f1(x)}" y="${bottom + 16}" text-anchor="${anchor}" font-size="9.5" fill="#5a6480">${hourLabel(new Date(t).getHours())}</text>`;
    }
    return `<svg class="hchart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Sleep stages, ${clock(n.start)} to ${clock(n.end)}">${svg}</svg>`;
  }
  // Rounded-top column from a baseline.
  function colPath(x, y0, y1, bw, r, fill) {
    const h = y0 - y1;
    if (h < 0.5) return "";
    const rr = Math.min(r, h);
    return `<path d="M${f1(x)} ${f1(y0)}V${f1(y1 + rr)}A${f1(rr)} ${f1(rr)} 0 0 1 ${f1(x + rr)} ${f1(y1)}H${f1(x + bw - rr)}A${f1(rr)} ${f1(rr)} 0 0 1 ${f1(x + bw)} ${f1(y1 + rr)}V${f1(y0)}Z" fill="${fill}"/>`;
  }
  // Hours asleep each night; the chosen night in blue, the rest quieter; the average as a line.
  function nightsSvg(nights, off, sel, avg) {
    const W = 320, H = 150, L = 26, R = 26, T = 8, B = 18;
    const pw = W - L - R, ph = H - T - B, base = T + ph;
    const top = Math.ceil(Math.max(480, ...nights.map(n => n.asleep)) / 120) * 120;
    const Y = m => T + ph - (m / top) * ph;
    const slot = pw / nights.length, bw = Math.min(22, slot - 3), r = Math.min(4, bw / 2);
    let svg = "";
    for (let m = 0; m <= top; m += 120) {
      svg += `<line x1="${L}" x2="${W - R}" y1="${f1(Y(m))}" y2="${f1(Y(m))}" stroke="#1e2535" stroke-width="1"/>`
        + `<text x="${L - 5}" y="${f1(Y(m) + 3)}" fill="#5a6480" font-size="9" text-anchor="end">${m / 60}h</text>`;
    }
    nights.forEach((n, k) => {
      const x = L + k * slot + (slot - bw) / 2;
      svg += colPath(x, base, Y(n.asleep), bw, r, off + k === sel ? "#4a9eff" : "#2d4a73");
      if (nights.length <= 8 || k % 2 === (nights.length - 1) % 2) svg += `<text x="${f1(L + (k + 0.5) * slot)}" y="${H - 5}" fill="#5a6480" font-size="9" text-anchor="middle">${+n.day.slice(8)}</text>`;
    });
    svg += `<line x1="${L}" x2="${W - R}" y1="${f1(Y(avg))}" y2="${f1(Y(avg))}" stroke="#c8cee0" stroke-width="1"/>`
      + `<text x="${W - R + 4}" y="${f1(Y(avg) + 3)}" fill="#8892b0" font-size="9">avg</text>`;
    nights.forEach((n, k) => {
      svg += `<rect x="${f1(L + k * slot)}" y="${T}" width="${f1(slot)}" height="${ph + B}" fill="transparent" data-act="nightSel" data-i="${off + k}" tabindex="0" role="button" aria-label="${esc(shortDate(n.day))}: ${fmtDur(n.asleep)} asleep"/>`;
    });
    return `<svg class="hchart" viewBox="0 0 ${W} ${H}" role="group" aria-label="Hours asleep each night">${svg}</svg>`;
  }

  // ── Heart rate page: resting heart rate over the month, and today through the day ──
  function pageHeart() {
    const hr = S.health.heart;
    if (!hasScope("heart") || (hr && hr.needScope)) return allowCard("heart");
    if (!hr) return loadingCard;
    if (hr.err) return errorCard();
    const rest = hr.resting || [], r = rest[rest.length - 1];
    const avg = rest.length ? rest.reduce((s, x) => s + x.bpm, 0) / rest.length : null;
    let html = `<div class="card"><div class="label">Resting heart rate</div>
      <div class="hero-sm">${r ? r.bpm : "–"} <span class="small dim">bpm</span></div>
      <div class="small muted">${r ? (r.day === isoDay() ? "Today" : esc(shortDate(r.day))) : "None yet"}${avg != null && rest.length > 1 ? ` · ${rest.length}-day average ${Math.round(avg)}` : ""}</div>
      ${rest.length > 1 ? restingSvg(rest) + `<div class="mread">${restRead(rest)}</div>` : ""}</div>`;
    const day = hr.day || [], last = day[day.length - 1];
    html += `<div class="card"><div class="row"><span class="label grow">Today</span><span class="small muted">${last ? `Latest ${last.avg} bpm at ${clock(last.t)}` : "No readings yet"}</span></div>
      ${day.length ? hrDaySvg(day) + `<div class="mread">${hrRead(day)}</div>` : ""}
      <div class="tiny faint" style="margin-top:4px">${syncedText()}</div></div>`;
    if (rest.length) html += `<details class="card tbl"><summary class="small">Resting heart rate by day</summary>${rest.slice().reverse().map(x =>
      `<div class="row small tr"><span class="grow">${esc(shortDate(x.day))}</span><b class="tv">${x.bpm} bpm</b></div>`).join("")}</details>`;
    return html;
  }
  const hrRead = day => {
    const d = S.health.hrSel != null && day[S.health.hrSel];
    return d ? `<b>${clock(d.t)}</b> · ${d.avg} bpm <span class="muted">(${d.min}–${d.max} over 5 minutes)</span>` : `<div class="tiny faint" style="text-align:center">Tap the chart to see a time</div>`;
  };
  const restRead = rest => {
    const d = S.health.restSel != null && rest[S.health.restSel];
    return d ? `<b>${esc(shortDate(d.day))}</b> · ${d.bpm} bpm resting` : `<div class="tiny faint" style="text-align:center">Tap the chart to see a day</div>`;
  };
  const niceSteps = (lo, hi, step) => ({ lo: Math.floor(lo / step) * step, hi: Math.ceil(hi / step) * step });
  // Today's 5-minute averages as a line, the range within each 5 minutes as a faint band.
  function hrDaySvg(day) {
    const W = 320, H = 160, L = 30, R = 10, T = 8, B = 18;
    const pw = W - L - R, ph = H - T - B, base = T + ph;
    const mid = new Date(); mid.setHours(0, 0, 0, 0);
    const t0 = mid.getTime(), span = 86400000;
    const X = t => L + ((Date.parse(t) - t0) / span) * pw;
    const { lo, hi } = niceSteps(Math.min(...day.map(d => d.min)) - 3, Math.max(...day.map(d => d.max)) + 3, 20);
    const Y = v => T + ph - ((v - lo) / (hi - lo || 1)) * ph;
    let svg = "";
    for (let v = lo; v <= hi; v += 20) svg += `<line x1="${L}" x2="${W - R}" y1="${f1(Y(v))}" y2="${f1(Y(v))}" stroke="#1e2535" stroke-width="1"/><text x="${L - 5}" y="${f1(Y(v) + 3)}" fill="#5a6480" font-size="9" text-anchor="end">${v}</text>`;
    for (const h of [0, 6, 12, 18]) {
      const x = L + (h / 24) * pw;
      svg += `<text x="${f1(x)}" y="${H - 5}" fill="#5a6480" font-size="9" text-anchor="${h === 0 ? "start" : "middle"}">${hourLabel(h)}</text>`;
    }
    const runs = [];   // a gap of over 15 minutes (watch off) breaks the line
    day.forEach((d, i) => { if (!i || Date.parse(d.t) - Date.parse(day[i - 1].t) > 15 * 60000) runs.push([]); runs[runs.length - 1].push(d); });
    for (const run of runs) {
      const top = run.map(d => `${f1(X(d.t))},${f1(Y(d.max))}`), bot = run.slice().reverse().map(d => `${f1(X(d.t))},${f1(Y(d.min))}`);
      svg += `<polygon points="${top.concat(bot).join(" ")}" fill="#4a9eff" fill-opacity="0.12"/>`;
      svg += run.length > 1 ? `<polyline points="${run.map(d => `${f1(X(d.t))},${f1(Y(d.avg))}`).join(" ")}" fill="none" stroke="#4a9eff" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`
        : `<circle cx="${f1(X(run[0].t))}" cy="${f1(Y(run[0].avg))}" r="2" fill="#4a9eff"/>`;
    }
    const sel = S.health.hrSel != null && day[S.health.hrSel];
    if (sel) svg += `<line x1="${f1(X(sel.t))}" x2="${f1(X(sel.t))}" y1="${T}" y2="${base}" stroke="#8892b0" stroke-width="1"/>`;
    const dot = sel || day[day.length - 1];
    svg += `<circle cx="${f1(X(dot.t))}" cy="${f1(Y(dot.avg))}" r="4" fill="#4a9eff" stroke="#141824" stroke-width="2"/>`;
    svg += `<rect x="${L}" y="${T}" width="${pw}" height="${ph + B}" fill="transparent" data-act="hrTap" data-x0="${L}" data-pw="${pw}" data-w="${W}" aria-label="Heart rate through today"/>`;
    return `<svg class="hchart" viewBox="0 0 ${W} ${H}" role="group" aria-label="Heart rate today">${svg}</svg>`;
  }
  // Resting heart rate by day: a line, the latest value labelled at its end.
  function restingSvg(rest) {
    const W = 320, H = 130, L = 30, R = 30, T = 10, B = 18;
    const pw = W - L - R, ph = H - T - B;
    const { lo, hi } = niceSteps(Math.min(...rest.map(r => r.bpm)) - 2, Math.max(...rest.map(r => r.bpm)) + 2, 5);
    const X = i => L + (i / Math.max(1, rest.length - 1)) * pw;
    const Y = v => T + ph - ((v - lo) / (hi - lo || 1)) * ph;
    let svg = "";
    for (let v = lo; v <= hi; v += 5) svg += `<line x1="${L}" x2="${W - R}" y1="${f1(Y(v))}" y2="${f1(Y(v))}" stroke="#1e2535" stroke-width="1"/><text x="${L - 5}" y="${f1(Y(v) + 3)}" fill="#5a6480" font-size="9" text-anchor="end">${v}</text>`;
    svg += `<polyline points="${rest.map((r, i) => `${f1(X(i))},${f1(Y(r.bpm))}`).join(" ")}" fill="none" stroke="#4a9eff" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    const n = rest.length - 1;
    svg += `<text x="${L}" y="${H - 5}" fill="#5a6480" font-size="9">${esc(shortDate(rest[0].day))}</text><text x="${W - R}" y="${H - 5}" fill="#5a6480" font-size="9" text-anchor="end">${esc(shortDate(rest[n].day))}</text>`;
    const s = S.health.restSel != null && rest[S.health.restSel] ? S.health.restSel : null;
    if (s != null && s !== n) svg += `<line x1="${f1(X(s))}" x2="${f1(X(s))}" y1="${T}" y2="${T + ph}" stroke="#8892b0" stroke-width="1"/><circle cx="${f1(X(s))}" cy="${f1(Y(rest[s].bpm))}" r="4" fill="#4a9eff" stroke="#141824" stroke-width="2"/>`;
    svg += `<circle cx="${f1(X(n))}" cy="${f1(Y(rest[n].bpm))}" r="4" fill="#4a9eff" stroke="#141824" stroke-width="2"/><text x="${f1(X(n) + 8)}" y="${f1(Y(rest[n].bpm) + 3.5)}" fill="#c8cee0" font-size="10.5" font-weight="700">${rest[n].bpm}</text>`;
    svg += `<rect x="${L - 6}" y="${T}" width="${pw + 12}" height="${ph + B}" fill="transparent" data-act="restTap" data-x0="${L}" data-pw="${pw}" data-w="${W}" data-n="${rest.length}" aria-label="Resting heart rate by day"/>`;
    return `<svg class="hchart" viewBox="0 0 ${W} ${H}" role="group" aria-label="Resting heart rate, last ${rest.length} days">${svg}</svg>`;
  }
  // Where a tap landed along a chart, in its own units (0..1 across the plot).
  function tapFrac(el, ev) {
    const svg = el.ownerSVGElement || el.closest("svg");
    const box = svg.getBoundingClientRect();
    const scale = +el.dataset.w / (box.width || +el.dataset.w);
    const x = ((ev && ev.clientX != null ? ev.clientX : box.left + box.width / 2) - box.left) * scale;
    return Math.max(0, Math.min(1, (x - +el.dataset.x0) / +el.dataset.pw));
  }

  // A–Z, or most used first: how often you've logged each one (your own diary).
  function sorted(list) {
    const out = byName(list);
    if (S.sort !== "used") return out;
    const n = new Map();
    for (const e of S.diary) if (e.ref_id) n.set(e.ref_id, (n.get(e.ref_id) || 0) + 1);
    return out.sort((a, b) => (n.get(b.id) || 0) - (n.get(a.id) || 0));   // ties stay A–Z
  }
  const sortBar = () => `<div class="sortbar">${segHtml([["az", "A–Z"], ["used", "Most used"]], S.sort, "sortBy")}</div>`;
  const fixedOf = f => (+f.fixed_amount > 0 ? +f.fixed_amount : 0);

  const libBar = () => `<div class="sortbar">${segHtml([["foods", "Foods"], ["dishes", "Dishes"]], S.view, "libTab")}</div>`;
  function viewFoods() {
    return libBar() + `<div class="row" style="margin-bottom:10px">
        <input class="inp grow" id="foodSearch" data-live="foodSearch" placeholder="Search foods" value="${esc(S.foodQuery)}" autocomplete="off">
        <button class="btn blue" data-act="scan" data-from="foods" style="padding:10px 12px">Scan</button>
        <button class="btn primary" data-act="newFood" style="padding:10px 14px">+ New</button></div>
      ${S.foods.length > 1 ? sortBar() : ""}
      <div id="foodList">${foodListHtml()}</div>`;
  }
  function foodListHtml() {
    if (!S.foods.length) return `<div class="card empty">No foods yet. Scan a barcode, or add one straight from the packet — the calories and macros for a weight, like per 100 g.</div>`;
    const q = S.foodQuery.trim().toLowerCase();
    const list = sorted(S.foods).filter(f => !q || f.name.toLowerCase().includes(q));
    if (!list.length) return `<div class="card empty">No foods match “${esc(S.foodQuery)}”.</div>`;
    return `<div class="list">${list.map(f => `<div class="item tap" data-act="editFood" data-id="${f.id}">
      <div class="grow"><div class="name ellip">${esc(f.name)}</div><div class="macros">${macroLine(f)}</div></div>
      <div style="text-align:right"><div class="kcal">${fmtK(f.kcal)}</div><div class="tiny faint">per ${basisText(f.unit)}</div>
        ${fixedOf(f) ? `<div class="tiny fixed">fixed ${esc(amountText(fixedOf(f), f.unit))}</div>` : ""}</div></div>`).join("")}</div>${sharedNote}`;
  }
  const sharedNote = `<div class="tiny faint" style="text-align:center;margin:-4px 0 12px">Shared with your household · diaries stay private</div>`;

  function viewDishes() {
    let html = libBar() + `<button class="btn primary block" data-act="newDish" style="margin-bottom:12px">+ New dish</button>`;
    if (!S.dishes.length) return html + `<div class="card empty">No dishes yet. A dish is a recipe made from your foods: add the ingredients and it works out the calories and macros per portion.</div>`;
    const fb = foodsById();
    if (S.dishes.length > 1) html += sortBar();
    html += `<div class="list">${sorted(S.dishes).map(d => {
      const t = dishTotals(d, fb);
      const per = scaleN(t, 1 / (+d.portions || 1));
      const n = (d.items || []).length;
      return `<div class="item tap" data-act="editDish" data-id="${d.id}">
        <div class="grow"><div class="name ellip">${esc(d.name)}</div>
          <div class="sub">${esc(amountText(d.portions, "portion"))} · ${n} ingredient${n === 1 ? "" : "s"}${t.missing ? ` · <span style="color:var(--amber)">${t.missing} missing</span>` : ""}</div>
          <div class="macros">${macroLine(per)}</div></div>
        <div style="text-align:right"><div class="kcal">${fmtK(per.kcal)}</div><div class="tiny faint">per portion</div></div></div>`;
    }).join("")}</div>${sharedNote}`;
    return html;
  }

  function weightInputs(unit, kg, prefix) {
    if (unit === "stlb") {
      const v = kg ? kgToStLb(kg) : { st: "", lb: "" };
      return `<div class="grid2"><div class="row"><input class="inp" id="${prefix}St" type="number" inputmode="decimal" step="any" value="${v.st}" placeholder="st"><span class="muted">st</span></div>
        <div class="row"><input class="inp" id="${prefix}Lb" type="number" inputmode="decimal" step="any" value="${v.lb}" placeholder="lb"><span class="muted">lb</span></div></div>`;
    }
    return `<div class="row"><input class="inp" id="${prefix}Kg" type="number" inputmode="decimal" step="any" value="${kg ? (+kg).toFixed(1) : ""}" placeholder="kg"><span class="muted">kg</span></div>`;
  }
  function readWeight(unit, prefix) {
    const val = id => { const el = document.getElementById(id); return el ? el.value : ""; };
    const kg = unit === "stlb" ? (val(prefix + "St") === "" && val(prefix + "Lb") === "" ? NaN : stLbToKg(num(val(prefix + "St")) || 0, num(val(prefix + "Lb")) || 0)) : num(val(prefix + "Kg"));
    return kg >= 20 && kg <= 400 ? Math.round(kg * 100) / 100 : NaN;
  }

  function chartSvg(ws, goal, unit) {
    const pts = ws.slice(-90);
    const W = 320, H = 150, P = 12, TOP = 20, BOT = 18;   // label bands above and below the line
    const xs = pts.map(w => parseIso(w.day).getTime());
    let lo = Math.min(...pts.map(w => +w.kg)), hi = Math.max(...pts.map(w => +w.kg));
    if (goal) { lo = Math.min(lo, goal); hi = Math.max(hi, goal); }
    if (hi - lo < 1) { hi += 0.5; lo -= 0.5; }
    const x0 = xs[0], x1 = xs[xs.length - 1];
    const X = t => (x1 === x0 ? W / 2 : P + ((t - x0) / (x1 - x0)) * (W - 2 * P));
    const Y = v => TOP + ((hi - v) / (hi - lo)) * (H - TOP - BOT);
    const path = pts.map((w, i) => `${i ? "L" : "M"}${X(xs[i]).toFixed(1)},${Y(+w.kg).toFixed(1)}`).join(" ");
    const goalLine = goal ? `<line x1="${P}" x2="${W - P}" y1="${Y(goal).toFixed(1)}" y2="${Y(goal).toFixed(1)}" stroke="#00c88c" stroke-dasharray="4 4" stroke-width="1" opacity=".8"/>
      <text x="${W - P}" y="${(Y(goal) - 4).toFixed(1)}" fill="#00c88c" font-size="9" text-anchor="end">goal</text>` : "";
    const dots = pts.length <= 45 ? pts.map((w, i) => `<circle cx="${X(xs[i]).toFixed(1)}" cy="${Y(+w.kg).toFixed(1)}" r="2.6" fill="#4a9eff"/>`).join("") : "";
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Weight trend" style="margin-top:12px">
      <text x="${P}" y="9" fill="#5a6480" font-size="9">${esc(fmtWeight(hi, unit))}</text>
      <text x="${P}" y="${H - 2}" fill="#5a6480" font-size="9">${esc(fmtWeight(lo, unit))}</text>
      ${goalLine}<path d="${path}" fill="none" stroke="#4a9eff" stroke-width="2" stroke-linejoin="round"/>${dots}</svg>`;
  }

  function viewWeight() {
    const unit = S.settings.weight_unit || "kg";
    const ws = [...S.weights].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    const today = isoDay();
    const todays = ws.find(w => w.day === today);
    const latest = ws[ws.length - 1];
    let html = `<div class="card"><div class="label" style="margin-bottom:8px">${todays ? "Today's weight" : "Log today's weight"}</div>
      ${weightInputs(unit, todays ? todays.kg : latest ? latest.kg : null, "w")}
      <button class="btn primary block" data-act="saveWeight" style="margin-top:10px">${todays ? "Update" : "Save"}</button></div>`;
    if (!ws.length) return html + `<div class="card empty">No weights logged yet.</div>`;
    const first = ws[0];
    const weekAgo = [...ws].reverse().find(w => w.day <= addDays(today, -7));
    const goal = +S.settings.goal_kg || 0;
    html += `<div class="card"><div class="row" style="align-items:flex-start">
      <div class="grow"><div class="label">Latest</div><div style="font-size:22px;font-weight:800">${fmtWeight(latest.kg, unit)}</div><div class="tiny faint">${esc(dayLabel(latest.day))}</div></div>
      <div style="text-align:right" class="small muted">
        ${weekAgo && weekAgo !== latest ? `<div>vs a week ago <b class="soft" style="color:var(--soft)">${fmtDelta(latest.kg - weekAgo.kg, unit)}</b></div>` : ""}
        ${ws.length > 1 ? `<div style="margin-top:3px">since ${esc(dayLabel(first.day))} <b style="color:var(--soft)">${fmtDelta(latest.kg - first.kg, unit)}</b></div>` : ""}
        ${goal ? `<div style="margin-top:3px">goal ${fmtWeight(goal, unit)} · <b style="color:var(--green)">${Math.abs(latest.kg - goal) < 0.05 ? "reached" : fmtDelta(latest.kg - goal, unit).slice(1) + " to go"}</b></div>` : ""}
      </div></div>
      ${ws.length > 1 ? chartSvg(ws, goal, unit) : ""}</div>`;
    const rev = [...ws].reverse().slice(0, 90);
    html += `<div class="list">${rev.map((w, i) => {
      const prev = rev[i + 1];
      return `<div class="item tap" data-act="editWeight" data-id="${w.id}">
        <div class="grow"><div class="name">${esc(dayLabel(w.day))}</div>${/^(Today|Yesterday)$/.test(dayLabel(w.day)) ? `<div class="sub">${esc(longDate(w.day))}</div>` : ""}</div>
        <div style="text-align:right"><div class="kcal">${fmtWeight(w.kg, unit)}</div>${prev ? `<div class="tiny faint">${fmtDelta(w.kg - prev.kg, unit)}</div>` : ""}</div></div>`;
    }).join("")}</div>`;
    return html;
  }

  // ── Sheets ────────────────────────────────────────────────────────────────
  function showSheet(html) {
    $sheet.innerHTML = `<div class="veil" data-act="closeVeil"><div class="sheet">${html}</div></div>`;
  }
  function closeSheet() {
    stopScan();
    if (ctx && ctx.kind === "news") pref.set("seenVersion", APP_VERSION);   // seen, however it was closed
    ctx = null;
    $sheet.innerHTML = "";
  }
  const closeX = `<button class="iconbtn x" data-act="closeSheet" aria-label="Close">✕</button>`;
  const segHtml = (opts, cur, act) => `<div class="seg">${opts.map(([k, l]) => `<button type="button" data-act="${act}" data-k="${k}" class="${cur === k ? "on" : ""}">${l}</button>`).join("")}</div>`;
  const nutPreview = (n, note) => `<div class="row"><div class="grow"><div class="label">${note}</div><div class="macros" style="margin-top:4px">${macroLine(n)}</div></div><div class="kcal" style="font-size:18px">${fmtK(n.kcal)} <span class="tiny dim">kcal</span></div></div>`;

  // Add to the diary: pick a food or dish, then an amount.
  function openAdd(meal) {
    ctx = { kind: "pick", meal, q: "" };
    showSheet(pickHtml());
  }
  function recentMap() {
    const m = new Map();
    for (const e of S.diary) if (e.ref_id) { const t = e.created_at || e.day; if (!m.has(e.ref_id) || m.get(e.ref_id) < t) m.set(e.ref_id, t); }
    return m;
  }
  function pickHtml() {
    return `${closeX}<h3>Add to ${esc(mealName(ctx.meal))}</h3>
      <div class="row search"><input class="inp grow" data-live="pickSearch" placeholder="Search foods and dishes" value="${esc(ctx.q)}" autocomplete="off">
        <button class="btn blue" data-act="scan" data-from="pick" style="padding:10px 12px">Scan</button></div>
      <div id="pickList">${pickListHtml()}</div>`;
  }
  function pickListHtml() {
    if (!S.foods.length && !S.dishes.length) return `<div class="empty">No foods yet.</div><button class="btn blue block" data-act="newFoodFromPick">+ Add a food</button>`;
    const rec = recentMap();
    const q = ctx.q.trim().toLowerCase();
    const all = [...S.foods.map(f => ({ kind: "food", obj: f })), ...S.dishes.map(d => ({ kind: "dish", obj: d }))]
      .filter(x => !q || x.obj.name.toLowerCase().includes(q))
      .sort((a, b) => {
        const ra = rec.get(a.obj.id) || "", rb = rec.get(b.obj.id) || "";
        if (ra !== rb) return ra < rb ? 1 : -1;
        return a.obj.name.localeCompare(b.obj.name, "en", { sensitivity: "base" });
      });
    const newBtn = `<button class="btn ghost block" data-act="newFoodFromPick" style="margin-top:4px">+ New food${ctx.q.trim() ? ` “${esc(ctx.q.trim())}”` : ""}</button>`;
    if (!all.length) return `<div class="empty">Nothing matches.</div>${newBtn}`;
    const fb = foodsById();
    return `<div class="list">${all.slice(0, 80).map(x => {
      const fixed = x.kind === "food" ? fixedOf(x.obj) : 0;
      const per = x.kind === "food" ? (fixed ? foodFor(x.obj, fixed) : x.obj) : scaleN(dishTotals(x.obj, fb), 1 / (+x.obj.portions || 1));
      const note = fixed ? `<div class="tiny fixed">adds ${esc(amountText(fixed, x.obj.unit))}</div>`
        : `<div class="tiny faint">per ${x.kind === "food" ? basisText(x.obj.unit) : "portion"}</div>`;
      return `<div class="item tap" data-act="pick" data-kind="${x.kind}" data-id="${x.obj.id}">
        <div class="grow"><div class="name ellip">${esc(x.obj.name)}${x.kind === "dish" ? ` <span class="tiny" style="color:var(--amber)">dish</span>` : ""}</div><div class="macros">${macroLine(per)}</div></div>
        <div style="text-align:right"><div class="kcal">${fmtK(per.kcal)}</div>${note}</div></div>`;
    }).join("")}</div>${newBtn}`;
  }
  // The amount you last logged for this food or dish (in `unit`, if given).
  function lastLogged(id, unit) {
    let best = null;
    for (const e of S.diary) {
      if (e.ref_id !== id || !(+e.amount > 0) || (unit && e.amount_unit !== unit)) continue;
      if (!best || String(e.created_at || e.day) > String(best.created_at || best.day)) best = e;
    }
    return best;
  }
  // Foods with a fixed portion go straight into the diary; everything else asks how much.
  function pickItem(kind, id, meal) {
    const f = kind === "food" ? S.foods.find(x => x.id === id) : null;
    if (f && fixedOf(f)) return quickAdd(f, meal);
    openAmount(kind, id, meal);
  }
  let adding = false;
  async function quickAdd(food, meal) {
    if (adding) return;   // ignore a double tap
    adding = true;
    try {
      await busy(null, async () => {
        const amount = fixedOf(food);
        const row = { user_id: S.user.id, day: S.day, meal, kind: "food", ref_id: food.id, name: food.name, amount, amount_unit: food.unit, ...roundN(foodFor(food, amount)) };
        const saved = await run(() => sb.from("ct_diary").insert(row).select().single());
        S.diary.push(saved);
        closeSheet(); render(); addedToast(saved);
      });
    } finally { adding = false; }
  }
  function openAmount(kind, id, meal) {
    const obj = kind === "food" ? S.foods.find(f => f.id === id) : S.dishes.find(d => d.id === id);
    if (!obj) return;
    let unit, amount;
    if (kind === "food") {
      unit = obj.unit;
      const last = lastLogged(id, unit);
      amount = last ? +last.amount : basisOf(unit);
    } else {
      const last = lastLogged(id);
      unit = last && (last.amount_unit === "portion" || (last.amount_unit === "g" && obj.cooked_grams)) ? last.amount_unit : "portion";
      amount = last && last.amount_unit === unit ? +last.amount : 1;
    }
    ctx = { kind: "amount", item: kind, id, meal, unit, amount };
    showSheet(amountHtml());
  }
  function amountNut() {
    const fb = foodsById();
    if (ctx.item === "food") { const f = fb[ctx.id]; return f ? foodFor(f, num(ctx.amount) || 0) : zero(); }
    const d = S.dishes.find(x => x.id === ctx.id);
    return d ? dishFor(d, fb, num(ctx.amount) || 0, ctx.unit) : zero();
  }
  function amountHtml() {
    const obj = ctx.item === "food" ? S.foods.find(f => f.id === ctx.id) : S.dishes.find(d => d.id === ctx.id);
    const units = ctx.item === "food" ? [[obj.unit, unitWord(obj.unit, 2)]] : [["portion", "Portions"], ...(obj.cooked_grams ? [["g", "Grams"]] : [])];
    return `${closeX}<h3>${esc(obj.name)}</h3>
      <div class="field"><span class="label">Amount</span>
        <div class="row"><input class="inp" id="amt" data-live="amt" type="number" inputmode="decimal" step="any" value="${esc(ctx.amount)}" style="max-width:130px">
        ${units.length > 1 ? `<div class="grow">${segHtml(units, ctx.unit, "amtUnit")}</div>` : `<span class="muted">${esc(units[0][1])}</span>`}</div></div>
      <div class="field"><span class="label">Meal</span>${segHtml(MEALS, ctx.meal, "amtMeal")}</div>
      <div class="preview" id="pv">${nutPreview(amountNut(), "This adds")}</div>
      <button class="btn primary block" data-act="saveEntry">${S.day === isoDay() ? "Add" : "Add to " + esc(dayLabel(S.day))}</button>`;
  }

  // Edit a diary entry: scaled from what was logged, so history stays as it was.
  function openEditEntry(id) {
    const e = S.diary.find(x => x.id === id);
    if (!e) return;
    ctx = { kind: "entry", id, meal: e.meal, amount: e.amount };
    showSheet(entryHtml());
  }
  function entryNut() {
    const e = S.diary.find(x => x.id === ctx.id);
    const a = num(ctx.amount) || 0;
    return e && +e.amount ? scaleN(e, a / +e.amount) : zero();
  }
  function entryHtml() {
    const e = S.diary.find(x => x.id === ctx.id);
    return `${closeX}<h3>${esc(e.name)}</h3>
      <div class="field"><span class="label">Amount</span><div class="row">
        <input class="inp" id="amt" data-live="entryAmt" type="number" inputmode="decimal" step="any" value="${esc(ctx.amount)}" style="max-width:130px">
        <span class="muted">${esc(unitWord(e.amount_unit, 2))}</span></div></div>
      <div class="field"><span class="label">Meal</span>${segHtml(MEALS, ctx.meal, "entryMeal")}</div>
      <div class="preview" id="pv">${nutPreview(entryNut(), "Now")}</div>
      <div class="grid2"><button class="btn danger" data-act="deleteEntry">Delete</button><button class="btn primary" data-act="updateEntry">Save</button></div>`;
  }

  // Food form. Values are typed exactly as on the label, for whatever weight it shows.
  // `opts` can pre-fill a new food (from a scan) and say what to do after saving.
  function openFood(food, opts = {}) {
    const unit = food ? food.unit : opts.unit || "g";
    const v = food || opts.vals;
    ctx = {
      kind: "food", id: food ? food.id : null, then: opts.then || null, note: opts.note || "",
      name: food ? food.name : opts.name || "", unit, basis: basisOf(unit),
      vals: v ? { kcal: v.kcal, protein: v.protein, carbs: v.carbs, fat: v.fat } : { kcal: "", protein: "", carbs: "", fat: "" },
      barcode: (food ? food.barcode : opts.barcode) || "",
      fixedOn: food ? !!fixedOf(food) : +opts.fixed > 0,
      fixed: food ? (fixedOf(food) || "") : (+opts.fixed > 0 ? opts.fixed : ""),
    };
    showSheet(foodHtml());
  }
  function foodStoredPreview() {
    const vals = { kcal: num(ctx.vals.kcal) || 0, protein: num(ctx.vals.protein) || 0, carbs: num(ctx.vals.carbs) || 0, fat: num(ctx.vals.fat) || 0 };
    const b = num(ctx.basis);
    if (!(b > 0) || b === basisOf(ctx.unit)) return "";
    const s = toStored(ctx.unit, b, vals);
    return nutPreview(s, `Saved as per ${basisText(ctx.unit)}`);
  }
  function foodHtml() {
    const v = ctx.vals;
    const valIn = (k, label) => `<div><span class="label" style="display:block;margin-bottom:4px">${label}</span>
      <input class="inp" data-live="fVal" data-k="${k}" type="number" inputmode="decimal" step="any" value="${esc(v[k])}" placeholder="0"></div>`;
    const pv = foodStoredPreview();
    const unitLabel = ctx.unit === "item" ? "item(s)" : ctx.unit;
    return `${closeX}<h3>${ctx.id ? "Edit food" : "New food"}</h3>
      ${ctx.note ? `<div class="note">${esc(ctx.note)}</div>` : ""}
      <div class="field"><span class="label">Name</span><input class="inp" id="fName" data-live="fName" value="${esc(ctx.name)}" placeholder="e.g. Greek yoghurt" autocomplete="off"></div>
      <div class="field"><span class="label">Measured in</span>${segHtml([["g", "Grams"], ["ml", "Millilitres"], ["item", "Items"]], ctx.unit, "fUnit")}</div>
      <div class="field"><span class="label">Values for</span><div class="row">
        <input class="inp" id="fBasis" data-live="fBasis" type="number" inputmode="decimal" step="any" value="${esc(ctx.basis)}" style="max-width:100px">
        <span class="muted">${unitLabel}</span><span class="tiny faint grow">as on the label</span></div></div>
      <div class="grid4" style="margin-bottom:11px">${valIn("kcal", "kcal")}${valIn("protein", "Protein")}${valIn("carbs", "Carbs")}${valIn("fat", "Fat")}</div>
      <div class="preview${pv ? "" : " hidden"}" id="fpv">${pv}</div>
      <div class="field"><span class="label">Portion</span>${segHtml([["choose", "Choose each time"], ["fixed", "Always the same"]], ctx.fixedOn ? "fixed" : "choose", "fFixedMode")}
        ${ctx.fixedOn ? `<div class="row" style="margin-top:8px"><input class="inp" id="fFixed" data-live="fFixed" type="number" inputmode="decimal" step="any" value="${esc(ctx.fixed)}" placeholder="e.g. 70" style="max-width:100px">
          <span class="muted">${unitLabel}</span><span class="tiny faint grow">added in one tap</span></div>` : ""}</div>
      <div class="field"><span class="label">Barcode</span><div class="row">
        ${ctx.barcode ? `<span class="grow small" style="color:var(--soft)">${esc(ctx.barcode)}</span><button class="btn ghost sm" data-act="fBarcodeClear">Remove</button>`
                      : `<span class="grow tiny faint">Link one so a scan finds this food</span><button class="btn blue sm" data-act="scan" data-from="link">Scan</button>`}</div></div>
      ${ctx.id ? `<div class="grid2"><button class="btn danger" data-act="deleteFood">Delete</button><button class="btn primary" data-act="saveFood">Save</button></div>`
               : `<button class="btn primary block" data-act="saveFood">Save food</button>`}`;
  }

  // Dish form: ingredients from the foods list; totals update as you type.
  function openDish(dish) {
    ctx = {
      kind: "dish", id: dish ? dish.id : null, name: dish ? dish.name : "",
      portions: dish ? dish.portions : 1, cooked: dish && dish.cooked_grams ? dish.cooked_grams : "",
      items: dish ? (dish.items || []).map(it => ({ food_id: it.food_id, amount: it.amount })) : [], picking: false, q: "",
    };
    showSheet(dishHtml());
  }
  const dishDraft = () => ({ items: ctx.items.map(it => ({ food_id: it.food_id, amount: num(it.amount) || 0 })), portions: num(ctx.portions) || 1, cooked_grams: num(ctx.cooked) > 0 ? num(ctx.cooked) : null });
  function dishTotalsHtml() {
    const fb = foodsById();
    const d = dishDraft();
    const t = dishTotals(d, fb);
    const per = scaleN(t, 1 / d.portions);
    return `${nutPreview(per, `Per portion (of ${fmtAmt(d.portions)})`)}
      <div class="row tiny muted" style="margin-top:8px"><span class="grow">Whole dish ${fmtK(t.kcal)} kcal${t.grams ? ` · ${fmtK(t.grams)} g raw` : ""}</span>
      ${d.cooked_grams ? `<span>${fmtK((t.kcal / d.cooked_grams) * 100)} kcal per 100 g cooked</span>` : ""}</div>`;
  }
  function dishHtml() {
    const fb = foodsById();
    const rows = ctx.items.map((it, i) => {
      const f = fb[it.food_id];
      if (!f) return `<div class="ing"><span class="small" style="color:var(--amber)">Deleted food</span><span></span><span></span><button class="x-btn" data-act="ingDel" data-i="${i}">✕</button></div>`;
      return `<div class="ing"><span class="name ellip" style="font-size:13px">${esc(f.name)}</span>
        <div class="row" style="gap:4px"><input class="inp" id="ing${i}" data-live="ingAmt" data-i="${i}" type="number" inputmode="decimal" step="any" value="${esc(it.amount)}"><span class="tiny dim">${f.unit === "item" ? "×" : f.unit}</span></div>
        <span class="small muted" style="text-align:right" id="ingK${i}">${fmtK(foodFor(f, num(it.amount) || 0).kcal)}</span>
        <button class="x-btn" data-act="ingDel" data-i="${i}" aria-label="Remove">✕</button></div>`;
    }).join("");
    const picker = ctx.picking ? `<div style="margin-top:8px"><input class="inp search" data-live="ingSearch" placeholder="Search your foods" value="${esc(ctx.q)}" autocomplete="off">
        <div id="ingPickList">${ingPickHtml()}</div></div>`
      : `<button class="btn ghost block" data-act="ingAdd" style="margin-top:8px">+ Add ingredient</button>`;
    return `${closeX}<h3>${ctx.id ? "Edit dish" : "New dish"}</h3>
      <div class="field"><span class="label">Name</span><input class="inp" id="dName" data-live="dName" value="${esc(ctx.name)}" placeholder="e.g. Chilli con carne" autocomplete="off"></div>
      <div class="grid2 field">
        <div><span class="label" style="display:block;margin-bottom:5px">Portions</span><input class="inp" data-live="dPortions" type="number" inputmode="decimal" step="any" value="${esc(ctx.portions)}"></div>
        <div><span class="label" style="display:block;margin-bottom:5px">Cooked weight (g)</span><input class="inp" data-live="dCooked" type="number" inputmode="decimal" step="any" value="${esc(ctx.cooked)}" placeholder="optional"></div>
      </div>
      <div class="label" style="margin:4px 0 2px">Ingredients</div>
      <div>${rows || `<div class="tiny faint" style="padding:8px 0">None yet.</div>`}</div>
      ${picker}
      <div class="preview" id="dpv" style="margin-top:12px">${dishTotalsHtml()}</div>
      ${ctx.id ? `<div class="grid2"><button class="btn danger" data-act="deleteDish">Delete</button><button class="btn primary" data-act="saveDish">Save</button></div>`
               : `<button class="btn primary block" data-act="saveDish">Save dish</button>`}`;
  }
  function ingPickHtml() {
    const q = ctx.q.trim().toLowerCase();
    const list = byName(S.foods).filter(f => !q || f.name.toLowerCase().includes(q)).slice(0, 60);
    if (!S.foods.length) return `<div class="empty">Add foods first (Library tab).</div>`;
    if (!list.length) return `<div class="empty">No foods match.</div>`;
    return `<div class="list" style="margin-top:6px">${list.map(f => `<div class="item tap" data-act="ingPick" data-id="${f.id}">
      <div class="grow"><div class="name ellip">${esc(f.name)}</div></div><div class="small muted">${fmtK(f.kcal)} / ${basisText(f.unit)}</div></div>`).join("")}</div>`;
  }

  function openWeightEntry(id) {
    const w = S.weights.find(x => x.id === id);
    if (!w) return;
    ctx = { kind: "weight", id };
    const unit = S.settings.weight_unit || "kg";
    showSheet(`${closeX}<h3>${esc(longDate(w.day))}</h3>
      <div class="field">${weightInputs(unit, w.kg, "e")}</div>
      <div class="grid2"><button class="btn danger" data-act="deleteWeight">Delete</button><button class="btn primary" data-act="updateWeight">Save</button></div>`);
  }

  function openSettings() {
    const st = S.settings;
    const unit = st.weight_unit || "kg";
    ctx = { kind: "settings", unit, hour: remindHour() };
    const tIn = (k, label) => `<div><span class="label" style="display:block;margin-bottom:4px">${label}</span>
      <input class="inp" id="t_${k}" type="number" inputmode="decimal" step="any" value="${st[k + "_target"] != null ? esc(st[k + "_target"]) : ""}" placeholder="—"></div>`;
    showSheet(`${closeX}<h3>Settings</h3>
      <div class="field"><span class="label">Your name</span><input class="inp" id="dispName" maxlength="40" autocomplete="given-name" value="${esc(st.display_name || "")}" placeholder="e.g. Hollie"></div>
      <div class="label" style="margin-bottom:6px">Daily targets</div>
      <div class="grid4" style="margin-bottom:12px">${tIn("kcal", "kcal")}${tIn("protein", "Protein g")}${tIn("carbs", "Carbs g")}${tIn("fat", "Fat g")}</div>
      <div class="field"><span class="label">Weight in</span>${segHtml([["kg", "Kilograms"], ["stlb", "Stones & pounds"]], unit, "setUnit")}</div>
      <div class="field"><span class="label">Goal weight (optional)</span><div id="goalBox">${weightInputs(unit, st.goal_kg || null, "g")}</div></div>
      ${st.fit_status ? `<div class="field"><span class="label">Daily step goal</span><input class="inp" id="stepGoal" type="number" inputmode="numeric" step="500" value="${+st.step_goal > 0 ? esc(st.step_goal) : ""}" placeholder="10000"></div>` : ""}
      <button class="btn primary block" data-act="saveSettings">Save</button>
      <div class="field" style="margin-top:16px"><span class="label">Fitbit</span><div class="row">
        ${st.fit_status === "linked" ? `<span class="grow small muted">Connected. Calories burned, steps, sleep and heart rate come from your Fitbit.</span><button class="btn ghost sm" data-act="fitDisconnect">Disconnect</button>`
          : st.fit_status === "reauth" ? `<span class="grow small" style="color:var(--amber)">The link has run out.</span><button class="btn blue sm" data-act="fitConnect">Reconnect</button>`
          : `<span class="grow small muted">See the calories you burn, your steps, sleep and heart rate, from your Fitbit.</span><button class="btn blue sm" data-act="fitConnect">Connect</button>`}</div>
        ${st.fit_status === "linked" && !(hasScope("sleep") && hasScope("heart")) ? `<div class="row" style="margin-top:8px"><span class="grow small" style="color:var(--amber)">Sleep and heart rate need one more permission.</span><button class="btn blue sm" data-act="fitConnect">Allow</button></div>` : ""}</div>
      ${st.fit_status === "linked" ? `<div class="field" id="remindBox">${remindHtml()}</div>` : ""}
      <div class="row" style="margin-top:16px"><span class="grow tiny faint">Vitals v${APP_VERSION}${S.user && S.user.email ? " · " + esc(S.user.email) : ""}</span>
        <button class="btn ghost" data-act="whatsNew" style="padding:8px 12px;font-size:12px">What's new</button>
        <button class="btn ghost" data-act="signOut" style="padding:8px 12px;font-size:12px">Sign out</button></div>`);
    if (st.fit_status === "linked") checkPush();
  }

  // ── What's new ────────────────────────────────────────────────────────────
  // After an update, a note of what's changed shows once on each phone (every version since it
  // was last opened; not on a new install). Add an entry, newest first, with every update you'd notice.
  const WHATS_NEW = [
    { v: "2.1.0", date: "3 Oct 2026", items: [
      "<b>What's new</b> — after each update, a note like this says what's changed. See it again any time in Settings (⚙).",
    ] },
  ];
  const NEWS_FROM = "2.0.1";   // a phone that had the app before these notes started sees everything after this
  function verCmp(a, b) {
    const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; }
    return 0;
  }
  let newsChecked = false, bootSignedIn = false;
  function whatsNewCheck() {
    if (newsChecked) return;
    newsChecked = true;
    const seen = pref.get("seenVersion", "");
    if (seen === APP_VERSION) return;
    if (!seen && !bootSignedIn) { pref.set("seenVersion", APP_VERSION); return; }   // a new install: nothing has changed for them
    const since = seen || NEWS_FROM;
    const notes = WHATS_NEW.filter(n => verCmp(n.v, since) > 0 && verCmp(n.v, APP_VERSION) <= 0);
    if (!notes.length) { pref.set("seenVersion", APP_VERSION); return; }
    if (!ctx) showNews(notes);
  }
  function showNews(notes) {
    ctx = { kind: "news" };
    showSheet(`${closeX}<h3>What's new</h3>
      ${notes.map(n => `<div class="news"><div class="label">Version ${esc(n.v)} · ${esc(n.date)}</div><ul>${n.items.map(i => `<li>${i}</li>`).join("")}</ul></div>`).join("")}
      <button class="btn primary block" data-act="closeSheet">Got it</button>`);
  }

  // ── Step reminder: a notification from the server when you're under your step goal ──
  // Each phone opts in: its push subscription is saved in ct_push_subs; the server checks
  // hourly and nudges at the chosen hour. iPhones need the app on the Home Screen for this.
  const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const onIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
  const deviceName = () => (onIOS() ? "iPhone" : /Android/.test(navigator.userAgent) ? "Android" : "Computer");
  const b64uBytes = str => { const t = String(str).replace(/-/g, "+").replace(/_/g, "/"); const bin = atob(t + "===".slice((t.length + 3) % 4)); return Uint8Array.from(bin, c => c.charCodeAt(0)); };
  const swReg = () => Promise.race([navigator.serviceWorker.ready,
    new Promise((_, no) => setTimeout(() => no(oops("Notifications aren't ready on this phone yet — reopen the app and try again.")), 8000))]);
  function sameKey(sub, key) {
    const a = sub && sub.options && sub.options.applicationServerKey;
    if (!a) return false;
    const x = new Uint8Array(a), y = b64uBytes(key);
    return x.length === y.length && x.every((v, i) => v === y[i]);
  }
  const saveSub = sub => { const j = sub.toJSON(); return run(() => sb.from("ct_push_subs").upsert({ endpoint: j.endpoint, user_id: S.user.id, p256dh: j.keys.p256dh, auth: j.keys.auth, device: deviceName() }, { onConflict: "endpoint" })); };
  async function saveRemind(patch) {
    const saved = await run(() => sb.from("ct_settings").upsert({ user_id: S.user.id, ...patch, updated_at: new Date().toISOString() }, { onConflict: "user_id" }).select().single());
    S.settings = saved || { ...S.settings, ...patch };
  }
  const remindNote = hour => {
    const p = S.push;
    if (!p.supported) return onIOS() ? "On iPhone this needs the app on your Home Screen: in Safari tap Share → Add to Home Screen, then open it from there." : "This browser can't show notifications.";
    if (p.perm === "denied") return "Notifications are blocked for this app. Allow them in your phone's settings, then turn this on.";
    return `A notification on this phone at ${hourText(hour)} if you're under ${fmtK(stepGoal())} steps.`;
  };
  function remindHtml() {
    if (!S.push.checked) {   // a first guess until checkPush() has looked
      const ok = pushSupported();
      S.push = { checked: false, supported: ok, perm: ok ? Notification.permission : "default", on: ok && Notification.permission === "granted" && !!S.settings.step_remind };
    }
    const hour = ctx && ctx.kind === "settings" && ctx.hour != null ? ctx.hour : remindHour();
    const hours = [...new Set([17, 18, 19, 20, 21, 22, hour])].sort((a, b) => a - b)
      .map(h => `<option value="${h}"${h === hour ? " selected" : ""}>${hourText(h)}</option>`).join("");
    return `<span class="label">Step reminder</span>
      <div class="row"><div class="grow">${segHtml([["off", "Off"], ["on", "On"]], S.push.on ? "on" : "off", "remindSet")}</div>
        <select class="inp" id="remindHour" data-live="remindHour" aria-label="Reminder time" style="width:auto">${hours}</select></div>
      <div class="tiny faint" id="remindNote" style="margin-top:6px">${esc(remindNote(hour))}</div>`;
  }
  // Is this phone getting reminders? Looked up when Settings opens.
  async function checkPush() {
    const p = { checked: true, supported: pushSupported(), perm: "default", on: false };
    if (p.supported) {
      p.perm = Notification.permission;
      if (p.perm === "granted" && S.settings.step_remind) {
        try {
          const sub = await (await swReg()).pushManager.getSubscription();
          if (sub) { const rows = await run(() => sb.from("ct_push_subs").select("endpoint").eq("endpoint", sub.endpoint)); p.on = !!(rows && rows.length); }
        } catch (e) { console.error(e); }
      }
    }
    S.push = p;
    const box = document.getElementById("remindBox");
    if (box && ctx && ctx.kind === "settings") box.innerHTML = remindHtml();
  }
  async function remindOn(hour) {
    if (!pushSupported()) throw oops(onIOS() ? "On iPhone, add Vitals to your Home Screen first, then open it from there." : "This browser can't show notifications.");
    const perm = await Notification.requestPermission();   // first, while it's still the tap that asked
    S.push.perm = perm;
    if (perm !== "granted") throw oops(perm === "denied" ? "Notifications are blocked — allow them for this app in your phone's settings." : "Reminders need notifications to be allowed.");
    const reg = await swReg();
    const { key } = await fitCall("push_key");
    if (!key) throw oops("Couldn't set up reminders — try again.");
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub, key)) { await sub.unsubscribe(); sub = null; }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uBytes(key) });
    await saveSub(sub);
    await saveRemind({ step_remind: true, remind_hour: hour });
    S.push = { checked: true, supported: true, perm: "granted", on: true };
    const t = await fitCall("push_test").catch(() => ({}));
    toast(t.sent ? "Reminders on — a test notification is on its way." : "Reminders on, but the test notification didn't send. Check notifications are allowed.", !t.sent);
  }
  async function remindOff(quiet) {
    let sub = null;
    if (pushSupported()) { try { sub = await (await swReg()).pushManager.getSubscription(); } catch (e) { /* no worker, so nothing subscribed */ } }
    if (sub) { await run(() => sb.from("ct_push_subs").delete().eq("endpoint", sub.endpoint)); await sub.unsubscribe().catch(() => {}); }
    const left = await run(() => sb.from("ct_push_subs").select("endpoint"));
    if (!left || !left.length) await saveRemind({ step_remind: false });   // no other phone of yours still wants them
    S.push = { ...S.push, on: false };
    if (!quiet) toast("Reminders off on this phone");
  }
  // Browsers can renew a subscription: keep this phone's saved one current.
  async function healPush() {
    if (!S.user || !S.settings.step_remind || !pushSupported() || Notification.permission !== "granted") return;
    try { const sub = await (await swReg()).pushManager.getSubscription(); if (sub) await saveSub(sub); }
    catch (e) { console.error(e); }
  }

  // ── Barcode scanner ───────────────────────────────────────────────────────
  // Opened from the Add sheet ("pick": log it), the Library ("foods": add or
  // edit it) or the food form ("link": attach the barcode to that food).
  let scan = null;   // the running camera session
  function openScan(from) {
    stopScan();
    const back = ctx && (ctx.kind === "pick" || ctx.kind === "food") ? ctx : null;
    ctx = { kind: "scan", from, back, meal: back && back.meal };
    showSheet(`<button class="iconbtn x" data-act="scanBack" aria-label="Close">✕</button><h3>Scan a barcode</h3>
      <div class="scanbox" id="scanBox"><video id="scanVideo" playsinline muted autoplay></video><div class="scanguide"></div></div>
      <div class="small muted" id="scanMsg" style="text-align:center;margin:9px 0 12px">Starting the camera…</div>
      <div class="row"><input class="inp grow" id="scanCode" inputmode="numeric" autocomplete="off" placeholder="Or type the barcode number">
        <button class="btn blue" data-act="scanManual">Find</button></div>`);
    startScan();
  }
  const scanMsg = t => { const m = document.getElementById("scanMsg"); if (m) m.textContent = t; };
  function stopScan() {
    if (!scan) return;
    clearTimeout(scan.timer);
    if (scan.stream) scan.stream.getTracks().forEach(t => t.stop());
    const v = document.getElementById("scanVideo");
    if (v) v.srcObject = null;
    scan = null;
  }
  async function startScan() {
    stopScan();
    const me = { stream: null, timer: null };
    scan = me;
    const box = document.getElementById("scanBox");
    if (box) box.classList.remove("off");
    const live = () => scan === me && ctx && ctx.kind === "scan";
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw Object.assign(new Error("no camera"), { name: "NoCamera" });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } } });
      if (!live()) { stream.getTracks().forEach(t => t.stop()); return; }
      me.stream = stream;
      const video = document.getElementById("scanVideo");
      if (!video) { stopScan(); return; }
      video.muted = true;
      video.setAttribute("playsinline", "");   // iPhone: play inside the page, not full screen
      video.srcObject = stream;
      await video.play().catch(() => {});
      const decode = await makeDecoder();
      if (!live()) return;
      scanMsg("Line the barcode up with the red line");
      const tick = async () => {
        if (!live()) return;
        let raw = null;
        try { raw = await decode(video); } catch (e) { raw = null; }
        if (!live()) return;
        const code = raw ? normCode(raw) : "";
        if (code && validCode(code)) {
          stopScan();
          if (navigator.vibrate) navigator.vibrate(60);
          findCode(code);
          return;
        }
        me.timer = setTimeout(tick, 150);
      };
      tick();
    } catch (e) {
      if (!live()) return;
      stopScan();
      if (box) box.classList.add("off");
      scanMsg(e && (e.name === "NotAllowedError" || e.name === "SecurityError") ? "Camera access is off for this app — allow it in your phone's settings, or type the number below."
        : e && e.name === "ScannerLoad" ? "Couldn't load the scanner — check your connection, or type the number below."
        : "No camera available — type the number below.");
    }
  }
  // The phone's own barcode reader where there is one (Android); otherwise the
  // ZXing decoder, downloaded the first time it's needed (iPhone).
  async function makeDecoder() {
    if ("BarcodeDetector" in window) {
      try {
        const have = await window.BarcodeDetector.getSupportedFormats();
        const want = ["ean_13", "ean_8", "upc_a"].filter(f => have.includes(f));
        if (want.length) {
          const det = new window.BarcodeDetector({ formats: want });
          return async video => { const r = await det.detect(video); return r.length ? r[0].rawValue : null; };
        }
      } catch (e) { /* use ZXing instead */ }
    }
    if (!window.ZXing) {
      await new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "/vendor/zxing.min.js";
        s.onload = resolve;
        s.onerror = () => reject(Object.assign(new Error("scanner didn't load"), { name: "ScannerLoad" }));
        document.head.appendChild(s);
      });
    }
    const Z = window.ZXing;
    const hints = new Map();
    hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A]);
    hints.set(Z.DecodeHintType.TRY_HARDER, true);
    const reader = new Z.MultiFormatReader();
    reader.setHints(hints);
    const canvas = document.createElement("canvas");
    const g = canvas.getContext("2d", { willReadFrequently: true });
    return async video => {
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) return null;
      // The middle of the picture, around the guide line, at most 800 px wide.
      const sw = Math.round(vw * 0.8), sh = Math.round(vh * 0.5);
      const k = Math.min(1, 800 / sw);
      canvas.width = Math.round(sw * k); canvas.height = Math.round(sh * k);
      g.drawImage(video, Math.round((vw - sw) / 2), Math.round((vh - sh) / 2), sw, sh, 0, 0, canvas.width, canvas.height);
      try {
        return reader.decodeWithState(new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(canvas)))).getText();
      } catch (e) { return null; }   // no barcode in this frame
    };
  }
  async function lookupOFF(code) {
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = setTimeout(() => { if (ctl) ctl.abort(); }, 9000);
    try {
      const res = await fetch(`${OFF_URL}${code}.json?fields=${OFF_FIELDS}`, ctl ? { signal: ctl.signal } : {});
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("lookup failed " + res.status);
      const j = await res.json();
      return j && j.product && j.status !== 0 ? j.product : null;
    } finally { clearTimeout(timer); }
  }
  // A barcode was read (or typed): household foods first, then Open Food Facts.
  async function findCode(code) {
    const c = ctx;
    if (!c || c.kind !== "scan") return;
    if (c.from === "link") {
      const other = S.foods.find(f => f.barcode === code && f.id !== c.back.id);
      ctx = c.back;
      if (!other) ctx.barcode = code;
      showSheet(foodHtml());
      toast(other ? `That barcode is already on “${other.name}”.` : "Barcode added — tap Save to keep it", !!other);
      return;
    }
    scanMsg(`Looking up ${code}…`);
    let food = S.foods.find(f => f.barcode === code);
    let product = null, failed = false;
    try {
      if (!food) {   // the other person may have added it since the list was loaded
        const rows = await run(() => sb.from("ct_foods").select("*").eq("barcode", code));
        food = rows && rows[0];
        if (food) S.foods = S.foods.filter(f => f.id !== food.id).concat(food);
      }
      if (!food) product = await lookupOFF(code);
    } catch (e) { failed = true; }
    if (ctx !== c) return;   // closed while looking it up
    if (food) return c.from === "pick" ? pickItem("food", food.id, c.meal) : openFood(food, { note: "Already in your foods." });
    const then = c.from === "pick" ? { meal: c.meal } : null;
    if (failed) return openFood(null, { barcode: code, then, note: "Couldn't look it up just now. Enter it from the label — the barcode is saved with it." });
    if (!product) return openFood(null, { barcode: code, then, note: "Not in the product database yet. Enter it from the label once — next time the scan finds it." });
    const p = offToFood(product);
    openFood(null, { barcode: code, then, name: p.name, unit: p.unit, vals: p.vals, fixed: p.fixed,
      note: p.vals ? "Filled in from Open Food Facts — check it against the label, then save." : "Found the name but no nutrition info — enter it from the label." });
  }

  // ── Toast ─────────────────────────────────────────────────────────────────
  let toastTimer = null;
  function toast(msg, err, action) {
    clearTimeout(toastTimer);
    $toast.innerHTML = `<div class="toast${err ? " err" : ""}${action ? " act" : ""}"><span>${esc(msg)}</span>${action ? `<button data-act="${action}">Undo</button>` : ""}</div>`;
    toastTimer = setTimeout(() => { $toast.innerHTML = ""; }, err ? 4500 : action ? 6000 : 2500);
  }
  let lastAdded = null;   // the diary entry Undo removes
  function addedToast(entry) {
    lastAdded = entry.id;
    toast(`Added ${entry.name} · ${fmtK(entry.kcal)} kcal`, false, "undoAdd");
  }
  async function busy(btn, fn) {
    if (btn) btn.disabled = true;
    try { await fn(); }
    catch (e) { console.error(e); toast(errText(e), true); }
    finally { if (btn && btn.isConnected) btn.disabled = false; }
  }

  // ── Actions ───────────────────────────────────────────────────────────────
  const A = {
    closeVeil: (el, ev) => { if (ev.target === el) closeSheet(); },
    closeSheet: () => closeSheet(),
    tab: el => {
      S.view = el.dataset.v === "library" ? S.lib : el.dataset.v;
      closeSheet(); render(); window.scrollTo(0, 0);
      if (S.view === "home") enterHealth(); else healthTimers();
    },
    libTab: el => { S.view = S.lib = el.dataset.k === "dishes" ? "dishes" : "foods"; pref.set("lib", S.lib); render(); },
    hopen: el => openPage(el.dataset.p),
    pageBack: () => closePage(false),
    nightSel: el => { S.health.nightSel = +el.dataset.i; renderPage(); },
    hrTap: (el, ev) => {
      const day = (S.health.heart && S.health.heart.day) || [];
      if (!day.length) return;
      const mid = new Date(); mid.setHours(0, 0, 0, 0);
      const t = mid.getTime() + tapFrac(el, ev) * 86400000;
      let best = 0;
      day.forEach((d, i) => { if (Math.abs(Date.parse(d.t) - t) < Math.abs(Date.parse(day[best].t) - t)) best = i; });
      S.health.hrSel = best; renderPage();
    },
    restTap: (el, ev) => {
      const rest = (S.health.heart && S.health.heart.resting) || [];
      if (!rest.length) return;
      S.health.restSel = Math.round(tapFrac(el, ev) * (rest.length - 1)); renderPage();
    },
    hretry: () => {
      const p = S.health.page;
      if (p === "sleep") { S.health.sleep = null; renderPage(); loadSleep(true).then(renderPage); }
      else if (p === "heart") { S.health.heart = null; renderPage(); loadHeart(true).then(renderPage); }
      else { loadLive().then(renderPage); }
    },
    settings: () => openSettings(),
    whatsNew: () => { closeSheet(); showNews(WHATS_NEW); },
    goToday: () => { S.day = isoDay(); render(); },
    day: el => busy(null, async () => { S.day = addDays(S.day, +el.dataset.n); render(); await ensureDay(S.day); render(); }),
    mode: el => busy(null, async () => {
      S.mode = el.dataset.k === "month" ? "month" : "day";
      if (S.mode === "month") { S.month = S.day.slice(0, 7); S.mSel = null; }
      render();
      if (S.mode === "month") await loadMonth();
    }),
    month: el => busy(null, async () => {
      const next = addMonths(S.month, +el.dataset.n);
      if (next > isoDay().slice(0, 7)) return;
      S.month = next; S.mSel = null;
      render();
      await loadMonth();
    }),
    mSel: el => { S.mSel = S.mSel === el.dataset.day ? null : el.dataset.day; render(); },
    openDay: el => busy(null, async () => {
      S.day = el.dataset.day; S.mode = "day";
      render(); window.scrollTo(0, 0);
      await ensureDay(S.day); render();
    }),

    async signIn(el) {
      const email = document.getElementById("email").value.trim();
      const pw = document.getElementById("pw").value;
      const msg = document.getElementById("loginMsg");
      if (!email || !pw) { msg.textContent = "Enter your email and password."; return; }
      el.disabled = true; msg.textContent = "Signing in…";
      const { data, error } = await sb.auth.signInWithPassword({ email, password: pw });
      el.disabled = false;
      if (error) { msg.textContent = error.message; return; }
      setUser(data.user);
    },
    async forgot() {
      const email = document.getElementById("email").value.trim();
      const msg = document.getElementById("loginMsg");
      if (!email) { msg.textContent = "Enter your email first."; return; }
      await sb.auth.resetPasswordForEmail(email);
      msg.textContent = "Password reset email sent.";
    },
    async signOut() {
      closeSheet();
      if (S.settings.step_remind) await remindOff(true).catch(e => console.error(e));   // this phone stops getting your reminders
      await sb.auth.signOut(); setUser(null);
    },

    // lists
    sortBy: el => { S.sort = el.dataset.k === "used" ? "used" : "az"; pref.set("sort", S.sort); render(); },

    // Fitbit: Google sign-in happens on Google's page, then Google sends you back to the app
    fitConnect: el => busy(el, async () => {
      const data = await fitCall("start");
      if (data.error === "not_configured") { toast("The Fitbit link isn't set up yet — the Google Cloud part still needs doing.", true); return; }
      if (!data.url) throw oops("Couldn't start the Fitbit link — try again.");
      window.location.href = data.url;
    }),
    remindSet: el => busy(el, async () => {
      const on = el.dataset.k === "on";
      if (on === !!S.push.on) return;
      if (on) await remindOn(ctx && ctx.hour != null ? ctx.hour : remindHour()); else await remindOff();
      const box = document.getElementById("remindBox");
      if (box) box.innerHTML = remindHtml();
    }),
    fitDisconnect: el => busy(el, async () => {
      if (!window.confirm("Disconnect your Fitbit? Calories burned already fetched stay in your diary.")) return;
      await fitCall("disconnect");
      S.settings.fit_status = null;
      closeSheet(); render(); toast("Fitbit disconnected");
    }),

    // diary
    addEntry: el => openAdd(el.dataset.meal),
    pick: el => pickItem(el.dataset.kind, el.dataset.id, ctx.meal),
    newFoodFromPick: () => openFood(null, { name: ctx.q.trim(), then: { meal: ctx.meal } }),
    amtUnit: el => {
      ctx.unit = el.dataset.k;
      const last = lastLogged(ctx.id, ctx.unit);
      ctx.amount = last ? +last.amount : ctx.unit === "g" ? 100 : 1;
      showSheet(amountHtml());
    },
    amtMeal: el => { ctx.meal = el.dataset.k; showSheet(amountHtml()); },
    saveEntry: el => busy(el, async () => {
      const amount = num(ctx.amount);
      if (!(amount > 0)) { toast("Enter an amount.", true); return; }
      const obj = ctx.item === "food" ? S.foods.find(f => f.id === ctx.id) : S.dishes.find(d => d.id === ctx.id);
      const n = roundN(amountNut());
      const row = { user_id: S.user.id, day: S.day, meal: ctx.meal, kind: ctx.item, ref_id: ctx.id, name: obj.name, amount, amount_unit: ctx.unit, ...n };
      const saved = await run(() => sb.from("ct_diary").insert(row).select().single());
      S.diary.push(saved);
      closeSheet(); render();
      addedToast(saved);
    }),
    undoAdd: el => busy(el, async () => {
      const id = lastAdded;
      if (!id) return;
      lastAdded = null;
      await run(() => sb.from("ct_diary").delete().eq("id", id));
      S.diary = S.diary.filter(e => e.id !== id);
      render(); toast("Removed");
    }),

    // barcode scanning
    scan: el => openScan(el.dataset.from),
    scanBack: () => {
      const back = ctx && ctx.back;
      stopScan();
      if (!back) return closeSheet();
      ctx = back;
      showSheet(back.kind === "food" ? foodHtml() : pickHtml());
    },
    scanManual: () => {
      const inp = document.getElementById("scanCode");
      const code = normCode(inp ? inp.value : "");
      if (!validCode(code)) { scanMsg("That doesn't look like a barcode — check the number under the lines."); return; }
      stopScan();
      findCode(code);
    },
    editEntry: el => openEditEntry(el.dataset.id),
    entryMeal: el => { ctx.meal = el.dataset.k; showSheet(entryHtml()); },
    updateEntry: el => busy(el, async () => {
      const amount = num(ctx.amount);
      if (!(amount > 0)) { toast("Enter an amount.", true); return; }
      const patch = { amount, meal: ctx.meal, ...roundN(entryNut()) };
      const saved = await run(() => sb.from("ct_diary").update(patch).eq("id", ctx.id).select().single());
      S.diary = S.diary.map(e => (e.id === ctx.id ? saved : e));
      closeSheet(); render();
    }),
    deleteEntry: el => busy(el, async () => {
      const id = ctx.id;
      await run(() => sb.from("ct_diary").delete().eq("id", id));
      S.diary = S.diary.filter(e => e.id !== id);
      closeSheet(); render();
    }),

    // foods
    newFood: () => openFood(null),
    editFood: el => openFood(S.foods.find(f => f.id === el.dataset.id)),
    fUnit: el => {
      const was = ctx.unit;
      ctx.unit = el.dataset.k;
      if (num(ctx.basis) === basisOf(was)) ctx.basis = basisOf(ctx.unit);
      showSheet(foodHtml());
    },
    fFixedMode: el => {
      ctx.fixedOn = el.dataset.k === "fixed";
      if (ctx.fixedOn && !(num(ctx.fixed) > 0) && ctx.unit === "item") ctx.fixed = 1;
      showSheet(foodHtml());
      const inp = document.getElementById("fFixed");
      if (inp && !(num(ctx.fixed) > 0)) inp.focus();
    },
    fBarcodeClear: () => { ctx.barcode = ""; showSheet(foodHtml()); },
    saveFood: el => busy(el, async () => {
      const name = ctx.name.trim();
      if (!name) { toast("Give the food a name.", true); return; }
      const vals = { kcal: num(ctx.vals.kcal), protein: num(ctx.vals.protein) || 0, carbs: num(ctx.vals.carbs) || 0, fat: num(ctx.vals.fat) || 0 };
      if (!(vals.kcal >= 0)) { toast("Enter the calories.", true); return; }
      if ([vals.protein, vals.carbs, vals.fat].some(v => v < 0)) { toast("Values can't be negative.", true); return; }
      const stored = toStored(ctx.unit, ctx.basis, vals);
      if (!stored) { toast("Enter the weight the values are for.", true); return; }
      const fixed = ctx.fixedOn ? num(ctx.fixed) : null;
      if (ctx.fixedOn && !(fixed > 0)) { toast("Enter the fixed amount, or choose each time.", true); return; }
      const barcode = ctx.barcode || null;
      const taken = barcode && S.foods.find(f => f.id !== ctx.id && f.barcode === barcode);
      if (taken) { toast(`That barcode is already on “${taken.name}”.`, true); return; }
      const dup = S.foods.find(f => f.id !== ctx.id && f.name.trim().toLowerCase() === name.toLowerCase());
      if (dup && !window.confirm(`There's already a food called “${dup.name}”. Save another one anyway?`)) return;
      const row = { name, unit: ctx.unit, ...stored, fixed_amount: fixed, barcode, updated_at: new Date().toISOString() };
      let saved;
      try {
        if (ctx.id) {
          saved = await run(() => sb.from("ct_foods").update(row).eq("id", ctx.id).select().single());
          S.foods = S.foods.map(f => (f.id === saved.id ? saved : f));
        } else {
          saved = await run(() => sb.from("ct_foods").insert({ ...row, user_id: S.user.id }).select().single());
          S.foods.push(saved);
        }
      } catch (e) {
        // The other person linked this barcode to a food a moment ago.
        if (e && e.code === "23505") { toast("That barcode is already on another food.", true); refreshShared(); return; }
        throw e;
      }
      const then = ctx.then;
      closeSheet(); render();
      if (then) pickItem("food", saved.id, then.meal);   // straight on to logging it
      else toast("Saved");
    }),
    deleteFood: el => busy(el, async () => {
      const id = ctx.id;
      S.dishes = (await run(() => sb.from("ct_dishes").select("*"))) || S.dishes;
      const used = S.dishes.filter(d => (d.items || []).some(it => it.food_id === id));
      if (used.length) { toast(`Used in ${used.map(d => d.name).join(", ")} — remove it there first.`, true); return; }
      if (!window.confirm("Delete this food? Diary entries already logged keep their calories.")) return;
      await run(() => sb.from("ct_foods").delete().eq("id", id));
      S.foods = S.foods.filter(f => f.id !== id);
      closeSheet(); render();
    }),

    // dishes
    newDish: () => openDish(null),
    editDish: el => openDish(S.dishes.find(d => d.id === el.dataset.id)),
    ingAdd: () => { ctx.picking = true; ctx.q = ""; showSheet(dishHtml()); const s = $sheet.querySelector("[data-live=ingSearch]"); if (s) s.focus(); },
    ingPick: el => {
      const f = S.foods.find(x => x.id === el.dataset.id);
      if (!f) return;
      ctx.items.push({ food_id: f.id, amount: basisOf(f.unit) });
      ctx.picking = false;
      showSheet(dishHtml());
      const inp = document.getElementById("ing" + (ctx.items.length - 1));
      if (inp) { inp.focus(); inp.select(); }
    },
    ingDel: el => { ctx.items.splice(+el.dataset.i, 1); showSheet(dishHtml()); },
    saveDish: el => busy(el, async () => {
      const name = ctx.name.trim();
      const d = dishDraft();
      if (!name) { toast("Give the dish a name.", true); return; }
      const items = d.items.filter(it => it.amount > 0 && S.foods.some(f => f.id === it.food_id));
      if (!items.length) { toast("Add at least one ingredient.", true); return; }
      if (!(d.portions > 0)) { toast("Portions must be more than 0.", true); return; }
      const dup = S.dishes.find(x => x.id !== ctx.id && x.name.trim().toLowerCase() === name.toLowerCase());
      if (dup && !window.confirm(`There's already a dish called “${dup.name}”. Save another one anyway?`)) return;
      const row = { name, portions: d.portions, cooked_grams: d.cooked_grams, items, updated_at: new Date().toISOString() };
      if (ctx.id) {
        const saved = await run(() => sb.from("ct_dishes").update(row).eq("id", ctx.id).select().single());
        S.dishes = S.dishes.map(x => (x.id === saved.id ? saved : x));
      } else {
        const saved = await run(() => sb.from("ct_dishes").insert({ ...row, user_id: S.user.id }).select().single());
        S.dishes.push(saved);
      }
      closeSheet(); render(); toast("Saved");
    }),
    deleteDish: el => busy(el, async () => {
      if (!window.confirm("Delete this dish? Diary entries already logged keep their calories.")) return;
      const id = ctx.id;
      await run(() => sb.from("ct_dishes").delete().eq("id", id));
      S.dishes = S.dishes.filter(d => d.id !== id);
      closeSheet(); render();
    }),

    // weight
    saveWeight: el => busy(el, async () => {
      const unit = S.settings.weight_unit || "kg";
      const kg = readWeight(unit, "w");
      if (!(kg > 0)) { toast("Enter a weight.", true); return; }
      const saved = await run(() => sb.from("ct_weights").upsert({ user_id: S.user.id, day: isoDay(), kg }, { onConflict: "user_id,day" }).select().single());
      S.weights = S.weights.filter(w => w.day !== saved.day).concat(saved);
      render(); toast("Weight saved");
    }),
    editWeight: el => openWeightEntry(el.dataset.id),
    updateWeight: el => busy(el, async () => {
      const unit = S.settings.weight_unit || "kg";
      const kg = readWeight(unit, "e");
      if (!(kg > 0)) { toast("Enter a weight.", true); return; }
      const saved = await run(() => sb.from("ct_weights").update({ kg }).eq("id", ctx.id).select().single());
      S.weights = S.weights.map(w => (w.id === saved.id ? saved : w));
      closeSheet(); render();
    }),
    deleteWeight: el => busy(el, async () => {
      const id = ctx.id;
      await run(() => sb.from("ct_weights").delete().eq("id", id));
      S.weights = S.weights.filter(w => w.id !== id);
      closeSheet(); render();
    }),

    // settings
    setUnit: el => {
      const kg = readWeight(ctx.unit, "g");     // keep a typed goal when switching units
      ctx.unit = el.dataset.k;
      $sheet.querySelectorAll("[data-act=setUnit]").forEach(b => b.classList.toggle("on", b.dataset.k === ctx.unit));
      document.getElementById("goalBox").innerHTML = weightInputs(ctx.unit, kg > 0 ? kg : null, "g");
    },
    saveSettings: el => busy(el, async () => {
      const t = k => { const v = num(document.getElementById("t_" + k).value); return v > 0 ? v : null; };
      const goal = readWeight(ctx.unit, "g");
      const row = { user_id: S.user.id, kcal_target: t("kcal"), protein_target: t("protein"), carbs_target: t("carbs"), fat_target: t("fat"),
        goal_kg: goal > 0 ? goal : null, weight_unit: ctx.unit, updated_at: new Date().toISOString() };
      const dn = document.getElementById("dispName");
      if (dn) row.display_name = dn.value.trim().slice(0, 40) || null;
      const sg = document.getElementById("stepGoal");
      if (sg) {
        const v = num(sg.value);
        if (String(sg.value).trim() && !(v >= 100 && v <= 100000)) { toast("Step goal: enter a number from 100 to 100,000.", true); return; }
        row.step_goal = v > 0 ? Math.round(v) : null;
      }
      const saved = await run(() => sb.from("ct_settings").upsert(row, { onConflict: "user_id" }).select().single());
      S.settings = saved || row;
      closeSheet(); render(); toast("Saved");
    }),
  };

  // Typing updates only the numbers that depend on it, so the keyboard stays put.
  const LIVE = {
    foodSearch: el => { S.foodQuery = el.value; document.getElementById("foodList").innerHTML = foodListHtml(); },
    pickSearch: el => { ctx.q = el.value; document.getElementById("pickList").innerHTML = pickListHtml(); },
    amt: el => { ctx.amount = el.value; document.getElementById("pv").innerHTML = nutPreview(amountNut(), "This adds"); },
    entryAmt: el => { ctx.amount = el.value; document.getElementById("pv").innerHTML = nutPreview(entryNut(), "Now"); },
    fName: el => { ctx.name = el.value; },
    fFixed: el => { ctx.fixed = el.value; },
    fBasis: el => { ctx.basis = el.value; refreshFoodPreview(); },
    fVal: el => { ctx.vals[el.dataset.k] = el.value; refreshFoodPreview(); },
    dName: el => { ctx.name = el.value; },
    dPortions: el => { ctx.portions = el.value; document.getElementById("dpv").innerHTML = dishTotalsHtml(); },
    dCooked: el => { ctx.cooked = el.value; document.getElementById("dpv").innerHTML = dishTotalsHtml(); },
    ingAmt: el => {
      const i = +el.dataset.i;
      ctx.items[i].amount = el.value;
      const f = foodsById()[ctx.items[i].food_id];
      const k = document.getElementById("ingK" + i);
      if (f && k) k.textContent = fmtK(foodFor(f, num(el.value) || 0).kcal);
      document.getElementById("dpv").innerHTML = dishTotalsHtml();
    },
    ingSearch: el => { ctx.q = el.value; document.getElementById("ingPickList").innerHTML = ingPickHtml(); },
    remindHour: el => {
      ctx.hour = +el.value;
      const note = document.getElementById("remindNote");
      if (note) note.textContent = remindNote(ctx.hour);
      if (S.push.on) busy(null, async () => { await saveRemind({ remind_hour: ctx.hour }); toast(`Reminder moved to ${hourText(ctx.hour)}`); });
    },
  };
  function refreshFoodPreview() {
    const box = document.getElementById("fpv");
    if (!box) return;
    const pv = foodStoredPreview();
    box.innerHTML = pv;
    box.classList.toggle("hidden", !pv);
  }

  document.addEventListener("click", ev => {
    const el = ev.target.closest("[data-act]");
    if (!el) return;
    const fn = A[el.dataset.act];
    if (fn) fn(el, ev);
  });
  document.addEventListener("input", ev => {
    const el = ev.target.closest("[data-live]");
    if (el && LIVE[el.dataset.live]) LIVE[el.dataset.live](el, ev);
  });
  document.addEventListener("keydown", ev => {
    if (ev.key === "Escape" && S.health.page) { closePage(false); return; }
    const t = ev.target;
    if (!t || !t.getAttribute) return;
    // chart columns are role="button": Enter or Space picks them, as a click would
    if ((ev.key === "Enter" || ev.key === " ") && t.getAttribute("role") === "button" && A[t.getAttribute("data-act")]) { ev.preventDefault(); A[t.getAttribute("data-act")](t, ev); return; }
    if (ev.key !== "Enter") return;
    if (t.id === "pw") A.signIn(document.querySelector("[data-act=signIn]"));
    if (t.id === "scanCode") A.scanManual();
  });

  // ── Start ─────────────────────────────────────────────────────────────────
  // Google sends you back to the app with ?fitbit=connected (or why it didn't work).
  const FIT_MSG = {
    connected: ["Fitbit connected. Steps, sleep and heart rate are on Home.", false],
    cancelled: ["Fitbit not connected.", false],
    expired: ["That took too long — tap Connect again.", true],
    noscope: ["Tick the activity box on Google's screen, so the app can see calories burned and steps.", true],
    error: ["Couldn't connect the Fitbit — try again.", true],
  };
  let fitReturn = null;
  (function readFitReturn() {
    const p = new URLSearchParams(window.location.search);
    const v = p.get("fitbit");
    if (!v) return;
    fitReturn = FIT_MSG[v] ? v : "error";
    p.delete("fitbit");
    const q = p.toString();
    try { window.history.replaceState(null, "", window.location.pathname + (q ? "?" + q : "") + window.location.hash); } catch (e) { /* cosmetic */ }
  })();

  async function setUser(u) {
    S.user = u;
    S.push = { checked: false };
    if (S.health.page) closePage(true);
    S.health = { page: null, live: null, sleep: null, heart: null, shown: null, cheer: null, nightSel: null, hrSel: null, restSel: null };
    S.view = "home";
    lastBurnSync = lastFullSync = 0;
    closeSheet();
    if (!u) { S.loading = false; render(); return; }
    S.loading = true; render();
    try { await loadAll(); }
    catch (e) { console.error(e); toast(isNet(e) ? "No connection — pull down or reopen to try again." : "Couldn't load your data.", true); }
    S.loading = false; render();
    if (fitReturn) { const [msg, bad] = FIT_MSG[fitReturn]; fitReturn = null; toast(msg, bad); }
    syncBurn();
    healPush();
    if (S.view === "home") enterHealth();
    whatsNewCheck();
  }

  // Foods and dishes are shared, so fetch them again when coming back to the app
  // (the other person may have added some). Left alone while a form is open.
  async function refreshShared() {
    try {
      const [foods, dishes] = await Promise.all([run(() => sb.from("ct_foods").select("*")), run(() => sb.from("ct_dishes").select("*"))]);
      S.foods = foods || S.foods;
      S.dishes = dishes || S.dishes;
      if (!ctx && S.view !== "home") render();
    } catch (e) { /* offline: keep what we have */ }
  }

  // After midnight, "today" moves on by itself when the app comes back.
  let lastToday = isoDay();
  let hiddenAt = 0;
  document.addEventListener("visibilitychange", () => {
    // The camera stops while the app is in the background, and starts again on return.
    if (document.hidden) { hiddenAt = Date.now(); stopScan(); healthTimers(); return; }
    if (ctx && ctx.kind === "scan") startScan();
    const t = isoDay();
    if (t !== lastToday) { if (S.day === lastToday) S.day = t; lastToday = t; if (S.user && !ctx) render(); }
    if (S.user && !S.loading && !ctx && hiddenAt && Date.now() - hiddenAt > 60 * 1000) refreshShared();
    if (S.user && !S.loading) syncBurn();   // at most every 2 minutes
    if (S.user && !S.loading && (S.health.page || S.view === "home")) { healthTimers(); healthPoll(); if (S.health.page === "steps") keepAwake(true); }
    hiddenAt = 0;
  });

  // While the app is open, calories burned and steps refresh every couple of minutes.
  setInterval(() => { if (!document.hidden && S.user && !S.loading) syncBurn(); }, 30 * 1000);

  function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    window.addEventListener("load", () => {
      const hadController = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).then(r => r.update()).catch(() => {});
      let reloading = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (reloading || !hadController) return;
        reloading = true; window.location.reload();
      });
    });
  }

  async function boot() {
    registerSW();
    if (!window.supabase || !window.supabase.createClient) {
      $app.innerHTML = `<div class="empty">Couldn't start. Check your connection and reopen the app.</div>`;
      return;
    }
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    const { data } = await sb.auth.getSession();
    bootSignedIn = !!(data && data.session);   // signed in already = not a new install (see whatsNewCheck)
    await setUser(data && data.session ? data.session.user : null);
    // Only react to a different account: Supabase re-announces the same login on
    // every return to the app. Deferred, as Supabase asks, so no calls run inside it.
    sb.auth.onAuthStateChange((event, session) => {
      const u = session ? session.user : null;
      if ((u && u.id) !== (S.user && S.user.id)) setTimeout(() => setUser(u), 0);
    });
  }
  boot();
})();
