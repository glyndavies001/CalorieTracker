// @ts-nocheck
// CalorieTracker ⇄ Google Health API (Fitbit): calories burned and steps each day,
// plus the evening step reminder.
//
// POST {action:"start"}                → the Google sign-in URL for the caller
// GET  ?code=…&state=…                 → Google sends the person back here after signing in
// POST {action:"sync", today, from}    → fetch calories burned and steps for those days into ct_burn
// POST {action:"disconnect"}           → forget the link (and revoke it at Google)
// POST {action:"push_key"}             → the public key phones subscribe with
// POST {action:"push_test"}            → a test notification to the caller's phones
// POST {action:"remind"} + x-cron-key  → hourly, from the database scheduler: people whose reminder
//                                        hour it is (UK time) and who are under their step goal get a nudge
//
// Other POST calls need the person's Supabase login (Authorization: Bearer <jwt>), checked against
// the Auth API. Tokens live in ct_fit_links, which the app itself can't read.
// No imports beyond ./webpush.ts: plain fetch to Google, PostgREST and GoTrue.
import { sendPush, makeVapidKeys } from "./webpush.ts";

export const APP_URL = "https://calorie-tracker-roan-three.vercel.app";
const SCOPE = "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly";
const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE = "https://oauth2.googleapis.com/revoke";
const ROLLUP = type => `https://health.googleapis.com/v4/users/me/dataTypes/${type}/dataPoints:dailyRollUp`;
const STATE_MINUTES = 20;
const MAX_DAYS = 14;   // the API's limit for one total-calories query
const DEFAULT_GOAL = 10000, DEFAULT_HOUR = 20;
const TZ = "Europe/London";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const backToApp = result => new Response(null, { status: 302, headers: { Location: `${APP_URL}/?fitbit=${result}` } });
const fmt = n => Math.round(+n || 0).toLocaleString("en-GB");

