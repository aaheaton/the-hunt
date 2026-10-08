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
import { destinationPoint, distanceM } from './geo.js';
import { findSpawnPoint, findPointNear, habitatsNear, terrainStatus } from './terrain.js';

// Ids must stay unique across reloads, because signals are persisted.
let nextId = 1;
const idPrefix = Date.now().toString(36);

// Testing override: ?spawn=<speciesId> forces the first spawn to be that
// species (ignores the night gate, still uses safe terrain placement).
let forcedSpawn = (() => {
  try { return new URLSearchParams(location.search).get('spawn'); } catch (_) { return null; }
})();

function habitatsFor(species) {
  return species.spawnHabitats || ['any'];
}

/** Random (unchecked) point minD–maxD from the player — the pre-terrain fallback. */
function randomPoint(playerPos, minD, maxD, cone = null) {
  const bearing = cone
    ? cone.centerDeg + (Math.random() * 2 - 1) * cone.halfDeg
    : Math.random() * 360;
  return destinationPoint(playerPos, bearing, minD + Math.random() * (maxD - minD));
}

function makeSignal(species, pos, habitat, unchecked) {
  const now = Date.now();
  return {
    id: `sig-${idPrefix}-${nextId++}`,
    speciesId: species.id,
    // The search zone is centred on the spawn point; wanderers / hiders
    // move around inside it.
    zoneCenter: { lat: pos.lat, lng: pos.lng },
    pos: { lat: pos.lat, lng: pos.lng },
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
 * Try to create a signal for one species minD–maxD from the player (measured
 * to the creature's true position). Returns the signal, or null if the
 * species has no safe spot in its habitat in that ring.
 */
function trySpawnSpecies(species, playerPos, minD, maxD, tries, cone = null) {
  // Small rings need more random candidates to land a hit.
  const n = tries || (maxD <= 160 ? 200 : CONFIG.terrainSpawnTries);
  const spot = findSpawnPoint(playerPos, habitatsFor(species), minD, maxD, n, cone);
  if (spot === undefined) {
    // No terrain data: old behaviour, flagged unchecked.
    return makeSignal(species, randomPoint(playerPos, minD, maxD, cone), species.habitat, true);
  }
  if (!spot) return null;
  return makeSignal(species, { lat: spot.lat, lng: spot.lng }, spot.habitat, false);
}

/**
 * Create a brand-new signal near the player, or null if nothing can spawn.
 * @param {object} ctx { night, existing, minD, maxD, noLegendary, cone }
 *   cone: optional { centerDeg, halfDeg } — only place within this compass arc.
 */
export function spawnSignal(playerPos, ctx = {}) {
  const night = !!ctx.night;
  const existing = ctx.existing || [];
  const minD = ctx.minD ?? CONFIG.spawnMinDistanceM;
  const maxD = ctx.maxD ?? CONFIG.spawnMaxDistanceM;
  const legendaryActive = existing.filter((s) => s.legendary).length;

  if (forcedSpawn) {
    const species = speciesById(forcedSpawn);
    forcedSpawn = null;
    if (species) {
      const sig = trySpawnSpecies(species, playerPos, minD, maxD, undefined, ctx.cone);
      if (sig) return sig;
    }
  }

  // Only species whose habitat actually exists nearby (when terrain is known).
  const habitats = habitatsNear(playerPos, maxD);
  let pool = spawnableSpecies({ night }).filter((s) => {
    if (s.rarity === 'legendary' && (ctx.noLegendary || legendaryActive >= CONFIG.maxActiveLegendary)) return false;
    if (!habitats) return true;
    return habitatsFor(s).some((h) => habitats[h]);
  });

  for (let attempt = 0; attempt < 6 && pool.length; attempt++) {
    const species = rollSpecies(pool, night ? CONFIG.nightSpeciesWeightMultiplier : 1);
    const sig = trySpawnSpecies(species, playerPos, minD, maxD, undefined, ctx.cone);
    if (sig) return sig;
    pool = pool.filter((s) => s !== species); // no room for this one here
  }
  return null;
}

/**
 * The guaranteed close first signal of a session (~25–50m). If there's no
 * safe spot that close, widen the ring step by step rather than give up.
 * Never a legendary (that should stay an event, not a freebie).
 */
export function spawnFirstSignal(playerPos, ctx = {}) {
  const minD = CONFIG.firstSignalMinDistanceM;
  for (const maxD of [CONFIG.firstSignalMaxDistanceM, 80, CONFIG.nearRadiusM]) {
    const sig = spawnSignal(playerPos, { ...ctx, minD, maxD, noLegendary: true });
    if (sig) return sig;
  }
  return null;
}

/** Facing cones to try, narrowest first, ending with "any direction". */
function frontCones(heading) {
  if (heading == null || !isFinite(heading)) return [null];
  return [CONFIG.frontConeHalfDeg, ...CONFIG.frontConeFallbackDeg]
    .map((halfDeg) => ({ centerDeg: heading, halfDeg }))
    .concat([null]);
}

/**
 * Start-up spawn: at least CONFIG.frontSpawnCount signals in front of the
 * player (around compass `heading`). The first is the guaranteed close first
 * signal (25–50m, widening if needed); the others sit within nearRadiusM.
 * Each one tries the narrow front cone, then a wider cone, and only then any
 * direction. With no heading this is just the old directionless spawn.
 * Returns the new signals (first = the close one), never legendaries.
 */
export function spawnStartupSignals(playerPos, heading, ctx = {}) {
  const out = [];
  const cones = frontCones(heading);
  const place = (minD, maxDs) => {
    for (const cone of cones) {
      for (const maxD of maxDs) {
        const sig = spawnSignal(playerPos, {
          ...ctx, existing: out, minD, maxD, noLegendary: true, cone,
        });
        if (sig) { sig.frontSpawn = !!cone; return sig; }
      }
    }
    return null;
  };
  const first = place(CONFIG.firstSignalMinDistanceM, [CONFIG.firstSignalMaxDistanceM, 80, CONFIG.nearRadiusM]);
  if (first) out.push(first);
  while (out.length < CONFIG.frontSpawnCount) {
    const sig = place(CONFIG.spawnMinDistanceM, [CONFIG.nearRadiusM]);
    if (!sig) break;
    out.push(sig);
  }
  return out;
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

/** Roll a random overall signal target between min and max (inclusive). */
export function rollSignalTarget() {
  const { minActiveSignals: min, maxActiveSignals: max } = CONFIG;
  return min + Math.floor(Math.random() * (max - min + 1));
}

/**
 * Top up the active signal list to `ctx.target` (rolled by the caller so it
 * doesn't change every tick). Returns the newly-added signals.
 */
export function refillSignals(activeSignals, playerPos, ctx = {}) {
  const target = ctx.target ?? rollSignalTarget();
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

/**
 * Keep 1–2 signals within CONFIG.nearRadiusM of the player. When none are
 * that close, spawn up to a random 1–2 in the 40–150m ring. If the list is
 * already at its maximum, the furthest signal that isn't being tracked (and
 * isn't a legendary) makes room. Returns { added, removed }.
 */
export function ensureNearSignals(activeSignals, playerPos, ctx = {}) {
  const added = [];
  const removed = [];
  const near = activeSignals.filter((s) => distanceM(playerPos, s.pos) <= CONFIG.nearRadiusM).length;
  if (near >= CONFIG.nearMinSignals) return { added, removed };

  const { nearMinSignals: min, nearMaxSignals: max } = CONFIG;
  const want = min + Math.floor(Math.random() * (max - min + 1)) - near;
  for (let i = 0; i < want; i++) {
    const sig = spawnSignal(playerPos, {
      ...ctx,
      existing: activeSignals,
      minD: CONFIG.spawnMinDistanceM,
      maxD: CONFIG.nearRadiusM,
      noLegendary: true,
    });
    if (!sig) break;
    if (activeSignals.length >= CONFIG.maxActiveSignals) {
      const victim = activeSignals
        .filter((s) => s.id !== ctx.currentId && !s.legendary)
        .sort((a, b) => distanceM(playerPos, b.pos) - distanceM(playerPos, a.pos))[0];
      if (!victim) break;
      activeSignals.splice(activeSignals.indexOf(victim), 1);
      removed.push(victim);
    }
    activeSignals.push(sig);
    added.push(sig);
  }
  return { added, removed };
}

/** Remove (and return) signals the player has left more than CONFIG.despawnDistanceM behind. */
export function despawnFarSignals(activeSignals, playerPos) {
  const gone = activeSignals.filter((s) => distanceM(playerPos, s.pos) > CONFIG.despawnDistanceM);
  for (const s of gone) activeSignals.splice(activeSignals.indexOf(s), 1);
  return gone;
}

/* ------------------------------------------------------------------ */
/* Persistence across short restarts                                    */
/* ------------------------------------------------------------------ */

/** Save the live signal list (minus per-tick scratch fields). */
export function saveSignals(activeSignals, currentId) {
  try {
    const signals = activeSignals.map((s) =>
      Object.fromEntries(Object.entries(s).filter(([k]) => !k.startsWith('_')))
    );
    localStorage.setItem(
      CONFIG.storage.activeSignals,
      JSON.stringify({ savedAt: Date.now(), currentId, signals })
    );
  } catch (err) {
    console.warn('Failed saving signals', err);
  }
}

/**
 * Load signals saved less than CONFIG.signalPersistMs ago. Drops any that
 * have expired, or are now out of despawn range of the player. Returns
 * { signals, currentId } or null.
 */
export function loadSignals(playerPos, { night = false } = {}) {
  try {
    const raw = localStorage.getItem(CONFIG.storage.activeSignals);
    if (!raw) return null;
    const data = JSON.parse(raw);
    const now = Date.now();
    if (!data || !Array.isArray(data.signals) || now - data.savedAt > CONFIG.signalPersistMs) {
      localStorage.removeItem(CONFIG.storage.activeSignals);
      return null;
    }
    const signals = data.signals.filter(
      (s) =>
        speciesById(s.speciesId) &&
        s.pos && isFinite(s.pos.lat) &&
        !(s.expiresAt && now >= s.expiresAt) &&
        !(s.nightOnly && !night) &&
        distanceM(playerPos, s.pos) <= CONFIG.despawnDistanceM
    );
    if (!signals.length) return null;
    const currentId = signals.some((s) => s.id === data.currentId) ? data.currentId : null;
    return { signals, currentId };
  } catch (err) {
    console.warn('Failed loading signals', err);
    return null;
  }
}

export { terrainStatus };
