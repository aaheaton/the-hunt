// Wraps the two real-world inputs the whole game depends on: GPS position
// and compass heading. Kept isolated so app.js doesn't need to know about
// iOS-vs-Android permission quirks.

/** Request device-orientation permission on iOS 13+; no-op elsewhere. */
export async function requestOrientationPermission() {
  const DOE = window.DeviceOrientationEvent;
  if (DOE && typeof DOE.requestPermission === 'function') {
    try {
      const res = await DOE.requestPermission();
      return res === 'granted';
    } catch (err) {
      console.warn('Orientation permission denied/error', err);
      return false;
    }
  }
  return true; // Android / desktop browsers don't gate this behind a prompt.
}

/**
 * Start watching GPS position. onUpdate receives {lat, lng, accuracy}.
 * Returns a function to stop watching.
 */
export function watchPosition(onUpdate, onError) {
  if (!('geolocation' in navigator)) {
    onError?.(new Error('Geolocation is not supported on this device/browser.'));
    return () => {};
  }
  const id = navigator.geolocation.watchPosition(
    (pos) => {
      onUpdate({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      });
    },
    (err) => onError?.(err),
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
  );
  return () => navigator.geolocation.clearWatch(id);
}

/**
 * Start watching compass heading (0-360, 0 = north).
 * Handles the iOS-only `webkitCompassHeading` (already north-referenced)
 * vs the standard `alpha` (which points the other way and isn't reliably
 * north-referenced unless the event is `absolute`).
 * Returns a function to stop watching.
 */
export function watchHeading(onUpdate) {
  let handler = (evt) => {
    let heading = null;
    if (typeof evt.webkitCompassHeading === 'number') {
      heading = evt.webkitCompassHeading; // already 0=N, clockwise
    } else if (evt.absolute && typeof evt.alpha === 'number') {
      heading = (360 - evt.alpha) % 360;
    } else if (typeof evt.alpha === 'number') {
      // Best-effort fallback; not guaranteed north-referenced on all devices.
      heading = (360 - evt.alpha) % 360;
    }
    if (heading !== null && !Number.isNaN(heading)) onUpdate(heading);
  };

  const eventName =
    'ondeviceorientationabsolute' in window
      ? 'deviceorientationabsolute'
      : 'deviceorientation';
  window.addEventListener(eventName, handler, true);
  return () => window.removeEventListener(eventName, handler, true);
}
