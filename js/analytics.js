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
    gpsFixMs: null,          // time from Start Hunting to first GPS fix
    firstCaptureMs: null,    // time from Start Hunting to first capture
    distanceM: 0,            // walked this session (implausible jumps ignored)
    activeMs: 0,             // foreground play time
    screenMs: {},
    terrain: null,           // 'ready' | 'failed' | ...
    nightAtStart: null,
    counts: {
      detected: 0, tracked: 0, captured: 0, faded: 0,
      fled: 0, hid: 0, switches: 0, legendaryEvents: 0,
    },
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

export function noteContext({ terrain, night } = {}) {
  if (!session) return;
  if (terrain) session.terrain = terrain;
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
    outcome: null,           // captured | faded | dawn | session-ended
    endedAt: null,
    stageAtEnd: null,        // closest band reached
    timeToCaptureMs: null,   // wall clock: first tracked -> captured
  };
  hunts.set(sig.id, h);
  session.hunts.push(h);
  session.counts.detected += 1;
  if (h.rarity === 'legendary') session.counts.legendaryEvents += 1;
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
    h.firstTrackedBy = source;   // 'player' tapped it, or 'auto' (nearest after a capture / on start)
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

export function signalCaptured(sigId) {
  if (!session) return;
  const h = hunts.get(sigId);
  const now = Date.now();
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

/** Signal left the active list without a capture (legendary expiry, dawn). */
export function signalGone(sigId, reason) {
  if (!session) return;
  const h = hunts.get(sigId);
  if (h && !h.outcome) {
    finaliseHunt(h, reason, Date.now(), session);
    session.counts.faded += 1;
  }
  if (currentHuntId === sigId) currentHuntId = null;
  persist(true);
}

function finaliseHunt(h, outcome, at, s) {
  h.outcome = outcome;
  h.endedAt = at;
  h.stageAtEnd = !h.firstTrackedAt ? 'never-tracked' : h.closestM == null ? 'distant' : bandFor(h.closestM);
  h.walkedWhileTrackingM = round(h.walkedWhileTrackingM);
  h.closestM = round(h.closestM);
  h.lastDistM = round(h.lastDistM);
  h.activeTrackMs = Math.round(h.activeTrackMs);
  if (s === session) hunts.delete(h.signalId);
}

/* ------------------------------------------------------------------ */
/* Per-tick / per-fix updates                                          */
/* ------------------------------------------------------------------ */

/** Called every game tick with the live signal list (distances computed). */
export function tick(signals) {
  if (!session) return;
  const now = Date.now();
  const dt = lastTickAt && !document.hidden ? Math.min(now - lastTickAt, 10000) : 0;
  lastTickAt = now;
  session.activeMs += dt;

  const h = currentHuntId ? hunts.get(currentHuntId) : null;
  if (h && !h.outcome) {
    h.activeTrackMs += dt;
    const sig = signals.find((s) => s.id === currentHuntId);
    if (sig && isFinite(sig._distanceM) && !sig._hidden) {
      const d = sig._distanceM;
      h.lastDistM = d;
      if (h.closestM == null || d < h.closestM) h.closestM = d;
      if (d <= CONFIG.veryCloseM && !h.reachedVeryCloseAt) h.reachedVeryCloseAt = now;
      if (d <= CONFIG.captureRangeM && !h.reachedCaptureRangeAt) h.reachedCaptureRangeAt = now;
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

/** Aggregate §50 metrics over every logged session (includes the live one). */
export function summary() {
  const sessions = store.sessions.filter((s) => s.activeMs > 0 || s.hunts.length);
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
    behaviourEvents: {
      runnerEscapes: sum((s) => s.counts.fled),
      hiderVanishes: sum((s) => s.counts.hid),
      signalSwitches: sum((s) => s.counts.switches),
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
      },
    },
    privacy: 'No coordinates are recorded — only distances, durations, counts and species labels.',
    summary: summary(),
    sessions: store.sessions,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  return URL.createObjectURL(blob);
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
