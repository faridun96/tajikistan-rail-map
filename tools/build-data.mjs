// Конвертирует DWG-схему в data.js для 3D-карты.
// Запуск:  cd tools && npm install && node build-data.mjs [путь_к.dwg]
import { Dwg_File_Type, LibreDwg } from '@mlightcad/libredwg-web';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dwgPath = process.argv[2] || fs.readdirSync(root).filter(f => f.toLowerCase().endsWith('.dwg')).map(f => path.join(root, f))[0];
if (!dwgPath) throw new Error('DWG-файл не найден');
console.log('Читаю', dwgPath);

// ---------- 1. DWG -> база ----------
const lib = await LibreDwg.create(path.join(here, 'node_modules/@mlightcad/libredwg-web/wasm/'));
const dwg = lib.dwg_read_data(fs.readFileSync(dwgPath), Dwg_File_Type.DWG);
const db = lib.convert(dwg);
lib.dwg_free(dwg);

// ---------- 2. Разворачиваем блоки ----------
const B = {};
for (const b of db.tables.BLOCK_RECORD.entries) B[b.name] = b;
const flat = { lines: [], circles: [], texts: [] };
const M = (m, p) => ({ x: m[0] * p.x + m[1] * p.y + m[2], y: m[3] * p.x + m[4] * p.y + m[5] });
const mul = (a, b) => [a[0]*b[0]+a[1]*b[3], a[0]*b[1]+a[1]*b[4], a[0]*b[2]+a[1]*b[5]+a[2], a[3]*b[0]+a[4]*b[3], a[3]*b[1]+a[4]*b[4], a[3]*b[2]+a[4]*b[5]+a[5]];
function walk(es, m, path) {
  for (const e of es) {
    if (e.type === 'LWPOLYLINE') flat.lines.push({ path, h: e.handle, closed: !!(e.flag & 1), p: e.vertices.map(v => M(m, v)) });
    else if (e.type === 'LINE') flat.lines.push({ path, h: e.handle, p: [M(m, e.startPoint), M(m, e.endPoint)] });
    else if (e.type === 'CIRCLE') { const q = M(m, e.center); flat.circles.push({ ...q, r: e.radius, h: e.handle, transp: e.transparency > 0 && e.transparencyType !== 0 && e.transparencyType !== 1 }); }
    else if (e.type === 'MTEXT' || e.type === 'TEXT') { const q = M(m, e.insertionPoint || e.startPoint); flat.texts.push({ t: e.text, ...q, hgt: e.textHeight, w: e.rectWidth, path }); }
    else if (e.type === 'INSERT') {
      const b = B[e.name]; const r = e.rotation || 0, sx = e.xScale || 1, sy = e.yScale || 1, bp = b.basePoint || { x: 0, y: 0 };
      let mi = [Math.cos(r)*sx, -Math.sin(r)*sy, e.insertionPoint.x, Math.sin(r)*sx, Math.cos(r)*sy, e.insertionPoint.y];
      mi = mul(mi, [1, 0, -bp.x, 0, 1, -bp.y]);
      walk(b.entities || [], mul(m, mi), path + '/' + e.name);
    }
  }
}
walk(db.entities, [1, 0, 0, 0, 1, 0], '');

// ---------- 3. Геометрия-помощники ----------
const len = p => { let s = 0; for (let i = 1; i < p.length; i++) s += Math.hypot(p[i].x - p[i-1].x, p[i].y - p[i-1].y); return s; };
function project(p, x, y) { // ближайшая точка на полилинии -> {d, at, pt}
  let best = { d: Infinity }, acc = 0;
  for (let i = 1; i < p.length; i++) {
    const a = p[i-1], b = p[i], dx = b.x - a.x, dy = b.y - a.y, ll = dx*dx + dy*dy, sl = Math.sqrt(ll);
    let t = ll ? ((x - a.x)*dx + (y - a.y)*dy) / ll : 0; t = Math.max(0, Math.min(1, t));
    const px = a.x + t*dx, py = a.y + t*dy, d = Math.hypot(px - x, py - y);
    if (d < best.d) best = { d, at: acc + t*sl, pt: { x: px, y: py }, seg: i };
    acc += sl;
  }
  return best;
}
function slice(p, a0, a1) { // часть полилинии между дистанциями a0..a1
  const out = []; let acc = 0;
  out.push(pointAt(p, a0));
  for (let i = 1; i < p.length; i++) { acc += Math.hypot(p[i].x - p[i-1].x, p[i].y - p[i-1].y); if (acc > a0 && acc < a1) out.push(p[i]); }
  out.push(pointAt(p, a1));
  return out;
}
function pointAt(p, d) { let acc = 0; for (let i = 1; i < p.length; i++) { const s = Math.hypot(p[i].x - p[i-1].x, p[i].y - p[i-1].y); if (acc + s >= d) { const t = s ? (d - acc) / s : 0; return { x: p[i-1].x + t*(p[i].x - p[i-1].x), y: p[i-1].y + t*(p[i].y - p[i-1].y) }; } acc += s; } return p[p.length - 1]; }
const cleanText = t => t.replace(/\\P/g, ' / ').replace(/\\[A-Za-z][^;\\{}]*;/g, '').replace(/\\L|\\l|\\O|\\o/g, '').replace(/[{}]/g, '').replace(/C/g, 'С').replace(/\s+/g, ' ').trim();
const textCenter = t => ({ x: t.x + (t.w || t.t.length * t.hgt * 0.6) / 2, y: t.y - t.hgt / 2 });

