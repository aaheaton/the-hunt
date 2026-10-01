// The Hunt — prototype bootstrap. Wires sensors -> spawner/state -> ui.
// Structured around the 4-tab Tactical HUD design: Scanner / Map / Capture
// / Journal, sharing one live game-state object.

import { CONFIG } from './config.js';
import { distanceM, bearingDeg } from './geo.js';
import { speciesById } from './characters.js';
import { requestOrientationPermission, watchPosition, watchHeading } from './sensors.js';
import { wanderTick, refillSignals } from './spawner.js';
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
    if (sig._distanceM <= thresh && sig.revealedClues.length <= i) {
      const clue = species.clues[i];
      if (clue && !sig.revealedClues.includes(clue)) sig.revealedClues.push(clue);
    }
  });
}

function recomputeSignal(sig) {
  sig._distanceM = distanceM(state.playerPos, sig.pos);
  sig._bearingDeg = bearingDeg(state.playerPos, sig.pos);
  revealCluesFor(sig);
}

/* ------------------------------------------------------------------ */
/* Screen navigation                                                    */
/* ------------------------------------------------------------------ */

function goToScreen(name) {
  state.currentScreen = name;
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
  if (alsoGotoScanner) goToScreen('scanner');
  else refreshCurrentScreen();
}
window.__theHuntSelectSignal = selectSignal;

function refreshCurrentScreen() {
  ui.renderHeader({
    hasFix: !!state.playerPos,
    activeCount: state.activeSignals.length,
    playerPos: state.playerPos,
  });

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
  }
}

/* ------------------------------------------------------------------ */
/* Main tick                                                            */
/* ------------------------------------------------------------------ */

function tick() {
  if (!state.playerPos) return;
  for (const sig of state.activeSignals) recomputeSignal(sig);
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
  if (!sig || sig._distanceM > CONFIG.captureRangeM) return;

  const species = speciesById(sig.speciesId);
  const walked = state.huntStartPos ? distanceM(state.huntStartPos, state.playerPos) : 0;
  const { isFirst } = recordCapture({
    speciesId: species.id,
    rarity: species.rarity,
    location: sig.pos,
    distanceWalkedM: walked,
  });

  state.activeSignals = state.activeSignals.filter((s) => s.id !== sig.id);
  refillSignals(state.activeSignals, state.playerPos);

  // Auto-advance to the next nearest signal so the loop keeps flowing
  // ("Another signal detected...", GDD section 46) without forcing a
  // separate screen.
  const next = [...state.activeSignals].sort((a, b) => {
    const da = distanceM(state.playerPos, a.pos);
    const db = distanceM(state.playerPos, b.pos);
    return da - db;
  })[0];
  state.currentSignalId = next ? next.id : null;
  state.huntStartPos = state.playerPos;

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
    }
  }
  state.playerPos = pos;
  if (firstFix) {
    refillSignals(state.activeSignals, state.playerPos);
    if (!state.currentSignalId && state.activeSignals[0]) {
      state.currentSignalId = state.activeSignals[0].id;
      state.huntStartPos = state.playerPos;
    }
    goToScreen('scanner');
  } else {
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
    refreshCurrentScreen();
    setTimeout(() => e.currentTarget.classList.remove('active'), 400);
  });
  document.getElementById('map-north').addEventListener('click', () => {
    ui.toggleMapOrientation();
    refreshCurrentScreen();
  });
  document.getElementById('map-engage-btn').addEventListener('click', (e) => {
    e.preventDefault();
    const nearest = [...state.activeSignals].sort((a, b) => a._distanceM - b._distanceM)[0];
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

  setInterval(tick, CONFIG.tickMs);
  setInterval(() => wanderTick(state.activeSignals), CONFIG.wanderTickMs);
  setupLookUpReminder();
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
