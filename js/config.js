// The Hunt — tunable game constants.
// Everything gameplay-balance-related lives here so it's easy to retune
// without hunting through logic files.

export const CONFIG = {
  // How far out a new signal can spawn from the player when a hunt starts.
  // Measured to the creature's true position.
  spawnMinDistanceM: 40,
  // Playtest 2026-10-15: median signal was 211m away when detected and the
  // only capture started at 28m — spawn closer so hunts fit a short session.
  spawnMaxDistanceM: 250,

  // The first signal of every session is placed close, so the very first
  // hunt fits in a couple of minutes (playtest 2026-10-06: nearest signal
  // was never under 100m and nobody captured anything).
  firstSignalMinDistanceM: 25,   // outside runner/hider trigger range
  firstSignalMaxDistanceM: 50,

  // On start-up, at least this many signals are placed in FRONT of the
  // player (within ±frontConeHalfDeg of their compass heading), so the
  // first thing they see on the scanner is "ahead of you" rather than
  // "turn around". If no safe spot exists in the cone the cone widens
  // (frontConeFallbackDeg) and finally falls back to any direction.
  // The first front signal is the close first signal (25–50m); the rest
  // go out to nearRadiusM. Needs a compass heading — without one
  // (desktop / no sensor) spawning is directionless as before.
  frontSpawnCount: 2,
  frontConeHalfDeg: 40,
  frontConeFallbackDeg: [70],
  headingWaitMs: 2500,           // max extra wait for a first compass reading

  // Keep the field populated as the player walks (playtest: signals were
  // left behind and the area emptied out).
  despawnDistanceM: 350,         // signals further than this are removed
  nearRadiusM: 100,              // always keep some signals within this…
  nearMinSignals: 2,             // …at least this many (playtest 2026-10-15: guarantee 2 within 100m)…
  nearMaxSignals: 2,             // …topping up to 2 when short
  topUpRetryMs: 20 * 1000,       // wait this long after a failed top-up

  // Signals survive short app restarts / reloads for this long.
  signalPersistMs: 30 * 60 * 1000,

  // The "search zone" a character wanders inside — its true position is
  // never the exact spawn point, it's randomized within this radius of it.
  // This is what stops someone from just sharing a fixed coordinate online.
  searchZoneRadiusM: 35,

  // Scanner Level 1 range (see GDD section 24) — signals outside this
  // radius aren't detected at all yet. Also doubles as the Map screen's
  // radar view radius, so the map and scanner always agree on "in range".
  // Matches the closer spawn ring (was 500m, when signals spawned out to 450m).
  scannerRangeM: 350,

  // --- The final approach: "Search" stage (GDD §3) ---
  // Entering the search area (within searchZoneRadiusM of the creature)
  // fires "IN THE SEARCH AREA" + vibration and switches the scanner to
  // hot/cold feedback instead of exact metres.
  searchExitM: 45,               // hysteresis: count as "left" beyond this
  searchHideDistance: true,      // hide exact metres/bearing while searching
  searchPulseMaxMs: 1600,        // pulse interval at the zone edge (35m)…
  searchPulseMinMs: 250,         // …down to this at capture range
  searchWarmerStepM: 3,          // smoothed distance must drop this much for "warmer"
  // Playtest 2026-10-15: 14 "colder" warnings, mostly GPS noise (a phone's
  // reported position wanders 5–20m standing still). Now the smoothed
  // distance must grow by 6m on 2 ticks in a row before we say "colder".
  searchColderStepM: 6,          // …or rise this much for a "colder" warning
  searchColderConfirmTicks: 2,   // …on this many consecutive ticks
  searchColderToastMs: 6000,     // min gap between "colder" toasts
  // Inside the search area exact metres/bearing stay hidden, but beyond this
  // distance the scanner still gives a rough 8-point direction ("TRY NE") so
  // players don't get lost. Closer than this it's pure hot/cold.
  searchHintAboveM: 15,

  // Distance thresholds that change what the scanner shows.
  veryCloseM: 20,
  // Capture range adapts to GPS accuracy (playtest: 12m vs ±5–20m GPS meant
  // players stood "on" a creature and still couldn't capture it). Effective
  // range = clamp(accuracy × factor, captureRangeM, captureRangeMaxM).
  captureRangeM: 12,
  captureRangeMaxM: 20,
  captureAccuracyFactor: 1.0,
  // Once in range, stay capturable for this long even if GPS jitters out.
  captureLatchMs: 8000,

  // How many simultaneous signals the player can have active at once.
  // The actual target is re-rolled between min and max each time the
  // list is refilled (e.g. after a capture), so the map feels less uniform.
  // Playtest 2026-10-15: 6–12 signals per session, 75% never tracked, 25
  // target switches — fewer choices, more focus.
  minActiveSignals: 3,
  maxActiveSignals: 4,

  // --- Direction (playtest 2026-10-15: half of longer hunts ended further
  // away than they started) ---
  // While walking, heading comes from the GPS track (direction of travel)
  // instead of the phone compass, which is unreliable on many Androids.
  courseMinMoveM: 6,             // need this much movement for a course reading…
  courseMinSpeedMps: 0.6,        // …at walking pace (filters GPS drift)…
  courseMaxAccuracyM: 25,        // …with a usable fix
  courseMaxAgeMs: 8000,          // course reading stays "fresh" this long
  // "You're moving away" nudge: smoothed distance grew this much past the
  // closest you've been to the tracked signal.
  awayNudgeM: 25,
  awayNudgeCooldownMs: 45 * 1000,
  // If the game picked the signal for you (not you) and you're walking away
  // from it, switch to a nearer one when it's at least this much closer.
  autoRetargetGainM: 20,

  // Behaviours paused for now (playtest 2026-10-15: 0% capture rate, and even
  // stationary creatures were only caught 2% of the time). Species with these
  // behaviours spawn as stationary until the core hunt works. Set to [] to
  // bring them back.
  pausedBehaviours: ['runner', 'hider'],

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
  // Playtest 2026-10-15: terrain failed in 24 of 43 sessions. Mirrors are now
  // raced in parallel (fastest wins) with a shorter timeout, the last good
  // result is cached on the device, and failed loads retry sooner.
  terrainTimeoutMs: 12000,
  // After a failed fetch, wait this long before trying again.
  terrainRetryMs: 20 * 1000,
  // Re-use cached terrain for the same area without asking the network
  // when younger than this; older (up to terrainCacheMaxDays) is a fallback.
  terrainCacheFreshHours: 72,
  terrainCacheMaxDays: 30,
  // How close (m) to a public footpath counts as "on the path".
  terrainPathSnapM: 4,
  // "Near water" band: a creature sits on the bank within this many metres.
  terrainWaterBandM: 30,
  // Ignore tiny green polygons (verges, planters, roundabout islands).
  terrainMinGreenAreaM2: 1500,
  // Attempts per habitat when looking for a valid spawn point.
  terrainSpawnTries: 60,

  // --- Behaviours (GDD §7) ---
  // Runner: hops a short way (never more than runnerFleeMaxM) directly away
  // from the player when you get this close — never towards or behind you.
  runnerTriggerM: 25,
  runnerFleeMinM: 5,
  runnerFleeMaxM: 10,        // hard cap, enforced in behaviours.js
  // Escape direction must be within this many degrees of straight "away
  // from the player", so the runner never ends up beside or behind you.
  runnerFleeConeDeg: 60,
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
    terrainIndex: 'thehunt_terrain_index_v1',
  },
};
