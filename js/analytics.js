// The Hunt — local playtest analytics (GDD §50 success metrics).
//
// Logs, per play session and per signal ("hunt"):
//   • signals detected vs. tracked vs. captured
//   • time per hunt (active tracking time + wall-clock time to capture)
//   • distance walked per session and per hunt
//   • where hunts are abandoned (closest distance band reached before the
//     signal was dropped / switched away from / faded / the session ended)
//   • behaviour events (runner escapes, hider vanishes), screen time
//
// Also (playtest 2026-10-15 follow-up): GPS accuracy, where the heading came
// from (direction of travel vs. compass), capture-screen use, "capture now"
// alerts, "moving away" nudges, and a desk-test vs. field-session split.
//
// And (playtest 2026-10-16 follow-up): every session is stamped with the
// app build (CONFIG.build) and the summary is split per build; each tracked
// hunt keeps a distance-to-signal sample every 5s ([seconds, metres, speed
// dm/s] — still no coordinates), walking speed inside the search area, and
// how the capture was reached (the CAPTURE NOW bar vs. the nav / scanner).
//
// Everything stays in localStorage on the device and is exported as JSON
// from the Journal tab. Privacy (GDD §39): NO coordinates are ever stored
// here — only distances, durations, counts and species/behaviour labels.

import { CONFIG } from './config.js';
import { speciesById } from './characters.js';

const STORE_KEY = 'thehunt_analytics_v1';
const SCHEMA = 1;
const MAX_SESSIONS = 200;
// Coming back to the app after this long counts as a new session.
const SESSION_GAP_MS = 30 * 60 * 1000;
const PERSIST_EVERY_MS = 10 * 1000;
// A session counts as a desk test (not a real field hunt) below either of these.
const FIELD_MIN_ACTIVE_MS = 60 * 1000;
const FIELD_MIN_DISTANCE_M = 25;
// GPS accuracy histogram buckets (upper bounds, metres).
const ACC_BUCKETS = [5, 10, 20, 40, Infinity];
const MAX_ACC_SAMPLES = 120;

// Closest-approach bands, nearest first. A hunt's "stage" is the nearest
// band the player ever reached for that signal.
function bands() {
  return [
    { id: 'capture-range', maxM: CONFIG.captureRangeM },
    { id: 'very-close', maxM: CONFIG.veryCloseM },
    { id: 'close', maxM: 30 },
    { id: 'mid', maxM: 80 },
    { id: 'far', maxM: 150 },
    { id: 'distant', maxM: Infinity },
  ];
}
export function bandFor(distM) {
  if (distM == null || !isFinite(distM)) return 'never-tracked';
  return bands().find((b) => distM <= b.maxM).id;
}

let store = load();
let session = null;          // current session object (lives inside store.sessions)
let hunts = new Map();       // signalId -> hunt record (open hunts of current session)
let currentHuntId = null;
let lastTickAt = null;
let lastPersistAt = 0;
let currentScreen = null;
let screenSince = null;
let hiddenAt = null;

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const s = raw ? JSON.parse(raw) : null;
    if (s && s.schema === SCHEMA && Array.isArray(s.sessions)) return s;
  } catch (err) {
    console.warn('analytics: failed to load', err);
  }
  return { schema: SCHEMA, createdAt: Date.now(), sessions: [] };
}

function persist(force) {
  const now = Date.now();
  if (!force && now - lastPersistAt < PERSIST_EVERY_MS) return;
  lastPersistAt = now;
  if (session) session.lastActiveAt = now;
  if (store.sessions.length > MAX_SESSIONS) store.sessions = store.sessions.slice(-MAX_SESSIONS);
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch (err) {
    console.warn('analytics: failed to save', err);
  }
}

/** Close any session left open by a previous page load (app killed, tab closed). */
function closeStaleSessions() {
  for (const s of store.sessions) {
    if (s.endedAt) continue;
    s.endedAt = s.lastActiveAt || s.startedAt;
    s.endReason = 'app-closed';
    for (const h of s.hunts) if (!h.outcome) finaliseHunt(h, 'session-ended', s.endedAt, s);
  }
}
closeStaleSessions();
persist(true);

/* ------------------------------------------------------------------ */
/* Sessions                                                             */
/* ------------------------------------------------------------------ */

