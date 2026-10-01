// Small inline-SVG icon set. Deliberately not using an icon font (like the
// design mockup's Material Symbols) so the PWA has zero external font
// dependency for iconography and stays installable/usable offline.
// Every icon is a 24x24 viewBox, stroke-based, currentColor.

const wrap = (inner, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" class="icon ${extra}">${inner}</svg>`;

export const ICONS = {
  radar: wrap(
    '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12" r="5" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2 3"/><path d="M12 12 L12 3 A9 9 0 0 1 18.5 6.5 Z" fill="currentColor" fill-opacity="0.25"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/>'
  ),
  grid: wrap(
    '<rect x="3" y="3" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="14" y="3" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="3" y="14" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="14" y="14" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.5"/>'
  ),
  reticle: wrap(
    '<circle cx="12" cy="12" r="7" stroke="currentColor" stroke-width="1.5"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4" stroke="currentColor" stroke-width="1.5"/>'
  ),
  book: wrap(
    '<path d="M4 5.5C4 4.67 4.67 4 5.5 4H12v16H5.5A1.5 1.5 0 0 1 4 18.5V5.5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M20 5.5c0-.83-.67-1.5-1.5-1.5H12v16h6.5c.83 0 1.5-.67 1.5-1.5V5.5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>'
  ),
  navArrow: wrap(
    '<path d="M12 2 L19 20 L12 16 L5 20 Z" fill="currentColor"/>'
  ),
  eye: wrap(
    '<path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12" r="2.5" stroke="currentColor" stroke-width="1.5"/>'
  ),
  pulse: wrap(
    '<path d="M2 12h4l2-7 4 14 2-9 2 5h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'
  ),
  footprint: wrap(
    '<ellipse cx="9" cy="7" rx="2.6" ry="3.4" stroke="currentColor" stroke-width="1.3"/><ellipse cx="16" cy="15" rx="2.6" ry="3.4" stroke="currentColor" stroke-width="1.3"/>'
  ),
  pin: wrap(
    '<path d="M12 22s7-7.58 7-12.5A7 7 0 0 0 5 9.5C5 14.42 12 22 12 22Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="12" cy="9.5" r="2.3" stroke="currentColor" stroke-width="1.5"/>'
  ),
  compass: wrap(
    '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.5"/><path d="M15 9l-2 6-6 2 2-6 6-2Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>'
  ),
  camera: wrap(
    '<rect x="3" y="7" width="18" height="13" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M8 7l1.6-2.5h4.8L16 7" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="12" cy="13.5" r="3.4" stroke="currentColor" stroke-width="1.5"/>'
  ),
  download: wrap(
    '<path d="M12 3v12m0 0-4-4m4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 17v2.5A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5V17" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>'
  ),
  bolt: wrap(
    '<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" fill="currentColor" fill-opacity="0.15"/>'
  ),
  explorer: wrap(
    '<circle cx="12" cy="8.2" r="3.4" stroke="currentColor" stroke-width="1.5"/><path d="M4.5 20c1.2-4 4-6 7.5-6s6.3 2 7.5 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>'
  ),
  north: wrap(
    '<path d="M12 3v18M7 8l5-5 5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'
  ),
  target: wrap(
    '<circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.4"/><circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="1.4"/><circle cx="12" cy="12" r="1" fill="currentColor"/>'
  ),
};

export function icon(name, extraClass = '') {
  const svg = ICONS[name];
  if (!svg) return '';
  return extraClass ? svg.replace('class="icon ', `class="icon ${extraClass} `) : svg;
}
