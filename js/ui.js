// All DOM rendering + screen switching lives here. app.js owns game state
// and calls into these functions; nothing in here mutates game state.

import { CONFIG } from './config.js';
import { RARITY, SPECIES, speciesById, formFor, maxStage } from './characters.js';
import { getCollection, getJournal, hunterLevel, totalDiscoveredSpeciesCount, evolutionStatus } from './storage.js';

const screens = {
  safety: document.getElementById('screen-safety'),
  scanner: document.getElementById('screen-scanner'),
  map: document.getElementById('screen-map'),
  capture: document.getElementById('screen-capture'),
  journal: document.getElementById('screen-journal'),
};

const RARITY_SYMBOL = { common: '●', uncommon: '◆', rare: '❖', epic: '▲', legendary: '★' };
const BEHAVIOR_LABEL = { stationary: 'STATIONARY // HOLDING POSITION', wanderer: 'WANDERER // MOVING SLOWLY' };
const HABITAT_LABEL = {
  trees: 'Prefers dense canopy & large trees',
  urban: 'Prefers built-up, populated areas',
  water: 'Stays close to rivers, lakes & canals',
  night: 'More active after dusk',
};

function rarityVar(rarity) {
  return `var(--rarity-${rarity})`;
}

export function rarityClass(rarity) {
  return `badge-${rarity}`;
}

/* ------------------------------------------------------------------ */
/* Screen switching / nav / header                                     */
/* ------------------------------------------------------------------ */

export function showScreen(name) {
  for (const key of Object.keys(screens)) {
    screens[key].classList.toggle('active', key === name);
  }
  const isSafety = name === 'safety';
  document.getElementById('app-header').classList.toggle('hidden', isSafety);
  document.getElementById('app-nav').classList.toggle('hidden', isSafety);
  if (!isSafety) {
    document.querySelectorAll('.nav-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.screen === name);
    });
  }
}

export function initSafetyBox() {
  const items = [
    'Stay aware of your surroundings — look up, not just at your screen.',
    'Only explore public, safe areas. Never trespass or enter private property.',
    'Watch for traffic. Never cross roads while looking at the phone.',
    'Everything here runs on this device only — nothing is uploaded anywhere.',
  ];
  const box = document.getElementById('safety-box');
  box.innerHTML = items
    .map(
      (t) => `<div class="item"><svg class="icon" viewBox="0 0 24 24" fill="none"><path d="M20 6 9 17l-5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><span>${t}</span></div>`
    )
    .join('');
}

export function setPermissionStatus(text) {
  document.getElementById('permission-status').textContent = text;
}

export function renderHeader({ hasFix, activeCount, playerPos }) {
  document.getElementById('hdr-level').textContent = `LVL ${hunterLevel()}`;
  const dot = document.getElementById('hdr-gps-dot');
  const status = document.getElementById('hdr-status');
  dot.classList.toggle('warn', !hasFix);
  status.classList.toggle('warn', !hasFix);
  status.textContent = hasFix
    ? `GPS: LOCK • ${activeCount} ACTIVE SIGNAL${activeCount === 1 ? '' : 'S'}`
    : 'GPS: ACQUIRING…';

  const sectorEl = document.getElementById('hdr-sector');
  if (playerPos) {
    // A deterministic, stable "grid sector" label derived from real coordinates
    // (not a fake random tag) — purely flavour, never used for anything real.
    const gx = Math.floor(((playerPos.lng + 180) * 100) % 26);
    const gy = Math.floor(((playerPos.lat + 90) * 100) % 100);
    sectorEl.textContent = `GRID-${gy}${String.fromCharCode(65 + gx)}`;
  } else {
    sectorEl.textContent = '—';
  }
}

/* ------------------------------------------------------------------ */
/* Toast                                                                */
/* ------------------------------------------------------------------ */

export function showLookUpToast(show) {
  document.getElementById('lookup-toast').classList.toggle('hidden', !show);
}

/* ------------------------------------------------------------------ */
/* Scanner screen                                                       */
/* ------------------------------------------------------------------ */

function signalStrengthRatio(distanceM) {
  return Math.max(0, Math.min(1, 1 - distanceM / CONFIG.scannerRangeM));
}