export function startSession(extra = {}) {
  if (session) endSession('restarted');
  const now = Date.now();
  session = {
    id: `s-${now.toString(36)}`,
    startedAt: now,
    lastActiveAt: now,
    endedAt: null,
    endReason: null,
    build: CONFIG.build,     // app build this session ran on
    gpsFixMs: null,          // time from Start Hunting to first GPS fix
    firstCaptureMs: null,    // time from Start Hunting to first capture
    distanceM: 0,            // walked this session (implausible jumps ignored)
    activeMs: 0,             // foreground play time
    screenMs: {},
    terrain: null,           // 'ready' | 'failed' | ...
    nightAtStart: null,
    terrainSource: null,     // 'network' | 'cache' | 'stale-cache'
    counts: {
      detected: 0, tracked: 0, captured: 0, faded: 0,
      fled: 0, hid: 0, switches: 0, legendaryEvents: 0,
      leftBehind: 0, searchEntries: 0, colderWarnings: 0,
      captureReady: 0,            // "in capture range" alerts fired
      captureScreenOpens: 0,
      captureScreenOutOfRange: 0, // opened the capture screen while it couldn't capture
      awayNudges: 0,              // "you're moving away" nudges
      autoRetargets: 0,           // game swapped to a closer signal
      aheadSpawns: 0,             // signals placed ahead of a walking player
      behindDespawns: 0,          // signals dropped because they were far behind a walker
      aheadOffers: 0,             // "new signal ahead" offered after walking away from everything
      slowDownPrompts: 0,         // "slow down" in the search area (walking through at pace)
    },
    headingMs: {},           // foreground time by heading source (course / compass / …)
    gpsAccuracyHist: {},     // tick counts by GPS accuracy bucket (≤5, ≤10, ≤20, ≤40, >40 m)
    hunts: [],
    ...extra,
  };
  store.sessions.push(session);
  hunts = new Map();
  currentHuntId = null;
  lastTickAt = now;
  persist(true);
  return session;
}

export function endSession(reason = 'ended') {
  if (!session) return;
  const now = Date.now();
  flushScreenTime(now);
  for (const h of hunts.values()) if (!h.outcome) finaliseHunt(h, 'session-ended', now, session);
  session.endedAt = now;
  session.endReason = reason;
  persist(true);
  session = null;
  hunts = new Map();
  currentHuntId = null;
}

export function noteGpsFix() {
  if (session && session.gpsFixMs == null) session.gpsFixMs = Date.now() - session.startedAt;
}

export function noteContext({ terrain, night, terrainSource } = {}) {
  if (!session) return;
  if (terrain) session.terrain = terrain;
  if (terrainSource) session.terrainSource = terrainSource;
  if (night != null && session.nightAtStart == null) session.nightAtStart = !!night;
}

/* ------------------------------------------------------------------ */
/* Hunts                                                                */
/* ------------------------------------------------------------------ */

/** A signal appeared within scanner range ("detected"). */
export function signalDetected(sig, distFromPlayerM) {
  if (!session || hunts.has(sig.id)) return;
  const species = speciesById(sig.speciesId);
  const h = {
    signalId: sig.id,
    speciesId: sig.speciesId,
    rarity: species?.rarity || null,
    behaviour: sig.behavior,
    habitat: sig.habitat,
    terrainChecked: !sig.unchecked,
    detectedAt: Date.now(),
    detectedDistM: round(distFromPlayerM),
    firstTrackedAt: null,
    trackedStints: 0,
    activeTrackMs: 0,        // foreground time spent with this as the current signal
    walkedWhileTrackingM: 0,
    closestM: null,          // closest approach while tracking
    lastDistM: null,
    reachedVeryCloseAt: null,
    reachedCaptureRangeAt: null,
    fled: 0,
    hid: 0,
    enteredSearchAreaAt: null, // first time inside the search area (Search stage)
    searchEntries: 0,
    colderWarnings: 0,
    captureReadyAt: null,    // first "in capture range" alert (accuracy-aware range)
    awayNudges: 0,
    aheadSpawn: !!sig.aheadSpawn, // placed ahead of a walking player
    aheadOffer: !!sig.aheadOffer, // the "new signal ahead" offer
    slowDownPrompts: 0,
    searchStoppedMs: 0,      // time spent (nearly) standing still inside the search area
    _searchSpeeds: [],       // walking speed samples inside the search area (dm/s)
    track: [],               // [secondsSinceFirstTracked, distM, speed dm/s] every ~5s while tracking
    _lastSampleAt: 0,
    captureVia: null,        // 'bar' (CAPTURE NOW bar) | 'nav' | 'scanner'
    gpsAccuracyAtClosestM: null,
    captureRangeAtClosestM: null,
    _acc: [],                // GPS accuracy samples while tracking (summarised at the end)
    outcome: null,           // captured | faded | dawn | left-behind | made-room | session-ended
    endedAt: null,
    stageAtEnd: null,        // closest band reached
    timeToCaptureMs: null,   // wall clock: first tracked -> captured
  };
  hunts.set(sig.id, h);
  session.hunts.push(h);
  session.counts.detected += 1;
  if (h.aheadSpawn) session.counts.aheadSpawns = (session.counts.aheadSpawns || 0) + 1;
  if (h.rarity === 'legendary') session.counts.legendaryEvents += 1;
}

