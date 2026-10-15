// The Hunt — prototype bootstrap. Wires sensors -> spawner/state -> ui.
// Structured around the 4-tab Tactical HUD design: Scanner / Map / Capture
// / Journal, sharing one live game-state object.

import { CONFIG } from './config.js';
import { distanceM, bearingDeg, angleDiff } from './geo.js';
import { speciesById } from './characters.js';
import { requestOrientationPermission, watchPosition, watchHeading } from './sensors.js';
import {
  wanderTick,
  refillSignals,
  rollSignalTarget,
  spawnStartupSignals,
  ensureNearSignals,
  despawnFarSignals,
  saveSignals,
  loadSignals,
  relocateUncheckedSignals,
} from './spawner.js';
import { updateSearch, resetSearch, isSearching, pulseIntervalMs, captureRangeFor, roughDirection } from './search.js';
import { ensureTerrain, terrainStatus, terrainSource } from './terrain.js';
import { updateBehaviours, isHidden } from './behaviours.js';
import { isNight } from './sun.js';
import { recenterLiveMap } from './livemap.js';
import {
  evolveSpecies,
  recordCapture,
  hasSeenSafetyIntro,
  markSafetyIntroSeen,
  addLifetimeDistance,
  getLifetimeDistanceM,
  exportFieldLogBlobUrl,
} from './storage.js';
import * as ui from './ui.js';
import * as analytics from './analytics.js';

const state = {
  playerPos: null,
  playerHeading: null,      // the heading the game uses (see updateHeading)
  headingSource: 'none',    // 'course' | 'compass' | 'compass-corrected' | 'none'
  compassHeading: null,     // raw phone compass
  compassOffset: null,      // learned compass error vs. direction of travel (deg)
  compassOffsetN: 0,
  course: null,             // { deg, at } — direction of travel from GPS
  courseAnchor: null,       // last position a course was measured from
  activeSignals: [],
  currentSignalId: null,
  trackedBy: null,          // who picked the current signal: 'player' | 'auto' | 'restored'
  captureReadyId: null,     // signal we've already announced "in capture range" for
  lastAwayNudgeAt: 0,
  huntStartPos: null,
  sessionDistanceM: 0,
  currentScreen: 'safety',
  arStream: null,
  arFallback: false,
  night: false,
  terrainAnnounced: false, // last terrain status announced to the player
  spawnsStarted: false,
  signalTarget: 0,        // overall signal count to top up to (re-rolled on capture / despawn)
  nextFieldCheckAt: 0,    // throttle for despawn + top-up checks
  lastSavedAt: 0,
};

const FIELD_CHECK_MS = 5000;
const SAVE_EVERY_MS = 5000;

let stopWatchingPosition = null;
let stopWatchingHeading = null;
let fpsRafId = null;

function currentSignal() {
  return state.activeSignals.find((s) => s.id === state.currentSignalId) || null;
}

function revealCluesFor(sig) {
  const species = speciesById(sig.speciesId);
  const thresholds = [150, 80, 30];
  thresholds.forEach((thresh, i) => {
    const clue = species.clues[i];
    if (clue && sig._distanceM <= thresh && !sig.revealedClues.includes(clue)) {
      // Keep species clues in order ahead of any behaviour notes.
      const firstExtra = sig.revealedClues.findIndex((c) => !species.clues.includes(c));
      if (firstExtra === -1) sig.revealedClues.push(clue);
      else sig.revealedClues.splice(firstExtra, 0, clue);
    }
  });
}

function recomputeSignal(sig, now = Date.now()) {
  sig._distanceM = distanceM(state.playerPos, sig.pos);
  sig._bearingDeg = bearingDeg(state.playerPos, sig.pos);
  sig._hidden = isHidden(sig);
  // Capture range widens with poor GPS accuracy, and once you've been in
  // range it stays capturable for a few seconds so a GPS wobble can't snatch
  // the button away just as you tap it (playtest 2026-10-15).
  const range = captureRangeFor(state.playerPos.accuracy);
  sig._captureRangeM = range;
  if (!sig._hidden && sig._distanceM <= range) sig._capturableUntil = now + CONFIG.captureLatchMs;
  sig._canCapture = !sig._hidden && (
    sig._distanceM <= range ||
    (now < (sig._capturableUntil || 0) && sig._distanceM <= range + 10)
  );
  if (!sig._hidden) revealCluesFor(sig);
}

