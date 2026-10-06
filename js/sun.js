// Day / night detection from the player's real position and clock.
// Uses the standard NOAA solar-position approximation (accurate to well under
// a degree, plenty for "is it dark yet?"). No network needed.
//
// "Night" = the sun is more than CONFIG.nightSunAltitudeDeg below the horizon
// (civil dusk by default), so night creatures appear once it's actually dark,
// not the moment the sun touches the horizon.
//
// Testing override: add ?night=1 (or ?night=0) to the URL to force it.

import { CONFIG } from './config.js';

const forced = (() => {
  try {
    const v = new URLSearchParams(location.search).get('night');
    if (v === '1') return true;
    if (v === '0') return false;
  } catch (_) { /* not in a browser */ }
  return null;
})();

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

/** Sun altitude in degrees above the horizon at a place and time. */
export function sunAltitudeDeg(lat, lng, date = new Date()) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const t = (jd - 2451545) / 36525;
  const L0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const M = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const C =
    Math.sin(toRad(M)) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(toRad(2 * M)) * (0.019993 - 0.000101 * t) +
    Math.sin(toRad(3 * M)) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * t;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(toRad(omega));
  const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(toRad(omega));
  const decl = toDeg(Math.asin(Math.sin(toRad(eps)) * Math.sin(toRad(lambda))));

  // Equation of time (minutes).
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const y = Math.tan(toRad(eps / 2)) ** 2;
  const eqTime = 4 * toDeg(
    y * Math.sin(2 * toRad(L0)) -
    2 * e * Math.sin(toRad(M)) +
    4 * e * y * Math.sin(toRad(M)) * Math.cos(2 * toRad(L0)) -
    0.5 * y * y * Math.sin(4 * toRad(L0)) -
    1.25 * e * e * Math.sin(2 * toRad(M))
  );

  const utcMinutes = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  let trueSolarTime = (utcMinutes + eqTime + 4 * lng) % 1440;
  if (trueSolarTime < 0) trueSolarTime += 1440;
  let hourAngle = trueSolarTime / 4 - 180;
  if (hourAngle < -180) hourAngle += 360;

  const cosZenith =
    Math.sin(toRad(lat)) * Math.sin(toRad(decl)) +
    Math.cos(toRad(lat)) * Math.cos(toRad(decl)) * Math.cos(toRad(hourAngle));
  const zenith = toDeg(Math.acos(Math.max(-1, Math.min(1, cosZenith))));
  return 90 - zenith;
}

/** True when it's dark enough for night creatures at this position. */
export function isNight(pos, date = new Date()) {
  if (forced !== null) return forced;
  if (!pos) return false;
  return sunAltitudeDeg(pos.lat, pos.lng, date) < CONFIG.nightSunAltitudeDeg;
}

export function nightIsForced() {
  return forced;
}