export function renderScannerScreen(signals, currentId, heading) {
  const sorted = [...signals].sort((a, b) => a._distanceM - b._distanceM);
  const nearest = sorted[0];
  const current = signals.find((s) => s.id === currentId) || nearest || null;

  // --- Alert banner ---
  const headlineEl = document.getElementById('alert-headline');
  const subEl = document.getElementById('alert-sub');
  const rangeEl = document.getElementById('alert-range');
  const freqEl = document.getElementById('alert-freq');
  if (current) {
    const species = speciesById(current.speciesId);
    headlineEl.textContent = current.revealedClues.length ? species.name.toUpperCase() : 'UNKNOWN SIGNAL DETECTED';
    subEl.textContent = 'Approx. vector triangulation active';
    const inRange = current._distanceM <= CONFIG.scannerRangeM;
    rangeEl.textContent = inRange ? '● IN RANGE' : '○ OUT OF RANGE';
    freqEl.textContent = `| FREQ: ${(100 + current._distanceM * 0.4).toFixed(1)} MHz`;
  } else {
    headlineEl.textContent = 'NO SIGNALS YET';
    subEl.textContent = 'Scanning for nearby activity…';
    rangeEl.textContent = '● SEARCHING';
    freqEl.textContent = '| FREQ: —';
  }

  const ratio = current ? signalStrengthRatio(current._distanceM) : 0;
  const segs = Math.round(ratio * 8);
  document.getElementById('gain-label').textContent = `SIGNAL GAIN [${Math.round(ratio * 100)}%]`;
  document.getElementById('gain-segs').textContent = `${segs} / 8 SEGMENTS`;
  document.getElementById('gain-meter').innerHTML = Array.from({ length: 8 })
    .map((_, i) => `<div class="seg${i < segs ? ' on' : ''}"></div>`)
    .join('');

  // --- Contact tabs ---
  document.getElementById('contacts-count').textContent = `${signals.length} ACTIVE`;
  const tabsEl = document.getElementById('contact-tabs');
  tabsEl.innerHTML = '';
  sorted.forEach((sig, i) => {
    const species = speciesById(sig.speciesId);
    const known = sig.revealedClues.length > 0;
    const btn = document.createElement('button');
    btn.className = 'contact-tab' + (sig.id === (current && current.id) ? ' active' : '');
    btn.innerHTML = `
      <div class="row1">
        <span class="sig-id" style="color:${rarityVar(species.rarity)}">SIG-${String.fromCharCode(65 + i)}</span>
        <span class="dot" style="background:${rarityVar(species.rarity)}"></span>
      </div>
      <div class="dist">${Math.round(sig._distanceM)}m</div>
      <div class="rarity-label" style="color:${rarityVar(species.rarity)}">${known ? species.name.toUpperCase() : RARITY[species.rarity].label.toUpperCase()}</div>
    `;
    btn.addEventListener('click', () => window.__theHuntSelectSignal?.(sig.id));
    tabsEl.appendChild(btn);
  });

  // --- Radar ---
  renderRadarBlips(signals, current, heading);
  document.getElementById('radar-bearing').textContent = current
    ? `BEARING: ${Math.round(current._bearingDeg)}°`
    : 'BEARING: —';
  document.getElementById('radar-distance').textContent = current ? `${Math.round(current._distanceM)}` : '—';
  document.getElementById('radar-radius').innerHTML = current
    ? `<strong>± ${CONFIG.searchZoneRadiusM}m</strong>`
    : '<strong>—</strong>';

  const statusEl = document.getElementById('scanner-status');
  if (!current) {
    statusEl.textContent = 'AWAITING GPS LOCK';
    statusEl.classList.remove('very-close');
  } else {
    const veryClose = current._distanceM <= CONFIG.veryCloseM;
    statusEl.textContent = veryClose ? '⚠ VERY CLOSE' : 'SIGNAL DETECTED';
    statusEl.classList.toggle('very-close', veryClose);
  }

  // --- Telemetry / clues ---
  const clueList = document.getElementById('clue-list');
  clueList.innerHTML = '';
  if (current) {
    const species = speciesById(current.speciesId);
    clueList.innerHTML += `
      <div class="telemetry-item">
        <div class="ti-icon"><svg class="icon" viewBox="0 0 24 24" fill="none"><path d="M13 4a5 5 0 1 0 0 10M13 4v10M13 4a5 5 0 1 1 0 10" stroke="currentColor" stroke-width="1.4"/></svg></div>
        <div><div class="ti-label">Movement Pattern</div><div class="ti-value">${BEHAVIOR_LABEL[current.behavior] || '—'}</div></div>
      </div>
      <div class="telemetry-item">
        <div class="ti-icon"><svg class="icon" viewBox="0 0 24 24" fill="none"><path d="M12 2 3 21h18L12 2Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg></div>
        <div><div class="ti-label">Habitat Correlation</div><div class="ti-value" style="white-space:normal;">${HABITAT_LABEL[species.habitat] || '—'}</div></div>
      </div>
    `;
    current.revealedClues.forEach((clue) => {
      clueList.innerHTML += `
        <div class="telemetry-item">
          <div class="ti-icon" style="color:var(--rarity-epic);"><svg class="icon" viewBox="0 0 24 24" fill="none"><path d="M12 2v4M12 18v4M2 12h4M18 12h4" stroke="currentColor" stroke-width="1.5"/></svg></div>
          <div><div class="ti-label">Sensor Clue</div><div class="ti-value" style="white-space:normal;">${clue}</div></div>
        </div>`;
    });
  } else {
    clueList.innerHTML = '<p class="muted" style="font-size:12px;margin:0;">No active contact selected.</p>';
  }

  // --- Goto-capture button ---
  const gotoBtn = document.getElementById('btn-goto-capture');
  const gotoLabel = document.getElementById('goto-capture-label');
  gotoBtn.disabled = !current;
  if (current) {
    const inCaptureRange = current._distanceM <= CONFIG.captureRangeM;
    gotoLabel.textContent = inCaptureRange ? 'Enter Capture Mode' : 'Get closer, then enter Capture Mode';
  } else {
    gotoLabel.textContent = 'No signal selected';
  }
}