/** The tracked signal just came into (accuracy-aware) capture range. */
export function captureReady(sigId) {
  if (!session) return;
  session.counts.captureReady = (session.counts.captureReady || 0) + 1;
  const h = hunts.get(sigId);
  if (h && !h.captureReadyAt) h.captureReadyAt = Date.now();
}

/** The Capture screen was opened; `canCapture` = the tracked signal was in range. */
export function captureScreenOpened(canCapture) {
  if (!session) return;
  session.counts.captureScreenOpens = (session.counts.captureScreenOpens || 0) + 1;
  if (!canCapture) session.counts.captureScreenOutOfRange = (session.counts.captureScreenOutOfRange || 0) + 1;
}

/** Direction help: 'away' (moving-away nudge) or 'retarget' (auto-switched to a closer signal). */
export function directionEvent(type, sigId) {
  if (!session) return;
  if (type === 'away') {
    session.counts.awayNudges = (session.counts.awayNudges || 0) + 1;
    const h = hunts.get(sigId);
    if (h) h.awayNudges = (h.awayNudges || 0) + 1;
  } else if (type === 'retarget') {
    session.counts.autoRetargets = (session.counts.autoRetargets || 0) + 1;
  } else if (type === 'offer') {
    session.counts.aheadOffers = (session.counts.aheadOffers || 0) + 1;
  }
}

/** The player made this signal the one they're following. */
export function signalTracked(sigId, source = 'player') {
  if (!session) return;
  if (currentHuntId && currentHuntId !== sigId) {
    const prev = hunts.get(currentHuntId);
    if (prev && !prev.outcome) session.counts.switches += 1;
  }
  currentHuntId = sigId;
  const h = hunts.get(sigId);
  if (!h || h.outcome) return;
  if (!h.firstTrackedAt) {
    h.firstTrackedAt = Date.now();
    h.firstTrackedBy = source;   // 'player' tapped it, 'auto' (nearest after a capture / on start), 'auto-retarget', 'restored'
    session.counts.tracked += 1;
  }
  h.trackedStints += 1;
}

export function behaviourEvent(type, sigId) {
  if (!session) return;
  const h = hunts.get(sigId);
  if (type === 'fled') { session.counts.fled += 1; if (h) h.fled += 1; }
  if (type === 'hid') { session.counts.hid += 1; if (h) h.hid += 1; }
}

/** Search-stage events for a hunt: entered | left | warmer | colder. */
export function searchEvent(type, sigId) {
  if (!session) return;
  const h = hunts.get(sigId);
  if (type === 'entered') {
    session.counts.searchEntries = (session.counts.searchEntries || 0) + 1;
    if (h) { h.searchEntries += 1; if (!h.enteredSearchAreaAt) h.enteredSearchAreaAt = Date.now(); }
  } else if (type === 'colder') {
    session.counts.colderWarnings = (session.counts.colderWarnings || 0) + 1;
    if (h) h.colderWarnings += 1;
  } else if (type === 'slow-down') {
    session.counts.slowDownPrompts = (session.counts.slowDownPrompts || 0) + 1;
    if (h) h.slowDownPrompts = (h.slowDownPrompts || 0) + 1;
  }
}

/** `via`: how the player reached the Capture screen — 'bar' | 'nav' | 'scanner'. */
export function signalCaptured(sigId, via = null) {
  if (!session) return;
  const h = hunts.get(sigId);
  const now = Date.now();
  if (h) h.captureVia = via;
  session.counts.captured += 1;
  if (session.firstCaptureMs == null) session.firstCaptureMs = now - session.startedAt;
  if (h && !h.outcome) {
    if (!h.firstTrackedAt) { h.firstTrackedAt = h.detectedAt; session.counts.tracked += 1; }
    h.timeToCaptureMs = now - h.firstTrackedAt;
    finaliseHunt(h, 'captured', now, session);
  }
  if (currentHuntId === sigId) currentHuntId = null;
  persist(true);
}

