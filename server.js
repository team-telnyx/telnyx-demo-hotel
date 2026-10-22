// TelnyxHotel voice concierge backend. Serves the pages and proxies Telnyx so
// the API key never reaches the browser:
//   /ws/assistant   realtime conversation with the AI receptionist
//   /api/tts        Text-to-Speech (voice previews)
//   /api/concierge  languages and Ultra voices offered to guests, /api/prefs the user's pick
//   /api/booking-recap, /api/booking-sms   booking confirmations (Telnyx Email / Messaging)
// Every page and API needs a login (auth.js), or a guest session: English only,
// nothing sent to the guest. Calls are recorded for the history (calls.js).
import express from "express";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { bookingFacts, buildSms, getPreview, recapMode, sendRecap } from "./recap.js";
import {
  GRANTS, allowedPages, attachUser, canAccess, changeOwnPassword, createUser, deleteUser, guestLogin, guestStatus, initAuth, isAdmin,
  isGuest, listUsers, login, logout, pageGate, publicUser, readCookie, refreshUsers, requirePage, setCookie, updateUser, userFromRequest,
} from "./auth.js";
import { openDb } from "./db.js";
import { guestStats, initGuestStats } from "./guest-stats.js";
import { deleteContact, initContacts, listContacts, parseContact, saveContact } from "./contacts.js";
import { TEMPLATE_DEFAULTS, cleanTemplate, getTemplate, initContactEmail, renderEmail, saveTemplate, sendContactEmail } from "./contact-email.js";
import { edgeTraffic, initEdgeMetrics } from "./edge-metrics.js";
import { onEdge, setting } from "./settings.js";
import { framePolicy } from "./frame-policy.js";
import { activeCallFor, createCallRecorder, deleteCall, getCall, initCalls, listCalls } from "./calls.js";
import { LANGUAGES, getConcierge, initConcierge, publicConcierge, saveConcierge } from "./concierge.js";
import { initAssistantAdmin, readAssistant, updateAssistant } from "./assistant-admin.js";
import { getEmailSettings, initEmail, listDomains, recentMessages, saveEmailSettings, sendTestEmail } from "./email.js";
import { getSmsSettings, initSms, listProfiles, listWhatsApp, messagesByCall, profileSenders, recentSms, saveSmsSettings, sendSms, sendTestSms } from "./sms.js";

try { process.loadEnvFile(); } catch { /* no .env — rely on the real environment */ }

const API_KEY = setting("TELNYX_API_KEY");
const ASSISTANT_ID = setting("TELNYX_ASSISTANT_ID");
const PORT = process.env.PORT || 3000;
if (!API_KEY) {
  console.error(`${onEdge() ? "TELNYXHOTEL_TELNYX_API_KEY" : "TELNYX_API_KEY"} is not set. Copy .env.example to .env and add your key.`);
  process.exit(1);
}
if (!ASSISTANT_ID) console.warn("TELNYX_ASSISTANT_ID is not set — the receptionist page will not work.");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, process.env.DATA_DIR || "data");

// The server answers /health right away; storage connects in the background
// and is retried until it works.
let storage;
function startStorage() {
  storage = (async () => {
    const { db, engine } = await openDb(DATA_DIR);
    await initAuth(db, {
      // Without a configured secret, derive one from the API key (stable across restarts and instances).
      sessionSecret: setting("SESSION_SECRET") || crypto.createHmac("sha256", API_KEY).update("telnyxhotel-session").digest("base64url"),
      admin: { email: setting("ADMIN_EMAIL"), password: setting("ADMIN_PASSWORD"), name: setting("ADMIN_NAME") },
      guests: setting("GUEST_ACCESS") !== "off",
    });
    initCalls(db);
    initGuestStats(db, { apiKey: API_KEY });
    initContacts(db);
    initContactEmail(db);
    initConcierge(db);
    initEmail(db, { apiKey: API_KEY });
    initSms(db, { apiKey: API_KEY });
    console.log(`Storage ready: ${engine === "sqldb-api" ? `Telnyx Edge SQL database ${setting("SQLDB_ID")}` : path.join(DATA_DIR, "telnyxhotel.db")}`);
  })();
  storage.catch((err) => {
    console.error(`Storage unavailable (${err.message}) — retrying in 10 s`);
    setTimeout(startStorage, 10_000);
  });
}
startStorage();
const TELNYX = "https://api.telnyx.com/v2";
const TELNYX_WS = "wss://api.telnyx.com/v2";
const authHeaders = { Authorization: `Bearer ${API_KEY}` };
initAssistantAdmin({ apiKey: API_KEY, id: ASSISTANT_ID });
initEdgeMetrics({ apiKey: API_KEY, functionName: setting("EDGE_FUNCTION") });

const app = express();
app.disable("x-powered-by");
// Behind the platform's proxy: take the client IP it appends (one hop), so the
// login and recap rate limits can't be dodged with a forged X-Forwarded-For.
if (onEdge()) app.set("trust proxy", 1);
app.get(["/health", "/health/*"], (_req, res) => res.json({ ok: true }));

