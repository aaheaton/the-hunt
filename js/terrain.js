// Real-world terrain for spawning (GDD §11 Real-World Locations, §26 Safety).
//
// Pulls parks, woodland, water, footpaths, roads, railways and no-go areas
// around the player from OpenStreetMap via the Overpass API, then answers two
// questions for the spawner and the creature behaviours:
//
//   1. Is this spot SAFE?   - on a public footpath / pedestrian area or inside
//                              a public green space, NOT in water, NOT within a
//                              buffer of a road or railway, NOT inside a no-go
//                              area (schools, playgrounds, cemeteries, golf
//                              courses, industrial/military/construction sites,
//                              anything tagged access=private).
//   2. Does it match a HABITAT? - trees (park / wood), water (a walkable bank
//                              near a river, lake or canal), urban (a footpath
//                              outside green space).
//
// Safety works as an allow-list: a creature can only ever sit somewhere a
// pedestrian is expected to be, so private gardens, building interiors and
// road carriageways are never candidates in the first place.
//
// All geometry is projected to a flat local metre grid around the fetch
// centre (equirectangular — accurate to a few cm over a 1km area), which keeps
// the maths simple and fast enough to run hundreds of checks per tick.

import { CONFIG } from './config.js';
import { angleDiff, bearingDeg } from './geo.js';

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/* ------------------------------------------------------------------ */
/* Tag classification                                                   */
/* ------------------------------------------------------------------ */

const GREEN = {
  leisure: ['park', 'nature_reserve', 'common', 'recreation_ground', 'dog_park'],
  landuse: ['forest', 'meadow', 'village_green', 'recreation_ground'],
  natural: ['wood', 'scrub', 'heath', 'grassland'],
};
const WOODED = { landuse: ['forest'], natural: ['wood', 'scrub'], leisure: ['nature_reserve'] };
const NO_GO = {
  amenity: ['school', 'kindergarten', 'childcare', 'college', 'grave_yard', 'prison'],
  leisure: ['playground', 'golf_course', 'schoolyard'],
  landuse: ['cemetery', 'military', 'construction', 'railway', 'industrial'],
};
const WATER_AREA = { natural: ['water'], waterway: ['riverbank'], landuse: ['reservoir'] };
const WATER_LINE_MIN_M = { river: 8, canal: 6, stream: 2 }; // keep off the water itself
const WALK = ['footway', 'path', 'pedestrian', 'cycleway', 'bridleway', 'track', 'living_street'];
// Buffer (m) from a road's centreline that a creature must stay outside of.
const ROAD_BUFFER_M = {
  motorway: 30, motorway_link: 25, trunk: 22, trunk_link: 18,
  primary: 14, primary_link: 12, secondary: 11, secondary_link: 10,
  tertiary: 9, tertiary_link: 8, unclassified: 6, residential: 6, service: 4,
};
const RAIL_BUFFER_M = { rail: 15, light_rail: 12, narrow_gauge: 10, subway: 15, tram: 6 };

function matches(tags, table) {
  for (const k in table) if (tags[k] && table[k].includes(tags[k])) return true;
  return false;
}
function isPrivate(tags) {
  return ['private', 'no'].includes(tags.access) || ['private', 'no'].includes(tags.foot);
}
function underground(tags) {
  return tags.tunnel === 'yes' || tags.tunnel === 'culvert' || tags.indoor === 'yes' ||
    (tags.layer && Number(tags.layer) < 0);
}

/* ------------------------------------------------------------------ */
/* Local metre projection + geometry helpers                            */
/* ------------------------------------------------------------------ */

function makeProjection(center) {
  const kx = 111320 * Math.cos((center.lat * Math.PI) / 180);
  const ky = 110540;
  return {
    toXY: (lat, lng) => [(lng - center.lng) * kx, (lat - center.lat) * ky],
    toLL: (x, y) => ({ lat: center.lat + y / ky, lng: center.lng + x / kx }),
  };
}

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function ringBBox(ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return Math.abs(a / 2);
}