/** Signal left the active list without a capture (legendary expiry, dawn, left behind). */
export function signalGone(sigId, reason) {
  if (!session) return;
  const h = hunts.get(sigId);
  if (h && !h.outcome) {
    finaliseHunt(h, reason, Date.now(), session);
    if (reason === 'behind') session.counts.behindDespawns = (session.counts.behindDespawns || 0) + 1;
    if (reason === 'left-behind' || reason === 'made-room' || reason === 'behind') session.counts.leftBehind = (session.counts.leftBehind || 0) + 1;
    else session.counts.faded += 1;
  }
  if (currentHuntId === sigId) currentHuntId = null;
  persist(true);
}

function finaliseHunt(h, outcome, at, s) {
  h.outcome = outcome;
  h.endedAt = at;
  tidyHunt(h);
  if (s === session) hunts.delete(h.signalId);
}

/** Round the running numbers and fold the accuracy samples into a median. */
function tidyHunt(h) {
  h.stageAtEnd = !h.firstTrackedAt ? 'never-tracked' : h.closestM == null ? 'distant' : bandFor(h.closestM);
  h.walkedWhileTrackingM = round(h.walkedWhileTrackingM);
  h.closestM = round(h.closestM);
  h.lastDistM = round(h.lastDistM);
  h.activeTrackMs = Math.round(h.activeTrackMs);
  if (Array.isArray(h._acc)) {
    h.gpsAccuracyMedianM = median(h._acc.map(Math.round));
    delete h._acc;
  }
  if (Array.isArray(h._searchSpeeds)) {
    const m = median(h._searchSpeeds);
    h.searchSpeedMedianMps = m == null ? null : m / 10;
    delete h._searchSpeeds;
  }
  if (h.searchStoppedMs != null) h.searchStoppedMs = Math.round(h.searchStoppedMs);
  delete h._lastSampleAt;
  return h;
}

/* ------------------------------------------------------------------ */
/* Per-tick / per-fix updates                                          */
/* ------------------------------------------------------------------ */

/**
 * Called every game tick with the live signal list (distances computed).
 * ctx: { headingSource, accuracyM, speedMps, searching } — where the heading
 * came from this tick, the current GPS accuracy (metres), walking speed, and
 * whether the tracked signal is in Search mode.
 */
export function tick(signals, ctx = {}) {
  if (!session) return;
  const now = Date.now();
  const dt = lastTickAt && !document.hidden ? Math.min(now - lastTickAt, 10000) : 0;
  lastTickAt = now;
  session.activeMs += dt;
  const acc = isFinite(ctx.accuracyM) ? ctx.accuracyM : null;
  if (dt > 0) {
    const src = ctx.headingSource || 'none';
    session.headingMs ||= {};
    session.headingMs[src] = (session.headingMs[src] || 0) + dt;
    if (acc != null) {
      const b = ACC_BUCKETS.find((x) => acc <= x);
      const key = b === Infinity ? '>40' : `≤${b}`;
      session.gpsAccuracyHist ||= {};
      session.gpsAccuracyHist[key] = (session.gpsAccuracyHist[key] || 0) + 1;
    }
  }

  const h = currentHuntId ? hunts.get(currentHuntId) : null;
  if (h && !h.outcome) {
    h.activeTrackMs += dt;
    if (acc != null && dt > 0) {
      h._acc ||= [];
      if (h._acc.length < MAX_ACC_SAMPLES) h._acc.push(acc);
    }
    const sig = signals.find((s) => s.id === currentHuntId);
    if (sig && isFinite(sig._distanceM) && !sig._hidden) {
      const d = sig._distanceM;
      h.lastDistM = d;
      if (h.closestM == null || d < h.closestM) {
        h.closestM = d;
        h.gpsAccuracyAtClosestM = round(acc);
        h.captureRangeAtClosestM = sig._captureRangeM ?? CONFIG.captureRangeM;
      }
      if (d <= CONFIG.veryCloseM && !h.reachedVeryCloseAt) h.reachedVeryCloseAt = now;
      if (sig._canCapture && !h.reachedCaptureRangeAt) h.reachedCaptureRangeAt = now;
      const speed = isFinite(ctx.speedMps) ? ctx.speedMps : null;
      // Distance profile of the hunt, every ~5s (no coordinates).
      if (dt > 0 && h.firstTrackedAt && now - (h._lastSampleAt || 0) >= CONFIG.huntSampleEveryMs) {
        h._lastSampleAt = now;
        h.track ||= [];
        if (h.track.length < CONFIG.huntMaxSamples) {
          h.track.push([Math.round((now - h.firstTrackedAt) / 1000), Math.round(d), speed == null ? null : Math.round(speed * 10)]);
        }
      }
      // How players move inside the search area: do they stop and look?
      if (ctx.searching && dt > 0 && speed != null) {
        h._searchSpeeds ||= [];
        if (h._searchSpeeds.length < 400) h._searchSpeeds.push(Math.round(speed * 10));
        if (speed < CONFIG.stoppedSpeedMps) h.searchStoppedMs = (h.searchStoppedMs || 0) + dt;
      }
    }
  }
  persist(false);
}