// ---------- 4. Пути (основные полилинии) ----------
let tracks = flat.lines.filter(l => !l.path && len(l.p) > 1500).map(l => ({ h: l.h, p: l.p }));
// склеиваем полилинии, у которых совпадают концы
for (let merged = true; merged;) {
  merged = false;
  outer: for (const a of tracks) for (const b of tracks) {
    if (a === b) continue;
    const ae = a.p[a.p.length - 1], bs = b.p[0];
    if (Math.hypot(ae.x - bs.x, ae.y - bs.y) < 60) { a.p = a.p.concat(b.p.slice(1)); a.h += '+' + b.h; tracks = tracks.filter(t => t !== b); merged = true; break outer; }
  }
}

// ---------- 5. Станции: кружки + ближайшие подписи (жадное 1:1) ----------
const nameTexts = flat.texts.filter(t => t.hgt > 200 && !/^км/i.test(t.t));
const chainTexts = flat.texts.filter(t => t.hgt > 100 && t.hgt < 200);
const noteTexts = flat.texts.filter(t => /^км/i.test(t.t));
const circles = flat.circles.filter(c => c.r > 100);
function greedy(cs, ts, maxD) {
  const pairs = [];
  cs.forEach((c, i) => ts.forEach((t, j) => { const q = textCenter(t); pairs.push([Math.hypot(q.x - c.x, q.y - c.y), i, j]); }));
  pairs.sort((a, b) => a[0] - b[0]);
  const res = new Map(), usedT = new Set();
  for (const [d, i, j] of pairs) if (d < maxD && !res.has(i) && !usedT.has(j)) { res.set(i, ts[j]); usedT.add(j); }
  return res;
}
const nm = greedy(circles, nameTexts, 2600), ch = greedy(circles, chainTexts, 1400);
const stations = circles.map((c, i) => {
  const st = { id: c.h, x: c.x, y: c.y, name: nm.has(i) ? cleanText(nm.get(i).t) : null, chain: ch.has(i) ? cleanText(ch.get(i).t) : null, outside: c.transp };
  const note = noteTexts.find(t => Math.hypot(textCenter(t).x - c.x, textCenter(t).y - c.y) < 2500);
  if (note) st.note = cleanText(note.t);
  return st;
});