// Shown in every page footer. The branch comes from GIT_BRANCH, the build
// (edge-build.js writes build.json) or the local checkout.
const VERSION = (() => {
  let build = {};
  try { build = JSON.parse(readFileSync(path.join(__dirname, "build.json"), "utf8")); } catch { /* not a build */ }
  let branch = setting("GIT_BRANCH") || build.branch;
  if (!branch) try { branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: __dirname, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { /* no git */ }
  return { backend: JSON.parse(readFileSync(path.join(__dirname, "package.json"), "utf8")).version, branch: branch || "unknown" };
})();
const framing = framePolicy(setting("FRAME_ANCESTORS"));
// Everything past /health is per-user: framed only by configured hosts, never stored in shared
// caches, and API answers (call data, users) not stored at all.
app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    ...framing,
    "Referrer-Policy": "same-origin",
    "Cache-Control": req.path.startsWith("/api/") || req.path.startsWith("/recap/") ? "no-store" : "private, no-cache",
  });
  if (onEdge() || req.secure) res.set("Strict-Transport-Security", "max-age=31536000");
  next();
});
app.use((_req, res, next) => storage.then(() => next(), (err) => {
  res.status(503).type("text").send(`Storage is unavailable, try again shortly (${err.message})`);
}));
app.use(express.json({ limit: "16kb" }));
app.use(attachUser);
app.use(pageGate);
app.use(express.static(path.join(__dirname, "public"), { cacheControl: false }));

// Errors thrown by auth.js carry an HTTP status.
const sendError = (res, err) => {
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: "Internal error" });
};

// ---------------------------------------------------------------------------
// Login, account, admin (users & page access)
// ---------------------------------------------------------------------------
app.get("/api/version", (_req, res) => res.json(VERSION));
app.post("/api/auth/login", login);
app.post("/api/auth/logout", logout);
app.get("/api/auth/guest", guestStatus);
app.post("/api/auth/guest", guestLogin);
app.get("/api/auth/me", requirePage(), (req, res) => {
  res.json({ user: publicUser(req.user), pages: allowedPages(req.user) });
});
app.post("/api/auth/password", requirePage(), async (req, res) => {
  try {
    await changeOwnPassword(req.user, req.body?.current, req.body?.next);
    res.json({ ok: true, relogin: true });
  } catch (err) { sendError(res, err); }
});

app.get("/api/admin/users", requirePage("admin"), (_req, res) => {
  res.json({ users: listUsers(), pages: GRANTS });
});
app.post("/api/admin/users", requirePage("admin"), async (req, res) => {
  try { res.status(201).json({ user: await createUser(req.body ?? {}) }); } catch (err) { sendError(res, err); }
});
app.patch("/api/admin/users/:id", requirePage("admin"), async (req, res) => {
  try { res.json({ user: await updateUser(req.params.id, req.body ?? {}, req.user) }); } catch (err) { sendError(res, err); }
});
app.delete("/api/admin/users/:id", requirePage("admin"), async (req, res) => {
  try { await deleteUser(req.params.id, req.user); res.json({ ok: true }); } catch (err) { sendError(res, err); }
});

// ---------------------------------------------------------------------------
// Call history and guest messages: users see their own, admins everyone's.
// ---------------------------------------------------------------------------

// A call's confirmation SMS / WhatsApp settles after the call: add its current
// status from the SMS log (sent by the call's own user). Never the text.
async function withMessageStatus(summaries) {
  if (!summaries.length) return summaries;
  const byCall = await messagesByCall().catch((err) => {
    console.error("SMS statuses:", err.message);
    return new Map();
  });
  return summaries.map((s) => {
    const m = byCall.get(s.id);
    return m && m.user === s.user.email ? { ...s, message: { ...(s.message || {}), ...m } } : s;
  });
}

app.get("/api/calls", requirePage("history"), async (req, res) => {
  const userId = isAdmin(req.user) ? req.query.user || undefined : req.user.id;
  try { res.json({ calls: await withMessageStatus(await listCalls({ userId })), isAdmin: isAdmin(req.user) }); } catch (err) { sendError(res, err); }
});
app.get("/api/calls/:id", requirePage("history"), async (req, res) => {
  try {
    const call = await getCall(req.params.id);
    if (!call || (!isAdmin(req.user) && call.summary.user.id !== req.user.id)) return res.status(404).json({ error: "Call not found" });
    [call.summary] = await withMessageStatus([call.summary]);
    res.json(call);
  } catch (err) { sendError(res, err); }
});
app.get("/api/messages", requirePage("history"), async (req, res) => {
  const user = isAdmin(req.user) ? null : req.user;
  const [sms, email] = await Promise.allSettled([recentSms({ user: user?.email }), recentMessages({ userId: user?.id })]);
  if (sms.status === "rejected") return sendError(res, sms.reason);
  const emailOf = new Map(listUsers().map((u) => [u.id, u.email]));
  res.json({
    sms: sms.value, email: (email.value ?? []).map((m) => ({ ...m, user: emailOf.get(m.userId) ?? null })),
    emailError: email.reason?.message || null, isAdmin: !user,
  });
});
// Guest stats (admins): every guest call with its Telnyx insights, for ?days=N (0: all).
app.get("/api/admin/guests", requirePage("guests"), async (req, res) => {
  const days = [1, 7, 30, 90, 0].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
  try { res.json({ days, ...(await guestStats({ days })) }); } catch (err) { sendError(res, err); }
});
// Contacts left by guests from the booking page pop-up (admins: list, delete).
app.get("/api/admin/contacts", requirePage("guests"), async (_req, res) => {
  try { res.json({ contacts: await listContacts() }); } catch (err) { sendError(res, err); }
});
// The follow-up e-mail: its template (with the Telnyx Email setup it uses), a preview, and sending it.
app.get("/api/admin/contacts/template", requirePage("guests"), async (_req, res) => {
  try {
    const [template, s] = await Promise.all([getTemplate(), getEmailSettings()]);
    res.json({ template, defaults: TEMPLATE_DEFAULTS, email: { enabled: s.enabled, from: s.from, sandbox: s.sandbox, overrideTo: s.overrideTo } });
  } catch (err) { sendError(res, err); }
});
app.put("/api/admin/contacts/template", requirePage("guests"), async (req, res) => {
  try { res.json({ template: await saveTemplate(req.body ?? {}) }); } catch (err) { sendError(res, err); }
});
app.post("/api/admin/contacts/template/preview", requirePage("guests"), (req, res) => {
  try { res.json(renderEmail(cleanTemplate(req.body ?? {}))); } catch (err) { sendError(res, err); }
});
app.post("/api/admin/contacts/:id/email", requirePage("guests"), async (req, res) => {
  try { res.json({ contact: await sendContactEmail(req.params.id, req.user) }); } catch (err) { sendError(res, err); }
});
app.delete("/api/admin/contacts/:id", requirePage("guests"), async (req, res) => {
  try { (await deleteContact(req.params.id)) ? res.json({ ok: true }) : res.status(404).json({ error: "Contact not found" }); } catch (err) { sendError(res, err); }
});
// Traffic of the Edge function (all requests, not calls), last 24 h or 7 days.
app.get("/api/admin/traffic", requirePage("guests"), async (req, res) => {
  try { res.json(await edgeTraffic({ days: Number(req.query.days) || 30 })); } catch (err) { sendError(res, err); }
});
app.delete("/api/calls/:id", requirePage("history"), async (req, res) => {
  try {
    const call = await getCall(req.params.id);
    if (!call || (!isAdmin(req.user) && call.summary.user.id !== req.user.id)) return res.status(404).json({ error: "Call not found" });
    if (!(await deleteCall(req.params.id))) return res.status(409).json({ error: "The call is still in progress" });
    res.json({ ok: true });
  } catch (err) { sendError(res, err); }
});

