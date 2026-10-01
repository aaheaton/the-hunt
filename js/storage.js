// Local persistence — the whole prototype runs with no backend (GDD Stage
// 1/MVP scope), so the "collection" and "field journal" both live in
// localStorage on the player's own device.

import { CONFIG } from './config.js';
import { fuzzCoord } from './geo.js';
import { speciesById, maxStage } from './characters.js';

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
    console.warn('Failed reading', key, err);
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.warn('Failed writing', key, err);
  }
}

/** { [speciesId]: { count, firstDiscoveredAt, stage?, evolutions?: [{stage, at}] } } */
export function getCollection() {
  // Drop entries for species that have been removed from the roster.
  const all = readJSON(CONFIG.storage.collection, {});
  return Object.fromEntries(Object.entries(all).filter(([id]) => speciesById(id)));
}

/** Array of journal entries, newest first. */
export function getJournal() {
  return readJSON(CONFIG.storage.journal, []).filter((e) => speciesById(e.speciesId));
}

export function hasSeenSafetyIntro() {
  return readJSON(CONFIG.storage.safetySeen, false) === true;
}

export function markSafetyIntroSeen() {
  writeJSON(CONFIG.storage.safetySeen, true);
}

/**
 * Record a capture: bumps the collection count and appends a journal entry.
 * Only ever stores an approximate (fuzzed) location, never a precise route
 * (GDD section 39 — privacy should be designed in, not bolted on).
 */
export function recordCapture({ speciesId, rarity, location, distanceWalkedM }) {
  const collection = getCollection();
  const isFirst = !collection[speciesId];
  const entry = collection[speciesId] || { count: 0, firstDiscoveredAt: null };
  entry.count += 1;
  if (isFirst) entry.firstDiscoveredAt = Date.now();
  collection[speciesId] = entry;
  writeJSON(CONFIG.storage.collection, collection);

  const journal = getJournal();
  journal.unshift({
    speciesId,
    rarity,
    at: Date.now(),
    approxLocation: fuzzCoord(location),
    distanceWalkedM: Math.round(distanceWalkedM || 0),
    firstDiscovery: isFirst,
  });
  writeJSON(CONFIG.storage.journal, journal);

  return { isFirst, entry };
}

export function totalDiscoveredSpeciesCount() {
  return Object.keys(getCollection()).length;
}

export function totalCaptureCount() {
  return Object.values(getCollection()).reduce((sum, e) => sum + e.count, 0);
}

/** Real (not fake) hunter level: one level per N total captures. Cosmetic only. */
export function hunterLevel() {
  return 1 + Math.floor(totalCaptureCount() / CONFIG.capturesPerHunterLevel);
}

/** Lifetime distance walked while actively tracking a signal, in metres. */
export function getLifetimeDistanceM() {
  return readJSON(CONFIG.storage.lifetimeDistanceM, 0);
}

export function addLifetimeDistance(deltaM) {
  if (!deltaM || deltaM < 0) return getLifetimeDistanceM();
  const total = getLifetimeDistanceM() + deltaM;
  writeJSON(CONFIG.storage.lifetimeDistanceM, total);
  return total;
}

/**
 * Bundle the collection + journal into a downloadable JSON blob URL.
 * This is a genuinely working feature (unlike the mockup's decorative
 * "Export Field Log" button) — a real local backup/export, no backend.
 */
export function exportFieldLogBlobUrl() {
  const payload = {
    exportedAt: new Date().toISOString(),
    collection: getCollection(),
    journal: getJournal(),
    lifetimeDistanceM: getLifetimeDistanceM(),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  return URL.createObjectURL(blob);
}

/* ------------------------------------------------------------------ */
/* Evolution                                                            */
/* ------------------------------------------------------------------ */

/** Current evolution stage for a collected species (1 if not evolved / no line). */
export function currentStage(speciesId) {
  return getCollection()[speciesId]?.stage || 1;
}

/**
 * Next evolution the player could unlock, with progress, or null if the
 * species has no evolution line or is already at its final form.
 */
export function evolutionStatus(speciesId) {
  const species = speciesById(speciesId);
  const entry = getCollection()[speciesId];
  if (!species?.evolution || !entry) return null;
  const stage = entry.stage || 1;
  if (stage >= maxStage(species)) return { final: true, stage };
  const next = species.evolution[stage];
  return {
    final: false,
    stage,
    next,
    captures: entry.count,
    required: next.requiresCaptures,
    ready: entry.count >= next.requiresCaptures,
  };
}

/** Evolve a species one stage if the player has enough captures. Returns the new stage or null. */
export function evolveSpecies(speciesId) {
  const status = evolutionStatus(speciesId);
  if (!status || status.final || !status.ready) return null;
  const collection = getCollection();
  const entry = collection[speciesId];
  entry.stage = status.stage + 1;
  entry.evolutions = [...(entry.evolutions || []), { stage: entry.stage, at: Date.now() }];
  writeJSON(CONFIG.storage.collection, collection);
  return entry.stage;
}
