// Signal spawner: creates and maintains the player's active "signals"
// (undiscovered characters somewhere nearby). Positions are deliberately
// re-randomized within a search zone rather than fixed, per GDD section 6.

import { CONFIG } from './config.js';
import { rollSpecies } from './characters.js';
import { randomPointInRadius } from './geo.js';

let nextId = 1;

function projectFrom(origin, bearing, distM) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const lat1 = toRad(origin.lat);
  const lng1 = toRad(origin.lng);
  const brng = toRad(bearing);
  const dOverR = distM / R;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(dOverR) + Math.cos(lat1) * Math.sin(dOverR) * Math.cos(brng)
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(dOverR) * Math.cos(lat1),
      Math.cos(dOverR) - Math.sin(lat1) * Math.sin(lat2)
    );
  return { lat: toDeg(lat2), lng: ((toDeg(lng2) + 540) % 360) - 180 };
}

/** Create a brand-new signal at a random point within scanner range of the player. */
export function spawnSignal(playerPos) {
  const species = rollSpecies();
  const bearing = Math.random() * 360;
  const dist =
    CONFIG.spawnMinDistanceM +
    Math.random() * (CONFIG.spawnMaxDistanceM - CONFIG.spawnMinDistanceM);
  const zoneCenter = projectFrom(playerPos, bearing, dist);
  const truePos = randomPointInRadius(zoneCenter, CONFIG.searchZoneRadiusM);

  return {
    id: `sig-${nextId++}`,
    speciesId: species.id,
    zoneCenter,
    pos: truePos,
    behavior: species.behavior,
    spawnedAt: Date.now(),
    revealedClues: [],
  };
}

/** Nudge "wanderer" signals a small random step within their search zone. */
export function wanderTick(signals) {
  for (const sig of signals) {
    if (sig.behavior !== 'wanderer') continue;
    const bearing = Math.random() * 360;
    sig.pos = projectFrom(sig.pos, bearing, CONFIG.wanderStepM);
  }
}

/** Top up the active signal list to a random target between
 *  CONFIG.minActiveSignals and CONFIG.maxActiveSignals (inclusive). */
export function refillSignals(activeSignals, playerPos) {
  const { minActiveSignals: min, maxActiveSignals: max } = CONFIG;
  const target = min + Math.floor(Math.random() * (max - min + 1));
  while (activeSignals.length < target) {
    activeSignals.push(spawnSignal(playerPos));
  }
  return activeSignals;
}