// ---------------------------------------------------------------------------
// Telnyx Ultra voices (all languages), cached for 10 minutes. Admins pick a
// shortlist per language (concierge.js); guests only see that shortlist.
// ---------------------------------------------------------------------------
const ACCENTS = {
  "en-us": "American", "en-gb": "British", "en-au": "Australian", "en-ie": "Irish",
  "en-in": "Indian", "en-za": "South African", "en-ca": "Canadian",
  "fr-fr": "France", "fr-ca": "Canada", "es-es": "España", "es-mx": "México", "es-co": "Colombia",
  "de-de": "Deutschland", "de-at": "Österreich", "de-ch": "Schweiz", "nl-nl": "Nederland", "nl-be": "België",
};
let voiceCache = { at: 0, voices: [] };
let voiceRefresh = null;

// Served from memory; a list older than 10 minutes is still used while a fresh
// one loads in the background, so only the very first call waits for Telnyx.
function assistantVoices() {
  const fresh = Date.now() - voiceCache.at < 10 * 60_000;
  if (voiceCache.voices.length && fresh) return Promise.resolve(voiceCache.voices);
  voiceRefresh ??= loadVoices().finally(() => { voiceRefresh = null; });
  if (voiceCache.voices.length) {
    voiceRefresh.catch((err) => console.error("Voice list refresh failed:", err.message));
    return Promise.resolve(voiceCache.voices);
  }
  return voiceRefresh;
}

async function loadVoices() {
  const res = await fetch(`${TELNYX}/text-to-speech/voices`, { headers: authHeaders });
  if (!res.ok) throw new Error(`voices ${res.status}: ${await res.text()}`);
  const { voices = [] } = await res.json();
  const list = voices
    .filter((v) => v.id?.startsWith("Telnyx.Ultra.") && v.language)
    .map((v) => {
      const language = v.language.toLowerCase();
      return {
        id: v.id,
        name: v.name,
        label: v.label || "",
        gender: (v.gender || "").toLowerCase(),
        language,
        lang: language.slice(0, 2),
        accent: ACCENTS[language] || "",
        provider: "ultra",
        model: "ultra",
      };
    })
    .sort((a, b) => a.language.localeCompare(b.language) || a.name.localeCompare(b.name));
  voiceCache = { at: Date.now(), voices: list };
  return list;
}

// The user's language and voice live in a cookie (per user and browser), not
// in the assistant settings, and only count while the admin still offers them.
const PREFS = "telnyxhotel_prefs";
const voiceFor = (language, id) => (language.voices.some((v) => v.id === id) ? id
  : language.voices.some((v) => v.id === language.defaultVoice) ? language.defaultVoice : language.voices[0]?.id) ?? null;

// Guests get English only.
async function conciergeFor(user) {
  const concierge = await publicConcierge(await assistantVoices());
  if (!isGuest(user)) return concierge;
  const languages = concierge.languages.filter((l) => l.code === "en");
  if (!languages.length) throw Object.assign(new Error("The guest demo needs English, which is turned off"), { status: 503 });
  return { defaultLanguage: "en", languages };
}

async function preferences(req, concierge) {
  concierge ??= await conciergeFor(req.user);
  const [uid, lang, voice] = String(readCookie(req.headers.cookie, PREFS) || "").split("|");
  const mine = uid === req.user.id;
  const language = (mine && concierge.languages.find((l) => l.code === lang)) || concierge.languages.find((l) => l.code === concierge.defaultLanguage);
  return { lang: language.code, voice: voiceFor(language, mine && language.code === lang ? voice : null) };
}

