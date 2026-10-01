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

Real map tiles/POI data, true AR anchoring (this uses camera passthrough
+ a screen-space reticle, not spatial tracking), a real backend/spawn
engine, accounts, trading, evolution, weather/social/legendary behaviors,
multiplayer. See GDD §49 "Product Development Roadmap" for the intended
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
js/spawner.js        signal creation, wander drift, respawn-to-fill logic
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
on-device — nothing is uploaded anywhere in this prototype.

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