/** Called with each accepted GPS movement delta (metres). */
export function moved(deltaM) {
  if (!session || !(deltaM > 0)) return;
  session.distanceM += deltaM;
  const h = currentHuntId ? hunts.get(currentHuntId) : null;
  if (h && !h.outcome) h.walkedWhileTrackingM += deltaM;
}

export function screenChanged(name) {
  const now = Date.now();
  flushScreenTime(now);
  currentScreen = name;
  screenSince = now;
}

function flushScreenTime(now) {
  if (session && currentScreen && screenSince && !document.hidden) {
    session.screenMs[currentScreen] = (session.screenMs[currentScreen] || 0) + (now - screenSince);
  }
  screenSince = now;
}

/* Background / foreground: persist on hide, roll a new session after a long gap. */
document.addEventListener('visibilitychange', () => {
  const now = Date.now();
  if (document.hidden) {
    if (session && currentScreen && screenSince) {
      session.screenMs[currentScreen] = (session.screenMs[currentScreen] || 0) + (now - screenSince);
    }
    hiddenAt = now;
    persist(true);
  } else {
    screenSince = now;
    lastTickAt = now;
    if (session && hiddenAt && now - hiddenAt > SESSION_GAP_MS) {
      session.lastActiveAt = hiddenAt;
      endSession('backgrounded');
      startSession({ resumed: true });
      // Signals still on the map carry into the new session as fresh detections.
      _rehydrate?.();
    }
    hiddenAt = null;
  }
});
window.addEventListener('pagehide', () => persist(true));

let _rehydrate = null;
/** app.js supplies a callback that re-registers live signals after a session roll-over. */
export function setRehydrate(fn) { _rehydrate = fn; }

/* ------------------------------------------------------------------ */
/* Summary + export                                                     */
/* ------------------------------------------------------------------ */

function round(n) { return n == null || !isFinite(n) ? null : Math.round(n); }
function median(arr) {
  const a = arr.filter((x) => x != null).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
}
function mean(arr) {
  const a = arr.filter((x) => x != null);
  return a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : null;
}
function pct(n, d) { return d ? Math.round((n / d) * 1000) / 10 : null; }
function mergeCounts(objs) {
  const out = {};
  for (const o of objs) for (const [k, v] of Object.entries(o || {})) out[k] = (out[k] || 0) + v;
  return out;
}
function mergeMinutes(objs) {
  const ms = mergeCounts(objs);
  return Object.fromEntries(Object.entries(ms).map(([k, v]) => [k, Math.round(v / 6000) / 10]));
}

function groupStats(allHunts, key) {
  const out = {};
  for (const h of allHunts) {
    const k = h[key] ?? 'unknown';
    const g = (out[k] ||= { detected: 0, tracked: 0, captured: 0, abandoned: 0, captureTimesMs: [] });
    g.detected += 1;
    if (h.firstTrackedAt) g.tracked += 1;
    if (h.outcome === 'captured') { g.captured += 1; g.captureTimesMs.push(h.activeTrackMs); }
    else if (h.firstTrackedAt && h.outcome) g.abandoned += 1;
  }
  for (const g of Object.values(out)) {
    g.trackedCaptureRatePct = pct(g.captured, g.tracked);
    g.medianActiveHuntS = median(g.captureTimesMs) == null ? null : Math.round(median(g.captureTimesMs) / 1000);
    delete g.captureTimesMs;
  }
  return out;
}

/** Sessions with anything in them (a restart before a GPS fix leaves an empty one). */
function nonEmptySessions() {
  return store.sessions.filter((s) => s.activeMs > 0 || s.hunts.length);
}

/** Real outdoor hunt, or a quick desk/indoor test? */
export function isFieldSession(s) {
  return s.activeMs >= FIELD_MIN_ACTIVE_MS && s.distanceM >= FIELD_MIN_DISTANCE_M;
}

/**
 * Which build a session ran on. Sessions logged before builds were stamped
 * are dated: the 2026-10-15 fixes went live that afternoon.
 */
export function sessionBuild(s) {
  if (s.build) return s.build;
  return s.startedAt < Date.UTC(2026, 9, 15, 13, 0) ? 'pre-2026-10-15' : '2026-10-15';
}

