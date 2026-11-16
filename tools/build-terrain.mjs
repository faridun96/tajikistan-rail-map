// Реальный рельеф: скачивает тайлы высот (AWS Terrain Tiles, формат Terrarium, z9 ≈ 240 м/пикс)
// и собирает карту высот в проекции карты -> ../terrain.png (+ ../terrain.json).
// Запуск:  cd tools && node build-terrain.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PNG } from 'pngjs';
import { PROJ, project } from './geo.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const cacheDir = path.join(here, 'cache', 'dem');
fs.mkdirSync(cacheDir, { recursive: true });

const Z = 9, TS = 256, N = 2 ** Z;
const { lonMin, lonMax, latMin, latMax, kmPerPx } = PROJ.terrain;
const lon2x = (lon) => ((lon + 180) / 360) * N;
const lat2y = (lat) => ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * N;
const tx0 = Math.floor(lon2x(lonMin)), tx1 = Math.floor(lon2x(lonMax));
const ty0 = Math.floor(lat2y(latMax)), ty1 = Math.floor(lat2y(latMin));

// ---------- 1. тайлы ----------
const tiles = new Map();
for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
  const f = path.join(cacheDir, `${Z}_${tx}_${ty}.png`);
  if (!fs.existsSync(f)) {
    const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${tx}/${ty}.png`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(url + ' -> ' + r.status);
    fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
    process.stdout.write('.');
  }
  const png = PNG.sync.read(fs.readFileSync(f));
  const h = new Float32Array(TS * TS);
  for (let i = 0; i < TS * TS; i++) h[i] = png.data[i * 4] * 256 + png.data[i * 4 + 1] + png.data[i * 4 + 2] / 256 - 32768;
  tiles.set(`${tx}_${ty}`, h);
}
console.log('\nтайлов:', tiles.size);
function demAt(gx, gy) { // глобальные пиксели z9
  const tx = Math.floor(gx / TS), ty = Math.floor(gy / TS);
  const t = tiles.get(`${tx}_${ty}`); if (!t) return 0;
  const px = Math.min(TS - 1, Math.max(0, Math.floor(gx - tx * TS))), py = Math.min(TS - 1, Math.max(0, Math.floor(gy - ty * TS)));
  return t[py * TS + px];
}
function demBilinear(lon, lat) {
  const gx = lon2x(lon) * TS - 0.5, gy = lat2y(lat) * TS - 0.5;
  const x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
  const a = demAt(x0, y0), b = demAt(x0 + 1, y0), c = demAt(x0, y0 + 1), d = demAt(x0 + 1, y0 + 1);
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

// ---------- 2. карта высот в проекции карты ----------
const [xMin, zMin] = project(lonMin, latMax), [xMax, zMax] = project(lonMax, latMin);
const W = Math.round((xMax - xMin) / kmPerPx), H = Math.round((zMax - zMin) / kmPerPx);
const out = new PNG({ width: W, height: H, colorType: 2 });
let hMax = 0;
for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
  const x = xMin + (i + 0.5) * kmPerPx, z = zMin + (j + 0.5) * kmPerPx;
  const lat = PROJ.lat0 - z / PROJ.kmPerDegLat, lon = PROJ.lon0 + x / PROJ.kmPerDegLon;
  const m = Math.max(0, Math.min(65535, Math.round(demBilinear(lon, lat))));
  hMax = Math.max(hMax, m);
  const k = (j * W + i) * 4;
  out.data[k] = m >> 8; out.data[k + 1] = m & 255; out.data[k + 2] = 0; out.data[k + 3] = 255;
}
fs.writeFileSync(path.join(root, 'terrain.png'), PNG.sync.write(out, { colorType: 2 }));
const meta = { width: W, height: H, xMin: +xMin.toFixed(3), zMin: +zMin.toFixed(3), kmPerPx, maxMeters: hMax, encoding: 'meters = R*256 + G', source: 'AWS Terrain Tiles (Mapzen/Tilezen, Terrarium), zoom 9' };
fs.writeFileSync(path.join(root, 'terrain.json'), JSON.stringify(meta, null, 1));
console.log('terrain.png', W + 'x' + H, 'макс. высота', hMax, 'м');