// Languages and voice shortlists for the booking page's pre-call step.
app.get("/api/concierge", requirePage("booking"), async (req, res) => {
  try {
    const concierge = await conciergeFor(req.user);
    res.json({ ...concierge, preferred: await preferences(req, concierge) });
  } catch (err) {
    console.error("Concierge settings failed:", err.message);
    res.status(502).json({ error: "Could not load the voices from Telnyx" });
  }
});

app.get("/api/prefs", requirePage("booking", "flow"), async (req, res) => {
  try { res.json(await preferences(req)); } catch (err) { sendError(res, err); }
});
// { lang, voice }: without a voice (or with one not offered), the language's default.
app.put("/api/prefs", requirePage("booking", "flow"), async (req, res) => {
  try {
    const { languages } = await conciergeFor(req.user);
    const language = languages.find((l) => l.code === req.body?.lang);
    const voice = language && voiceFor(language, req.body.voice);
    if (!voice) return res.status(400).json({ error: "This language is not offered" });
    setCookie(req, res, PREFS, `${req.user.id}|${language.code}|${voice}`, 365 * 864e5);
    res.json({ lang: language.code, voice });
  } catch (err) { sendError(res, err); }
});

// ---------------------------------------------------------------------------
// Admin: concierge widget (languages, voice shortlists, greetings) and the
// Telnyx AI Assistant itself (prompt, model, voice, listening, knowledge base).
// ---------------------------------------------------------------------------
app.get("/api/admin/concierge", requirePage("assistant"), async (_req, res) => {
  try {
    const catalog = await assistantVoices();
    const languages = Object.entries(LANGUAGES).map(([code, l]) => ({ code, name: l.name, label: l.label, defaultGreeting: l.greeting }));
    const voices = catalog.filter((v) => languages.some((l) => LANGUAGES[l.code].match.test(v.language)))
      .map(({ id, name, label, gender, language, accent }) => ({ id, name, label, gender, language, accent }));
    res.json({ config: await getConcierge(catalog), languages, voices });
  } catch (err) { sendError(res, err); }
});
app.put("/api/admin/concierge", requirePage("assistant"), async (req, res) => {
  try { res.json({ config: await saveConcierge(req.body ?? {}, await assistantVoices()) }); } catch (err) { sendError(res, err); }
});

app.get("/api/admin/assistant", requirePage("assistant"), async (_req, res) => {
  try { res.json(await readAssistant()); } catch (err) { sendError(res, err); }
});
app.patch("/api/admin/assistant/:section", requirePage("assistant"), async (req, res) => {
  // Hold the voice lock: a call switching the voice must not interleave with an edit.
  const release = await acquireVoiceLock();
  try {
    const result = await updateAssistant(req.params.section, req.body ?? {});
    console.log(`Assistant ${req.params.section} settings updated by ${req.user.email} (version ${result.version})`);
    res.json(result);
  } catch (err) { sendError(res, err); } finally { release(); }
});

// ---------------------------------------------------------------------------
// Admin: guest e-mail (Telnyx Email) and SMS / WhatsApp (Telnyx Messaging).
// ---------------------------------------------------------------------------
app.get("/api/admin/email", requirePage("email"), async (_req, res) => {
  try {
    const settings = await getEmailSettings();
    // The settings still show when Telnyx can't be reached.
    const [domains, messages] = await Promise.allSettled([listDomains(), recentMessages()]);
    res.json({
      settings,
      domains: domains.value ?? [], messages: messages.value ?? [],
      telnyxError: domains.reason?.message || messages.reason?.message || null,
      fallback: recapMode(),
    });
  } catch (err) { sendError(res, err); }
});
app.put("/api/admin/email", requirePage("email"), async (req, res) => {
  try {
    const settings = await saveEmailSettings(req.body ?? {});
    console.log(`E-mail settings updated by ${req.user.email} (${settings.enabled ? `on, from ${settings.from}` : "off"})`);
    res.json({ ok: true, settings });
  } catch (err) { sendError(res, err); }
});
app.post("/api/admin/email/test", requirePage("email"), async (req, res) => {
  if (!recapAllowed(req.ip)) return res.status(429).json({ error: "Too many e-mails, try again later" });
  try {
    const sent = await sendTestEmail(req.body?.to, req.user);
    res.json({ ok: true, status: sent.status, sandbox: sent.sandbox, to: sent.to, id: sent.id });
  } catch (err) { sendError(res, err); }
});

app.get("/api/admin/sms", requirePage("sms"), async (_req, res) => {
  try {
    const [settings, messages] = await Promise.all([getSmsSettings(), recentSms()]);
    res.json({ settings, messages });
  } catch (err) { sendError(res, err); }
});
app.get("/api/admin/sms/profiles", requirePage("sms"), async (_req, res) => {
  try { res.json({ profiles: await listProfiles() }); } catch (err) { sendError(res, err); }
});
app.get("/api/admin/sms/profiles/:id/senders", requirePage("sms"), async (req, res) => {
  try { res.json(await profileSenders(req.params.id)); } catch (err) { sendError(res, err); }
});
app.get("/api/admin/sms/whatsapp", requirePage("sms"), async (_req, res) => {
  try { res.json(await listWhatsApp()); } catch (err) { sendError(res, err); }
});
app.put("/api/admin/sms", requirePage("sms"), async (req, res) => {
  try {
    const settings = await saveSmsSettings(req.body ?? {});
    console.log(`Guest message settings updated by ${req.user.email} (${settings.enabled ? `on, ${settings.channel} from ${settings.channel === "whatsapp" ? settings.waFrom : settings.from}` : "off"})`);
    res.json({ ok: true, settings });
  } catch (err) { sendError(res, err); }
});
app.post("/api/admin/sms/test", requirePage("sms"), async (req, res) => {
  if (!smsAllowed(req.ip)) return res.status(429).json({ error: "Too many messages, try again later" });
  try {
    const sent = await sendTestSms(req.body?.to, req.user.email);
    res.json({ ok: true, status: sent.status, channel: sent.channel, to: sent.to, id: sent.telnyxId, lineType: sent.lineType });
  } catch (err) { sendError(res, err); }
});