function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return { d: Math.hypot(px - cx, py - cy), cx, cy };
}

/** Polygon = { outer: ring[], inner: ring[], bbox, area, ...data } */
function makePolygon(outer, inner, data) {
  const bbox = outer.map(ringBBox).reduce((a, b) => ({
    minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY),
  }));
  const area = outer.reduce((s, r) => s + ringArea(r), 0) - inner.reduce((s, r) => s + ringArea(r), 0);
  return { outer, inner, bbox, area, ...data };
}

function inPolygon(x, y, poly) {
  const b = poly.bbox;
  if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY) return false;
  if (!poly.outer.some((r) => pointInRing(x, y, r))) return false;
  return !poly.inner.some((r) => pointInRing(x, y, r));
}

/** Join relation member ways into closed rings (greedy endpoint matching). */
function assembleRings(lines) {
  const pending = lines.filter((l) => l.length >= 2).map((l) => l.slice());
  const rings = [];
  const same = (a, b) => Math.abs(a[0] - b[0]) < 0.5 && Math.abs(a[1] - b[1]) < 0.5;
  while (pending.length) {
    let ring = pending.shift();
    let grew = true;
    while (!same(ring[0], ring[ring.length - 1]) && grew) {
      grew = false;
      const end = ring[ring.length - 1];
      for (let i = 0; i < pending.length; i++) {
        const l = pending[i];
        if (same(l[0], end)) ring = ring.concat(l.slice(1));
        else if (same(l[l.length - 1], end)) ring = ring.concat(l.slice().reverse().slice(1));
        else continue;
        pending.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (ring.length >= 4) rings.push(ring);
  }
  return rings;
}

/** Simple spatial hash for line segments so "what's near this point?" is cheap. */
class SegmentIndex {
  constructor(cell = 60) {
    this.cell = cell;
    this.cells = new Map();
    this.segs = [];
    this.totalLength = 0;
  }
  add(x1, y1, x2, y2, data = {}) {
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < 0.01) return;
    const seg = { x1, y1, x2, y2, len, ...data };
    this.segs.push(seg);
    this.totalLength += len;
    const c = this.cell;
    const i0 = Math.floor(Math.min(x1, x2) / c), i1 = Math.floor(Math.max(x1, x2) / c);
    const j0 = Math.floor(Math.min(y1, y2) / c), j1 = Math.floor(Math.max(y1, y2) / c);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const k = `${i},${j}`;
      if (!this.cells.has(k)) this.cells.set(k, []);
      this.cells.get(k).push(seg);
    }
  }
  addLine(points, data) {
    for (let i = 1; i < points.length; i++) {
      this.add(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1], data);
    }
  }
  /** Segments whose cells overlap a square of half-size r around (x,y). */
  near(x, y, r) {
    const c = this.cell;
    const out = new Set();
    for (let i = Math.floor((x - r) / c); i <= Math.floor((x + r) / c); i++) {
      for (let j = Math.floor((y - r) / c); j <= Math.floor((y + r) / c); j++) {
        const list = this.cells.get(`${i},${j}`);
        if (list) for (const s of list) out.add(s);
      }
    }
    return out;
  }
  /** Nearest segment within r: { d, cx, cy, seg } or null. */
  nearest(x, y, r) {
    let best = null;
    for (const s of this.near(x, y, r)) {
      const res = segDist(x, y, s.x1, s.y1, s.x2, s.y2);
      if (res.d <= r && (!best || res.d < best.d)) best = { ...res, seg: s };
    }
    return best;
  }
}

/* ------------------------------------------------------------------ */
/* Parsing an Overpass response                                         */
/* ------------------------------------------------------------------ */