function renderRadarBlips(signals, current, heading) {
  const layer = document.getElementById('radar-blip-layer');
  layer.innerHTML = '';
  const dialRadiusPx = 112; // matches the 240px dial's outer ring radius
  const centerPx = 120;
  const h = heading ?? 0;

  for (const sig of signals) {
    const relative = ((sig._bearingDeg - h + 360) % 360);
    const rad = (relative - 90) * (Math.PI / 180); // -90 so 0deg (ahead) points up
    const rPx = Math.min(dialRadiusPx - 14, (sig._distanceM / CONFIG.scannerRangeM) * dialRadiusPx);
    const x = centerPx + rPx * Math.cos(rad);
    const y = centerPx + rPx * Math.sin(rad);
    const species = speciesById(sig.speciesId);
    const isCurrent = current && sig.id === current.id;

    const el = document.createElement('div');
    el.className = 'radar-blip';
    el.style.left = `${(x / 240) * 100}%`;
    el.style.top = `${(y / 240) * 100}%`;
    el.style.color = rarityVar(species.rarity);
    el.innerHTML = `${isCurrent ? '<span class="ring1"></span>' : ''}<span class="ring2"></span><span class="core"></span>`;
    el.style.cursor = 'pointer';
    el.addEventListener('click', () => window.__theHuntSelectSignal?.(sig.id));
    layer.appendChild(el);
  }

  // Rotate the player arrow to reflect real compass heading (0 = pointing up/ahead).
  document.getElementById('radar-center-arrow').style.transform = 'rotate(0deg)';
}

/* ------------------------------------------------------------------ */
/* Map screen                                                          */
/* ------------------------------------------------------------------ */

let mapFilter = 'all';
let mapNorthUp = true;

export function setMapFilter(f) {
  mapFilter = f;
}
export function getMapFilter() {
  return mapFilter;
}
export function toggleMapOrientation() {
  mapNorthUp = !mapNorthUp;
  return mapNorthUp;
}
export function isMapNorthUp() {
  return mapNorthUp;
}

export function renderMapFilters() {
  const rarities = ['all', 'common', 'uncommon', 'rare', 'epic', 'legendary'];
  const row = document.getElementById('map-filters');
  row.innerHTML = rarities
    .map(
      (r) =>
        `<button class="filter-chip${r === mapFilter ? ' active' : ''}" data-filter="${r}">${r === 'all' ? 'ALL ZONES' : r}</button>`
    )
    .join('');
}