// ---------------------------------------------------------------------------
// TTS proxy for voice previews, with a small cache.
// ---------------------------------------------------------------------------
const ttsCache = new Map();

app.post("/api/tts", requirePage("booking", "assistant"), async (req, res) => {
  const { text, voice, language } = req.body ?? {};
  if (typeof text !== "string" || !text.trim() || text.length > 1000) {
    return res.status(400).json({ error: "text must be a non-empty string (max 1000 chars)" });
  }
  if (!(await assistantVoices().catch(() => [])).some((v) => v.id === voice)) return res.status(400).json({ error: "voice must be a Telnyx Ultra voice" });
  const key = `${voice}|${language}|${text}`;
  const cached = ttsCache.get(key);
  if (cached) return res.type(cached.type).send(cached.body);

  try {
    const upstream = await fetch(`${TELNYX}/text-to-speech/speech`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        voice,
        language: language || "en",
        output_type: "binary_output",
      }),
    });
    if (!upstream.ok) {
      const err = await upstream.text();
      console.error(`TTS REST ${upstream.status}: ${err}`);
      return res.status(upstream.status).json({ error: err });
    }
    const type = upstream.headers.get("content-type") || "audio/mpeg";
    const body = Buffer.from(await upstream.arrayBuffer());
    if (ttsCache.size > 100) ttsCache.delete(ttsCache.keys().next().value);
    ttsCache.set(key, { type, body });
    res.type(type).send(body);
  } catch (err) {
    console.error("TTS REST proxy failed:", err);
    res.status(502).json({ error: "Upstream TTS request failed" });
  }
});

// ---------------------------------------------------------------------------
// Booking confirmations. Rate-limited per IP (5 per 10 minutes) so the demo
// can't be used as a relay; the booking is re-validated server-side (recap.js)
// and an SMS goes to mobile numbers only (sms.js).
// ---------------------------------------------------------------------------
function rateLimit(max, windowMs) {
  const hits = new Map();
  return (ip) => {
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) return false;
    hits.set(ip, [...recent, now]);
    return true;
  };
}
const recapAllowed = rateLimit(5, 10 * 60_000);
const smsAllowed = rateLimit(5, 10 * 60_000);

// A guest asks to be contacted by Telnyx (the booking page pop-up).
const contactAllowed = rateLimit(5, 10 * 60_000);
app.post("/api/contact", requirePage("booking"), async (req, res) => {
  if (!isGuest(req.user)) return res.status(403).json({ error: "Only for the guest demo" });
  const { email, phone, consent, lang } = req.body ?? {};
  try {
    parseContact({ email, phone, consent }); // typos don't count against the limit
    if (!contactAllowed(req.ip)) return res.status(429).json({ error: "Too many requests, try again later" });
    res.json(await saveContact({ guestId: req.user.id, email, phone, consent, lang, ip: clientIp(req), country: clientWhere(req).country }));
  } catch (err) { sendError(res, err); }
});

app.post("/api/booking-sms", requirePage("booking"), async (req, res) => {
  const { booking, code, lang } = req.body ?? {};
  const callId = /^c_[0-9a-f]{8,24}$/.test(String(req.body?.callId)) ? req.body.callId : null;
  const rec = activeCallFor(req.user.id);
  const started = Date.now();
  const log = (status, ok, detail) => rec?.http({
    label: "Booking confirmation SMS", method: "POST", url: "/api/booking-sms", status, ok, ms: Date.now() - started, detail,
  });
  try {
    if (isGuest(req.user)) {
      log(200, true, { code, sent: false, reason: "guest demo" });
      return res.json({ sent: false, reason_code: "guest", reason: "Nothing is sent in the guest demo" });
    }
    if (!(await getSmsSettings()).enabled) {
      log(200, true, { code, sent: false, reason: "SMS is off" });
      return res.json({ sent: false, reason_code: "off", reason: "SMS confirmations are turned off" });
    }
    if (!smsAllowed(req.ip)) return res.status(429).json({ error: "Too many messages, try again later" });
    const text = buildSms({ booking: booking ?? {}, code, lang });
    const facts = bookingFacts({ booking: booking ?? {}, code });
    const r = await sendSms({ to: booking?.phone, text, facts, kind: "booking", code, lang, user: req.user.email, callId });
    rec?.setMessage({ smsId: r.id, channel: r.channel, sent: r.sent, status: r.status, reason: r.reason, error: r.error });
    log(200, r.sent, { code, lang, channel: r.channel, sent: r.sent, status: r.status, line_type: r.lineType, error: r.error, message_id: r.telnyxId });
    res.json(r.sent
      ? { sent: true, channel: r.channel, status: r.status, to: r.guestNumber, redirected: r.redirected }
      : { sent: false, channel: r.channel, reason_code: r.reason, reason: r.error });
  } catch (err) {
    log(err.status === 400 ? 400 : 502, false, { code, error: err.message });
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error("Booking SMS failed:", err.message);
    res.status(502).json({ error: "Could not send the SMS" });
  }
});