/** Make `id` the tracked signal. `by`: 'player' | 'auto' | 'restored' | 'auto-retarget'. */
function trackSignal(id, by) {
  state.currentSignalId = id;
  state.huntStartPos = state.playerPos;
  state.trackedBy = by === 'auto-retarget' ? 'auto' : by;
  const sig = state.activeSignals.find((s) => s.id === id);
  if (sig) sig._away = null;
  if (id) analytics.signalTracked(id, by);
}

/* ------------------------------------------------------------------ */
/* Spawning (terrain-aware, night-aware)                               */
/* ------------------------------------------------------------------ */

/** Top up signals and announce any legendary arrivals. */
function topUpSignals() {
  if (!state.playerPos || !state.spawnsStarted) return;
  state.night = isNight(state.playerPos);
  if (!state.signalTarget) state.signalTarget = rollSignalTarget();
  const ctx = { night: state.night, currentId: state.currentSignalId };
  // 1–2 always within 150m first, then fill the rest of the field.
  const near = ensureNearSignals(state.activeSignals, state.playerPos, ctx);
  for (const sig of near.removed) analytics.signalGone(sig.id, 'made-room');
  const added = [
    ...near.added,
    ...refillSignals(state.activeSignals, state.playerPos, { ...ctx, target: state.signalTarget }),
  ];
  for (const sig of added) analytics.signalDetected(sig, distanceM(state.playerPos, sig.pos));
  if (!state.currentSignalId && state.activeSignals[0]) {
    trackSignal(nearestSignal()?.id || state.activeSignals[0].id, 'auto');
  }
  const legendary = added.find((s) => s.legendary);
  if (legendary) announceLegendary(legendary);
}

function nearestSignal() {
  return [...state.activeSignals]
    .filter((s) => !s._hidden)
    .sort((a, b) => distanceM(state.playerPos, a.pos) - distanceM(state.playerPos, b.pos))[0] || null;
}

function announceLegendary(sig) {
  if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 600]);
  ui.showLegendaryEvent(speciesById(sig.speciesId), sig, () => selectSignal(sig.id, true));
}

/**
 * Periodic field upkeep while walking: drop signals left far behind and
 * keep the area around the player populated.
 */
function maintainField() {
  if (!state.playerPos || !state.spawnsStarted) return;
  const now = Date.now();
  if (now < state.nextFieldCheckAt) return;
  state.nextFieldCheckAt = now + FIELD_CHECK_MS;

  const gone = despawnFarSignals(state.activeSignals, state.playerPos);
  for (const sig of gone) analytics.signalGone(sig.id, 'left-behind');
  if (gone.some((s) => s.id === state.currentSignalId)) {
    state.currentSignalId = null;
    state.trackedBy = null;
    ui.showToast('SIGNAL OUT OF RANGE — SWITCHED TO THE NEAREST ONE', { ms: 3500, kind: 'info' });
  }
  if (gone.length) state.signalTarget = rollSignalTarget();

  const before = state.activeSignals.length;
  topUpSignals();
  const short =
    state.activeSignals.length < state.signalTarget ||
    !state.activeSignals.some((s) => distanceM(state.playerPos, s.pos) <= CONFIG.nearRadiusM);
  // Nothing could be placed (e.g. no safe ground nearby) — back off a while.
  if (short && state.activeSignals.length === before) state.nextFieldCheckAt = now + CONFIG.topUpRetryMs;
}

/**
 * Place the session's start-up signals — the guaranteed close first signal
 * plus at least one more, all in front of the way the player is facing
 * (CONFIG.frontSpawnCount) — then fill the rest of the field.
 */
function placeFirstSignals() {
  state.night = isNight(state.playerPos);
  const startup = spawnStartupSignals(state.playerPos, state.playerHeading, { night: state.night });
  for (const sig of startup) {
    state.activeSignals.push(sig);
    analytics.signalDetected(sig, distanceM(state.playerPos, sig.pos));
  }
  const first = startup[0];
  if (first) trackSignal(first.id, 'auto');
  state.signalTarget = rollSignalTarget();
  topUpSignals();
}

/** Bring back signals from a restart less than CONFIG.signalPersistMs ago. */
function restoreSignals() {
  const saved = loadSignals(state.playerPos, { night: isNight(state.playerPos) });
  if (!saved) return false;
  state.activeSignals = saved.signals;
  state.signalTarget = Math.max(saved.signals.length, CONFIG.minActiveSignals);
  for (const sig of saved.signals) analytics.signalDetected(sig, distanceM(state.playerPos, sig.pos));
  if (saved.currentId) trackSignal(saved.currentId, 'restored');
  topUpSignals();
  if (terrainStatus() !== 'failed') ui.showToast(`◉ ${saved.signals.length} SIGNAL${saved.signals.length === 1 ? '' : 'S'} STILL ACTIVE FROM YOUR LAST HUNT`, { ms: 3500, kind: 'info' });
  return true;
}

