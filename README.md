# The Hunt — Core Loop Prototype (Tactical Field HUD)

This is the **Stage 1 technical prototype** described in the GDD (sections
41–43): prove that physically hunting for an unknown character using GPS +
compass + a scanner UI is actually fun, before building anything else.

The visual design is adapted from the `stitch_mobile_app_design` bundle
(the "Tactical Field HUD" design system in `build.txt` / `DESIGN.md`) —
exact colors, typography (Space Grotesk / Inter / JetBrains Mono), the
glassmorphic HUD cards, segmented meters, rarity badges and the 4-tab
Scanner / Map / Capture / Journal navigation are all taken from that file.

## Design decisions worth knowing about

**Everything on screen is real, not mocked.** The source design mockups
include several systems that don't exist yet in this prototype — fake
multiplayer presence ("3 hunters nearby"), weekly events, an evolution/
duplicates matrix, a gadget loadout, a thermal-vision toggle, and a
hardcoded "LVL 14" tag. Rather than fake those, this build:
- Left them out entirely (no multiplayer, no events, no evolution, no
  gadget loadout, no thermal vision — those are real Stage 2+ systems).
- Made the ones that were cheap to make genuinely real instead: **Hunter
  Level** is computed from your actual capture count, the **FPS readout**
  on the Capture screen is a real per-second frame counter, and **Export
  Field Log** is a real local JSON download of your collection + journal.
- The Map screen's cartography is the same abstract SVG radar-style
  approach the source design itself uses (not real map tiles) — but it
  plots your *actual* active signals at their real bearing/distance,
  not the mockup's fictional Victoria Park/Lacuna Basin content.