function buildBrief(sessions) {
  const f = summaryFor(sessions);
  const field = summaryFor(sessions.filter(isFieldSession));
  return {
    sessions: f.sessions,
    fieldSessions: field.sessions,
    fieldActiveMinutes: field.totalActiveMinutes,
    fieldWalkedM: Math.round(sessions.filter(isFieldSession).reduce((t, s) => t + (s.distanceM || 0), 0)),
    captured: f.signals.captured,
    tracked: f.signals.tracked,
    trackedToCapturedPct: f.signals.trackedToCapturedPct,
    fieldCapturesPerActiveHour: field.perSession.capturesPerActiveHour,
    searchAreaHunts: f.searchStage.huntsThatReachedSearchArea,
    capturedAfterSearchArea: f.searchStage.capturedAfterReachingSearchArea,
  };
}

/** Aggregate §50 metrics over every logged session (includes the live one). */
export function summary() {
  const sessions = nonEmptySessions();
  const field = sessions.filter(isFieldSession);
  const out = summaryFor(sessions);
  // Per build, so a new version's numbers aren't drowned out by old sessions.
  const builds = [...new Set(sessions.map(sessionBuild))];
  out.byBuild = Object.fromEntries(builds.map((b) => [b, buildBrief(sessions.filter((s) => sessionBuild(s) === b))]));
  const cur = sessions.filter((s) => sessionBuild(s) === CONFIG.build);
  out.currentBuild = { build: CONFIG.build, ...summaryFor(cur), fieldOnly: summaryFor(cur.filter(isFieldSession)) };
  delete out.currentBuild.fieldOnly.fieldOnly;
  // Same core numbers, field sessions only — desk tests (short, barely
  // moving) drag the averages down and hide what happens outdoors.
  const f = summaryFor(field);
  out.fieldOnly = {
    rule: `active ≥ ${FIELD_MIN_ACTIVE_MS / 1000}s and walked ≥ ${FIELD_MIN_DISTANCE_M}m`,
    sessions: f.sessions,
    totalActiveMinutes: f.totalActiveMinutes,
    signals: f.signals,
    perSession: f.perSession,
    searchStage: f.searchStage,
    captureFlow: f.captureFlow,
    direction: f.direction,
    abandonedByClosestStageReached: f.abandonment.byClosestStageReached,
  };
  return out;
}