export function renderMap(signals, playerPos, heading, sessionDistanceM, lifetimeDistanceM) {
  const svg = document.getElementById('map-svg');
  const viewSize = 300;
  const center = viewSize / 2;
  const maxR = center - 20;
  const h = mapNorthUp ? 0 : heading || 0;

  const visible = signals.filter((s) => mapFilter === 'all' || speciesById(s.speciesId).rarity === mapFilter);

  let svgInner = `
    <rect width="${viewSize}" height="${viewSize}" fill="#0A0E14"/>
    <defs>
      <pattern id="tacgrid" width="30" height="30" patternUnits="userSpaceOnUse">
        <path d="M30 0 L0 0 0 30" fill="none" stroke="rgba(255,255,255,0.04)" stroke-width="1"/>
      </pattern>
    </defs>
    <rect width="${viewSize}" height="${viewSize}" fill="url(#tacgrid)"/>
    <circle cx="${center}" cy="${center}" r="${maxR}" fill="none" stroke="#262A31" stroke-width="1.5" stroke-dasharray="4 4"/>
    <circle cx="${center}" cy="${center}" r="${maxR * 0.66}" fill="none" stroke="#262A31" stroke-width="1"/>
    <circle cx="${center}" cy="${center}" r="${maxR * 0.33}" fill="none" stroke="#262A31" stroke-width="1" stroke-dasharray="2 4"/>
  `;

  for (const sig of visible) {
    const species = speciesById(sig.speciesId);
    const relative = ((sig._bearingDeg - h + 360) % 360);
    const rad = (relative - 90) * (Math.PI / 180);
    const rPx = Math.min(maxR - 10, (sig._distanceM / CONFIG.scannerRangeM) * maxR);
    const zonePxRadius = Math.max(10, (CONFIG.searchZoneRadiusM / CONFIG.scannerRangeM) * maxR);
    const x = center + rPx * Math.cos(rad);
    const y = center + rPx * Math.sin(rad);
    const color = getComputedColorForRarity(species.rarity);
    svgInner += `
      <circle cx="${x}" cy="${y}" r="${zonePxRadius}" fill="${color}" fill-opacity="0.08" stroke="${color}" stroke-opacity="0.55" stroke-dasharray="3 4"/>
      <circle cx="${x}" cy="${y}" r="${zonePxRadius * 0.4}" fill="${color}" fill-opacity="0.18"/>
      <circle cx="${x}" cy="${y}" r="5" fill="${color}"/>
    `;
  }

  // Player position + heading cone (always shown at true relative orientation).
  const coneAngle = mapNorthUp ? heading || 0 : 0;
  const coneRad = (coneAngle - 90) * (Math.PI / 180);
  const coneLen = 34;
  const cx1 = center + coneLen * Math.cos(coneRad - 0.35);
  const cy1 = center + coneLen * Math.sin(coneRad - 0.35);
  const cx2 = center + coneLen * Math.cos(coneRad + 0.35);
  const cy2 = center + coneLen * Math.sin(coneRad + 0.35);
  svgInner += `
    <path d="M ${center} ${center} L ${cx1} ${cy1} A ${coneLen} ${coneLen} 0 0 1 ${cx2} ${cy2} Z" fill="#00E5FF" fill-opacity="0.12"/>
    <circle cx="${center}" cy="${center}" r="10" fill="#00E5FF" fill-opacity="0.25">
      <animate attributeName="r" dur="2.4s" repeatCount="indefinite" values="6;16;6"/>
      <animate attributeName="opacity" dur="2.4s" repeatCount="indefinite" values="0.7;0.1;0.7"/>
    </circle>
    <circle cx="${center}" cy="${center}" r="5" fill="#00E5FF" stroke="#0A0E14" stroke-width="1.5"/>
  `;

  svg.innerHTML = svgInner;

  document.getElementById('map-signal-count').textContent = String(visible.length);
  document.getElementById('map-coords').textContent = playerPos
    ? `${playerPos.lat.toFixed(3)}, ${playerPos.lng.toFixed(3)}`
    : '—';
  document.getElementById('map-empty-note').classList.toggle('hidden', visible.length > 0);
  document.getElementById('map-north').classList.toggle('active', !mapNorthUp);

  // Zone cards for the 2 nearest visible signals.
  const cardsEl = document.getElementById('map-zone-cards');
  cardsEl.innerHTML = '';
  const nearest = [...visible].sort((a, b) => a._distanceM - b._distanceM).slice(0, 2);
  const positions = ['top:80px;left:10px;', 'bottom:52px;right:10px;'];
  nearest.forEach((sig, i) => {
    const species = speciesById(sig.speciesId);
    const card = document.createElement('div');
    card.className = 'map-zone-card';
    card.style.cssText = positions[i];
    card.innerHTML = `
      <div class="zc-top">
        <span class="zc-badge" style="background:rgba(255,255,255,0.08);color:${getComputedColorForRarity(species.rarity)}">${RARITY[species.rarity].label.toUpperCase()}</span>
      </div>
      <div class="zc-name">${sig.revealedClues.length ? species.name : 'Unknown Zone'}</div>
      <div class="zc-sub">${Math.round(sig._distanceM)}m • search radius ±${CONFIG.searchZoneRadiusM}m</div>
    `;
    card.addEventListener('click', () => window.__theHuntSelectSignal?.(sig.id, true));
    cardsEl.appendChild(card);
  });

  // Session stats.
  document.getElementById('stat-active').textContent = String(signals.length);
  document.getElementById('stat-distance').textContent = `${Math.round(sessionDistanceM || 0)}m`;
  document.getElementById('stat-lifetime').textContent = formatKm(lifetimeDistanceM || 0);

  const engageBtn = document.getElementById('map-engage-btn');
  const overallNearest = [...signals].sort((a, b) => a._distanceM - b._distanceM)[0];
  engageBtn.lastChild.textContent = overallNearest
    ? ` ENGAGE TACTICAL SCANNER [ ${Math.round(overallNearest._distanceM)}m CLOSEST ]`
    : ' ENGAGE TACTICAL SCANNER';
}

