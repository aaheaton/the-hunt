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
import { destinationPoint, distanceM, bearingDeg, angleDiff } from './geo.js';
import { findSpawnPoint, findPointNear, habitatsNear, terrainStatus, isSafeSpot } from './terrain.js';

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

/** The behaviour a species actually spawns with (paused ones → stationary). */
export function effectiveBehaviour(behavior) {
  return (CONFIG.pausedBehaviours || []).includes(behavior) ? 'stationary' : behavior;
}

function makeSignal(species, pos, habitat, unchecked) {
  const now = Date.now();
  const behavior = effectiveBehaviour(species.behavior);
  return {
    id: `sig-${idPrefix}-${nextId++}`,
    speciesId: species.id,
    // The search zone is centred on the spawn point; wanderers / hiders
    // move around inside it.
    zoneCenter: { lat: pos.lat, lng: pos.lng },
    pos: { lat: pos.lat, lng: pos.lng },
    habitat,
    unchecked,
    behavior,
    nightOnly: !!species.nightOnly,
    legendary: species.rarity === 'legendary',
    spawnedAt: now,
    expiresAt: species.rarity === 'legendary' ? now + CONFIG.legendaryLifetimeMs : null,
    revealedClues: [],
    // Behaviour state (behaviours.js).
    fleesLeft: behavior === 'runner' ? CONFIG.runnerFlees : 0,
    hidesLeft: behavior === 'hider' ? CONFIG.hiderHides : 0,
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

/* ------------------------------------------------------------------ */
/* Walking: spawn ahead, treat signals behind as gone (playtest 10-16)  */
/* ------------------------------------------------------------------ */

/** Degrees between the direction of travel and the signal (0 = dead ahead). */
function offHeadingDeg(playerPos, heading, sig) {
  return Math.abs(angleDiff(heading, bearingDeg(playerPos, sig.pos)));
}

/** Is the signal behind a walking player? (`heading` null = not walking → never.) */
export function isBehind(playerPos, heading, sig) {
  if (heading == null || !isFinite(heading)) return false;
  return offHeadingDeg(playerPos, heading, sig) > CONFIG.behindAngleDeg;
}

/** Is the signal roughly ahead of a walking player? (Not walking → everything counts.) */
export function isAhead(playerPos, heading, sig) {
  if (heading == null || !isFinite(heading)) return true;
  return offHeadingDeg(playerPos, heading, sig) <= CONFIG.aheadAngleDeg;
}

/** Cones around the direction of travel, narrowest first, then any direction. */
function aheadCones(heading) {
  if (heading == null || !isFinite(heading)) return [null];
  return [CONFIG.aheadConeHalfDeg, ...CONFIG.aheadConeFallbackDeg]
    .map((halfDeg) => ({ centerDeg: heading, halfDeg }))
    .concat([null]);
}

/**
 * spawnSignal, but while walking (ctx.heading set) try the cone ahead of the
 * player first. Marks the signal `aheadSpawn` when it landed in a cone.
 */
function spawnPreferAhead(playerPos, ctx) {
  for (const cone of aheadCones(ctx.heading)) {
    const sig = spawnSignal(playerPos, { ...ctx, cone });
    if (sig) { if (cone) sig.aheadSpawn = true; return sig; }
  }
  return null;
}

/**
 * Pick a signal to drop when the list is full: one behind a walking player
 * first, otherwise the furthest. Never the tracked one or a legendary.
 */
function pickVictim(activeSignals, playerPos, ctx) {
  return activeSignals
    .filter((s) => s.id !== ctx.currentId && !s.legendary)
    .sort((a, b) => {
      const ba = isBehind(playerPos, ctx.heading, a) ? 1 : 0;
      const bb = isBehind(playerPos, ctx.heading, b) ? 1 : 0;
      if (ba !== bb) return bb - ba;
      return distanceM(playerPos, b.pos) - distanceM(playerPos, a.pos);
    })[0] || null;
}

/**
 * Top up the active signal list to `ctx.target` (rolled by the caller so it
 * doesn't change every tick). While walking (ctx.heading) new signals go
 * ahead of the player. Returns the newly-added signals.
 */
export function refillSignals(activeSignals, playerPos, ctx = {}) {
  const target = ctx.target ?? rollSignalTarget();
  const added = [];
  let failures = 0;
  while (activeSignals.length < target && failures < 4) {
    const sig = spawnPreferAhead(playerPos, { ...ctx, existing: activeSignals });
    if (!sig) { failures++; continue; }
    activeSignals.push(sig);
    added.push(sig);
  }
  return added;
}

/**
 * Keep CONFIG.nearMinSignals signals within CONFIG.nearRadiusM of the player.
 * While walking, signals behind the player don't count (playtest 2026-10-16:
 * a signal 95m behind a walker still counted as "near", so nothing new was
 * placed ahead) and new ones go ahead. If the list is already at its
 * maximum, a signal behind (else the furthest) makes room — never the
 * tracked one or a legendary. Returns { added, removed }.
 */
export function ensureNearSignals(activeSignals, playerPos, ctx = {}) {
  const added = [];
  const removed = [];
  const near = activeSignals.filter((s) =>
    distanceM(playerPos, s.pos) <= CONFIG.nearRadiusM && !isBehind(playerPos, ctx.heading, s)
  ).length;
  if (near >= CONFIG.nearMinSignals) return { added, removed };

  const { nearMinSignals: min, nearMaxSignals: max } = CONFIG;
  const want = min + Math.floor(Math.random() * (max - min + 1)) - near;
  for (let i = 0; i < want; i++) {
    const sig = spawnPreferAhead(playerPos, {
      ...ctx,
      existing: activeSignals,
      minD: CONFIG.spawnMinDistanceM,
      maxD: CONFIG.nearRadiusM,
      noLegendary: true,
    });
    if (!sig) break;
    if (activeSignals.length >= CONFIG.maxActiveSignals) {
      const victim = pickVictim(activeSignals, playerPos, ctx);
      if (!victim) break;
      activeSignals.splice(activeSignals.indexOf(victim), 1);
      removed.push(victim);
    }
    activeSignals.push(sig);
    added.push(sig);
  }
  return { added, removed };
}

/**
 * Walking away from everything: place one fresh signal ahead of the player
 * (CONFIG.aheadOfferMinM–MaxM, in the cone of travel), making room if the
 * list is full. Returns { sig, removed } — sig is null if nowhere fits.
 */
export function spawnAheadOffer(activeSignals, playerPos, ctx = {}) {
  const removed = [];
  if (ctx.heading == null) return { sig: null, removed };
  let sig = null;
  for (const cone of aheadCones(ctx.heading).filter(Boolean)) {
    sig = spawnSignal(playerPos, {
      ...ctx, existing: activeSignals, cone, noLegendary: true,
      minD: CONFIG.aheadOfferMinM, maxD: CONFIG.aheadOfferMaxM,
    });
    if (sig) break;
  }
  if (!sig) return { sig: null, removed };
  sig.aheadSpawn = true;
  sig.aheadOffer = true;
  if (activeSignals.length >= CONFIG.maxActiveSignals) {
    const victim = pickVictim(activeSignals, playerPos, ctx);
    if (victim) {
      activeSignals.splice(activeSignals.indexOf(victim), 1);
      removed.push(victim);
    }
  }
  activeSignals.push(sig);
  return { sig, removed };
}

/**
 * While walking, drop signals more than CONFIG.behindDespawnM behind the
 * player (not the tracked one, not legendaries) so the slots go to signals
 * ahead. Returns the removed signals.
 */
export function despawnBehindSignals(activeSignals, playerPos, ctx = {}) {
  if (ctx.heading == null) return [];
  const gone = activeSignals.filter((s) =>
    s.id !== ctx.currentId && !s.legendary &&
    distanceM(playerPos, s.pos) > CONFIG.behindDespawnM &&
    isBehind(playerPos, ctx.heading, s)
  );
  for (const s of gone) activeSignals.splice(activeSignals.indexOf(s), 1);
  return gone;
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
    // Signals saved before a behaviour was paused come back as stationary.
    for (const s of signals) {
      const b = effectiveBehaviour(s.behavior);
      if (b !== s.behavior) {
        s.behavior = b;
        s.fleesLeft = 0;
        s.hidesLeft = 0;
        s.hiddenUntil = null;
      }
    }
    const currentId = signals.some((s) => s.id === data.currentId) ? data.currentId : null;
    return { signals, currentId };
  } catch (err) {
    console.warn('Failed loading signals', err);
    return null;
  }
}

/**
 * Terrain arrived after signals were placed blind (Overpass was slow or
 * down): move every unchecked signal onto a safe, habitat-appropriate spot
 * near where it was, or confirm it if it's already safe. Signals the player
 * is actively searching for (skipId) are left alone so they don't jump.
 * Returns the number of signals that were moved.
 */
export function relocateUncheckedSignals(activeSignals, { skipId = null } = {}) {
  let moved = 0;
  for (const sig of activeSignals) {
    if (!sig.unchecked || sig.id === skipId) continue;
    if (isSafeSpot(sig.pos)) {
      sig.unchecked = false;
      continue;
    }
    const p = findPointNear(sig.zoneCenter || sig.pos, 0, 80, { habitat: sig.habitat });
    if (!p) continue; // nowhere safe close by — keep it, still flagged unchecked
    sig.pos = { lat: p.lat, lng: p.lng };
    sig.zoneCenter = { lat: p.lat, lng: p.lng };
    sig.unchecked = false;
    if (sig.search) { sig.search.inZone = false; sig.search.ema = null; sig.search.ref = null; sig.search.trend = null; }
    moved += 1;
  }
  return moved;
}

export { terrainStatus };