function summaryFor(sessions) {
  const all = sessions.flatMap((s) => s.hunts);
  const finished = all.filter((h) => h.outcome);
  const captured = finished.filter((h) => h.outcome === 'captured');
  const trackedNotCaptured = finished.filter((h) => h.firstTrackedAt && h.outcome !== 'captured');
  const tracked = all.filter((h) => h.firstTrackedAt);

  const abandonmentByStage = {};
  for (const b of bands()) abandonmentByStage[b.id] = 0;
  for (const h of trackedNotCaptured) abandonmentByStage[h.stageAtEnd] = (abandonmentByStage[h.stageAtEnd] || 0) + 1;
  const abandonmentByOutcome = {};
  for (const h of trackedNotCaptured) abandonmentByOutcome[h.outcome] = (abandonmentByOutcome[h.outcome] || 0) + 1;

  const sum = (f) => sessions.reduce((t, s) => t + (f(s) || 0), 0);
  const totalActiveMin = sum((s) => s.activeMs) / 60000;

  return {
    sessions: sessions.length,
    totalActiveMinutes: Math.round(totalActiveMin * 10) / 10,
    signals: {
      detected: all.length,
      tracked: tracked.length,
      captured: captured.length,
      detectedToCapturedPct: pct(captured.length, all.length),
      trackedToCapturedPct: pct(captured.length, tracked.length),
    },
    perSession: {
      medianActiveMinutes: median(sessions.map((s) => Math.round(s.activeMs / 6000) / 10)),
      meanDistanceM: mean(sessions.map((s) => s.distanceM)),
      medianDistanceM: median(sessions.map((s) => Math.round(s.distanceM))),
      meanCaptures: sessions.length ? Math.round((captured.length / sessions.length) * 10) / 10 : null,
      capturesPerActiveHour: totalActiveMin > 0 ? Math.round((captured.length / totalActiveMin) * 600) / 10 : null,
      medianTimeToFirstCaptureS: median(sessions.map((s) => s.firstCaptureMs == null ? null : Math.round(s.firstCaptureMs / 1000))),
      medianGpsFixS: median(sessions.map((s) => s.gpsFixMs == null ? null : Math.round(s.gpsFixMs / 1000))),
    },
    perCapturedHunt: {
      medianActiveTrackS: median(captured.map((h) => Math.round(h.activeTrackMs / 1000))),
      medianWallClockS: median(captured.map((h) => h.timeToCaptureMs == null ? null : Math.round(h.timeToCaptureMs / 1000))),
      medianWalkedM: median(captured.map((h) => h.walkedWhileTrackingM)),
      medianStartDistanceM: median(captured.map((h) => h.detectedDistM)),
      medianSecondsFromCaptureRangeToCapture: median(captured.map((h) =>
        h.reachedCaptureRangeAt ? Math.round((h.endedAt - h.reachedCaptureRangeAt) / 1000) : null)),
      medianSecondsFromSearchAreaToCapture: median(captured.map((h) =>
        h.enteredSearchAreaAt ? Math.round((h.endedAt - h.enteredSearchAreaAt) / 1000) : null)),
    },
    searchStage: {
      huntsThatReachedSearchArea: tracked.filter((h) => h.enteredSearchAreaAt).length,
      capturedAfterReachingSearchArea: captured.filter((h) => h.enteredSearchAreaAt).length,
      searchAreaEntries: sum((s) => s.counts.searchEntries),
      colderWarnings: sum((s) => s.counts.colderWarnings),
      slowDownPrompts: sum((s) => s.counts.slowDownPrompts),
      // Walking speed inside the search area, and how many hunts stopped (≥5s nearly still) to search.
      medianSearchSpeedMps: (() => { const m = median(tracked.map((h) => h.searchSpeedMedianMps == null ? null : Math.round(h.searchSpeedMedianMps * 10))); return m == null ? null : m / 10; })(),
      huntsThatStoppedInSearchArea: tracked.filter((h) => (h.searchStoppedMs || 0) >= 5000).length,
      capturedAfterStopping: captured.filter((h) => (h.searchStoppedMs || 0) >= 5000).length,
    },
    abandonment: {
      trackedNotCaptured: trackedNotCaptured.length,
      byClosestStageReached: abandonmentByStage,
      byOutcome: abandonmentByOutcome,
      // 'player' = they tapped this signal; 'auto' = the game picked the nearest one for them.
      byHowTracked: trackedNotCaptured.reduce((o, h) => { const k = h.firstTrackedBy || 'unknown'; o[k] = (o[k] || 0) + 1; return o; }, {}),
      stageKey: Object.fromEntries(bands().map((b) => [b.id, b.maxM === Infinity ? '>150m' : `≤${b.maxM}m`])),
      note: 'A hunt counts as abandoned if it was tracked but never captured — the player switched away and never came back, it faded, or the session ended.',
    },
    captureFlow: {
      captureReadyAlerts: sum((s) => s.counts.captureReady),
      huntsThatReachedCaptureRange: tracked.filter((h) => h.reachedCaptureRangeAt).length,
      capturedAfterReachingCaptureRange: captured.filter((h) => h.reachedCaptureRangeAt).length,
      captureScreenOpens: sum((s) => s.counts.captureScreenOpens),
      captureScreenOpensOutOfRange: sum((s) => s.counts.captureScreenOutOfRange),
      medianGpsAccuracyAtClosestM: median(tracked.map((h) => h.gpsAccuracyAtClosestM)),
      medianCaptureRangeAtClosestM: median(tracked.map((h) => h.captureRangeAtClosestM)),
      captureVia: captured.reduce((o, h) => { const k = h.captureVia || 'unknown'; o[k] = (o[k] || 0) + 1; return o; }, {}),
    },
    direction: {
      awayNudges: sum((s) => s.counts.awayNudges),
      autoRetargets: sum((s) => s.counts.autoRetargets),
      aheadOffers: sum((s) => s.counts.aheadOffers),
      aheadSpawns: sum((s) => s.counts.aheadSpawns),
      behindDespawns: sum((s) => s.counts.behindDespawns),
      capturedFromAheadSpawns: captured.filter((h) => h.aheadSpawn).length,
      // Long hunts (walked > 50m) that still ended further away than they started.
      longHuntsEndedFurtherAway: tracked.filter((h) => h.outcome && h.walkedWhileTrackingM > 50 && h.lastDistM > h.detectedDistM).length,
      longHunts: tracked.filter((h) => h.outcome && h.walkedWhileTrackingM > 50).length,
      headingSourceMinutes: mergeMinutes(sessions.map((s) => s.headingMs)),
    },
    gps: {
      accuracyTicks: mergeCounts(sessions.map((s) => s.gpsAccuracyHist)),
      medianHuntAccuracyM: median(all.map((h) => h.gpsAccuracyMedianM)),
    },
    terrain: {
      bySession: sessions.reduce((o, s) => { const k = s.terrain || 'unknown'; o[k] = (o[k] || 0) + 1; return o; }, {}),
      bySource: sessions.reduce((o, s) => { if (s.terrainSource) o[s.terrainSource] = (o[s.terrainSource] || 0) + 1; return o; }, {}),
    },
    behaviourEvents: {
      runnerEscapes: sum((s) => s.counts.fled),
      hiderVanishes: sum((s) => s.counts.hid),
      signalSwitches: sum((s) => s.counts.switches),
      signalsLeftBehind: sum((s) => s.counts.leftBehind),
    },
    byBehaviour: groupStats(finished, 'behaviour'),
    byRarity: groupStats(finished, 'rarity'),
    bySpecies: groupStats(finished, 'speciesId'),
    screenTimeMinutes: Object.fromEntries(
      ['map', 'scanner', 'capture', 'journal'].map((k) => [k, Math.round(sum((s) => s.screenMs[k]) / 6000) / 10])
    ),
  };
}

