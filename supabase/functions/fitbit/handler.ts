// @ts-nocheck
// CalorieTracker ⇄ Google Health API (Fitbit): calories burned each day.
//
// POST {action:"start"}                → the Google sign-in URL for the caller
// GET  ?code=…&state=…                 → Google sends the person back here after signing in
// POST {action:"sync", today, from}    → fetch total calories burned for those days into ct_burn
// POST {action:"disconnect"}           → forget the link (and revoke it at Google)
//
// POST calls need the person's Supabase login (Authorization: Bearer <jwt>); it is checked
// against the Auth API. Tokens live in ct_fit_links, which the app itself can't read.
// No imports: plain fetch to Google, PostgREST and GoTrue, so it runs and tests anywhere.

export const APP_URL = "https://calorie-tracker-roan-three.vercel.app";
const SCOPE = "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly";
const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE = "https://oauth2.googleapis.com/revoke";
const HEALTH = "https://health.googleapis.com/v4/users/me/dataTypes/total-calories/dataPoints:dailyRollUp";
const STATE_MINUTES = 20;
const MAX_DAYS = 14;   // the API's limit for one total-calories query

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const backToApp = result => new Response(null, { status: 302, headers: { Location: `${APP_URL}/?fitbit=${result}` } });

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
  const rows = await db("GET", "ct_config?select=key,value&key=in.(google_client_id,google_client_secret)");
  const c = Object.fromEntries((rows || []).map(r => [r.key, r.value]));
  return c.google_client_id && c.google_client_secret ? { id: c.google_client_id, secret: c.google_client_secret } : null;
}
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

// Total calories burned (including resting) for each day from..today.
export async function fetchBurned(token, from, today) {
  const res = await fetch(HEALTH, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ range: { start: civil(from), end: civil(addDays(today, 1)) }, windowSizeDays: 1 }),
  });
  if (res.status === 401) return { expired: true };
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`health ${res.status}: ${(data.error && data.error.message) || ""}`.trim());
  const days = [];
  for (const p of data.rollupDataPoints || []) {
    const day = isoOf(p.civilStartTime);
    const kcal = p.totalCalories && +p.totalCalories.kcalSum;
    if (day && isFinite(kcal) && kcal > 0) days.push({ day, kcal: Math.round(kcal) });
  }
  return { days };
}

async function sync(userId, from, today, cfg) {
  const link = await getLink(userId);
  if (!link || !link.refresh_token) return { linked: false };
  if (link.status === "reauth") return { linked: true, reconnect: true };
  let token = await accessToken(link, cfg);
  let got = token ? await fetchBurned(token, from, today) : { expired: true };
  if (got.expired && token) {   // rejected: force a fresh token once
    token = await accessToken({ ...link, access_token: null }, cfg);
    got = token ? await fetchBurned(token, from, today) : { expired: true };
  }
  if (got.expired) {
    await patchLink(userId, { status: "reauth", last_error: "link expired" });
    await setStatus(userId, "reauth");
    return { linked: true, reconnect: true };
  }
  if (got.days.length) await upsert("ct_burn", got.days.map(d => ({ user_id: userId, day: d.day, kcal: d.kcal, source: "google", updated_at: new Date().toISOString() })), "user_id,day");
  await patchLink(userId, { last_sync_at: new Date().toISOString(), last_error: null });
  return { linked: true, days: got.days };
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
  if (!code || !cfg) return backToApp("error");
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
    const today = new Date().toISOString().slice(0, 10);
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
    const user = await caller(req);
    if (!user) return json({ error: "signin" }, 401);
    const body = await req.json().catch(() => ({}));
    const cfg = await config();

    if (body.action === "start") {
      if (!cfg) return json({ error: "not_configured" });
      const state = randomState();
      await upsert("ct_fit_links", [{ user_id: user.id, pending_state: state, pending_at: new Date().toISOString() }], "user_id");
      const q = new URLSearchParams({ client_id: cfg.id, redirect_uri: redirectUri(), response_type: "code", access_type: "offline", prompt: "consent", scope: SCOPE, state });
      return json({ url: `${GOOGLE_AUTH}?${q}` });
    }
    if (body.action === "sync") {
      if (!cfg) return json({ linked: false, error: "not_configured" });
      const today = isIso(body.today) ? body.today : new Date().toISOString().slice(0, 10);
      let from = isIso(body.from) ? body.from : addDays(today, -(MAX_DAYS - 1));
      if (from > today) from = today;
      if (from < addDays(today, -(MAX_DAYS - 1))) from = addDays(today, -(MAX_DAYS - 1));
      return json(await sync(user.id, from, today, cfg));
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