function formatKm(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${Math.round(m)}m`;
}

function getComputedColorForRarity(rarity) {
  return RARITY[rarity]?.color || '#8892a0';
}

/* ------------------------------------------------------------------ */
/* Capture / AR screen                                                  */
/* ------------------------------------------------------------------ */

export function renderCaptureScreen(sig, usingFallback) {
  const noTarget = document.getElementById('ar-no-target');
  const targetEl = document.getElementById('ar-target');
  const metaCard = document.getElementById('ar-meta-card');
  const captureBtn = document.getElementById('btn-capture');
  const captureLabel = document.getElementById('capture-btn-label');
  const proximityBanner = document.getElementById('ar-proximity-banner');

  if (!sig) {
    noTarget.classList.remove('hidden');
    targetEl.classList.add('hidden');
    metaCard.classList.add('hidden');
    captureBtn.disabled = true;
    captureLabel.textContent = 'No target selected';
    proximityBanner.classList.add('hidden');
    return;
  }

  noTarget.classList.add('hidden');
  targetEl.classList.remove('hidden');
  metaCard.classList.remove('hidden');

  const species = speciesById(sig.speciesId);
  document.getElementById('ar-target-glyph').textContent = RARITY_SYMBOL[species.rarity];
  document.getElementById('ar-target-glyph').style.color = rarityVar(species.rarity);
  // Illustrated species materialise as their art once the player is close
  // enough to see them; until then they stay an anonymous signal orb.
  const wildForm = formFor(species, 1);
  const artEl = document.getElementById('ar-target-art');
  const showArt = !!wildForm && sig._distanceM <= CONFIG.veryCloseM;
  targetEl.classList.toggle('has-art', showArt);
  if (showArt && artEl.getAttribute('src') !== wildForm.art) artEl.setAttribute('src', wildForm.art);
  document.getElementById('ar-meta-name').textContent = wildForm ? `${species.name} — ${wildForm.form}` : species.name;
  const rarityBadge = document.getElementById('ar-meta-rarity');
  rarityBadge.className = `badge ${rarityClass(species.rarity)}`;
  rarityBadge.textContent = `${RARITY_SYMBOL[species.rarity]} ${RARITY[species.rarity].label}`;
  document.getElementById('ar-meta-sub').textContent = `BEHAVIOUR: ${species.behavior.toUpperCase()} // HABITAT: ${species.habitat.toUpperCase()}`;

  const lockRatio = Math.max(0, Math.min(1, 1 - sig._distanceM / (CONFIG.captureRangeM * 3)));
  document.getElementById('ar-lock-readout').textContent = usingFallback
    ? `SONAR LOCK: ${Math.round(lockRatio * 100)}%`
    : `LOCK-ON: ${Math.round(lockRatio * 100)}%`;

  const veryClose = sig._distanceM <= CONFIG.veryCloseM;
  proximityBanner.classList.toggle('hidden', !veryClose);
  if (veryClose) {
    document.getElementById('ar-proximity-text').textContent = `TARGET VERY CLOSE — ${Math.round(sig._distanceM)} METRES`;
  }

  const inRange = sig._distanceM <= CONFIG.captureRangeM;
  captureBtn.disabled = !inRange;
  captureLabel.textContent = inRange ? 'Deploy Capture' : `Get closer (${Math.round(sig._distanceM)}m away)`;
}

