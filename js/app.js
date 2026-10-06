// The Hunt — prototype bootstrap. Wires sensors -> spawner/state -> ui.
// Structured around the 4-tab Tactical HUD design: Scanner / Map / Capture
// / Journal, sharing one live game-state object.

import { CONFIG } from './config.js';
import { distanceM, bearingDeg } from './geo.js';
import { speciesById } from './characters.js';
import { requestOrientationPermission, watchPosition, watchHeading } from './sensors.js';
import { wanderTick, refillSignals } from './spawner.js';
import { ensureTerrain, terrainStatus } from './terrain.js';
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
  playerHeading: null,
  activeSignals: [],
  currentSignalId: null,
  huntStartPos: null,
  sessionDistanceM: 0,
  currentScreen: 'safety',
  arStream: null,
  arFallback: false,
  night: false,
  terrainAnnounced: false,
  spawnsStarted: false,
};

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

function recomputeSignal(sig) {
  sig._distanceM = distanceM(state.playerPos, sig.pos);
  sig._bearingDeg = bearingDeg(state.playerPos, sig.pos);
  sig._hidden = isHidden(sig);
  if (!sig._hidden) revealCluesFor(sig);
}

/* ------------------------------------------------------------------ */
/* Spawning (terrain-aware, night-aware)                               */
/* ------------------------------------------------------------------ */

/** Top up signals and announce any legendary arrivals. */
function topUpSignals() {
  if (!state.playerPos || !state.spawnsStarted) return;
  state.night = isNight(state.playerPos);
  const added = refillSignals(state.activeSignals, state.playerPos, { night: state.night });
  for (const sig of added) analytics.signalDetected(sig, distanceM(state.playerPos, sig.pos));
  if (!state.currentSignalId && state.activeSignals[0]) {
    state.currentSignalId = nearestSignal()?.id || state.activeSignals[0].id;
    state.huntStartPos = state.playerPos;
    analytics.signalTracked(state.currentSignalId, 'auto');
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

/** First GPS fix: load OSM terrain (briefly), then place the first signals. */
async function startSpawning() {
  ui.showToast('SCANNING TERRAIN — MAPPING PARKS, PATHS & WATER…', { ms: 0, kind: 'info' });
  // Don't make the player wait forever on a slow Overpass server.
  await Promise.race([
    ensureTerrain(state.playerPos),
    new Promise((r) => setTimeout(r, CONFIG.terrainTimeoutMs + 2000)),
  ]);
  state.spawnsStarted = true;
  announceTerrain();
  topUpSignals();
  tick();
}

function announceTerrain() {
  if (state.terrainAnnounced) return;
  const status = terrainStatus();
  analytics.noteContext({ terrain: status });
  if (status === 'ready') {
    state.terrainAnnounced = true;
    ui.showToast('TERRAIN MAPPED — SIGNALS LOCKED TO PARKS, PATHS & WATERSIDE', { ms: 3500, kind: 'info' });
  } else if (status === 'failed') {
    state.terrainAnnounced = true;
    ui.showToast('⚠ MAP DATA UNAVAILABLE — SIGNALS AREN\'T SAFETY-CHECKED. STAY ON PATHS & WATCH FOR ROADS.', { ms: 7000, kind: 'warn' });
  } else {
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
  ui.showScreen(name);
  if (name === 'capture') {
    startCaptureScreenSensors();
  } else {
    stopCaptureScreenSensors();
  }
  refreshCurrentScreen();
}

function selectSignal(id, alsoGotoScanner) {
  state.currentSignalId = id;
  state.huntStartPos = state.playerPos;
  analytics.signalTracked(id, 'player');
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
      getLifetimeDistanceM()
    );
  } else if (state.currentScreen === 'capture') {
    ui.renderCaptureScreen(currentSignal(), state.arFallback);
  } else if (state.currentScreen === 'journal') {
    ui.renderJournal(openDossier);
    ui.renderPlaytestStats(analytics.summary());
  }
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
  for (const sig of state.activeSignals) recomputeSignal(sig);
  analytics.tick(state.activeSignals);
  refreshCurrentScreen();
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
  if (!sig || sig._hidden || sig._distanceM > CONFIG.captureRangeM) return;

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
  topUpSignals();
  const next = nearestSignal();
  state.currentSignalId = next ? next.id : null;
  state.huntStartPos = state.playerPos;
  if (next) analytics.signalTracked(next.id, 'auto');

  if (species.rarity === 'legendary' && navigator.vibrate) navigator.vibrate([100, 50, 100, 50, 100, 50, 400]);
  ui.showCaptureSuccessBanner(species, isFirst);
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
    state.playerHeading = heading;
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
