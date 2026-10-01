// Geographic helpers: distance, bearing, destination-point projection,
// and coordinate fuzzing for privacy-conscious storage.

const R_EARTH_M = 6371000;

function toRad(deg) { return (deg * Math.PI) / 180; }
function toDeg(rad) { return (rad * 180) / Math.PI; }

/** Haversine distance in metres between two {lat,lng} points. */
export function distanceM(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial compass bearing (0-360, 0 = north) from a to b. */
export function bearingDeg(a, b) {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Project a new {lat,lng} from an origin, given a bearing and distance. */
export function destinationPoint(origin, bearing, distM) {
  const lat1 = toRad(origin.lat);
  const lng1 = toRad(origin.lng);
  const brng = toRad(bearing);
  const dOverR = distM / R_EARTH_M;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(dOverR) +
      Math.cos(lat1) * Math.sin(dOverR) * Math.cos(brng)
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(dOverR) * Math.cos(lat1),
      Math.cos(dOverR) - Math.sin(lat1) * Math.sin(lat2)
    );
  return { lat: toDeg(lat2), lng: ((toDeg(lng2) + 540) % 360) - 180 };
}

/** A uniformly-random point within radiusM of a center (approx, fine at this scale). */
export function randomPointInRadius(center, radiusM) {
  const angle = Math.random() * 360;
  // sqrt() keeps the distribution uniform over the disc area, not biased to center.
  const dist = Math.sqrt(Math.random()) * radiusM;
  return destinationPoint(center, angle, dist);
}

/** Shortest signed angular difference (-180..180) from a->b in degrees. */
export function angleDiff(a, b) {
  let d = (b - a) % 360;
  if (d < -180) d += 360;
  if (d > 180) d -= 360;
  return d;
}

/**
 * Round a coordinate down to ~100m precision for privacy-conscious storage
 * (GDD section 39: store approximate discovery locations, not exact routes).
 */
export function fuzzCoord(point, decimals = 3) {
  const f = Math.pow(10, decimals);
  return {
    lat: Math.round(point.lat * f) / f,
    lng: Math.round(point.lng * f) / f,
  };
}