function buildTerrain(json, center) {
  const proj = makeProjection(center);
  const t = {
    center,
    proj,
    green: [],
    plazas: [],
    noGo: [],
    waterAreas: [],
    walk: new SegmentIndex(),
    roads: new SegmentIndex(),
    rails: new SegmentIndex(),
    waterEdges: new SegmentIndex(),
    counts: {},
  };

  const geomToXY = (geometry) => (geometry || []).filter(Boolean).map((g) => proj.toXY(g.lat, g.lon));

  for (const el of json.elements || []) {
    const tags = el.tags || {};
    let outer = [];
    let inner = [];
    let line = null;

    if (el.type === 'way') {
      line = geomToXY(el.geometry);
      if (line.length < 2) continue;
      const closed = line.length >= 4 &&
        Math.abs(line[0][0] - line[line.length - 1][0]) < 0.01 &&
        Math.abs(line[0][1] - line[line.length - 1][1]) < 0.01;
      if (closed) outer = [line];
    } else if (el.type === 'relation') {
      const members = (el.members || []).filter((m) => m.type === 'way' && m.geometry);
      outer = assembleRings(members.filter((m) => m.role !== 'inner').map((m) => geomToXY(m.geometry)));
      inner = assembleRings(members.filter((m) => m.role === 'inner').map((m) => geomToXY(m.geometry)));
      if (!outer.length) continue;
    } else {
      continue;
    }

    // --- Areas ---
    if (outer.length) {
      if (matches(tags, NO_GO) || (isPrivate(tags) && (matches(tags, GREEN) || tags.leisure || tags.landuse))) {
        t.noGo.push(makePolygon(outer, inner, {}));
        continue;
      }
      if (matches(tags, GREEN)) {
        const poly = makePolygon(outer, inner, { wooded: matches(tags, WOODED) });
        if (poly.area >= CONFIG.terrainMinGreenAreaM2) t.green.push(poly);
        continue;
      }
      if (matches(tags, WATER_AREA)) {
        t.waterAreas.push(makePolygon(outer, inner, {}));
        for (const r of [...outer, ...inner]) t.waterEdges.addLine(r, { minD: 3 });
        continue;
      }
      if (tags.highway === 'pedestrian' && tags.area === 'yes' && !isPrivate(tags)) {
        t.plazas.push(makePolygon(outer, inner, {}));
        continue;
      }
    }

    if (!line) continue;

    // --- Lines ---
    if (tags.waterway && WATER_LINE_MIN_M[tags.waterway] != null && !underground(tags)) {
      t.waterEdges.addLine(line, { minD: WATER_LINE_MIN_M[tags.waterway] });
    } else if (tags.highway && WALK.includes(tags.highway) && !isPrivate(tags) && !underground(tags) && tags.area !== 'yes') {
      t.walk.addLine(line, {});
    } else if (tags.highway && ROAD_BUFFER_M[tags.highway] != null && !underground(tags)) {
      t.roads.addLine(line, { buf: ROAD_BUFFER_M[tags.highway] });
    } else if (tags.railway && RAIL_BUFFER_M[tags.railway] != null && !underground(tags)) {
      t.rails.addLine(line, { buf: RAIL_BUFFER_M[tags.railway] });
    }
  }

  t.counts = {
    green: t.green.length,
    plazas: t.plazas.length,
    noGo: t.noGo.length,
    waterAreas: t.waterAreas.length,
    waterEdges: t.waterEdges.segs.length,
    walkSegments: t.walk.segs.length,
    roadSegments: t.roads.segs.length,
    railSegments: t.rails.segs.length,
  };
  return t;
}

/* ------------------------------------------------------------------ */
/* Fetching                                                             */
/* ------------------------------------------------------------------ */

let current = null;      // the terrain in use
let status = 'idle';     // idle | loading | ready | failed
let inflight = null;
let lastFailAt = 0;