function persistSignals(force) {
  if (!state.spawnsStarted) return;
  const now = Date.now();
  if (!force && now - state.lastSavedAt < SAVE_EVERY_MS) return;
  state.lastSavedAt = now;
  saveSignals(state.activeSignals, state.currentSignalId);
}

/** First GPS fix: load OSM terrain (briefly), then place the first signals. */
async function startSpawning() {
  ui.showToast('SCANNING TERRAIN — MAPPING PARKS, PATHS & WATER…', { ms: 0, kind: 'info' });
  // Don't make the player wait forever on a slow Overpass server.
  await Promise.race([
    ensureTerrain(state.playerPos),
    new Promise((r) => setTimeout(r, CONFIG.terrainTimeoutMs + 2000)),
  ]);
  // Front-facing start-up spawns need a compass reading; give the sensor a
  // moment if it hasn't reported yet (desktop / no compass just proceeds).
  const headingDeadline = Date.now() + CONFIG.headingWaitMs;
  while (state.playerHeading == null && Date.now() < headingDeadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  state.spawnsStarted = true;
  announceTerrain();
  const restored = restoreSignals();
  if (!restored) placeFirstSignals();
  persistSignals(true);
  tick();
}

function announceTerrain() {
  const status = terrainStatus();
  if (status === state.terrainAnnounced) return;
  if (status === 'ready') {
    // Terrain can arrive after signals were placed blind (slow / failed
    // Overpass): move those onto safe ground now (playtest 2026-10-15).
    const late = state.activeSignals.some((s) => s.unchecked);
    analytics.noteContext({ terrain: late || state.terrainAnnounced === 'failed' ? 'ready-late' : 'ready', terrainSource: terrainSource() });
    state.terrainAnnounced = 'ready';
    if (late) {
      const cur = currentSignal();
      const moved = relocateUncheckedSignals(state.activeSignals, { skipId: isSearching(cur) ? cur.id : null });
      persistSignals(true);
      ui.showToast(moved
        ? `TERRAIN MAPPED — ${moved} SIGNAL${moved === 1 ? '' : 'S'} MOVED ONTO SAFE PATHS & PARKS`
        : 'TERRAIN MAPPED — SIGNALS ARE NOW SAFETY-CHECKED', { ms: 4000, kind: 'info' });
    } else {
      ui.showToast('TERRAIN MAPPED — SIGNALS LOCKED TO PARKS, PATHS & WATERSIDE', { ms: 3500, kind: 'info' });
    }
  } else if (status === 'failed') {
    if (state.terrainAnnounced === 'ready') return;
    analytics.noteContext({ terrain: 'failed' });
    state.terrainAnnounced = 'failed';
    ui.showToast('⚠ MAP DATA UNAVAILABLE — SIGNALS AREN\'T SAFETY-CHECKED YET. STAY ON PATHS & WATCH FOR ROADS. RETRYING…', { ms: 7000, kind: 'warn' });
  } else if (!state.terrainAnnounced) {
    ui.hideToast();
  }
}

/** Turn behaviour events into feedback for the player. */
function handleBehaviourEvents(events) {
  let removed = false;
  for (const { type, sig } of events) {
    const species = speciesById(sig.speciesId);
    const isCurrent = sig.id === state.currentSignalId;
    const name = sig.revealedClues.length ? species.name : 'The signal';
    if (type === 'fled' || type === 'hid') analytics.behaviourEvent(type, sig.id);
    if (type === 'expired' || type === 'dawn') analytics.signalGone(sig.id, type === 'expired' ? 'faded' : 'dawn');
    if (type === 'fled' || type === 'reappeared') resetSearch(sig);
    if (type === 'fled') {
      if (navigator.vibrate) navigator.vibrate([40, 30, 40, 30, 160]);
      ui.showToast(`⚡ IT NOTICED YOU! ${name.toUpperCase()} BOLTED — FOLLOW THE SIGNAL`, { ms: 4000, kind: 'alert' });
    } else if (type === 'hid' && isCurrent) {
      if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
      ui.showToast('◌ SIGNAL LOST — IT\'S HIDING. WAIT, OR CIRCLE ROUND AND COME BACK FROM ANOTHER SIDE', { ms: 5000, kind: 'alert' });
    } else if (type === 'reappeared' && isCurrent) {
      if (navigator.vibrate) navigator.vibrate(80);
      ui.showToast('◉ SIGNAL REACQUIRED — IT MOVED. CHECK THE BEARING', { ms: 3500, kind: 'info' });
    } else if (type === 'expired') {
      removed = true;
      ui.showToast(`★ THE ${species.name.toUpperCase()} SIGNAL HAS FADED… FOR NOW`, { ms: 5000, kind: 'legendary' });
    } else if (type === 'dawn') {
      removed = true;
      if (isCurrent) ui.showToast(`☀ DAWN — THE ${species.name.toUpperCase()} SIGNAL FADED WITH THE NIGHT`, { ms: 5000, kind: 'info' });
    }
  }
  if (removed) {
    state.activeSignals = state.activeSignals.filter((s) => !s._remove);
    if (!state.activeSignals.some((s) => s.id === state.currentSignalId)) {
      state.currentSignalId = null;
    }
    topUpSignals();
  }
}

/* ------------------------------------------------------------------ */
/* Screen navigation                                                    */
/* ------------------------------------------------------------------ */

function goToScreen(name) {
  state.currentScreen = name;
  analytics.screenChanged(name);
  if (name === 'capture') {
    const cur = currentSignal();
    analytics.captureScreenOpened(!!cur && !!cur._canCapture);
  }
  ui.showScreen(name);
  if (name === 'capture') {
    startCaptureScreenSensors();
  } else {
    stopCaptureScreenSensors();
  }
  refreshCurrentScreen();
}

function selectSignal(id, alsoGotoScanner) {
  trackSignal(id, 'player');
  if (alsoGotoScanner) goToScreen('scanner');
  else refreshCurrentScreen();
}
window.__theHuntSelectSignal = selectSignal;
// Playtest/debug hook: ?debug=1 exposes live game state in the console.
if (new URLSearchParams(location.search).get('debug') === '1') {
  window.__theHuntState = state;
  window.__theHuntAnalytics = analytics;
}

function refreshCurrentScreen() {
  ui.renderHeader({
    hasFix: !!state.playerPos,
    activeCount: state.activeSignals.length,
    playerPos: state.playerPos,
  });
  ui.setNightMode(state.night);

  if (state.currentScreen === 'scanner') {
    ui.renderScannerScreen(state.activeSignals, state.currentSignalId, state.playerHeading);
  } else if (state.currentScreen === 'map') {
    ui.renderMap(
      state.activeSignals,
      state.playerPos,
      state.playerHeading,
      state.sessionDistanceM,
      getLifetimeDistanceM(),
      state.currentSignalId
    );
  } else if (state.currentScreen === 'capture') {
    ui.renderCaptureScreen(currentSignal(), state.arFallback);
  } else if (state.currentScreen === 'journal') {
    ui.renderJournal(openDossier);
    ui.renderPlaytestStats(analytics.summary());
  }
  ui.renderCaptureReady(currentSignal(), state.currentScreen);
}

/* ------------------------------------------------------------------ */
/* Main tick                                                            */
/* ------------------------------------------------------------------ */

function tick() {
  if (!state.playerPos) return;
  const night = isNight(state.playerPos);
  if (night !== state.night) {
    state.night = night;
    if (night && state.spawnsStarted) ui.showToast('☾ NIGHT HAS FALLEN — NEW SIGNALS ARE STIRRING', { ms: 4500, kind: 'info' });
  }
  handleBehaviourEvents(updateBehaviours(state.activeSignals, state.playerPos, { night }));
  maintainField();
  const now = Date.now();
  for (const sig of state.activeSignals) recomputeSignal(sig, now);
  let cur = currentSignal();
  if (cur) handleSearchEvents(cur, updateSearch(cur));
  if (cur) handleAwayFromSignal(cur, now);
  cur = currentSignal();
  handleCaptureReady(cur);
  if (isSearching(cur) && !pulseTimer) schedulePulse();
  updateHeading();
  analytics.tick(state.activeSignals, {
    headingSource: state.headingSource,
    accuracyM: state.playerPos.accuracy,
  });
  persistSignals(false);
  refreshCurrentScreen();
}

/* ------------------------------------------------------------------ */
/* The final approach: Search stage (hot/cold)                          */
/* ------------------------------------------------------------------ */

function handleSearchEvents(sig, events) {
  for (const { type } of events) {
    analytics.searchEvent(type, sig.id);
    if (type === 'entered') {
      if (navigator.vibrate) navigator.vibrate([120, 60, 120, 60, 260]);
      ui.showToast('◎ IN THE SEARCH AREA — IT\'S CLOSE. FOLLOW THE PULSES: FASTER = WARMER', { ms: 4500, kind: 'search' });
    } else if (type === 'colder') {
      if (navigator.vibrate) navigator.vibrate(320);
      ui.showToast('❄ COLDER — YOU\'RE MOVING AWAY', { ms: 2500, kind: 'cold' });
    } else if (type === 'left') {
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
      ui.showToast('↩ YOU LEFT THE SEARCH AREA — HEAD BACK TOWARDS THE SIGNAL', { ms: 3500, kind: 'cold' });
    }
  }
}

// Pulses speed up as you close in. Runs on its own timer (the game tick is
// too slow for this), and stops itself once you're no longer searching.
let pulseTimer = null;
function schedulePulse() {
  clearTimeout(pulseTimer);
  pulseTimer = null;
  const sig = currentSignal();
  if (!isSearching(sig)) return;
  pulseTimer = setTimeout(() => {
    pulseTimer = null;
    const s = currentSignal();
    if (!isSearching(s)) return;
    if (!document.hidden) {
      if (navigator.vibrate) navigator.vibrate(s._canCapture ? 70 : 35);
      ui.searchPulse(pulseIntervalMs(s._distanceM, s._captureRangeM));
    }
    schedulePulse();
  }, pulseIntervalMs(sig._distanceM, sig._captureRangeM));
}

/* ------------------------------------------------------------------ */
/* Capture-ready alert (any screen)                                     */
/* ------------------------------------------------------------------ */

// Playtest 2026-10-15: players reached capture range on the Map screen
// (where they spent 60% of their time) with no way to know they could
// capture. Now entering range buzzes, toasts, and shows a "CAPTURE NOW" bar
// on every screen.
function handleCaptureReady(sig) {
  const ready = !!sig && !!sig._canCapture;
  if (!ready) {
    state.captureReadyId = null;
    return;
  }
  if (state.captureReadyId === sig.id) return;
  state.captureReadyId = sig.id;
  analytics.captureReady(sig.id);
  if (navigator.vibrate) navigator.vibrate([80, 50, 80, 50, 300]);
  if (state.currentScreen !== 'capture') {
    ui.showToast('◉ IN CAPTURE RANGE — TAP "CAPTURE NOW" BEFORE IT SLIPS AWAY', { ms: 4000, kind: 'search' });
  }
}

/* ------------------------------------------------------------------ */
/* Direction: heading from travel, "moving away" nudge, auto-retarget   */
/* ------------------------------------------------------------------ */

/** "AHEAD OF YOU" / "BEHIND YOU" / "TO YOUR LEFT" … or a rough compass point. */
function relativeDirection(bearing) {
  if (state.playerHeading == null) return `TO THE ${roughDirection(bearing, true)}`;
  const rel = angleDiff(state.playerHeading, bearing);
  if (Math.abs(rel) <= 35) return 'AHEAD OF YOU';
  if (Math.abs(rel) >= 145) return 'BEHIND YOU';
  return rel > 0 ? 'TO YOUR RIGHT' : 'TO YOUR LEFT';
}

/**
 * Playtest 2026-10-15: half of the longer hunts ended further from the
 * signal than they started. If the (smoothed) distance grows well past the
 * closest you've been, say so — and if the game chose this signal for you,
 * swap to one that's actually closer instead.
 */
function handleAwayFromSignal(sig, now) {
  if (sig._hidden || isSearching(sig) || !isFinite(sig._distanceM)) return;
  const a = (sig._away ||= { ema: sig._distanceM, best: sig._distanceM });
  a.ema += 0.4 * (sig._distanceM - a.ema);
  if (a.ema < a.best) a.best = a.ema;
  if (a.ema - a.best < CONFIG.awayNudgeM) return;
  if (now - state.lastAwayNudgeAt < CONFIG.awayNudgeCooldownMs) return;
  state.lastAwayNudgeAt = now;
  a.best = a.ema;

  if (state.trackedBy === 'auto') {
    const alt = nearestSignal();
    if (alt && alt.id !== sig.id && alt._distanceM <= sig._distanceM - CONFIG.autoRetargetGainM) {
      trackSignal(alt.id, 'auto-retarget');
      analytics.directionEvent('retarget', sig.id);
      if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
      ui.showToast(`↪ SWITCHED TO A CLOSER SIGNAL — ${Math.round(alt._distanceM)}m ${relativeDirection(alt._bearingDeg)}`, { ms: 4000, kind: 'info' });
      return;
    }
  }
  analytics.directionEvent('away', sig.id);
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  ui.showToast(`↩ YOU'RE MOVING AWAY FROM THE SIGNAL — IT'S ${relativeDirection(sig._bearingDeg)}`, { ms: 4500, kind: 'cold' });
}

/**
 * Pick the heading the game uses. While walking, the direction of travel
 * from GPS is far more reliable than the phone compass (Android compasses
 * are often off by tens of degrees, or not north-referenced at all). When
 * standing still the compass is used, corrected by the error we learned
 * while the player was walking.
 */
function updateHeading(now = Date.now()) {
  if (state.course && now - state.course.at <= CONFIG.courseMaxAgeMs) {
    state.playerHeading = state.course.deg;
    state.headingSource = 'course';
  } else if (state.compassHeading != null) {
    const corrected = state.compassOffsetN >= 3 && state.compassOffset != null;
    state.playerHeading = corrected
      ? (state.compassHeading + state.compassOffset + 360) % 360
      : state.compassHeading;
    state.headingSource = corrected ? 'compass-corrected' : 'compass';
  } else {
    state.playerHeading = state.course ? state.course.deg : null;
    state.headingSource = state.course ? 'course-stale' : 'none';
  }
}

/** Measure direction of travel from successive GPS fixes. */
function updateCourse(pos, now = Date.now()) {
  const okFix = !(pos.accuracy > CONFIG.courseMaxAccuracyM);
  let course = null;
  // The GPS chip's own course, when it reports one at walking pace.
  if (okFix && pos.course != null && pos.speed != null && pos.speed >= CONFIG.courseMinSpeedMps) course = pos.course;
  const anchor = state.courseAnchor;
  if (!anchor) {
    if (okFix) state.courseAnchor = { lat: pos.lat, lng: pos.lng, t: now };
  } else if (okFix) {
    const d = distanceM(anchor, pos);
    if (d >= CONFIG.courseMinMoveM) {
      const speed = d / Math.max(0.5, (now - anchor.t) / 1000);
      if (course == null && speed >= CONFIG.courseMinSpeedMps) course = bearingDeg(anchor, pos);
      state.courseAnchor = { lat: pos.lat, lng: pos.lng, t: now };
    } else if (now - anchor.t > 20000) {
      // Standing still: restart the anchor so slow GPS drift never adds up
      // to a fake "walk".
      state.courseAnchor = { lat: pos.lat, lng: pos.lng, t: now };
    }
  }
  if (course == null) return;
  state.course = { deg: course, at: now };
  // Learn how far off the compass is (walking direction ≈ facing direction).
  if (state.compassHeading != null) {
    const err = angleDiff(state.compassHeading, course);
    state.compassOffset = state.compassOffset == null
      ? err
      : state.compassOffset + 0.2 * angleDiff(state.compassOffset, err);
    state.compassOffsetN += 1;
  }
  updateHeading(now);
}

/* ------------------------------------------------------------------ */
/* Journal dossier + evolution                                          */
/* ------------------------------------------------------------------ */

function openDossier(speciesId) {
  ui.openJournalModal(speciesId, handleEvolve);
}

function handleEvolve(speciesId) {
  const newStage = evolveSpecies(speciesId);
  if (!newStage) return;
  if (navigator.vibrate) navigator.vibrate([60, 40, 120]);
  ui.openJournalModal(speciesId, handleEvolve, { justEvolved: true });
  refreshCurrentScreen();
}

/* ------------------------------------------------------------------ */
/* Capture                                                              */
/* ------------------------------------------------------------------ */

function attemptCapture() {
  const sig = currentSignal();
  if (!sig || !sig._canCapture) return;

  const species = speciesById(sig.speciesId);
  const walked = state.huntStartPos ? distanceM(state.huntStartPos, state.playerPos) : 0;
  analytics.signalCaptured(sig.id);
  const { isFirst } = recordCapture({
    speciesId: species.id,
    rarity: species.rarity,
    location: sig.pos,
    distanceWalkedM: walked,
  });

  state.activeSignals = state.activeSignals.filter((s) => s.id !== sig.id);
  // Auto-advance to the next nearest signal so the loop keeps flowing
  // ("Another signal detected...", GDD section 46) without forcing a
  // separate screen.
  state.currentSignalId = null;
  state.signalTarget = rollSignalTarget();
  topUpSignals();
  const next = nearestSignal();
  if (next) trackSignal(next.id, 'auto');
  else state.currentSignalId = null;
  state.captureReadyId = null;

  if (species.rarity === 'legendary' && navigator.vibrate) navigator.vibrate([100, 50, 100, 50, 100, 50, 400]);
  ui.showCaptureSuccessBanner(species, isFirst);
  persistSignals(true);
  refreshCurrentScreen();
  setTimeout(() => ui.hideCaptureSuccessBanner(), 4500);
}

/* ------------------------------------------------------------------ */
/* Capture screen sensors: camera + FPS counter                        */
/* ------------------------------------------------------------------ */

async function startCaptureScreenSensors() {
  startFpsCounter();
  if (!state.arFallback) await startCamera();
}

function stopCaptureScreenSensors() {
  stopFpsCounter();
  stopCamera();
}

async function startCamera() {
  const video = document.getElementById('ar-video');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: false,
    });
    state.arStream = stream;
    video.srcObject = stream;
  } catch (err) {
    console.warn('Camera unavailable, falling back to sonar mode', err);
    state.arFallback = true;
    document.getElementById('ar-fallback-toggle').checked = true;
  }
}