app.post("/api/booking-recap", requirePage("booking"), async (req, res) => {
  if (isGuest(req.user)) {
    activeCallFor(req.user.id)?.http({
      label: "Booking recap e-mail", method: "POST", url: "/api/booking-recap", status: 200, ok: true, ms: 0,
      detail: { code: req.body?.code, sent: false, reason: "guest demo" },
    });
    return res.json({ sent: false, guest: true, reason: "Nothing is sent in the guest demo" });
  }
  if (!recapAllowed(req.ip)) return res.status(429).json({ error: "Too many recap e-mails, try again later" });
  const { booking, code, lang } = req.body ?? {};
  const rec = activeCallFor(req.user.id); // log it on the call that confirmed the booking
  const started = Date.now();
  const log = (status, ok, detail) => rec?.http({
    label: "Booking recap e-mail", method: "POST", url: "/api/booking-recap", status, ok, ms: Date.now() - started, detail,
  });
  try {
    const result = await sendRecap({ booking, code, lang, user: req.user });
    log(200, true, { code, lang, sent: result.sent, mode: result.mode, preview_url: result.preview_url });
    res.json(result);
  } catch (err) {
    log(err.status === 400 ? 400 : 502, false, { code, error: err.message });
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error("Recap e-mail failed:", err.message);
    res.status(502).json({ error: "Could not send the e-mail" });
  }
});

app.get("/recap/:id", requirePage("booking"), (req, res) => {
  const recap = getPreview(req.params.id);
  if (!recap || (recap.userId !== req.user.id && !isAdmin(req.user))) return res.status(404).send("Recap not found (previews are kept in memory until the server restarts).");
  res.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  res.type("html").send(recap.html);
});

// ---------------------------------------------------------------------------
// Assistant voice switching.
// The realtime conversation API takes the voice from the assistant itself, so
// before each call we set the requested voice on the assistant. A lock is held
// from the update until the conversation has started (session.created), so two
// simultaneous callers can't swap each other's voice.
// ---------------------------------------------------------------------------
let voiceLock = Promise.resolve();

// Pause between a voice update and opening the conversation (see startAssistantCall).
const VOICE_SETTLE_MS = 2000;

function acquireVoiceLock() {
  let release;
  const next = new Promise((r) => (release = r));
  const ready = voiceLock.then(() => release);
  voiceLock = voiceLock.then(() => next);
  return ready;
}

// The assistant is shared by every instance, so read its voice (and whether it
// has a video avatar) from Telnyx: a read is far cheaper than an update.
async function liveAssistantState() {
  const res = await fetch(`${TELNYX}/ai/assistants/${ASSISTANT_ID}`, { headers: authHeaders });
  if (!res.ok) throw new Error(`assistant read ${res.status}`);
  const body = await res.json();
  const a = body.data ?? body;
  return { voice: a.voice_settings?.voice ?? null, avatar: !!a.avatar_settings };
}

async function setAssistantVoice(voice) {
  const current = await liveAssistantState().catch((err) => {
    console.error(`${err.message} — updating the voice anyway`);
    return null;
  });
  const avatar = !!current?.avatar;
  if (current?.voice === voice) return { skipped: true, avatar };
  const res = await fetch(`${TELNYX}/ai/assistants/${ASSISTANT_ID}`, {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ voice_settings: { voice } }),
  });
  if (!res.ok) throw Object.assign(new Error(`assistant update ${res.status}: ${await res.text()}`), { httpStatus: res.status });
  return { status: res.status, avatar };
}

// ---------------------------------------------------------------------------
// WebSocket proxies
// ---------------------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 }); // audio chunks are a few KB

// Refuse an upgrade with a plain HTTP status (the browser sees a failed socket).
function rejectUpgrade(socket, status, text) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

server.on("upgrade", (req, socket, head) => {
  handleUpgrade(req, socket, head).catch((err) => {
    console.error("WebSocket upgrade failed:", err);
    if (!socket.destroyed) rejectUpgrade(socket, 500, "Internal Server Error");
  });
});

async function handleUpgrade(req, socket, head) {
  const url = new URL(req.url, "http://localhost");
  // Cookies ride along on cross-site WebSocket handshakes, so check the Origin.
  const origin = req.headers.origin;
  if (origin) {
    let host;
    try { host = new URL(origin).host; } catch { /* invalid */ }
    if (!host || (host !== req.headers.host && host !== req.headers["x-forwarded-host"])) return rejectUpgrade(socket, 403, "Forbidden");
  }
  try { await storage; } catch { return rejectUpgrade(socket, 503, "Service Unavailable"); }
  await refreshUsers();
  const user = userFromRequest(req);
  if (!user) return rejectUpgrade(socket, 401, "Unauthorized");
  if (url.pathname === "/ws/assistant") {
    if (!canAccess(user, "booking")) return rejectUpgrade(socket, 403, "Forbidden");
    if (isGuest(user) && guestCalls >= GUEST_MAX_CALLS) return rejectUpgrade(socket, 503, "Service Unavailable");
    req.user = user;
    return wss.handleUpgrade(req, socket, head, (client) => startAssistantCall(client, url.searchParams, user, req));
  }
  socket.destroy();
}

// Guest calls: a few at a time per instance, 5 minutes each, English only (the
// page asks for it; the session.update is rewritten so a guest can't change it).
const GUEST_MAX_CALLS = 3;
const GUEST_CALL_MS = 5 * 60_000;
let guestCalls = 0;

