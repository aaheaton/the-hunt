// Live street map for the Map screen (Leaflet + dark CARTO/OpenStreetMap
// tiles). Shows the player's real GPS position, accuracy, heading cone,
// scanner range ring and active signal zones on top of real streets.
//
// Leaflet is loaded as a classic <script> (js/vendor/leaflet.js) and read
// from window.L, so the app keeps working as a plain static PWA.

import { CONFIG } from './config.js';

const TILE_URL =
  'https://basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}{r}.png' +
  (CONFIG.cartoApiKey ? `?key=${encodeURIComponent(CONFIG.cartoApiKey)}` : '');
const TILE_ATTRIB =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';

let map = null;
let rotatorEl = null;
let playerMarker = null;
let accuracyCircle = null;
let rangeRing = null;
const signalLayers = new Map(); // sig.id -> { zone, core, dot, beacon? }
const hiddenState = new Map();  // sig.id -> bool (last rendered hidden state)
let following = true; // auto-pan to the player until they drag the map
let lastSize = '';

function ensureMap() {
  if (map) return map;
  const L = window.L;
  if (!L) return null;

  rotatorEl = document.getElementById('map-rotator');
  map = L.map('map-live', {
    zoomControl: false,
    attributionControl: true,
    zoomSnap: 0,
    zoomDelta: 0.5,
    maxZoom: 20,
    minZoom: 12,
  });
  map.attributionControl.setPrefix(false);
  L.tileLayer(TILE_URL, { attribution: TILE_ATTRIB, maxZoom: 20 }).addTo(map);

  map.on('dragstart', () => { following = false; });

  rangeRing = L.circle([0, 0], {
    radius: CONFIG.scannerRangeM,
    color: '#00E5FF', weight: 1.2, opacity: 0.45, dashArray: '4 6',
    fill: false, interactive: false,
  }).addTo(map);

  accuracyCircle = L.circle([0, 0], {
    radius: 10, color: '#00E5FF', weight: 0.8, opacity: 0.5,
    fillColor: '#00E5FF', fillOpacity: 0.08, interactive: false,
  }).addTo(map);

  playerMarker = L.marker([0, 0], {
    interactive: false,
    keyboard: false,
    zIndexOffset: 1000,
    icon: L.divIcon({
      className: 'player-marker',
      iconSize: [80, 80],
      iconAnchor: [40, 40],
      html: `
        <div class="pm-cone" id="pm-cone"></div>
        <div class="pm-pulse"></div>
        <div class="pm-dot"></div>
        <div class="pm-label">YOU</div>`,
    }),
  }).addTo(map);

  return map;
}

/** Zoom level at which the scanner range ring fills ~45% of the viewport. */
function zoomForRange(lat) {
  const vp = document.getElementById('map-viewport');
  const minDim = Math.max(200, Math.min(vp.clientWidth, vp.clientHeight));
  const metresPerPx = CONFIG.scannerRangeM / (0.45 * minDim);
  return Math.log2((156543.03392 * Math.cos((lat * Math.PI) / 180)) / metresPerPx);
}

/** Snap back to the player and resume following. */
export function recenterLiveMap(playerPos) {
  following = true;
  if (map && playerPos) map.setView([playerPos.lat, playerPos.lng], zoomForRange(playerPos.lat), { animate: true });
}

/**
 * Draw / update the live map.
 * @param {Array} signals    visible signals (already filtered), with _distanceM
 * @param {object} playerPos {lat,lng,accuracy}
 * @param {number} heading   compass heading 0-360
 * @param {boolean} northUp  false = rotate the map so heading points up
 * @param {(rarity:string)=>string} colorFor
 */