function stopCamera() {
  if (state.arStream) {
    state.arStream.getTracks().forEach((t) => t.stop());
    state.arStream = null;
  }
  const video = document.getElementById('ar-video');
  video.srcObject = null;
}

function startFpsCounter() {
  let frames = 0;
  let lastSecond = performance.now();
  const loop = (now) => {
    frames += 1;
    if (now - lastSecond >= 1000) {
      ui.setArFpsText(frames);
      frames = 0;
      lastSecond = now;
    }
    fpsRafId = requestAnimationFrame(loop);
  };
  fpsRafId = requestAnimationFrame(loop);
}

function stopFpsCounter() {
  if (fpsRafId) cancelAnimationFrame(fpsRafId);
  fpsRafId = null;
}

/* ------------------------------------------------------------------ */
/* Sensors: GPS + compass                                              */
/* ------------------------------------------------------------------ */

function onPositionUpdate(pos) {
  const firstFix = !state.playerPos;
  if (state.playerPos) {
    const delta = distanceM(state.playerPos, pos);
    // Ignore implausible single-tick jumps (bad fix / spoofed jump) rather
    // than let them corrupt the walked-distance stats.
    if (delta < 200) {
      state.sessionDistanceM += delta;
      addLifetimeDistance(delta);
      analytics.moved(delta);
    }
  }
  updateCourse(pos);
  state.playerPos = pos;
  if (firstFix) {
    state.night = isNight(pos);
    analytics.noteGpsFix();
    analytics.noteContext({ night: state.night });
    goToScreen('map');
    startSpawning();
  } else {
    // Refresh OSM terrain in the background once the player has moved far.
    ensureTerrain(pos).then(announceTerrain);
    tick();
  }
}