function guestFrame(data, isBinary) {
  if (isBinary) return data;
  let ev;
  try { ev = JSON.parse(data.toString()); } catch { return data; }
  if (ev?.type !== "session.update") return data;
  const assistant = { ...ev.session?.assistant };
  assistant.dynamic_variables = { ...assistant.dynamic_variables, languages: "English", start_language: "English" };
  return JSON.stringify({ ...ev, session: { ...ev.session, assistant } });
}

// The caller's address: on Edge the proxy appends it to X-Forwarded-For (one
// hop, as for "trust proxy"); the socket itself is the proxy.
function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  return (onEdge() && (forwarded.at(-1) || String(req.headers["x-real-ip"] || "").trim())) || req.socket.remoteAddress;
}

// A country header, if the platform adds one: the fallback when the origin IP
// isn't in the IP → country table (geo.js).
const COUNTRY_HEADERS = ["cf-ipcountry", "x-country-code", "x-geo-country", "cloudfront-viewer-country", "x-vercel-ip-country"];
function clientWhere(req) {
  const country = COUNTRY_HEADERS.map((h) => String(req.headers[h] || "").toUpperCase()).find((c) => /^[A-Z]{2}$/.test(c) && c !== "XX");
  return { country: country || null };
}

// The voice is the user's preference (cookie). Telnyx takes the voice from the
// assistant itself, so it is set there before the call (under the voice lock).
async function startAssistantCall(client, query, user, req) {
  let voice = String(readCookie(req.headers.cookie, PREFS) || "").split("|")[2] || null;
  const inputRate = Number(query.get("input_sample_rate")) || 16000;
  const rec = createCallRecorder({
    user, voice, inputRate,
    ip: clientIp(req), userAgent: String(req.headers["user-agent"] || "").slice(0, 300), where: clientWhere(req),
  });
  rec.note("client.connected", { path: "/ws/assistant", voice, input_sample_rate: inputRate });

  const fail = (message) => {
    console.error(`assistant call: ${message}`);
    rec.fail(message);
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: "error", error: { code: "proxy_error", message } }));
      client.close(1011);
    }
  };
  if (!ASSISTANT_ID) return fail("TELNYX_ASSISTANT_ID is not configured on the server");
  if (isGuest(user)) {
    guestCalls++;
    const limit = setTimeout(() => {
      if (client.readyState !== WebSocket.OPEN) return;
      rec.note("guest.time_limit", { ms: GUEST_CALL_MS });
      client.send(JSON.stringify({ type: "error", error: { code: "guest_time_limit", message: "Guest calls last up to 5 minutes" } }));
      client.close(1000);
    }, GUEST_CALL_MS);
    client.once("close", () => { guestCalls--; clearTimeout(limit); });
  }

  // Record every browser frame; buffer the first ones (session.update) while we prepare.
  client.on("message", (data, isBinary) => rec.clientFrame(data, isBinary));
  const early = [];
  const buffer = (data, isBinary) => early.push([data, isBinary]);
  client.on("message", buffer);
  const earlyClose = (code) => rec.end(`browser closed the socket before the call started (${code})`);
  client.on("close", earlyClose);

  let voices;
  let t = rec.now();
  const cached = Date.now() - voiceCache.at < 10 * 60_000 && voiceCache.voices.length > 0;
  try {
    voices = await assistantVoices();
    rec.step("voices", t, { detail: { source: cached ? "cache" : "GET /v2/text-to-speech/voices", count: voices.length } });
  } catch (err) {
    rec.step("voices", t, { ok: false, detail: { error: err.message } });
    return fail(`could not load voices: ${err.message}`);
  }
  const preferred = await preferences(req).catch(() => ({}));
  if (voice && voice !== preferred.voice) return fail(`voice not allowed: ${voice}`);
  voice = preferred.voice;
  const voiceInfo = voices.find((v) => v.id === voice);
  if (!voiceInfo) return fail("no voice is set up for this language");
  rec.setVoice(voiceInfo);

  t = rec.now();
  const release = await acquireVoiceLock();
  rec.step("voice_lock", t, { detail: { note: "waits for other calls that are switching the assistant voice" } });
  let released = false;
  const unlock = () => { if (!released) { released = true; clearTimeout(lockTimer); release(); } };
  const lockTimer = setTimeout(unlock, 15_000); // never hold the lock forever

  if (client.readyState !== WebSocket.OPEN) return unlock(); // browser gave up meanwhile
  t = rec.now();
  let avatarConfigured = false;
  let switched = false;
  try {
    const result = await setAssistantVoice(voice);
    avatarConfigured = result.avatar;
    switched = !result.skipped;
    rec.step("assistant_voice", t, { detail: result.skipped ? { skipped: "voice already set on the assistant" } : { voice } });
    if (!result.skipped) {
      rec.http({ label: "Set assistant voice", method: "POST", url: `/v2/ai/assistants/${ASSISTANT_ID}`, status: result.status, ok: true, ms: rec.now() - t, detail: { voice_settings: { voice } } });
    }
  } catch (err) {
    rec.step("assistant_voice", t, { ok: false, detail: { error: err.message } });
    rec.http({ label: "Set assistant voice", method: "POST", url: `/v2/ai/assistants/${ASSISTANT_ID}`, status: err.httpStatus || null, ok: false, ms: rec.now() - t, detail: { error: err.message } });
    unlock();
    return fail(err.message);
  }
  if (client.readyState !== WebSocket.OPEN) return unlock();
  if (switched) {
    // A conversation opened within ~0.7 s of the voice update has been seen to
    // run without its tools; give Telnyx time to apply the new version.
    t = rec.now();
    await new Promise((r) => setTimeout(r, VOICE_SETTLE_MS));
    rec.step("voice_settle", t, { detail: { note: `waits ${VOICE_SETTLE_MS} ms after a voice change` } });
    if (client.readyState !== WebSocket.OPEN) return unlock();
  }

  const target = new URL(`${TELNYX_WS}/ai/assistants/${ASSISTANT_ID}/conversation`);
  target.searchParams.set("input_sample_rate", String(inputRate));
  // Video avatar: only for users an admin turned it on for, when the assistant
  // has one configured; the page can still ask for voice only (avatar=0).
  const avatar = !!user.avatar && avatarConfigured && query.get("avatar") !== "0";
  if (avatar) target.searchParams.set("avatar", "true");
  rec.note("avatar", { enabled: avatar, user_allowed: !!user.avatar, configured: avatarConfigured });
  // The call id goes to the page so the confirmation SMS can name its call: Edge runs
  // several instances, and the SMS request may reach one that isn't holding this call.
  client.send(JSON.stringify({ type: "telnyxhotel.call", avatar, callId: rec.id }));

  client.off("message", buffer);
  client.off("close", earlyClose);
  const upstreamStart = rec.now();
  let upstreamOpen = upstreamStart;
  let sessionStarted = false;
  const rewrite = isGuest(user) ? guestFrame : null;
  bridge(client, target, {
    rewrite,
    initial: rewrite ? early.map(([data, isBinary]) => [rewrite(data, isBinary), isBinary]) : early,
    onUpstreamOpen() {
      rec.step("upstream_ws", upstreamStart, { detail: { url: `${target.origin}${target.pathname}` } });
      upstreamOpen = rec.now();
    },
    onUpstreamText(text) {
      // On avatar calls session.created waits for the browser's WebRTC setup; the
      // session is already prepared at avatar.session.ready, so release the lock there.
      if (!released && (text.includes('"session.created"') || text.includes('"avatar.session.ready"'))) unlock();
      if (!sessionStarted && text.includes('"session.created"')) {
        sessionStarted = true;
        rec.step("session_created", upstreamOpen, { detail: { note: "Telnyx started the conversation" } });
      }
    },
    onUpstreamMessage: (data, isBinary) => rec.upstreamFrame(data, isBinary),
    onHandshakeError(status, body) {
      rec.step("upstream_ws", upstreamStart, { ok: false, detail: { status, body: body.slice(0, 500) } });
    },
    onClose(side, code) {
      unlock();
      rec.note(`${side}.closed`, { code });
      rec.end(`${side === "client" ? "browser" : "Telnyx"} closed the connection (${code})`);
    },
  });
}