- The Capture screen is a **real camera-based AR view** (`getUserMedia`),
  falling back to the sonar/compass HUD (GDD §15's "AR should be
  optional") automatically if camera access is denied or the browser
  doesn't support it, or manually via the "Sonar Mode" toggle.

## What's implemented

- Real GPS tracking and real compass heading (`deviceorientation` /
  iOS `webkitCompassHeading`).
- 3 simultaneous simulated "signals" spawned within ~60–260m of the
  player, each with a true position randomized inside a hidden search
  zone (GDD §6) — not a fixed marker. Two behaviors: Stationary and
  Wanderer.
- **Scanner tab:** proximity alert banner, a 3-up contact selector, a
  rotating radar dial plotting every active signal at its real relative
  bearing, progressive flavor clues as you approach, and a live signal
  strength meter.
- **Map tab:** a stylized sector map plotting real signal search-zones,
  a rarity filter, a north-up/heading-up toggle, a recenter button, and
  real session/lifetime distance-walked stats.
- **Capture tab:** camera-based AR with a targeting reticle, real
  lock-on percentage based on actual proximity, a "VERY CLOSE" alert
  under 20m, capture enabled within 12m, and a no-camera sonar fallback.
- **Journal tab:** real collection stats, a rarity breakdown, a featured
  "field dossier" card for your most recent discovery (lore, first
  capture date/location/distance walked), a specimen grid (locked/
  greyed for anything not yet found), and a real JSON export.
- Local collection + field journal in `localStorage`, no backend, no
  accounts.
- A safety intro screen and a periodic "look up" reminder (GDD §26).
- Installable as a PWA (manifest + service worker).

## What's deliberately NOT in this build yet

True AR anchoring (this uses camera passthrough
+ a screen-space reticle, not spatial tracking), a real backend/spawn
engine, accounts, trading, weather/social behaviours, multiplayer. See GDD §49 "Product Development Roadmap" for the intended
order.

## Running it locally (desktop testing)

From this folder:

```
python3 -m http.server 8080
```

Then open `http://localhost:8080` in Chrome — geolocation and the
service worker both work here because `localhost` counts as a secure
context even over plain HTTP. Use Chrome DevTools → `⋮` → *More tools* →
*Sensors* to fake a location and step it manually to simulate walking.
For the Capture tab, Chrome will ask for camera permission as normal.

## Testing on your actual phone (the point of this app)

Phone browsers only grant geolocation/camera/orientation access on a
secure context — `https://`, or `localhost` on the same device. Easiest
options, roughly in order of effort:

1. **Quick tunnel:** `npx localtunnel --port 8080` (or `ngrok http 8080`),
   open the `https://…` URL on your phone.
2. **Deploy for free:** GitHub Pages, Netlify, Vercel, or Cloudflare
   Pages — any gives a permanent `https://` URL you can add to your
   home screen.
3. **LAN with a local cert:** `mkcert` can generate a trusted local
   HTTPS cert if you want to stay fully offline.

Once open over HTTPS: tap **Start Hunting**, allow location (and, on
iOS, allow motion/orientation when prompted), walk toward a signal on
the Scanner tab, then switch to the Capture tab and allow camera access
when you're in range.

## Project structure

```
index.html          4 screens: safety intro, Scanner, Map, Capture, Journal
css/styles.css       Tactical Field HUD theme — tokens, typography, all components
js/config.js         all tunable gameplay constants (ranges, thresholds, timings)
js/geo.js            haversine distance, bearing, point projection, coord fuzzing
js/characters.js     species catalog, rarity table, clue pools
js/spawner.js        signal creation (terrain + night aware), wander drift, refill
js/terrain.js        OpenStreetMap (Overpass) terrain: safe-spot + habitat checks
js/behaviours.js     Runner / Hider / night-fade / legendary-expiry logic
js/sun.js            sun altitude → is it dark yet? (no network)
js/livemap.js        Leaflet street map on the Map tab
js/sensors.js        GPS + compass wrappers, iOS permission handling
js/storage.js        localStorage collection/journal + lifetime distance + export
js/icons.js          small inline-SVG icon set (no icon-font network dependency)
js/ui.js             all DOM rendering — no game state lives here
js/app.js            bootstraps everything, owns the single source of truth,
                     including camera lifecycle and the 4-tab navigation
manifest.json, sw.js PWA installability + offline app-shell caching
icons/, generate_icons.py   app icon assets (regeneratable, no external deps)
stitch_mobile_app_design/   the source design bundle this build was adapted from
```

## Tuning the feel

Everything that affects difficulty/pacing — scanner range, capture
range, how many signals are active at once, how far characters wander,
how often clues reveal — is in `js/config.js`.

## Privacy

Per GDD §39: only approximate (rounded to ~100m) discovery locations
are ever stored, never a continuous GPS trail, and everything stays
on-device. The one thing that leaves the phone: to place creatures
safely, the app asks the public OpenStreetMap Overpass API for parks,
paths, water and roads around you, sending a location **rounded to ~100m**
(never your exact position, never a trail). Playtest analytics (below)
store no coordinates at all.

## Creature roster, art & evolution (updated 2026-10-01)

The roster is exactly the creatures with concept art in the
`stitch_dark_folklore_creature_evolutions*.zip` files: 7 species, each with 3
evolution stages (21 images, resized to WebP in `assets/creatures/` as
`<id>-<stage>.webp` + `-thumb.webp`).

| # | Species | Rarity | Habitat | Stages (captures to unlock) |
|---|---|---|---|---|
| 1 | Domovoy | Common | Urban | Hearth Wisp → Hearth Sentinel (3) → The Ancestral (7) |
| 2 | The Wulver | Common | Trees | Hearthside Watcher → Cairn Warden (3) → Sovereign of the Mist (7) |
| 3 | The Leprechaun | Uncommon | Trees | Barrow Cobbler → Gold Warden (3) → The Hoard King (6) |
| 4 | Rusalka | Uncommon | Night | Drowned Willow Maid → The Murk-Siren (3) → Mora-Abyssia (6) |
| 5 | Naga | Rare | Water | The Lotus Coil → Monsoon Sentinel (2) → Ananta Shesha (4) |
| 6 | Blue Men of the Minch | Epic | Water | Wave-Caller → Storm Reaver (2) → Chieftain of the Minch (4) |
| 7 | Hollow Hart | Legendary | Night | Hollow Fawn → Bone Stag (2) → The Primeval (3) |

Wild spawns are always stage 1. Evolve from the species' Journal dossier once
the capture count is met. Saved data for removed species is ignored.
To add a creature: drop its 3 images into `assets/creatures/` with the naming
above, add an entry to `SPECIES` in `js/characters.js`, and list the files in `sw.js`.


## Behaviours, night creatures & real-world spawns (updated 2026-10-06)

**Behaviours (GDD §7)** — tune all numbers in `js/config.js`:

| Species | Behaviour | Spawns in | When |
|---|---|---|---|
| Domovoy | Stationary | Footpaths (urban) | Any time |
| The Wulver | Stationary | Parks / green space | Any time |
| The Leprechaun | **Hider** — vanishes for 15–30s at 22m, reappears on the far side of its zone (2 times) | Parks | Any time |
| Rusalka | Wanderer | Water banks, else parks | **Night only** |
| Naga | Stationary | Water banks | Any time |
| Blue Men of the Minch | **Runner** — bolts 30–50m away at 25m (2 times, then "too tired") | Water banks | Any time |
| Hollow Hart | **Runner**, legendary **event** | Woodland, else parks | **Night only** |

- **Night** = sun more than 6° below the horizon at your real position
  (civil dusk, `nightSunAltitudeDeg`). Night species spawn ×2 more often
  after dark and fade out at dawn.
- **Hollow Hart event:** full-screen "LEGENDARY SIGNAL" alert with a
  vibration pattern, a beacon on the map, red legendary scanner styling and
  a 30-minute countdown — then the signal fades. Max one at a time.

**Real-world spawns (GDD §11, §26).** On the first GPS fix the app loads
OpenStreetMap data within 800m (refreshed after you move 300m). Creatures
can only sit on public footpaths/pedestrian areas or inside public green
space, and never: in water, within a buffer of roads (4–30m by road type)
or railways, inside schools, playgrounds, cemeteries, golf courses,
industrial/military/construction sites, or anything tagged private.
Species are only offered if their habitat exists nearby, so no water
nearby means no water creatures. If Overpass can't be reached the game
falls back to random placement and warns the player.

**Testing switches** (add to the URL):
`?night=1` / `?night=0` force night/day · `?spawn=hollow-hart` (or any
species id) forces the first spawn · `?debug=1` exposes game state as
`window.__theHuntState` in the console.

## Playtest analytics (added 2026-10-06)

`js/analytics.js` logs the GDD §50 success metrics locally so every
playtest produces numbers. Nothing is sent anywhere and **no coordinates
are recorded** — only distances, durations, counts and species/behaviour
labels (stored in localStorage under `thehunt_analytics_v1`, last 200
sessions).

**What's logged**

- *Session*: start/end, time to first GPS fix, time to first capture,
  distance walked, foreground play time, time per screen, terrain status,
  day/night. Returning after 30+ min in the background starts a new session.
- *Hunt* (one per signal): species, rarity, behaviour, habitat, distance
  when detected, who picked it (`player` tap vs `auto` nearest-after-capture),
  active tracking time, metres walked while tracking, closest approach,
  when it first reached very-close / capture range, runner escapes, hider
  vanishes, and the outcome (`captured`, `faded`, `dawn`, `session-ended`).
- *Abandonment*: a tracked hunt that never got captured is bucketed by the
  closest band the player reached (>150m, ≤150, ≤80, ≤30, ≤20, ≤12m) — that's
  "where players give up".

**Getting the data out:** Journal tab → *Playtest Data* card shows headline
numbers and the abandonment histogram; **Export Playtest Data (.json)**
downloads a `summary` block (capture rates, median hunt time, distance per
session, captures/hour, breakdowns by behaviour/rarity/species, screen time)
plus every raw session, and the current tuning values from `config.js` so
exports from different tuning passes can be compared. **Reset playtest
data** (tap twice) clears it before a fresh round of tests.

Hunts that are still open don't appear in the abandonment chart until they
end (capture, fade, or the session closing — including the app being
killed, which is detected on next launch).

With `?debug=1`, `window.__theHuntAnalytics.summary()` is available in the
console.

## Spawning & the Search stage (updated 2026-10-07)

Changes from the first outdoor playtest (0 captures in 24 min):

- **Spawn range 40–450m** (measured to the creature itself).
- **First signal of every session is within ~25–50m** (never a legendary).
  If there's no safe spot that close, the ring widens to 80m, then 150m.
- **Field upkeep while walking** (checked every 5s): signals more than
  **500m** away are removed (logged as `left-behind`), and there are always
  **1–2 signals within 150m** — if none are, 1–2 new ones spawn 40–150m
  away (the furthest untracked signal makes room if the list is full).
- **Signals survive restarts for 30 minutes** (`thehunt_active_signals_v1`
  in localStorage, including the one you were tracking). Older saves, expired
  legendaries, night creatures after dawn and anything now >500m away are
  dropped. These are creature positions only, on the device only.
- **Search stage (GDD §3)** — new `js/search.js`. Inside the 35m search area:
  - "IN THE SEARCH AREA" toast + vibration on entry.
  - Hot/cold replaces exact metres and bearing (WARM → HOT → BURNING HOT →
    RIGHT HERE). Pulses (vibration + a ring on the radar) speed up from
    every ~1.6s at 35m to ~0.25s at capture range.
  - "❄ COLDER" warning (long buzz) when you move ~4m+ further away
    (smoothed so GPS jitter doesn't trigger it); "you left the search area"
    beyond 45m.
  - Set `searchHideDistance: false` in `config.js` to keep showing metres.
- Analytics: hunts now log `enteredSearchAreaAt`, `searchEntries`,
  `colderWarnings`; the summary has a `searchStage` block and
  `signalsLeftBehind`.

All tunables are in `js/config.js`. Service-worker cache v11.