// ---------- 6. Участки (конфигурация по названиям станций) ----------
const byName = n => stations.find(s => s.name === n);
const trackOf = n => { const s = byName(n); return tracks.map(t => ({ t, d: project(t.p, s.x, s.y).d })).sort((a, b) => a.d - b.d)[0].t; };
const SECTIONS = [
  { id: 'north',  name: 'Бекобод — Худжанд — Истиклол', region: 'Северный участок (Согд)', color: '#3fd0ff', track: 'Худжанд' },
  { id: 'isfara', name: 'Конибодом — Исфара — Шуроб',   region: 'Северный участок (Согд)', color: '#b98cff', track: 'Исфара' },
  { id: 'center', name: 'Кудукли — Душанбе — Вахдат',  region: 'Центральный участок',     color: '#ffc04a', track: 'Регар', to: 'Вахдат' },
  { id: 'link',   name: 'Вахдат — Ёвон',                region: 'Центральный участок',     color: '#ff7a59', track: 'Бахор', from: 'Вахдат', to: 'Ёвон' },
  { id: 'south',  name: 'Ёвон — Вахш — Шахритус — Сархад', region: 'Южный участок (Хатлон)', color: '#43e6a0', track: 'Вахш', from: 'Ёвон' },
  { id: 'kulob',  name: 'Хатлон — Дангара — Кулоб',     region: 'Южный участок (Хатлон)', color: '#ff5fa2', track: 'Кулоб' },
  { id: 'regar',  name: 'Регар — Сешанбе',              region: 'Центральный участок',     color: '#ffe680', track: 'Сешанбе' },
];
const lines = [], attach = [];
for (const sec of SECTIONS) {
  const tr = trackOf(sec.track); const L = len(tr.p);
  const a0 = sec.from ? project(tr.p, byName(sec.from).x, byName(sec.from).y).at : 0;
  const a1 = sec.to ? project(tr.p, byName(sec.to).x, byName(sec.to).y).at : L;
  let pts = slice(tr.p, a0, a1);
  // примыкание к соседнему пути (стрелочный перевод)
  for (const end of [0, 1]) {
    const e = end ? pts[pts.length - 1] : pts[0];
    for (const o of tracks) if (o !== tr) { const pr = project(o.p, e.x, e.y); if (pr.d > 30 && pr.d < 2500) { end ? pts.push(pr.pt) : pts.unshift(pr.pt); attach.push({ line: sec.id, pt: pr.pt }); break; } }
  }
  lines.push({ ...sec, pts });
}
// привязка станций к участкам
for (const s of stations) {
  let best = null;
  for (const l of lines) { const pr = project(l.pts, s.x, s.y); if (!best || pr.d < best.d - 1) best = { l, ...pr }; }
  s.line = best.l.id; s.at = best.at;
}
// развилки: станция другого участка рядом с концом участка (Конибодом, Регар, Вахдат, Ёвон, Хатлон)
for (const l of lines) for (const e of [l.pts[0], l.pts[l.pts.length - 1]]) {
  const near = stations.filter(s => s.line !== l.id).map(s => ({ s, d: Math.hypot(s.x - e.x, s.y - e.y) })).sort((p, q) => p.d - q.d)[0];
  if (near && near.d < 2500 && !(near.s.junction || []).includes(l.id)) (near.s.junction = near.s.junction || []).push(l.id);
}
stations.sort((a, b) => SECTIONS.findIndex(x => x.id === a.line) - SECTIONS.findIndex(x => x.id === b.line) || a.at - b.at);

// ---------- 7. Отметки км и пикетов (массивы черточек) ----------
const ticks = { km: [], pk: [] };
for (const l of flat.lines.filter(l => l.path && l.p.length === 2)) {
  const [a, b] = l.p; const L = Math.hypot(b.x - a.x, b.y - a.y);
  const kind = L > 190 ? 'km' : 'pk';
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  let best = null; for (const ln of lines) { const pr = project(ln.pts, mx, my); if (!best || pr.d < best.d) best = { id: ln.id, ...pr }; }
  if (best.d > 400) continue;
  ticks[kind].push([best.pt.x, best.pt.y, Math.atan2(b.y - a.y, b.x - a.x), best.id]);
}

// ---------- 8. Нормализация в км, центр карты = 0 ----------
const all = lines.flatMap(l => l.pts);
const cx = (Math.min(...all.map(p => p.x)) + Math.max(...all.map(p => p.x))) / 2;
const cy = (Math.min(...all.map(p => p.y)) + Math.max(...all.map(p => p.y))) / 2;
const K = v => +(v / 1000).toFixed(3);
const X = x => K(x - cx), Z = y => K(-(y - cy)); // three.js: X вправо, Z на юг
const out = {
  source: path.basename(dwgPath),
  generated: new Date().toISOString().slice(0, 10),
  lines: lines.map(l => ({ id: l.id, name: l.name, region: l.region, color: l.color, length: K(len(l.pts)), pts: l.pts.map(p => [X(p.x), Z(p.y)]) })),
  stations: stations.map(s => ({ id: s.id, name: s.name, chain: s.chain, note: s.note, line: s.line, at: K(s.at), x: X(s.x), z: Z(s.y), junction: s.junction, outside: s.outside || undefined, border: /сархад/i.test(s.name || '') || undefined })),
  ticks: { km: ticks.km.map(t => [X(t[0]), Z(t[1]), +(-t[2]).toFixed(3), t[3]]), pk: ticks.pk.map(t => [X(t[0]), Z(t[1]), +(-t[2]).toFixed(3), t[3]]) },
};
fs.writeFileSync(path.join(root, 'data.js'), '// Сгенерировано tools/build-data.mjs из ' + out.source + '\nwindow.RAIL_DATA = ' + JSON.stringify(out) + ';\n');
console.log('Участков:', out.lines.length, 'станций:', out.stations.length, 'км-отметок:', out.ticks.km.length, 'пикетов:', out.ticks.pk.length);
for (const l of out.lines) console.log(' ', l.id.padEnd(7), l.length.toFixed(1).padStart(6), 'км ', l.name, '—', out.stations.filter(s => s.line === l.id).map(s => s.name || '?').join(', '));
for (const s of out.stations.filter(s => !s.name || s.junction || s.outside || s.note)) console.log('  *', s.name, s.chain, s.note || '', s.junction || '', s.outside ? 'outside' : '');