function bridge(client, target, { initial = [], rewrite, onUpstreamOpen, onUpstreamText, onUpstreamMessage, onHandshakeError, onClose } = {}) {
  // No per-message compression: frames are mostly base64 audio, so deflate only adds delay.
  const upstream = new WebSocket(target, { headers: authHeaders, perMessageDeflate: false });
  const pending = [...initial]; // client frames received before upstream is open

  client.on("message", (data, isBinary) => {
    if (rewrite) data = rewrite(data, isBinary);
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
    else pending.push([data, isBinary]);
  });
  upstream.on("open", () => {
    for (const [data, isBinary] of pending) upstream.send(data, { binary: isBinary });
    pending.length = 0;
    onUpstreamOpen?.();
  });
  upstream.on("message", (data, isBinary) => {
    if (!isBinary && onUpstreamText) onUpstreamText(data.toString());
    onUpstreamMessage?.(data, isBinary);
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });

  // Surface handshake failures (401/403/400) to the browser as a JSON error.
  let handshakeFailed = false;
  upstream.on("unexpected-response", (_req, res) => {
    handshakeFailed = true;
    let body = "";
    res.on("data", (c) => (body += c));
    res.on("end", () => {
      console.error(`${target.pathname} upstream ${res.statusCode}: ${body}`);
      onHandshakeError?.(res.statusCode, body);
      if (client.readyState === WebSocket.OPEN) {
        const message = `Telnyx ${res.statusCode}: ${body || res.statusMessage}`;
        client.send(JSON.stringify({ type: "error", error: { code: "upstream_http", message }, message }));
        client.close(1011);
      }
    });
  });
  upstream.on("error", (err) => {
    if (!handshakeFailed) console.error(`${target.pathname} upstream error:`, err.message);
    if (client.readyState === WebSocket.OPEN) client.close(1011);
  });

  const safeClose = (ws, code) => {
    if (ws.readyState === WebSocket.OPEN) ws.close(code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000);
    else if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
  };
  upstream.on("close", (code) => { safeClose(client, code); onClose?.("upstream", code); });
  client.on("close", (code) => { safeClose(upstream, code); onClose?.("client", code); });
  client.on("error", () => safeClose(upstream, 1011));
}

// Last: unknown errors (bad JSON, oversized bodies, …) as JSON, never a stack trace.
app.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? "Internal error" : err.expose === false ? "Bad request" : err.message });
});

// A bug in one request must not take the whole demo down.
process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err));

server.listen(PORT, () => {
  assistantVoices().catch((err) => console.error("Voice list prefetch failed:", err.message)); // warm the first call
  console.log(`TelnyxHotel demo running at http://localhost:${PORT}`);
  console.log(`Recap e-mails: Telnyx Email when it is turned on in /email.html, otherwise ${recapMode()}`);
});
