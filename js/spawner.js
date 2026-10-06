// Signal spawner: creates and maintains the player's active "signals"
// (undiscovered characters somewhere nearby). Positions are deliberately
// re-randomized within a search zone rather than fixed, per GDD section 6.
//
// Spawns are real-world aware (GDD §11, §26): when OpenStreetMap terrain is
// loaded (terrain.js), every creature is placed on a safe public spot that
// matches its habitat — Water creatures on river/lake banks, Trees creatures
// in parks and woods, Urban creatures on footpaths — and never on roads,
// railways, in water, on private land or in no-go areas. If terrain can't be
// loaded (offline / Overpass down) it falls back to the old random placement
// and flags the signal as `unchecked`.
//
// Night-only species (GDD §7.5) only spawn after dark (sun.js).

import { CONFIG } from './config.js';
import { rollSpecies, spawnableSpecies, speciesById } from './characters.js';
import { randomPointInRadius, destinationPoint, distanceM } from './geo.js';
import { findSpawnPoint, findPointNear, habitatsNear, terrainStatus } from './terrain.js';

let nextId = 1;

// Testing override: ?spawn=<speciesId> forces the first spawn to be that
// species (ignores the night gate, still uses safe terrain placement).
let forcedSpawn = (() => {
  try { return new URLSearchParams(location.search).get('spawn'); } catch (_) { return null; }
})();

function habitatsFor(species) {
  return species.spawnHabitats || ['any'];
}

/** Random (unchecked) zone centre — the pre-terrain fallback. */
function randomZoneCenter(playerPos) {
  const bearing = Math.random() * 360;
  const dist =
    CONFIG.spawnMinDistanceM +
    Math.random() * (CONFIG.spawnMaxDistanceM - CONFIG.spawnMinDistanceM);
  return destinationPoint(playerPos, bearing, dist);
}

function makeSignal(species, zoneCenter, pos, habitat, unchecked) {
  const now = Date.now();
  return {
    id: `sig-${nextId++}`,
    speciesId: species.id,
    zoneCenter,
    pos,
    habitat,
    unchecked,
    behavior: species.behavior,
    nightOnly: !!species.nightOnly,
    legendary: species.rarity === 'legendary',
    spawnedAt: now,
    expiresAt: species.rarity === 'legendary' ? now + CONFIG.legendaryLifetimeMs : null,
    revealedClues: [],
    // Behaviour state (behaviours.js).
    fleesLeft: species.behavior === 'runner' ? CONFIG.runnerFlees : 0,
    hidesLeft: species.behavior === 'hider' ? CONFIG.hiderHides : 0,
    hiddenUntil: null,
    cooldownUntil: 0,
  };
}

/**
 * Try to create a signal for one species. Returns the signal or null if the
 * species has no safe spot in its habitat nearby.
 */
function trySpawnSpecies(species, playerPos) {
  const spot = findSpawnPoint(
    playerPos,
    habitatsFor(species),
    CONFIG.spawnMinDistanceM,
    CONFIG.spawnMaxDistanceM
  );

  if (spot === undefined) {
    // No terrain data: old behaviour, flagged unchecked.
    const zoneCenter = randomZoneCenter(playerPos);
    const pos = randomPointInRadius(zoneCenter, CONFIG.searchZoneRadiusM);
    return makeSignal(species, zoneCenter, pos, species.habitat, true);
  }
  if (!spot) return null;

  const zoneCenter = { lat: spot.lat, lng: spot.lng };
  // The true position wanders inside the search zone but must stay safe
  // (and in-habitat where possible).
  const pos =
    findPointNear(zoneCenter, 0, CONFIG.searchZoneRadiusM, { habitat: spot.habitat, tries: 25 }) ||
    zoneCenter;
  return makeSignal(species, zoneCenter, pos, spot.habitat, false);
}

/**
 * Create a brand-new signal near the player, or null if nothing can spawn.
 * @param {object} ctx { night: boolean, existing: Array }
 */
export function spawnSignal(playerPos, ctx = {}) {
  const night = !!ctx.night;
  const existing = ctx.existing || [];
  const legendaryActive = existing.filter((s) => s.legendary).length;

  if (forcedSpawn) {
    const species = speciesById(forcedSpawn);
    forcedSpawn = null;
    if (species) {
      const sig = trySpawnSpecies(species, playerPos);
      if (sig) return sig;
    }
  }

  // Only species whose habitat actually exists nearby (when terrain is known).
  const habitats = habitatsNear(playerPos, CONFIG.spawnMaxDistanceM);
  let pool = spawnableSpecies({ night }).filter((s) => {
    if (s.rarity === 'legendary' && legendaryActive >= CONFIG.maxActiveLegendary) return false;
    if (!habitats) return true;
    return habitatsFor(s).some((h) => habitats[h]);
  });

  for (let attempt = 0; attempt < 6 && pool.length; attempt++) {
    const species = rollSpecies(pool, night ? CONFIG.nightSpeciesWeightMultiplier : 1);
    const sig = trySpawnSpecies(species, playerPos);
    if (sig) return sig;
    pool = pool.filter((s) => s !== species); // no room for this one here
  }
  return null;
}

/**
 * Nudge "wanderer" signals a small random step, staying inside their search
 * zone and on safe ground.
 */
export function wanderTick(signals) {
  for (const sig of signals) {
    if (sig.behavior !== 'wanderer') continue;
    let next = findPointNear(sig.pos, CONFIG.wanderStepM * 0.5, CONFIG.wanderStepM * 1.5, {
      habitat: sig.habitat,
      tries: 12,
    });
    if (next === undefined) {
      next = destinationPoint(sig.pos, Math.random() * 360, CONFIG.wanderStepM);
    }
    if (next && distanceM(next, sig.zoneCenter) <= CONFIG.searchZoneRadiusM) sig.pos = next;
  }
}

/**
 * Top up the active signal list to a random target between
 * CONFIG.minActiveSignals and CONFIG.maxActiveSignals (inclusive).
 * Returns the newly-added signals.
 */
export function refillSignals(activeSignals, playerPos, ctx = {}) {
  const { minActiveSignals: min, maxActiveSignals: max } = CONFIG;
  const target = min + Math.floor(Math.random() * (max - min + 1));
  const added = [];
  let failures = 0;
  while (activeSignals.length < target && failures < 4) {
    const sig = spawnSignal(playerPos, { ...ctx, existing: activeSignals });
    if (!sig) { failures++; continue; }
    activeSignals.push(sig);
    added.push(sig);
  }
  return added;
}

export { terrainStatus };