// ── Supabase (service key) ──────────────────────────────────────────────────
function key(kind) {
  const env = globalThis.Deno.env;
  try { const all = JSON.parse(env.get(kind === "secret" ? "SUPABASE_SECRET_KEYS" : "SUPABASE_PUBLISHABLE_KEYS") || "{}"); if (all.default) return all.default; } catch (_) { /* fall back */ }
  return env.get(kind === "secret" ? "SUPABASE_SERVICE_ROLE_KEY" : "SUPABASE_ANON_KEY");
}
const base = () => globalThis.Deno.env.get("SUPABASE_URL");
function adminHeaders(extra = {}) {
  const k = key("secret");
  const h = { apikey: k, "Content-Type": "application/json", ...extra };
  if (k && k.startsWith("eyJ")) h.Authorization = `Bearer ${k}`;   // legacy JWT keys also go in Authorization
  return h;
}
async function db(method, path, body, prefer) {
  const res = await fetch(`${base()}/rest/v1/${path}`, { method, headers: adminHeaders(prefer ? { Prefer: prefer } : {}), body: body == null ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`db ${method} ${path.split("?")[0]} ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
const upsert = (table, rows, onConflict) => db("POST", `${table}?on_conflict=${onConflict}`, rows, "resolution=merge-duplicates,return=minimal");
async function getLink(userId) { const rows = await db("GET", `ct_fit_links?user_id=eq.${userId}&select=*`); return rows && rows[0]; }
const patchLink = (userId, patch) => db("PATCH", `ct_fit_links?user_id=eq.${userId}`, patch, "return=minimal");
const setStatus = (userId, fit_status) => upsert("ct_settings", [{ user_id: userId, fit_status }], "user_id");

async function config() {
  const rows = await db("GET", "ct_config?select=key,value&key=in.(google_client_id,google_client_secret,vapid_public,vapid_private,cron_key)");
  const c = Object.fromEntries((rows || []).map(r => [r.key, r.value]));
  let vapid = null;
  try { if (c.vapid_public && c.vapid_private) vapid = { publicKey: c.vapid_public, privateJwk: JSON.parse(c.vapid_private) }; } catch (_) { vapid = null; }
  return { id: c.google_client_id || "", secret: c.google_client_secret || "", vapid, cronKey: c.cron_key || "" };
}
const googleReady = cfg => !!(cfg.id && cfg.secret);
// Who is calling: their Supabase login, checked by the Auth API.
async function caller(req) {
  const auth = req.headers.get("authorization") || "";
  const jwt = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!jwt || !jwt.startsWith("eyJ")) return null;
  const res = await fetch(`${base()}/auth/v1/user`, { headers: { apikey: key("publishable"), Authorization: `Bearer ${jwt}` } });
  if (!res.ok) return null;
  const u = await res.json();
  return u && u.id ? u : null;
}

// ── Google ──────────────────────────────────────────────────────────────────
const redirectUri = () => `${base()}/functions/v1/fitbit`;
function randomState() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function tokenRequest(params) {
  const res = await fetch(GOOGLE_TOKEN, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString() });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}
// A usable access token, refreshing it when needed. null = the link has run out.
async function accessToken(link, cfg) {
  if (link.access_token && link.access_expires && new Date(link.access_expires).getTime() > Date.now() + 60000) return link.access_token;
  const r = await tokenRequest({ grant_type: "refresh_token", refresh_token: link.refresh_token, client_id: cfg.id, client_secret: cfg.secret });
  if (!r.ok) {
    if (r.data && (r.data.error === "invalid_grant" || r.data.error === "unauthorized_client")) return null;
    throw new Error(`token refresh ${r.status}: ${r.data && (r.data.error_description || r.data.error)}`);
  }
  const patch = { access_token: r.data.access_token, access_expires: new Date(Date.now() + (r.data.expires_in || 3600) * 1000).toISOString() };
  if (r.data.refresh_token) patch.refresh_token = r.data.refresh_token;
  await patchLink(link.user_id, patch);
  return r.data.access_token;
}

// ── Dates (civil, as the person's own calendar days) ────────────────────────
const isIso = s => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
function addDays(iso, n) { const [y, m, d] = iso.split("-").map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return t.toISOString().slice(0, 10); }
const civil = iso => { const [year, month, day] = iso.split("-").map(Number); return { date: { year, month, day }, time: {} }; };
const pad = n => String(n).padStart(2, "0");
const isoOf = c => (c && c.date ? `${c.date.year}-${pad(c.date.month)}-${pad(c.date.day)}` : null);
// The date and hour in the UK right now (BST or GMT as it happens).
export function ukNow(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
    .formatToParts(d).map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: +p.hour };
}

// One number per day from..today: total calories burned (including resting) or steps.
const READ = {
  "total-calories": p => p.totalCalories && Math.round(+p.totalCalories.kcalSum),
  "steps": p => p.steps && parseInt(p.steps.countSum, 10),
};
export async function fetchDaily(token, type, from, today) {
  const res = await fetch(ROLLUP(type), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ range: { start: civil(from), end: civil(addDays(today, 1)) }, windowSizeDays: 1 }),
  });
  if (res.status === 401) return { expired: true };
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`health ${type} ${res.status}: ${(data.error && data.error.message) || ""}`.trim());
  const days = new Map();
  for (const p of data.rollupDataPoints || []) {
    const day = isoOf(p.civilStartTime);
    const v = READ[type](p);
    if (day && isFinite(v) && v >= 0 && !(type === "total-calories" && v === 0)) days.set(day, v);
  }
  return { days };
}

async function sync(userId, from, today, cfg) {
  const link = await getLink(userId);
  if (!link || !link.refresh_token) return { linked: false };
  if (link.status === "reauth") return { linked: true, reconnect: true };
  let token = await accessToken(link, cfg);
  let cal = token ? await fetchDaily(token, "total-calories", from, today) : { expired: true };
  if (cal.expired && token) {   // rejected: force a fresh token once
    token = await accessToken({ ...link, access_token: null }, cfg);
    cal = token ? await fetchDaily(token, "total-calories", from, today) : { expired: true };
  }
  if (cal.expired) {
    await patchLink(userId, { status: "reauth", last_error: "link expired" });
    await setStatus(userId, "reauth");
    return { linked: true, reconnect: true };
  }
  let steps = { days: new Map() }, stepsError = false;
  try { const s = await fetchDaily(token, "steps", from, today); if (s.expired) stepsError = true; else steps = s; }
  catch (e) { stepsError = true; console.error(e); }   // steps missing shouldn't lose the calories
  const dayList = [...new Set([...cal.days.keys(), ...steps.days.keys()])].sort();
  const days = dayList.map(day => ({ day, kcal: cal.days.has(day) ? cal.days.get(day) : null, steps: steps.days.has(day) ? steps.days.get(day) : null }));
  // Saved separately, so a number Google didn't send never blanks one saved earlier.
  const stamp = new Date().toISOString();
  const rows = (col, m) => [...m].map(([day, v]) => ({ user_id: userId, day, [col]: v, source: "google", updated_at: stamp }));
  if (cal.days.size) await upsert("ct_burn", rows("kcal", cal.days), "user_id,day");
  if (steps.days.size) await upsert("ct_burn", rows("steps", steps.days), "user_id,day");
  await patchLink(userId, { last_sync_at: new Date().toISOString(), last_error: null });
  return stepsError ? { linked: true, days, stepsError } : { linked: true, days };
}

// ── Notifications ──────────────────────────────────────────────────────────
// The key pair that signs notifications: made on first use, kept here; only the public half leaves.
async function ensureVapid(cfg) {
  if (cfg.vapid) return cfg.vapid;
  const v = await makeVapidKeys();
  await db("POST", "ct_config?on_conflict=key", [{ key: "vapid_public", value: v.publicKey }, { key: "vapid_private", value: JSON.stringify(v.privateJwk) }], "resolution=ignore-duplicates,return=minimal");
  cfg.vapid = (await config()).vapid;   // whichever pair got there first
  return cfg.vapid;
}
// Sends to every phone the person has turned reminders on for; forgets phones that have gone.
async function pushToUser(userId, msg, cfg) {
  if (!cfg.vapid) return 0;
  const subs = await db("GET", `ct_push_subs?user_id=eq.${userId}&select=endpoint,p256dh,auth`) || [];
  let sent = 0;
  for (const s of subs) {
    let status = 0;
    try { status = await sendPush(s, { ...msg, url: `${APP_URL}/` }, cfg.vapid, APP_URL); } catch (e) { console.error("push", e); }
    if (status === 404 || status === 410) await db("DELETE", `ct_push_subs?endpoint=eq.${encodeURIComponent(s.endpoint)}`, null, "return=minimal");
    else if (status >= 200 && status < 300) { sent++; await db("PATCH", `ct_push_subs?endpoint=eq.${encodeURIComponent(s.endpoint)}`, { last_ok_at: new Date().toISOString() }, "return=minimal"); }
    else if (status) console.error("push status", status);
  }
  return sent;
}
const hourText = h => (h === 0 ? "midnight" : h === 12 ? "noon" : h < 12 ? `${h}am` : `${h - 12}pm`);
const RELINK = { title: "Couldn't check your steps", body: "Your Fitbit link has run out — open CalorieTracker to reconnect it.", tag: "steps" };

// Hourly: whoever's reminder hour it is gets checked once today and nudged if under their goal.
export async function remind(cfg, now = new Date()) {
  const { day, hour } = ukNow(now);
  await ensureVapid(cfg);
  const people = await db("GET", "ct_settings?step_remind=is.true&select=user_id,step_goal,remind_hour") || [];
  const due = people.filter(p => (p.remind_hour == null ? DEFAULT_HOUR : +p.remind_hour) === hour);
  let checked = 0, sent = 0;
  for (const p of due) {
    try {
      const link = await getLink(p.user_id);
      if (!link || !link.refresh_token || link.remind_sent_on === day) continue;
      checked++;
      await patchLink(p.user_id, { remind_sent_on: day });   // once a day, even if something below fails
      const goal = +p.step_goal > 0 ? +p.step_goal : DEFAULT_GOAL;
      let msg = null;
      const r = link.status === "reauth" ? { reconnect: true } : await sync(p.user_id, day, day, cfg);
      if (r.reconnect) msg = RELINK;
      else if (!r.stepsError) {   // Google hiccup: say nothing rather than something wrong
        const t = (r.days || []).find(d => d.day === day);
        if (!t || t.steps == null) msg = { title: "No steps synced yet today", body: `Open the Fitbit app so it can sync. Your goal is ${fmt(goal)}.`, tag: "steps" };
        else if (t.steps < goal) msg = { title: `${fmt(t.steps)} steps so far today`, body: `${fmt(goal - t.steps)} to go to ${fmt(goal)} — a short walk will do it.`, tag: "steps" };
      }
      if (msg) sent += await pushToUser(p.user_id, msg, cfg);
    } catch (e) { console.error("remind", p.user_id, e); }
  }
  return { day, hour, due: due.length, checked, sent };
}

// ── Google sends the person back here ──────────────────────────────────────
async function callback(url) {
  const state = url.searchParams.get("state") || "";
  if (!state) return backToApp("error");
  const rows = await db("GET", `ct_fit_links?pending_state=eq.${encodeURIComponent(state)}&select=*`);
  const link = rows && rows[0];
  if (!link) return backToApp("expired");
  const userId = link.user_id;
  await patchLink(userId, { pending_state: null, pending_at: null });   // single use
  if (!link.pending_at || Date.now() - new Date(link.pending_at).getTime() > STATE_MINUTES * 60000) return backToApp("expired");
  if (url.searchParams.get("error")) return backToApp("cancelled");
  const code = url.searchParams.get("code");
  const cfg = await config();
  if (!code || !googleReady(cfg)) return backToApp("error");
  const r = await tokenRequest({ grant_type: "authorization_code", code, client_id: cfg.id, client_secret: cfg.secret, redirect_uri: redirectUri() });
  if (!r.ok) { await patchLink(userId, { last_error: `code exchange ${r.status}: ${r.data.error || ""}` }); return backToApp("error"); }
  if (!String(r.data.scope || "").split(" ").includes(SCOPE)) return backToApp("noscope");   // activity box left unticked
  const refresh = r.data.refresh_token || link.refresh_token;
  if (!refresh) return backToApp("error");
  await patchLink(userId, {
    refresh_token: refresh, access_token: r.data.access_token, scope: r.data.scope, status: "ok", last_error: null,
    access_expires: new Date(Date.now() + (r.data.expires_in || 3600) * 1000).toISOString(), linked_at: new Date().toISOString(),
  });
  await setStatus(userId, "linked");
  try {   // fill in the last two weeks straight away
    const today = ukNow().day;
    await sync(userId, addDays(today, -(MAX_DAYS - 1)), today, cfg);
  } catch (e) { await patchLink(userId, { last_error: String(e.message || e).slice(0, 300) }); }
  return backToApp("connected");
}

export async function handler(req) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  try {
    if (req.method === "GET") {
      if (url.searchParams.has("state") || url.searchParams.has("code") || url.searchParams.has("error")) return await callback(url);
      return json({ ok: true });
    }
    if (req.method !== "POST") return json({ error: "method" }, 405);
    const body = await req.json().catch(() => ({}));
    const cfg = await config();

    if (body.action === "remind") {   // from the database scheduler, not a person
      const k = req.headers.get("x-cron-key") || "";
      if (!cfg.cronKey || k !== cfg.cronKey) return json({ error: "forbidden" }, 403);
      if (!googleReady(cfg)) return json({ error: "not_configured" });
      return json(await remind(cfg));
    }

    const user = await caller(req);
    if (!user) return json({ error: "signin" }, 401);

    if (body.action === "start") {
      if (!googleReady(cfg)) return json({ error: "not_configured" });
      const state = randomState();
      await upsert("ct_fit_links", [{ user_id: user.id, pending_state: state, pending_at: new Date().toISOString() }], "user_id");
      const q = new URLSearchParams({ client_id: cfg.id, redirect_uri: redirectUri(), response_type: "code", access_type: "offline", prompt: "consent", scope: SCOPE, state });
      return json({ url: `${GOOGLE_AUTH}?${q}` });
    }
    if (body.action === "sync") {
      if (!googleReady(cfg)) return json({ linked: false, error: "not_configured" });
      const today = isIso(body.today) ? body.today : ukNow().day;
      let from = isIso(body.from) ? body.from : addDays(today, -(MAX_DAYS - 1));
      if (from > today) from = today;
      if (from < addDays(today, -(MAX_DAYS - 1))) from = addDays(today, -(MAX_DAYS - 1));
      return json(await sync(user.id, from, today, cfg));
    }
    if (body.action === "push_key") return json({ key: (await ensureVapid(cfg)).publicKey });
    if (body.action === "push_test") {
      const s = (await db("GET", `ct_settings?user_id=eq.${user.id}&select=step_goal,remind_hour`) || [])[0] || {};
      const goal = +s.step_goal > 0 ? +s.step_goal : DEFAULT_GOAL, hour = s.remind_hour == null ? DEFAULT_HOUR : +s.remind_hour;
      const sent = await pushToUser(user.id, { title: "Step reminders are on", body: `You'll get a nudge at ${hourText(hour)} on days you're under ${fmt(goal)} steps.`, tag: "steps-test" }, cfg);
      return json({ sent });
    }
    if (body.action === "disconnect") {
      const link = await getLink(user.id);
      if (link && link.refresh_token) await fetch(`${GOOGLE_REVOKE}?token=${encodeURIComponent(link.refresh_token)}`, { method: "POST" }).catch(() => {});
      await db("DELETE", `ct_fit_links?user_id=eq.${user.id}`, null, "return=minimal");
      await setStatus(user.id, null);
      return json({ linked: false });
    }
    return json({ error: "action" }, 400);
  } catch (e) {
    console.error(e);
    if (req.method === "GET") return backToApp("error");
    return json({ error: "server", detail: String(e.message || e).slice(0, 300) }, 500);
  }
}