function overpassQuery(pos, r) {
  const A = `(around:${r},${pos.lat.toFixed(6)},${pos.lng.toFixed(6)})`;
  return `[out:json][timeout:25];
(
  way["leisure"~"^(park|nature_reserve|common|recreation_ground|dog_park|playground|golf_course|schoolyard)$"]${A};
  relation["leisure"~"^(park|nature_reserve|common|recreation_ground|golf_course)$"]${A};
  way["landuse"~"^(forest|meadow|village_green|recreation_ground|cemetery|military|construction|railway|industrial|reservoir)$"]${A};
  relation["landuse"~"^(forest|meadow|recreation_ground|cemetery|military|industrial|reservoir)$"]${A};
  way["natural"~"^(wood|scrub|heath|grassland|water)$"]${A};
  relation["natural"~"^(wood|scrub|heath|water)$"]${A};
  way["amenity"~"^(school|kindergarten|childcare|college|grave_yard|prison)$"]${A};
  relation["amenity"~"^(school|college)$"]${A};
  way["waterway"~"^(river|stream|canal|riverbank)$"]${A};
  way["highway"]${A};
  way["railway"~"^(rail|light_rail|subway|narrow_gauge|tram)$"]${A};
);
out geom qt;`;
}

async function fetchOverpass(pos) {
  const body = 'data=' + encodeURIComponent(overpassQuery(pos, CONFIG.terrainRadiusM));
  let lastErr;
  for (const url of OVERPASS_ENDPOINTS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CONFIG.terrainTimeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('Overpass unavailable');
}

function distFromCenter(pos, center) {
  const p = makeProjection(center).toXY(pos.lat, pos.lng);
  return Math.hypot(p[0], p[1]);
}

/**
 * Make sure terrain covering `pos` is loaded. Resolves to the status string.
 * Cheap to call every GPS update: only refetches once the player has moved
 * CONFIG.terrainRefetchM from the last fetch centre, and keeps using the old
 * terrain while a refresh is in flight.
 */
export function ensureTerrain(pos) {
  if (!pos) return Promise.resolve(status);
  if (current && distFromCenter(pos, current.center) < CONFIG.terrainRefetchM) return Promise.resolve(status);
  if (inflight) return inflight;
  if (status === 'failed' && Date.now() - lastFailAt < CONFIG.terrainRetryMs) return Promise.resolve(status);

  if (!current) status = 'loading';
  // Only a ~100m-rounded location is ever sent to the Overpass server
  // (GDD §39 privacy) — the 800m fetch radius easily absorbs the rounding.
  const center = { lat: Math.round(pos.lat * 1000) / 1000, lng: Math.round(pos.lng * 1000) / 1000 };
  inflight = fetchOverpass(center)
    .then((json) => {
      current = buildTerrain(json, center);
      status = 'ready';
      console.info('[terrain] loaded', current.counts);
      return status;
    })
    .catch((err) => {
      console.warn('[terrain] failed to load OSM data', err);
      lastFailAt = Date.now();
      if (!current) status = 'failed';
      return status;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

export function terrainStatus() {
  return status;
}

/** For tests / debugging. */
export function terrainCounts() {
  return current ? current.counts : null;
}

/* ------------------------------------------------------------------ */
/* Spot checks                                                          */
/* ------------------------------------------------------------------ */

function insideAny(x, y, polys) {
  return polys.some((p) => inPolygon(x, y, p));
}

function clearOf(index, x, y) {
  for (const s of index.near(x, y, 35)) {
    if (segDist(x, y, s.x1, s.y1, s.x2, s.y2).d < s.buf) return false;
  }
  return true;
}

function nearWalk(t, x, y, r = CONFIG.terrainPathSnapM) {
  return !!t.walk.nearest(x, y, r);
}

function walkable(t, x, y) {
  return insideAny(x, y, t.green) || insideAny(x, y, t.plazas) || nearWalk(t, x, y);
}

function safeXY(t, x, y) {
  return (
    walkable(t, x, y) &&
    !insideAny(x, y, t.waterAreas) &&
    !insideAny(x, y, t.noGo) &&
    clearOf(t.roads, x, y) &&
    clearOf(t.rails, x, y)
  );
}

/** Distance to the nearest water, honouring each edge's "stay this far off" margin. */
function waterOK(t, x, y) {
  let ok = false;
  for (const s of t.waterEdges.near(x, y, CONFIG.terrainWaterBandM)) {
    const d = segDist(x, y, s.x1, s.y1, s.x2, s.y2).d;
    if (d < s.minD) return false;           // that's in the river, not on the bank
    if (d <= CONFIG.terrainWaterBandM) ok = true;
  }
  return ok;
}

function habitatXY(t, x, y, habitat) {
  switch (habitat) {
    case 'trees': return insideAny(x, y, t.green);
    case 'woods': return t.green.some((p) => p.wooded && inPolygon(x, y, p));
    case 'water': return waterOK(t, x, y);
    case 'urban': return (nearWalk(t, x, y) && !insideAny(x, y, t.green)) || insideAny(x, y, t.plazas);
    default: return true;
  }
}

/** Is a lat/lng a safe, public, walkable spot? (true when terrain isn't available) */
export function isSafeSpot(pos) {
  if (!current) return true;
  const [x, y] = current.proj.toXY(pos.lat, pos.lng);
  return safeXY(current, x, y);
}

/* ------------------------------------------------------------------ */
/* Sampling                                                             */
/* ------------------------------------------------------------------ */

function pickWeighted(items, weightFn) {
  const total = items.reduce((s, it) => s + weightFn(it), 0);
  let r = Math.random() * total;
  for (const it of items) {
    r -= weightFn(it);
    if (r <= 0) return it;
  }
  return items[items.length - 1];
}

/** Random candidate point for a habitat, roughly within maxD of (px,py). */
function candidateFor(t, habitat, px, py, maxD) {
  const reach = (b) => b.maxX >= px - maxD && b.minX <= px + maxD && b.maxY >= py - maxD && b.minY <= py + maxD;

  if (habitat === 'trees' || habitat === 'woods') {
    const polys = t.green.filter((p) => reach(p.bbox) && (habitat === 'trees' || p.wooded));
    if (!polys.length) return null;
    const p = pickWeighted(polys, (q) => Math.sqrt(q.area));
    const b = p.bbox;
    for (let i = 0; i < 12; i++) {
      const x = b.minX + Math.random() * (b.maxX - b.minX);
      const y = b.minY + Math.random() * (b.maxY - b.minY);
      if (inPolygon(x, y, p)) return [x, y];
    }
    return null;
  }

  if (habitat === 'water') {
    const segs = [...t.waterEdges.near(px, py, maxD)];
    if (!segs.length) return null;
    const s = pickWeighted(segs, (q) => q.len);
    const u = Math.random();
    const bx = s.x1 + u * (s.x2 - s.x1), by = s.y1 + u * (s.y2 - s.y1);
    const nx = -(s.y2 - s.y1) / s.len, ny = (s.x2 - s.x1) / s.len;
    const side = Math.random() < 0.5 ? -1 : 1;
    const off = s.minD + 2 + Math.random() * (CONFIG.terrainWaterBandM - s.minD - 2);
    let x = bx + side * nx * off, y = by + side * ny * off;
    // Banks are often only walkable along a towpath — snap onto one if close.
    if (!walkable(t, x, y)) {
      const snap = t.walk.nearest(x, y, 20);
      if (snap) { x = snap.cx; y = snap.cy; }
    }
    return [x, y];
  }

  // urban / any: a random point along a public path.
  const segs = [...t.walk.near(px, py, maxD)];
  if (!segs.length) return null;
  const s = pickWeighted(segs, (q) => q.len);
  const u = Math.random();
  return [s.x1 + u * (s.x2 - s.x1), s.y1 + u * (s.y2 - s.y1)];
}

/**
 * Find a safe spawn point between minD and maxD from the player that matches
 * one of `habitats` (tried in order). Returns { lat, lng, habitat } or null.
 * Returns undefined when terrain isn't loaded (caller falls back to random).
 */
export function findSpawnPoint(playerPos, habitats, minD, maxD, tries = CONFIG.terrainSpawnTries, cone = null) {
  if (!current) return undefined;
  const t = current;
  const [px, py] = t.proj.toXY(playerPos.lat, playerPos.lng);
  // Optional facing cone { centerDeg, halfDeg } — compass bearings, 0 = N.
  // Rejection-sampled, so give it proportionally more attempts.
  if (cone) tries = Math.ceil(tries * Math.min(8, 180 / Math.max(5, cone.halfDeg)));
  for (const habitat of habitats) {
    for (let i = 0; i < tries; i++) {
      const c = candidateFor(t, habitat, px, py, maxD);
      if (!c) break; // nothing of this habitat nearby at all
      const [x, y] = c;
      const d = Math.hypot(x - px, y - py);
      if (d < minD || d > maxD) continue;
      if (!safeXY(t, x, y) || !habitatXY(t, x, y, habitat)) continue;
      const ll = t.proj.toLL(x, y);
      if (cone && Math.abs(angleDiff(cone.centerDeg, bearingDeg(playerPos, ll))) > cone.halfDeg) continue;
      return { ...ll, habitat };
    }
  }
  return null;
}

/**
 * Find a safe point between minR and maxR from `center` — used for a
 * creature's true position inside its search zone, wander steps, a Runner's
 * escape and a Hider's reappearance.
 *
 * opts.habitat  keep to this habitat if possible (falls back to any safe spot)
 * opts.awayFrom {lat,lng} — prefer directions pointing away from this point
 * Returns { lat, lng } or null. Returns undefined when terrain isn't loaded.
 */
export function findPointNear(center, minR, maxR, opts = {}) {
  if (!current) return undefined;
  const t = current;
  const [cx, cy] = t.proj.toXY(center.lat, center.lng);
  let away = null;
  if (opts.awayFrom) {
    const [ax, ay] = t.proj.toXY(opts.awayFrom.lat, opts.awayFrom.lng);
    away = Math.atan2(cy - ay, cx - ax);
  }
  const passes = opts.habitat ? [opts.habitat, null] : [null];
  const tries = opts.tries || 40;

  for (const habitat of passes) {
    for (let i = 0; i < tries; i++) {
      const ang = away != null && i < tries * 0.75
        ? away + (Math.random() - 0.5) * (Math.PI * 2 / 3)   // ±60° of "away"
        : Math.random() * Math.PI * 2;
      const r = minR + Math.sqrt(Math.random()) * (maxR - minR);
      let x = cx + Math.cos(ang) * r, y = cy + Math.sin(ang) * r;
      if (!walkable(t, x, y)) {
        const snap = t.walk.nearest(x, y, 25);
        if (!snap) continue;
        x = snap.cx; y = snap.cy;
      }
      const d = Math.hypot(x - cx, y - cy);
      if (d < minR * 0.7 || d > maxR * 1.25) continue;
      if (!safeXY(t, x, y)) continue;
      if (habitat && !habitatXY(t, x, y, habitat)) continue;
      return t.proj.toLL(x, y);
    }
  }
  return null;
}

/** Which habitats have at least one candidate within maxD (for species filtering). */
export function habitatsNear(playerPos, maxD) {
  if (!current) return null;
  const t = current;
  const [px, py] = t.proj.toXY(playerPos.lat, playerPos.lng);
  const reach = (b) => b.maxX >= px - maxD && b.minX <= px + maxD && b.maxY >= py - maxD && b.minY <= py + maxD;
  return {
    trees: t.green.some((p) => reach(p.bbox)),
    woods: t.green.some((p) => p.wooded && reach(p.bbox)),
    water: t.waterEdges.near(px, py, maxD).size > 0,
    urban: t.walk.near(px, py, maxD).size > 0,
    any: t.walk.near(px, py, maxD).size > 0 || t.green.some((p) => reach(p.bbox)),
  };
}

// Exposed for unit tests only.
export const __test = { buildTerrain, setTerrain: (json, center) => { current = buildTerrain(json, center); status = 'ready'; } };
