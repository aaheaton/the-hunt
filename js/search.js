// The final approach — the "Search" stage of the core loop (GDD §3:
// Detect → Track → **Search** → Discover → Capture).
//
// Once the player is inside the creature's search area (CONFIG.searchZoneRadiusM)
// the game stops being navigation and becomes hot/cold:
//   • "IN THE SEARCH AREA" + vibration on entry
//   • a temperature (WARM → HOT → BURNING → RIGHT HERE) instead of exact metres
//   • pulses that speed up as you close in (app.js drives the haptic timer)
//   • "COLDER" warnings when you move away
//
// Pure logic: keeps per-signal search state on the signal (`sig.search`) and
// returns events for app.js to turn into toasts / haptics. No DOM in here.
// GPS jitter is smoothed (EMA) and warmer/colder need a few metres of real
// change, so standing still doesn't flicker between the two.

import { CONFIG } from './config.js';

const EMA_ALPHA = 0.45;

/** Temperature band for a distance inside the search area. */
export function temperatureFor(d) {
  if (d <= CONFIG.captureRangeM) return { id: 'onit', label: 'RIGHT HERE', short: 'HERE!' };
  if (d <= 18) return { id: 'burning', label: 'BURNING HOT', short: 'BURNING' };
  if (d <= 26) return { id: 'hot', label: 'HOT', short: 'HOT' };
  return { id: 'warm', label: 'WARM', short: 'WARM' };
}

/** Haptic/visual pulse interval for a distance (ms): faster as you get closer. */
export function pulseIntervalMs(d) {
  const near = CONFIG.captureRangeM;
  const far = CONFIG.searchZoneRadiusM;
  const t = Math.max(0, Math.min(1, (d - near) / (far - near)));
  return Math.round(CONFIG.searchPulseMinMs + t * (CONFIG.searchPulseMaxMs - CONFIG.searchPulseMinMs));
}

/** Is this signal currently in Search mode (player inside its search area)? */
export function isSearching(sig) {
  return !!sig?.search?.inZone && !sig._hidden;
}

/** Forget smoothing (e.g. after a runner bolts or a hider reappears elsewhere). */
export function resetSearch(sig) {
  if (sig.search) {
    sig.search.inZone = false;
    sig.search.ema = null;
    sig.search.ref = null;
    sig.search.trend = null;
  }
}

/**
 * Advance search state for the tracked signal. Call once per tick after
 * sig._distanceM is computed.
 * @returns {Array<{type: 'entered'|'left'|'warmer'|'colder'}>}
 */
export function updateSearch(sig, now = Date.now()) {
  const events = [];
  if (!sig || sig._hidden || !isFinite(sig._distanceM)) return events;
  const st = (sig.search ||= { inZone: false, ema: null, ref: null, trend: null, lastColdAt: 0, entries: 0 });
  const raw = sig._distanceM;
  st.ema = st.ema == null ? raw : st.ema + EMA_ALPHA * (raw - st.ema);
  const d = st.ema;

  if (!st.inZone) {
    // Entry uses the raw distance so it fires as soon as you step in.
    if (raw <= CONFIG.searchZoneRadiusM) {
      st.inZone = true;
      st.entries += 1;
      st.ema = raw;
      st.ref = raw;
      st.trend = null;
      events.push({ type: 'entered' });
    }
    return events;
  }

  if (d > CONFIG.searchExitM) {
    st.inZone = false;
    st.trend = null;
    events.push({ type: 'left' });
    return events;
  }

  if (d <= st.ref - CONFIG.searchWarmerStepM) {
    st.ref = d;
    if (st.trend !== 'warmer') events.push({ type: 'warmer' });
    st.trend = 'warmer';
  } else if (d >= st.ref + CONFIG.searchColderStepM) {
    st.ref = d;
    st.trend = 'colder';
    if (now - st.lastColdAt >= CONFIG.searchColderToastMs) {
      st.lastColdAt = now;
      events.push({ type: 'colder' });
    }
  }
  return events;
}