function onPositionError(err) {
  ui.setPermissionStatus(
    'Could not get your location (' + (err.message || err.code || 'unknown error') + '). ' +
    'Location access is required to play — check your browser/site permissions.'
  );
}

async function startHunting() {
  ui.setPermissionStatus('Requesting permissions…');
  analytics.startSession();
  analytics.screenChanged(state.currentScreen);
  await requestOrientationPermission();

  stopWatchingHeading = watchHeading((heading) => {
    state.compassHeading = heading;
    updateHeading();
  });
  stopWatchingPosition = watchPosition(onPositionUpdate, onPositionError);

  ui.setPermissionStatus('Waiting for GPS fix…');
  markSafetyIntroSeen();
}

function setupLookUpReminder() {
  setInterval(() => {
    if (state.currentScreen !== 'scanner' && state.currentScreen !== 'capture' && state.currentScreen !== 'map') return;
    ui.showLookUpToast(true);
    setTimeout(() => ui.showLookUpToast(false), 6000);
  }, CONFIG.lookUpReminderMs);
}

/* ------------------------------------------------------------------ */
/* Wiring                                                               */
/* ------------------------------------------------------------------ */

function wireEvents() {
  document.getElementById('btn-start').addEventListener('click', startHunting);

  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => goToScreen(btn.dataset.screen));
  });

  document.getElementById('btn-goto-capture').addEventListener('click', () => {
    if (state.currentSignalId) goToScreen('capture');
  });

  document.getElementById('btn-capture').addEventListener('click', attemptCapture);
  document.getElementById('capture-ready-bar').addEventListener('click', () => {
    if (state.currentSignalId) goToScreen('capture');
  });
  document.getElementById('legendary-dismiss').addEventListener('click', ui.hideLegendaryEvent);
  document.getElementById('cs-view-btn').addEventListener('click', () => {
    ui.hideCaptureSuccessBanner();
    goToScreen('journal');
  });

  document.getElementById('ar-fallback-toggle').addEventListener('change', async (e) => {
    state.arFallback = e.target.checked;
    if (state.arFallback) stopCamera();
    else await startCamera();
    refreshCurrentScreen();
  });
  document.getElementById('ar-fallback-btn').addEventListener('click', () => {
    const toggle = document.getElementById('ar-fallback-toggle');
    toggle.checked = !toggle.checked;
    toggle.dispatchEvent(new Event('change'));
  });

  // Map controls.
  document.getElementById('map-recenter').addEventListener('click', (e) => {
    e.currentTarget.classList.add('active');
    recenterLiveMap(state.playerPos);
    refreshCurrentScreen();
    setTimeout(() => e.currentTarget.classList.remove('active'), 400);
  });
  document.getElementById('map-north').addEventListener('click', () => {
    ui.toggleMapOrientation();
    refreshCurrentScreen();
  });
  document.getElementById('map-engage-btn').addEventListener('click', (e) => {
    e.preventDefault();
    const nearest = [...state.activeSignals].filter((s) => !s._hidden).sort((a, b) => a._distanceM - b._distanceM)[0];
    if (nearest) selectSignal(nearest.id, true);
    else goToScreen('scanner');
  });
  ui.renderMapFilters();
  document.getElementById('map-filters').addEventListener('click', (e) => {
    const btn = e.target.closest('.filter-chip');
    if (!btn) return;
    ui.setMapFilter(btn.dataset.filter);
    ui.renderMapFilters();
    refreshCurrentScreen();
  });

  // Journal.
  document.getElementById('btn-close-journal').addEventListener('click', ui.closeJournalModal);
  document.getElementById('btn-export-log').addEventListener('click', () => {
    const url = exportFieldLogBlobUrl();
    const a = document.createElement('a');
    a.href = url;
    a.download = `the-hunt-field-log-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  });
  document.getElementById('btn-export-analytics').addEventListener('click', () => {
    downloadBlobUrl(analytics.exportBlobUrl(), `the-hunt-playtest-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`);
  });
  // Two-tap confirm (no browser confirm() dialog).
  let resetArmedUntil = 0;
  document.getElementById('btn-reset-analytics').addEventListener('click', (e) => {
    const btn = e.currentTarget;
    if (Date.now() < resetArmedUntil) {
      analytics.resetAnalytics();
      resetArmedUntil = 0;
      btn.textContent = 'Reset playtest data';
      ui.showToast('PLAYTEST DATA CLEARED', { ms: 2500, kind: 'info' });
      refreshCurrentScreen();
    } else {
      resetArmedUntil = Date.now() + 4000;
      btn.textContent = 'Tap again to clear';
      setTimeout(() => { if (Date.now() >= resetArmedUntil) btn.textContent = 'Reset playtest data'; }, 4100);
    }
  });
  analytics.setRehydrate(() => {
    for (const sig of state.activeSignals) {
      analytics.signalDetected(sig, state.playerPos ? distanceM(state.playerPos, sig.pos) : null);
    }
    if (state.currentSignalId) analytics.signalTracked(state.currentSignalId, 'auto');
  });

  setInterval(tick, CONFIG.tickMs);
  setInterval(() => wanderTick(state.activeSignals), CONFIG.wanderTickMs);
  setupLookUpReminder();
}

function downloadBlobUrl(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

document.addEventListener('visibilitychange', () => { if (document.hidden) persistSignals(true); });
window.addEventListener('pagehide', () => persistSignals(true));

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW registration failed', err));
  }
}

ui.initSafetyBox();
wireEvents();
registerServiceWorker();

// iOS requires the orientation-permission prompt to originate from a real
// user gesture (the Start Hunting tap), so we never auto-start — but we can
// tweak the copy a little for a returning player.
if (hasSeenSafetyIntro()) {
  document.querySelector('.intro-card .tagline').textContent = 'WELCOME BACK. WHAT ELSE IS HIDING NEARBY?';
}
