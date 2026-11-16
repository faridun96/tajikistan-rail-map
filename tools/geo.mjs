// Общая проекция карты: равнопромежуточная, центр — Таджикистан. Единица = 1 км.
// X — на восток, Z — на юг (как в three.js при взгляде сверху).
const lat0 = 38.85, lon0 = 71.15;
export const PROJ = {
  lat0, lon0,
  kmPerDegLat: 110.57,
  kmPerDegLon: 111.32 * Math.cos((lat0 * Math.PI) / 180),
  // охват карты высот
  terrain: { lonMin: 66.9, lonMax: 75.4, latMin: 36.3, latMax: 41.4, kmPerPx: 0.4 },
};
export function project(lon, lat) {
  return [(lon - PROJ.lon0) * PROJ.kmPerDegLon, (PROJ.lat0 - lat) * PROJ.kmPerDegLat];
}