export function renderLiveMap(signals, playerPos, heading, northUp, colorFor) {
  const m = ensureMap();
  const offline = document.getElementById('map-offline-note');
  if (!m) {
    offline?.classList.remove('hidden');
    return;
  }
  offline?.classList.add('hidden');

  // Leaflet can't measure a hidden container, so re-measure whenever the
  // Map screen becomes visible / changes size.
  const vp = document.getElementById('map-viewport');
  const size = `${vp.clientWidth}x${vp.clientHeight}`;
  const firstLayout = lastSize === '' && vp.clientWidth > 0;
  if (size !== lastSize && vp.clientWidth > 0) {
    m.invalidateSize(false);
    lastSize = size;
  }

  if (!playerPos) return;
  const ll = [playerPos.lat, playerPos.lng];

  // Heading-up mode rotates the (oversized) map layer; dragging a rotated
  // Leaflet map feels wrong, so it's locked to the player in that mode.
  const h = heading || 0;
  rotatorEl.style.transform = northUp ? 'none' : `rotate(${-h}deg)`;
  if (northUp) m.dragging.enable();
  else { m.dragging.disable(); following = true; }

  if (firstLayout) {
    m.setView(ll, zoomForRange(playerPos.lat), { animate: false });
  } else if (following) {
    m.panTo(ll, { animate: true, duration: 0.6 });
  }

  playerMarker.setLatLng(ll);
  rangeRing.setLatLng(ll);
  accuracyCircle.setLatLng(ll);
  accuracyCircle.setRadius(Math.max(3, playerPos.accuracy || 0));
  const cone = document.getElementById('pm-cone');
  // The cone lives inside the map layer, so a map-relative rotation of
  // `heading` is correct in both north-up and heading-up modes.
  if (cone) cone.style.transform = `rotate(${h}deg)`;

  // Signal zones: update in place, add new, remove stale.
  const L = window.L;
  const seen = new Set();
  for (const sig of signals) {
    seen.add(sig.id);
    const color = colorFor(sig._rarity);
    const p = [sig.pos.lat, sig.pos.lng];
    let layers = signalLayers.get(sig.id);
    if (!layers) {
      const leg = sig.legendary ? ' zone-legendary' : '';
      layers = {
        zone: L.circle(p, { radius: CONFIG.searchZoneRadiusM, color, weight: sig.legendary ? 2 : 1.2, opacity: 0.6, dashArray: '3 4', fillColor: color, fillOpacity: 0.1, className: 'sig-zone' + leg }),
        core: L.circle(p, { radius: CONFIG.searchZoneRadiusM * 0.4, stroke: false, fillColor: color, fillOpacity: 0.2, interactive: false, className: 'sig-core' + leg }),
        dot: L.circleMarker(p, { radius: sig.legendary ? 7 : 5, stroke: false, fillColor: color, fillOpacity: 1, className: 'sig-dot' + leg }),
      };
      if (sig.legendary) {
        // Expanding beacon rings so a legendary signal reads as an event.
        layers.beacon = L.circle(p, { radius: CONFIG.searchZoneRadiusM * 2.2, color, weight: 2, opacity: 0.9, fill: false, interactive: false, className: 'sig-beacon' });
      }
      const select = () => window.__theHuntSelectSignal?.(sig.id, true);
      layers.zone.on('click', select);
      layers.dot.on('click', select);
      Object.values(layers).forEach((l) => l.addTo(m));
      signalLayers.set(sig.id, layers);
    } else {
      Object.values(layers).forEach((l) => l.setLatLng(p));
    }
    // A hiding creature drops off the scanner: fade its zone, hide its dot.
    const hidden = !!sig._hidden;
    if (hiddenState.get(sig.id) !== hidden) {
      hiddenState.set(sig.id, hidden);
      layers.zone.setStyle({ opacity: hidden ? 0.2 : 0.6, fillOpacity: hidden ? 0.03 : 0.1 });
      layers.core.setStyle({ fillOpacity: hidden ? 0 : 0.2 });
      layers.dot.setStyle({ fillOpacity: hidden ? 0 : 1 });
      if (layers.beacon) layers.beacon.setStyle({ opacity: hidden ? 0 : 0.9 });
    }
  }
  for (const [id, layers] of signalLayers) {
    if (!seen.has(id)) {
      Object.values(layers).forEach((l) => l.remove());
      signalLayers.delete(id);
      hiddenState.delete(id);
    }
  }
}
