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
// change, so standing still doesn't flicker between the two. "Colder" also
// has to be confirmed on consecutive ticks (playtest 2026-10-15: most colder
// warnings were GPS noise, and players walked off after them).

import { CONFIG } from './config.js';

const EMA_ALPHA = 0.45;

/**
 * Effective capture range (m) for the current GPS accuracy. A ±15m fix can't
 * resolve a 12m circle, so the range widens with the reported accuracy, up to
 * CONFIG.captureRangeMaxM.
 */
export function captureRangeFor(accuracyM) {
  const base = CONFIG.captureRangeM;
  if (!isFinite(accuracyM) || accuracyM <= 0) return base;
  return Math.round(Math.min(CONFIG.captureRangeMaxM, Math.max(base, accuracyM * CONFIG.captureAccuracyFactor)));
}

/** Temperature band for a distance inside the search area. */
export function temperatureFor(d, range = CONFIG.captureRangeM) {
  if (d <= range) return { id: 'onit', label: 'RIGHT HERE', short: 'HERE!' };
  if (d <= range + 6) return { id: 'burning', label: 'BURNING HOT', short: 'BURNING' };
  if (d <= range + 14) return { id: 'hot', label: 'HOT', short: 'HOT' };
  return { id: 'warm', label: 'WARM', short: 'WARM' };
}

/** 0..1 "heat" inside the search area: 0 at the zone edge, 1 at capture range. */
export function searchHeat(d, range = CONFIG.captureRangeM) {
  const far = Math.max(range + 1, CONFIG.searchZoneRadiusM);
  return Math.max(0, Math.min(1, (far - d) / (far - range)));
}

/** Haptic/visual pulse interval for a distance (ms): faster as you get closer. */
export function pulseIntervalMs(d, range = CONFIG.captureRangeM) {
  const t = 1 - searchHeat(d, range);
  return Math.round(CONFIG.searchPulseMinMs + t * (CONFIG.searchPulseMaxMs - CONFIG.searchPulseMinMs));
}

const COMPASS_8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const COMPASS_8_LONG = ['NORTH', 'NORTH-EAST', 'EAST', 'SOUTH-EAST', 'SOUTH', 'SOUTH-WEST', 'WEST', 'NORTH-WEST'];
/** Rough 8-point compass direction for a bearing — deliberately vague. */
export function roughDirection(bearingDeg, long = false) {
  const i = Math.round((((bearingDeg % 360) + 360) % 360) / 45) % 8;
  return (long ? COMPASS_8_LONG : COMPASS_8)[i];
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
    sig.search.coldStreak = 0;
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
  const st = (sig.search ||= { inZone: false, ema: null, ref: null, trend: null, lastColdAt: 0, entries: 0, coldStreak: 0 });
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
      st.coldStreak = 0;
      events.push({ type: 'entered' });
    }
    return events;
  }

  if (d > CONFIG.searchExitM) {
    st.inZone = false;
    st.trend = null;
    st.coldStreak = 0;
    events.push({ type: 'left' });
    return events;
  }

  if (d <= st.ref - CONFIG.searchWarmerStepM) {
    st.ref = d;
    st.coldStreak = 0;
    if (st.trend !== 'warmer') events.push({ type: 'warmer' });
    st.trend = 'warmer';
  } else if (d >= st.ref + CONFIG.searchColderStepM && !sig._canCapture) {
    // Never tell someone who can capture right now that they're "colder".
    st.coldStreak = (st.coldStreak || 0) + 1;
    if (st.coldStreak >= CONFIG.searchColderConfirmTicks) {
      st.ref = d;
      st.coldStreak = 0;
      st.trend = 'colder';
      if (now - st.lastColdAt >= CONFIG.searchColderToastMs) {
        st.lastColdAt = now;
        events.push({ type: 'colder' });
      }
    }
  } else {
    st.coldStreak = 0;
  }
  return events;
}