export function setArFpsText(fps) {
  document.getElementById('ar-fps-chip').textContent = `FPS: ${fps}`;
}

export function showCaptureSuccessBanner(species, isFirst) {
  const banner = document.getElementById('capture-success-banner');
  document.getElementById('cs-tag').textContent = isFirst ? 'FIRST DISCOVERY!' : 'CONTAINMENT SYNCHRONIZED';
  document.getElementById('cs-name').textContent = `${species.name} Added to Journal`;
  document.getElementById('cs-sub').textContent = `${RARITY[species.rarity].label} specimen`;
  const form = formFor(species, 1);
  const icon = banner.querySelector('.cs-icon');
  icon.classList.toggle('has-art', !!form);
  icon.style.backgroundImage = form ? `url('${form.thumb}')` : '';
  icon.textContent = form ? '' : '✓';
  banner.classList.remove('hidden');
}

export function hideCaptureSuccessBanner() {
  document.getElementById('capture-success-banner').classList.add('hidden');
}

/* ------------------------------------------------------------------ */
/* Journal screen                                                       */
/* ------------------------------------------------------------------ */

export function renderJournal(onOpenSpecies) {
  const collection = getCollection();
  const discoveredCount = totalDiscoveredSpeciesCount();
  const spawnable = SPECIES.filter((s) => !s.locked);

  document.getElementById('dossier-tier').textContent = `HUNTER LVL ${hunterLevel()}`;
  document.getElementById('journal-found').textContent = String(discoveredCount);
  document.getElementById('journal-total').textContent = String(spawnable.length);

  const segCount = 10;
  const on = Math.round((discoveredCount / spawnable.length) * segCount);
  document.getElementById('journal-progress-meter').innerHTML = Array.from({ length: segCount })
    .map((_, i) => `<div class="seg${i < on ? ' on' : ''}"></div>`)
    .join('');

  // Rarity breakdown (real counts, computed from the actual collection).
  const counts = { common: 0, uncommon: 0, rare: 0, epic: 0, legendary: 0 };
  for (const [speciesId, entry] of Object.entries(collection)) {
    const sp = speciesById(speciesId);
    if (sp) counts[sp.rarity] += entry.count > 0 ? 1 : 0;
  }
  const breakdown = document.getElementById('rarity-breakdown');
  breakdown.innerHTML = Object.entries(counts)
    .map(
      ([rarity, count]) => `
      <div class="rarity-chip"${count === 0 ? ' style="opacity:0.5;"' : ''}>
        <span class="dot" style="background:${rarityVar(rarity)}"></span>
        <span>${rarity.slice(0, 5).toUpperCase()} <strong style="color:${rarityVar(rarity)}">${count}</strong></span>
      </div>`
    )
    .join('');

  // Featured card = most recently discovered species with an entry.
  const journal = getJournal();
  const wrap = document.getElementById('featured-card-wrap');
  if (journal.length === 0) {
    wrap.innerHTML = `
      <div class="glass-card" style="text-align:center;padding:28px 14px;">
        <p class="muted" style="font-size:13px;margin:0;">No specimens logged yet. Head to the Scanner tab to start a hunt.</p>
      </div>`;
  } else {
    const latest = journal[0];
    const species = speciesById(latest.speciesId);
    const entry = collection[species.id];
    const d = new Date(entry.firstDiscoveredAt);
    const form = formFor(species, entry.stage || 1);
    wrap.innerHTML = `
      <div class="glass-card featured-card">
        <div class="featured-top">
          <div class="fid"><span class="num">#${String(SPECIES.indexOf(species) + 1).padStart(3, '0')}</span><span class="num">//</span><span class="name">${species.name.toUpperCase()}${form ? ` <span class="num">· ${form.form.toUpperCase()}</span>` : ''}</span></div>
          <div class="featured-rarity-tag" style="background:rgba(255,255,255,0.06);color:${rarityVar(species.rarity)};">
            <span>${RARITY_SYMBOL[species.rarity]}</span><span class="label-caps">${RARITY[species.rarity].label}</span>
          </div>
        </div>
        <div class="featured-visual${form ? ' has-art' : ''}">
          ${form ? `<img class="fv-art" src="${form.art}" alt="${species.name} — ${form.form}" />` : ''}
          <svg class="reticle-bg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="none" stroke="${rarityVar(species.rarity)}" stroke-dasharray="4 6" stroke-width="1.5"/><circle cx="50" cy="50" r="20" fill="none" stroke="${rarityVar(species.rarity)}" stroke-width="1"/></svg>
          ${form ? '' : `<span class="glyph" style="color:${rarityVar(species.rarity)};">${RARITY_SYMBOL[species.rarity]}</span>`}
          ${form ? `<span class="fv-tag bl">STAGE ${form.stage}/${maxStage(species)}</span>` : ''}
          <span class="fv-tag tl">FOUND ${entry.count}×</span>
          <span class="fv-tag br">LAST SEEN ${new Date(latest.at).toLocaleDateString()}</span>
        </div>
        <div class="chip-row-plain">
          <span class="chip-plain"><svg class="icon" viewBox="0 0 24 24" fill="none"><path d="M12 2 3 21h18L12 2Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg> ${species.habitat.toUpperCase()}</span>
          <span class="chip-plain"><svg class="icon" viewBox="0 0 24 24" fill="none"><path d="M13 4a5 5 0 1 0 0 10M13 4v10" stroke="currentColor" stroke-width="1.4"/></svg> ${species.behavior.toUpperCase()}</span>
        </div>
        <div class="discovery-log">
          <div class="dl-top"><span class="lbl">Field Encounter Archive</span><span class="first">FIRST CAPTURE</span></div>
          <div class="dl-grid">
            <div><span class="dl-label">Discovered</span><span class="dl-value">${d.toLocaleDateString()}</span></div>
            <div><span class="dl-label">Timestamp</span><span class="dl-value">${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>
            <div class="full"><span class="dl-label">Geolocation Log</span><span class="dl-value"><svg class="icon" viewBox="0 0 24 24" fill="none"><path d="M12 22s7-7.58 7-12.5A7 7 0 0 0 5 9.5C5 14.42 12 22 12 22Z" stroke="currentColor" stroke-width="1.4"/></svg> ${latest.approxLocation.lat.toFixed(3)}, ${latest.approxLocation.lng.toFixed(3)}</span></div>
            <div class="full"><span class="dl-label">Distance walked this hunt</span><span class="dl-value"><svg class="icon" viewBox="0 0 24 24" fill="none"><ellipse cx="9" cy="7" rx="2.6" ry="3.4" stroke="currentColor" stroke-width="1.3"/></svg> ${latest.distanceWalkedM}m</span></div>
          </div>
        </div>
        <div class="lore-box">
          <svg class="icon" viewBox="0 0 24 24" fill="none"><path d="M4 5.5C4 4.67 4.67 4 5.5 4H12v16H5.5A1.5 1.5 0 0 1 4 18.5V5.5Z" stroke="currentColor" stroke-width="1.5"/></svg>
          <p>&ldquo;${form ? form.lore : species.lore}&rdquo;</p>
        </div>
      </div>`;
    wrap.querySelector('.featured-card').addEventListener('click', () => onOpenSpecies(species.id));
  }

  // Specimen grid: every species, locked if never found.
  const grid = document.getElementById('specimen-grid');
  grid.innerHTML = '';
  for (const species of SPECIES) {
    const entry = collection[species.id];
    const form = entry ? formFor(species, entry.stage || 1) : null;
    const evo = entry ? evolutionStatus(species.id) : null;
    const card = document.createElement('div');
    card.className = 'specimen-card' + (!entry ? ' locked' : '');
    card.innerHTML = `
      <div class="specimen-visual${form ? ' has-art' : ''}">
        ${form ? `<img class="sv-art" src="${form.thumb}" alt="" loading="lazy" />` : ''}
        ${evo && evo.ready ? '<span class="sv-evo">EVOLVE ▲</span>' : ''}
        <span class="glyph" style="color:${entry ? rarityVar(species.rarity) : 'var(--text-muted)'}">${entry ? RARITY_SYMBOL[species.rarity] : '?'}</span>
        <span class="sv-badge" style="color:${rarityVar(species.rarity)}">${RARITY[species.rarity].label.toUpperCase()}</span>
        ${entry ? `<span class="sv-count">×${entry.count}</span>` : ''}
      </div>
      <div class="specimen-name">${entry ? species.name : '???'}${form ? `<span class="specimen-form"> · ${form.form}</span>` : ''}</div>
      <div class="specimen-sub">${entry ? 'Tap to view dossier' : 'Not discovered'}</div>
    `;
    if (entry) card.addEventListener('click', () => onOpenSpecies(species.id));
    grid.appendChild(card);
  }
}

