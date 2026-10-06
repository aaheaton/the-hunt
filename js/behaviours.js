// Creature behaviours that react to the player (GDD §7).
//
//   Runner (§7.3) — when you get close it bolts 30–50m, roughly away from
//                   you, onto another safe spot ("It noticed you!"). After
//                   CONFIG.runnerFlees escapes it's too tired to run again.
//   Hider  (§7.4) — when you get close it vanishes for 15–30s, then
//                   reappears on the far side of its search zone, so you have
//                   to wait or come at it from another direction.
//   Night  (§7.5) — night-only signals fade out at dawn.
//   Legendary     — the signal only lasts CONFIG.legendaryLifetimeMs.
//
// Pure game logic: mutates signals and returns a list of events for app.js
// to turn into toasts / haptics. No DOM in here.

import { CONFIG } from './config.js';
import { distanceM, destinationPoint, bearingDeg } from './geo.js';
import { findPointNear } from './terrain.js';

function randBetween(a, b) {
  return a + Math.random() * (b - a);
}

/** Escape point for a runner: 30–50m away, biased away from the player. */
function escapePoint(sig, playerPos) {
  const p = findPointNear(sig.pos, CONFIG.runnerFleeMinM, CONFIG.runnerFleeMaxM, {
    habitat: sig.habitat,
    awayFrom: playerPos,
  });
  if (p !== undefined) return p; // terrain loaded: safe spot or null
  // No terrain: straight away from the player, ±45°.
  const away = (bearingDeg(playerPos, sig.pos) + randBetween(-45, 45) + 360) % 360;
  return destinationPoint(sig.pos, away, randBetween(CONFIG.runnerFleeMinM, CONFIG.runnerFleeMaxM));
}

/** Where a hider reappears: inside its zone, on the side away from the player. */
function reappearPoint(sig, playerPos) {
  const p = findPointNear(sig.zoneCenter, CONFIG.searchZoneRadiusM * 0.4, CONFIG.searchZoneRadiusM, {
    habitat: sig.habitat,
    awayFrom: playerPos,
  });
  if (p !== undefined) return p;
  const away = bearingDeg(playerPos, sig.zoneCenter);
  return destinationPoint(sig.zoneCenter, away, CONFIG.searchZoneRadiusM * 0.8);
}

export function isHidden(sig, now = Date.now()) {
  return !!sig.hiddenUntil && now < sig.hiddenUntil;
}

/**
 * Advance behaviours one tick.
 * @returns {Array<{type: string, sig: object}>} events:
 *   fled, tired, hid, reappeared, expired, dawn
 */
export function updateBehaviours(signals, playerPos, { now = Date.now(), night = false } = {}) {
  const events = [];
  if (!playerPos) return events;

  for (const sig of signals) {
    // Legendary signals fade.
    if (sig.expiresAt && now >= sig.expiresAt) {
      sig._remove = true;
      events.push({ type: 'expired', sig });
      continue;
    }
    // Night creatures vanish with the dawn.
    if (sig.nightOnly && !night) {
      sig._remove = true;
      events.push({ type: 'dawn', sig });
      continue;
    }

    const d = distanceM(playerPos, sig.pos);

    if (sig.behavior === 'runner') {
      if (sig.fleesLeft > 0 && now >= sig.cooldownUntil && d <= CONFIG.runnerTriggerM) {
        const to = escapePoint(sig, playerPos);
        if (to) {
          sig.pos = to;
          sig.zoneCenter = to;
          sig.fleesLeft -= 1;
          sig.cooldownUntil = now + CONFIG.runnerCooldownMs;
          events.push({ type: 'fled', sig });
          if (sig.fleesLeft === 0) {
            sig.revealedClues.push("It's too tired to run any further.");
            events.push({ type: 'tired', sig });
          }
        }
      }
    } else if (sig.behavior === 'hider') {
      if (sig.hiddenUntil && now >= sig.hiddenUntil) {
        sig.hiddenUntil = null;
        const to = reappearPoint(sig, playerPos);
        if (to) sig.pos = to;
        sig.cooldownUntil = now + CONFIG.hiderCooldownMs;
        events.push({ type: 'reappeared', sig });
      } else if (
        !sig.hiddenUntil &&
        sig.hidesLeft > 0 &&
        now >= sig.cooldownUntil &&
        d <= CONFIG.hiderTriggerM
      ) {
        sig.hiddenUntil = now + randBetween(CONFIG.hiderHideMinMs, CONFIG.hiderHideMaxMs);
        sig.hidesLeft -= 1;
        events.push({ type: 'hid', sig });
      }
    }
  }
  return events;
}
