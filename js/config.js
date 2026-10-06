// The Hunt — tunable game constants.
// Everything gameplay-balance-related lives here so it's easy to retune
// without hunting through logic files.

export const CONFIG = {
  // How far out a new signal can spawn from the player when a hunt starts.
  spawnMinDistanceM: 60,
  spawnMaxDistanceM: 450,

  // The "search zone" a character wanders inside — its true position is
  // never the exact spawn point, it's randomized within this radius of it.
  // This is what stops someone from just sharing a fixed coordinate online.
  searchZoneRadiusM: 35,

  // Scanner Level 1 range (see GDD section 24) — signals outside this
  // radius aren't detected at all yet. Also doubles as the Map screen's
  // radar view radius, so the map and scanner always agree on "in range".
  scannerRangeM: 500,

  // Distance thresholds that change what the scanner shows.
  veryCloseM: 20,
  captureRangeM: 12,

  // How many simultaneous signals the player can have active at once.
  // The actual target is re-rolled between min and max each time the
  // list is refilled (e.g. after a capture), so the map feels less uniform.
  minActiveSignals: 3,
  maxActiveSignals: 7,

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

  // --- Real-world terrain (OpenStreetMap via Overpass, GDD §11 / §26) ---
  // Radius of OSM data fetched around the player (must exceed
  // spawnMaxDistanceM + runner escape distance).
  terrainRadiusM: 800,
  // Re-fetch once the player is this far from the last fetch centre.
  terrainRefetchM: 300,
  terrainTimeoutMs: 25000,
  // After a failed fetch, wait this long before trying again.
  terrainRetryMs: 60 * 1000,
  // How close (m) to a public footpath counts as "on the path".
  terrainPathSnapM: 4,
  // "Near water" band: a creature sits on the bank within this many metres.
  terrainWaterBandM: 30,
  // Ignore tiny green polygons (verges, planters, roundabout islands).
  terrainMinGreenAreaM2: 1500,
  // Attempts per habitat when looking for a valid spawn point.
  terrainSpawnTries: 60,

  // --- Behaviours (GDD §7) ---
  // Runner: bolts 30–50m away when you get this close.
  runnerTriggerM: 25,
  runnerFleeMinM: 30,
  runnerFleeMaxM: 50,
  runnerFlees: 2,            // then it's too tired to run again
  runnerCooldownMs: 8000,
  // Hider: vanishes when you get this close, reappears elsewhere in its zone.
  hiderTriggerM: 22,
  hiderHideMinMs: 15000,
  hiderHideMaxMs: 30000,
  hiderHides: 2,
  hiderCooldownMs: 10000,

  // --- Night creatures (GDD §7.5) ---
  // Night = sun more than this many degrees below the horizon (-6 = civil dusk).
  nightSunAltitudeDeg: -6,
  // Night-only species are this much more likely once it's dark.
  nightSpeciesWeightMultiplier: 2,

  // --- Legendary signals (GDD §8: "should feel like an event") ---
  legendaryLifetimeMs: 30 * 60 * 1000,
  maxActiveLegendary: 1,

  // CARTO basemaps API key (removes the "API key required" watermark on
  // map tiles). Note: this ships in client-side code, so anyone can see
  // it — restrict it to your domain in the CARTO dashboard if possible.
  cartoApiKey: 'cb1_47ck_1_a859aa438149c792359ba97e',

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
