// The Hunt — tunable game constants.
// Everything gameplay-balance-related lives here so it's easy to retune
// without hunting through logic files.

export const CONFIG = {
  // How far out a new signal can spawn from the player when a hunt starts.
  spawnMinDistanceM: 60,
  spawnMaxDistanceM: 260,

  // The "search zone" a character wanders inside — its true position is
  // never the exact spawn point, it's randomized within this radius of it.
  // This is what stops someone from just sharing a fixed coordinate online.
  searchZoneRadiusM: 35,

  // Scanner Level 1 range (see GDD section 24) — signals outside this
  // radius aren't detected at all yet. Also doubles as the Map screen's
  // radar view radius, so the map and scanner always agree on "in range".
  scannerRangeM: 300,

  // Distance thresholds that change what the scanner shows.
  veryCloseM: 20,
  captureRangeM: 12,

  // How many simultaneous signals the player can have active at once.
  maxActiveSignals: 3,

  // How often (ms) "Wanderer" characters take a small random step.
  wanderTickMs: 8000,
  wanderStepM: 6,

  // Main game loop tick — recompute distance/bearing/signal strength.
  tickMs: 1500,

  // Safety nudge (GDD section 26): remind the player to look up after
  // this much continuous active tracking time.
  lookUpReminderMs: 3 * 60 * 1000,

  // Real (not fake) light progression: one Hunter Level per this many
  // total captures, purely cosmetic, never gates anything.
  capturesPerHunterLevel: 5,

  // localStorage keys.
  storage: {
    collection: 'thehunt_collection_v1',
    journal: 'thehunt_journal_v1',
    activeSignals: 'thehunt_active_signals_v1',
    hunterState: 'thehunt_hunter_state_v1',
    safetySeen: 'thehunt_safety_seen_v1',
    lifetimeDistanceM: 'thehunt_lifetime_distance_v1',
  },
};