export function exportBlobUrl() {
  persist(true);
  const payload = {
    kind: 'the-hunt-playtest-analytics',
    schema: SCHEMA,
    exportedAt: new Date().toISOString(),
    build: CONFIG.build,
    device: {
      userAgent: navigator.userAgent,
      screen: `${screen.width}x${screen.height}`,
      tuning: {
        scannerRangeM: CONFIG.scannerRangeM,
        spawnMinDistanceM: CONFIG.spawnMinDistanceM,
        spawnMaxDistanceM: CONFIG.spawnMaxDistanceM,
        searchZoneRadiusM: CONFIG.searchZoneRadiusM,
        veryCloseM: CONFIG.veryCloseM,
        captureRangeM: CONFIG.captureRangeM,
        minActiveSignals: CONFIG.minActiveSignals,
        maxActiveSignals: CONFIG.maxActiveSignals,
        firstSignalMaxDistanceM: CONFIG.firstSignalMaxDistanceM,
        despawnDistanceM: CONFIG.despawnDistanceM,
        nearRadiusM: CONFIG.nearRadiusM,
        nearSignals: `${CONFIG.nearMinSignals}-${CONFIG.nearMaxSignals}`,
        signalPersistMin: CONFIG.signalPersistMs / 60000,
        searchExitM: CONFIG.searchExitM,
        searchHideDistance: CONFIG.searchHideDistance,
        captureRangeMaxM: CONFIG.captureRangeMaxM,
        captureLatchMs: CONFIG.captureLatchMs,
        searchColderStepM: CONFIG.searchColderStepM,
        searchColderConfirmTicks: CONFIG.searchColderConfirmTicks,
        awayNudgeM: CONFIG.awayNudgeM,
        pausedBehaviours: CONFIG.pausedBehaviours,
        captureRangeByRarity: CONFIG.captureRangeByRarity,
        aheadConeHalfDeg: CONFIG.aheadConeHalfDeg,
        behindAngleDeg: CONFIG.behindAngleDeg,
        behindDespawnM: CONFIG.behindDespawnM,
        aheadOfferM: `${CONFIG.aheadOfferMinM}-${CONFIG.aheadOfferMaxM}`,
        searchSlowSpeedMps: CONFIG.searchSlowSpeedMps,
      },
    },
    privacy: 'No coordinates are recorded — only distances, durations, counts and species labels.',
    summary: summary(),
    // Empty sessions (restarted before a GPS fix) are left out so the list
    // matches summary.sessions. The live session is exported as a tidied
    // snapshot: open hunts are marked 'in-progress' and rounded.
    emptySessionsOmitted: store.sessions.length - nonEmptySessions().length,
    sessions: nonEmptySessions().map(exportSession),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  return URL.createObjectURL(blob);
}

function exportSession(s) {
  const copy = JSON.parse(JSON.stringify(s));
  copy.kind = isFieldSession(s) ? 'field' : 'desk';
  copy.build = sessionBuild(s);
  if (s === session && !s.endedAt) {
    copy.endReason = 'exported-live';
    copy.lastActiveAt = Date.now();
  }
  for (const h of copy.hunts) {
    if (!h.outcome) h.outcome = 'in-progress';
    tidyHunt(h);
  }
  return copy;
}

/** Wipe logged data (e.g. before a fresh round of playtests). Keeps the live session going. */
export function resetAnalytics() {
  const live = session;
  store = { schema: SCHEMA, createdAt: Date.now(), sessions: [] };
  if (live) {
    // Restart the live session cleanly so totals start from zero.
    session = null;
    hunts = new Map();
    currentHuntId = null;
    startSession({ resetMidSession: true });
    _rehydrate?.();
  }
  persist(true);
}

/** Handy for ?debug=1. */
export function _debug() { return { store, session, hunts, currentHuntId }; }