export function openJournalModal(speciesId, onEvolve, opts = {}) {
  const species = speciesById(speciesId);
  const journal = getJournal().filter((e) => e.speciesId === speciesId);
  const collection = getCollection();
  const entry = collection[speciesId];
  const stage = entry?.stage || 1;
  const form = formFor(species, stage);

  const content = document.getElementById('journal-content');
  const firstDate = entry?.firstDiscoveredAt ? new Date(entry.firstDiscoveredAt) : null;

  content.innerHTML = `
    ${form ? `
    <div class="evo-hero${opts.justEvolved ? ' just-evolved' : ''}">
      <img src="${form.art}" alt="${species.name} — ${form.form}" />
      <span class="evo-hero-stage">STAGE ${form.stage} / ${maxStage(species)}</span>
    </div>` : ''}
    <h2 class="headline-sm">${species.name}${form ? ` <span class="evo-form-name">— ${form.form}</span>` : ''}</h2>
    <p class="muted" style="font-size:12px;">${RARITY[species.rarity].label} · Found ${entry?.count ?? 0}×</p>
    <p style="font-size:13px;font-style:italic;">&ldquo;${form ? form.lore : species.lore}&rdquo;</p>
    ${form ? evolutionPanelHtml(species, stage) : ''}
    ${firstDate ? `<p class="muted" style="font-size:11px;">First discovered: ${firstDate.toLocaleDateString()} ${firstDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>` : ''}
    <hr style="border-color: var(--outline-variant); margin: 12px 0;" />
    <div>${journal
      .map(
        (e) => `
      <div style="border-bottom:1px solid var(--outline-variant);padding:8px 0;font-size:12px;">
        <div>${new Date(e.at).toLocaleDateString()} ${new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${e.firstDiscovery ? ' — <strong>First Discovery!</strong>' : ''}</div>
        <div class="muted">Near ${e.approxLocation.lat.toFixed(3)}, ${e.approxLocation.lng.toFixed(3)} · walked ${e.distanceWalkedM}m this hunt</div>
      </div>`
      )
      .join('')}</div>
  `;

  const evolveBtn = content.querySelector('#btn-evolve');
  if (evolveBtn && onEvolve) evolveBtn.addEventListener('click', () => onEvolve(speciesId));

  document.getElementById('journal-modal').classList.remove('hidden');
}

/** Grimoire-styled evolution pathway: every stage as a node, locked ones silhouetted. */
function evolutionPanelHtml(species, stage) {
  const status = evolutionStatus(species.id);
  const nodes = species.evolution
    .map((f, i) => {
      const unlocked = f.stage <= stage;
      const current = f.stage === stage;
      return `${i > 0 ? '<span class="evo-link"></span>' : ''}
        <div class="evo-node${unlocked ? ' unlocked' : ''}${current ? ' current' : ''}">
          <div class="evo-thumb"><img src="${f.thumb}" alt="" />${unlocked ? '' : '<span class="evo-q">?</span>'}</div>
          <div class="evo-node-label">${unlocked ? f.form : `Stage ${f.stage}`}</div>
        </div>`;
    })
    .join('');

  let footer = '';
  if (status?.final) {
    footer = '<div class="evo-status final">◆ Final form attained ◆</div>';
  } else if (status) {
    const segs = Math.min(status.required, 10);
    const on = Math.round((Math.min(status.captures, status.required) / status.required) * segs);
    footer = `
      <div class="evo-status">
        <span>Captures toward next form</span><strong>${Math.min(status.captures, status.required)} / ${status.required}</strong>
      </div>
      <div class="evo-meter">${Array.from({ length: segs }).map((_, i) => `<div class="seg${i < on ? ' on' : ''}"></div>`).join('')}</div>
      <button id="btn-evolve" class="btn-evolve" ${status.ready ? '' : 'disabled'}>
        ${status.ready ? `Evolve into ${status.next.form}` : `Capture ${status.required - status.captures} more to evolve`}
      </button>`;
  }

  return `
    <div class="evo-panel">
      <div class="evo-title"><span></span>Evolution Pathway<span></span></div>
      <div class="evo-path">${nodes}</div>
      ${footer}
    </div>`;
}

export function closeJournalModal() {
  document.getElementById('journal-modal').classList.add('hidden');
}
