// Конвертирует DWG-схему в data.js для 3D-карты.
// Запуск:  cd tools && npm install && node build-data.mjs [путь_к.dwg]
import { Dwg_File_Type, LibreDwg } from '@mlightcad/libredwg-web';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as topojson from 'topojson-client';
import { PROJ, project as geoProject } from './geo.mjs';

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


// ---------- 6. Участки: три участка, у каждого основная линия и ветка ----------
const GEO = JSON.parse(fs.readFileSync(path.join(here, 'stations-geo.json'), 'utf8'));
for (const s of stations) if (!s.name && s.chain && GEO.renames[s.chain]) s.name = GEO.renames[s.chain];
const byName = n => stations.find(s => s.name === n);
const trackOf = n => { const s = byName(n); return tracks.map(t => ({ t, d: project(t.p, s.x, s.y).d })).sort((a, b) => a.d - b.d)[0].t; };
const SECTIONS = [
  { id: 'north', name: 'Северный участок', region: 'Согдийская область', color: '#38d1ff', branches: [
    { id: 'north-main', name: 'Сархад — Худжанд — Конибодом — Сархад', track: 'Худжанд' },
    { id: 'north-isfara', name: 'Конибодом — Исфара — Шуроб', track: 'Исфара' } ] },
  { id: 'center', name: 'Центральный участок', region: 'Душанбе и РРП', color: '#ffbf47', branches: [
    { id: 'center-main', name: 'Сархад — Душанбе — Вахдат — Ёвон', track: 'Регар', to: 'Ёвон' },
    { id: 'center-seshanbe', name: 'Регар — Сешанбе', track: 'Сешанбе' } ] },
  { id: 'south', name: 'Южный участок', region: 'Хатлонская область', color: '#3ee69d', branches: [
    { id: 'south-main', name: 'Ёвон — Вахш — Шахритус — Сархад', track: 'Вахш', from: 'Ёвон' },
    { id: 'south-kulob', name: 'Хатлон — Дангара — Кулоб', track: 'Кулоб' } ] },
];
const branches = [];
for (const sec of SECTIONS) for (const br of sec.branches) {
  const tr = trackOf(br.track); const L = len(tr.p);
  const a0 = br.from ? project(tr.p, byName(br.from).x, byName(br.from).y).at : 0;
  const a1 = br.to ? project(tr.p, byName(br.to).x, byName(br.to).y).at : L;
  const pts = slice(tr.p, a0, a1);
  const b = { ...br, section: sec.id, pts, attach: [] };
  // примыкание к другому пути (стрелочный перевод): конец ветки дотягиваем до основного пути
  for (const end of [0, 1]) {
    const e = end ? pts[pts.length - 1] : pts[0];
    for (const o of tracks) if (o !== tr) {
      const pr = project(o.p, e.x, e.y);
      if (pr.d < 2500) { if (pr.d > 30) end ? pts.push(pr.pt) : pts.unshift(pr.pt); b.attach.push({ end, pt: pr.pt }); break; }
    }
  }
  branches.push(b);
}
const cum = p => { const c = [0]; for (let i = 1; i < p.length; i++) c.push(c[i - 1] + Math.hypot(p[i].x - p[i-1].x, p[i].y - p[i-1].y)); return c; };
for (const b of branches) { b.cum = cum(b.pts); b.L = b.cum[b.cum.length - 1]; }

// ---------- 7. Проверка разрывов в чертеже ----------
console.log('Проверка непрерывности путей:');
for (const b of branches) {
  let maxGap = 0, gi = 0; for (let i = 1; i < b.pts.length; i++) if (b.cum[i] - b.cum[i - 1] > maxGap) { maxGap = b.cum[i] - b.cum[i - 1]; gi = i; }
  const gs = stations.map(s => ({ n: s.name, d: Math.min(Math.hypot(s.x - b.pts[gi].x, s.y - b.pts[gi].y), Math.hypot(s.x - b.pts[gi-1].x, s.y - b.pts[gi-1].y)) })).sort((p, q) => p.d - q.d)[0];
  console.log('  ', b.id.padEnd(16), 'вершин', String(b.pts.length).padStart(4), ' длина', (b.L / 1000).toFixed(1).padStart(6), 'км  макс. отрезок', (maxGap / 1000).toFixed(2), 'км у ст.', gs.n);
}
for (const l of flat.lines.filter(l => !l.path && len(l.p) <= 1500)) {
  const c = l.p[0]; const near = branches.map(b => ({ b, ...project(b.pts, c.x, c.y) })).sort((x, y) => x.d - y.d)[0];
  console.log('   мелкая полилиния', l.h, 'длина', Math.round(len(l.p)), 'м, до пути', Math.round(near.d), 'м (' + near.b.id + ')');
}

// ---------- 8. Станции -> ветки ----------
for (const s of stations) {
  let best = null;
  for (const b of branches) { const pr = project(b.pts, s.x, s.y); if (!best || pr.d < best.d - 1) best = { b, ...pr }; }
  s.branch = best.b; s.atDraw = best.at; s.onLine = best.pt;
}
const isForeign = s => GEO.foreign.includes(s.name);
const isBorder = s => /сархад/i.test(s.name || '');
// развилки
for (const b of branches) for (const a of b.attach) {
  const near = stations.filter(s => s.branch !== b && !isBorder(s)).sort((p, q) => Math.hypot(p.x - a.pt.x, p.y - a.pt.y) - Math.hypot(q.x - a.pt.x, q.y - a.pt.y))[0];
  (near.junction = near.junction || []).push(b.id);
}
// стыки основных линий участков (Ёвон)
for (const b of branches) for (const e of [b.pts[0], b.pts[b.pts.length - 1]]) {
  const s = stations.find(s => s.branch !== b && Math.hypot(s.x - e.x, s.y - e.y) < 80 && !isBorder(s));
  if (s && !(s.junction || []).includes(b.id)) (s.junction = s.junction || []).push(b.id);
}

// ---------- 9. Привязка к реальной географии ----------
// Схема искажена (участки сдвинуты друг к другу), поэтому каждый отрезок пути между
// соседними станциями с известными координатами переносится своим подобием (поворот+масштаб+сдвиг):
// станции встают точно на свои места, форма пути между ними сохраняется.
const C = (x, y) => ({ re: x, im: y });
const cSub = (a, b) => C(a.re - b.re, a.im - b.im), cAdd = (a, b) => C(a.re + b.re, a.im + b.im);
const cMul = (a, b) => C(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
const cDiv = (a, b) => { const d = b.re * b.re + b.im * b.im; return C((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d); };
const drawToC = p => C(p.x / 1000, -p.y / 1000);           // км, ось вниз = юг (как в карте)
// у пунктов «Сархад» координаты — реальные точки пересечения пути с госграницей (ключ — пикетаж)
const geoOf = s => (/сархад/i.test(s.name || '') ? GEO.borderCrossings[s.chain] : GEO.coords[s.name]);
const realOf = s => { const c = geoOf(s); if (!c) return null; const [x, z] = geoProject(c[1], c[0]); return C(x, z); };
const order = ['north-main', 'north-isfara', 'center-main', 'center-seshanbe', 'south-main', 'south-kulob'];
const byId = Object.fromEntries(branches.map(b => [b.id, b]));
for (const id of order) {
  const b = byId[id];
  const ctrl = [];
  for (const s of stations.filter(s => s.branch === b)) { const r = realOf(s); if (r) ctrl.push({ d: s.atDraw, P: drawToC(s.onLine), R: r, name: s.name }); }
  for (const a of b.attach) {
    const parent = branches.filter(o => o !== b && o.warp).map(o => ({ o, ...project(o.pts, a.pt.x, a.pt.y) })).sort((p, q) => p.d - q.d)[0];
    const R = parent.o.warp(parent.at);
    ctrl.push({ d: a.end ? b.L : 0, P: drawToC(a.pt), R, name: 'примыкание', parent: parent.o, parentAt: parent.at });
  }
  ctrl.sort((p, q) => p.d - q.d);
  const segs = [];
  if (ctrl.length >= 2) for (let i = 0; i + 1 < ctrl.length; i++) segs.push({ d0: ctrl[i].d, d1: ctrl[i + 1].d, P: ctrl[i].P, R: ctrl[i].R, a: cDiv(cSub(ctrl[i + 1].R, ctrl[i].R), cSub(ctrl[i + 1].P, ctrl[i].P)) });
  else if (ctrl.length === 1 && ctrl[0].parent) { // одна опорная точка: берём масштаб/поворот основного пути в точке примыкания
    const ps = ctrl[0].parent.segAt(ctrl[0].parentAt);
    segs.push({ d0: -Infinity, d1: Infinity, P: ctrl[0].P, R: ctrl[0].R, a: ps.a });
  } else throw new Error('Нет опорных точек для ' + id);
  b.ctrl = ctrl;
  b.segAt = d => segs.find(s => d <= s.d1) || segs[segs.length - 1];
  b.warpPt = (p, d) => { const s = b.segAt(d); return cAdd(s.R, cMul(s.a, cSub(drawToC(p), s.P))); };
  b.warp = d => b.warpPt(pointAt(b.pts, d), d);
  // вершины + опорные точки как вершины (излом ровно на станции)
  const ds = new Set(b.cum.map(x => +x.toFixed(3)));
  for (const c of ctrl) ds.add(+c.d.toFixed(3));
  b.dList = [...ds].sort((x, y) => x - y);
  b.scale = segs.map(s => Math.hypot(s.a.re, s.a.im) * 1000);
}
for (const b of branches) console.log('  масштаб отрезков', b.id.padEnd(16), b.scale.map(x => x.toFixed(2)).join(' '));

// иностранные части путей (за станцией «Сархад»)
for (const b of branches) {
  const brd = stations.filter(s => s.branch === b && isBorder(s));
  const frn = stations.filter(s => s.branch === b && isForeign(s));
  b.foreign = [];
  for (const f of frn) {
    const s = brd.sort((p, q) => Math.abs(p.atDraw - f.atDraw) - Math.abs(q.atDraw - f.atDraw))[0];
    b.foreign.push({ from: f.atDraw < s.atDraw ? 0 : s.atDraw, to: f.atDraw < s.atDraw ? s.atDraw : b.L, station: f });
  }
  b.isForeignAt = d => b.foreign.some(f => d > f.from + 1 && d < f.to - 1);
}

// ---------- 10. Км-отметки и пикеты ----------
const ticks = { km: [], pk: [] };
for (const l of flat.lines.filter(l => l.path && l.p.length === 2)) {
  const [a, b2] = l.p; const L = Math.hypot(b2.x - a.x, b2.y - a.y);
  const kind = L > 190 ? 'km' : 'pk';
  const mx = (a.x + b2.x) / 2, my = (a.y + b2.y) / 2;
  let best = null; for (const b of branches) { const pr = project(b.pts, mx, my); if (!best || pr.d < best.d) best = { b, ...pr }; }
  if (best.d > 400 || best.b.isForeignAt(best.at)) continue;
  const w = best.b.warp(best.at), t1 = best.b.warp(Math.max(0, best.at - 30)), t2 = best.b.warp(Math.min(best.b.L, best.at + 30));
  const ang = Math.atan2(t2.im - t1.im, t2.re - t1.re) + Math.PI / 2; // поперёк пути
  const t = [+w.re.toFixed(3), +w.im.toFixed(3), +ang.toFixed(3), best.b.section, 0, 0];
  ticks[kind].push(t); (best.b.tickMeta = best.b.tickMeta || []).push({ kind, at: best.at, t });
}
// Номера пикетов: между км-отметками 9 пикетов, ПК1…ПК9 считаются от км-отметки по направлению роста километража
const chainNum = c => { const m = (c || '').trim().match(/^(\d+)(?:\+(\d+))?$/); return m ? +m[1] + (m[2] ? +m[2] / 1000 : 0) : null; };
const pkHist = {};
for (const b of branches) {
  const st = stations.filter(s => s.branch === b).map(s => ({ a: s.atDraw, k: chainNum(s.chain) })).filter(x => x.k != null).sort((p, q) => p.a - q.a);
  let vote = 0; for (let i = 1; i < st.length; i++) vote += Math.sign((st[i].k - st[i - 1].k) * (st[i].a - st[i - 1].a));
  b.chainDir = vote ? Math.sign(vote) : (b.attach.some(a => a.end) ? -1 : 1); // одна станция: километраж растёт от примыкания
  let meta = (b.tickMeta || []).sort((p, q) => p.at - q.at);
  const kms = meta.filter(m => m.kind === 'km').map(m => m.at);
  // штрих пикета, лежащий под км-отметкой, — это сама км-отметка: убираем
  const under = new Set(meta.filter(m => m.kind === 'pk' && kms.some(k => Math.abs(k - m.at) < 15)).map(m => m.t));
  ticks.pk = ticks.pk.filter(t => !under.has(t)); meta = meta.filter(m => !under.has(m.t));
  const pks = meta.filter(m => m.kind === 'pk');
  const step = pks.length > 1 ? pks.slice(1).map((m, i) => m.at - pks[i].at).sort((x, y) => x - y)[Math.floor((pks.length - 1) / 2)] : 100;
  for (const m of pks) {
    const lo = kms.filter(x => x < m.at).pop(), hi = kms.find(x => x > m.at);
    let fromLow; // доля пути от нижней (по дуге) км-отметки, в десятых
    if (lo != null && hi != null) fromLow = Math.round(((m.at - lo) / (hi - lo)) * 10);
    else if (lo != null) fromLow = Math.round((m.at - lo) / step);
    else if (hi != null) fromLow = 10 - Math.round((hi - m.at) / step);
    else fromLow = 0;
    const n = b.chainDir > 0 ? fromLow : 10 - fromLow;
    m.t[5] = Math.min(9, Math.max(1, n));
  }
  // проверка: сколько пикетов между соседними км-отметками
  for (let i = 1; i < kms.length; i++) { const c = pks.filter(m => m.at > kms[i - 1] && m.at < kms[i]).length; pkHist[c] = (pkHist[c] || 0) + 1; }
}
{ // сверка: на чертеже подпись ПКn стоит сразу за n-м штрихом от км-отметки
  let ok = 0, all = 0;
  for (const t of flat.texts.filter(t => /^ПК\d$/.test(t.t))) {
    const n = +t.t.slice(2), c = textCenter(t); let best = null;
    for (const b of branches) { const pr = project(b.pts, c.x, c.y); if (!best || pr.d < best.d) best = { b, ...pr }; }
    const kms = best.b.tickMeta.filter(m => m.kind === 'km').map(m => m.at).sort((x, y) => x - y);
    const lo = kms.filter(x => x <= best.at).pop(), hi = kms.find(x => x > best.at); if (lo == null || hi == null) continue;
    let pos = ((best.at - lo) / (hi - lo)) * 10; if (pos < 1 && n === 9) pos += 10; // ПК9 у следующей км-отметки
    all++; if (pos - n > -0.6 && pos - n < 2.1) ok++;
  }
  console.log('  номера ПК совпадают с подписями чертежа:', ok, 'из', all);
}
console.log('  пикетов между соседними км-отметками (кол-во: сколько раз):', JSON.stringify(pkHist), '| направление километража:', branches.map(b => b.id + (b.chainDir > 0 ? '↑' : '↓')).join(' '));

// ---------- 11. Границы стран ----------
const bordersFile = path.join(here, 'cache', 'countries-10m.json');
if (!fs.existsSync(bordersFile)) { fs.mkdirSync(path.dirname(bordersFile), { recursive: true }); fs.writeFileSync(bordersFile, Buffer.from(await (await fetch('https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-10m.json')).arrayBuffer())); }
const topo = JSON.parse(fs.readFileSync(bordersFile, 'utf8'));
const T = PROJ.terrain;
const inBox = ([lon, lat]) => lon > T.lonMin - 0.3 && lon < T.lonMax + 0.3 && lat > T.latMin - 0.3 && lat < T.latMax + 0.3;
const toXZ = ([lon, lat]) => geoProject(lon, lat).map(v => +v.toFixed(2));
function clipLines(ml) {
  const out = [];
  for (const line of ml) { let cur = []; for (const p of line) { if (inBox(p)) { const q = toXZ(p), l = cur[cur.length - 1]; if (!l || Math.hypot(q[0] - l[0], q[1] - l[1]) > 0.25) cur.push(q); } else { if (cur.length > 1) out.push(cur); cur = []; } } if (cur.length > 1) out.push(cur); }
  return out;
}
const TJ = '762';
// Госграница Таджикистана — точная, из OpenStreetMap (отношение 214626); границы соседей между собой — Natural Earth 1:10m
const osmBorderFile = path.join(here, 'cache', 'osm-tj-border.geojson');
if (!fs.existsSync(osmBorderFile)) fs.writeFileSync(osmBorderFile, Buffer.from(await (await fetch('https://polygons.openstreetmap.fr/get_geojson.py?id=214626&params=0')).arrayBuffer()));
const osmGeom = JSON.parse(fs.readFileSync(osmBorderFile, 'utf8'));
const osmPolys = (osmGeom.geometries ? osmGeom.geometries[0] : osmGeom).coordinates;
const thin = ring => { const out = []; for (const p of ring) { const q = toXZ(p), l = out[out.length - 1]; if (!l || Math.hypot(q[0] - l[0], q[1] - l[1]) > 0.2) out.push(q); } out.push(toXZ(ring[ring.length - 1])); return out; };
const tjPolys = osmPolys.map(poly => poly.map(thin));
const tjBorder = tjPolys.flatMap(poly => poly);
const otherBorders = clipLines(topojson.mesh(topo, topo.objects.countries, (a, b) => a !== b && a.id !== TJ && b.id !== TJ).coordinates);
const inside = (x, z) => { let c = false; for (const poly of tjPolys) for (const ring of poly) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, zi] = ring[i], [xj, zj] = ring[j]; if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c; } return c; };

const LABELS = [
  { t: 'Узбекистан', k: 'country', ll: [40.85, 68.45] }, { t: 'Узбекистан', k: 'country', ll: [38.2, 67.45] },
  { t: 'Кыргызстан', k: 'country', ll: [40.45, 73.3] }, { t: 'Афганистан', k: 'country', ll: [36.75, 69.6] },
  { t: 'Китай', k: 'country', ll: [38.0, 75.25] },
  { t: 'Согдийская область', k: 'region', ll: [39.55, 68.9] }, { t: 'Хатлонская область', k: 'region', ll: [37.45, 69.25] },
  { t: 'РРП', k: 'region', ll: [38.95, 70.4] }, { t: 'ГБАО', k: 'region', ll: [38.25, 73.2] },
].map(l => { const [x, z] = geoProject(l.ll[1], l.ll[0]); const inTj = inside(x, z); if ((l.k === 'country') === inTj) console.warn('  ! подпись не там:', l.t, inTj ? 'внутри TJ' : 'вне TJ'); return { t: l.t, k: l.k, x: +x.toFixed(2), z: +z.toFixed(2) }; });

// ---------- 12. Вывод ----------
const R3 = v => +v.toFixed(3);
const parseChain = c => (c || '').split('/').map(x => x.replace(/км/i, '').trim()).filter(Boolean).map(x => { const m = x.match(/^(\d+)(?:\+(\d+))?$/); return m ? +m[1] + (m[2] ? +m[2] / 1000 : 0) : null; }).filter(v => v != null);
const outBranches = [], outForeign = [];
for (const b of branches) {
  // делим на «наши» куски и иностранные
  let cur = null;
  const flush = () => { if (!cur || cur.pts.length < 2) return;
    if (cur.foreign) { const f = b.foreign.find(f => cur.d0 >= f.from - 2 && cur.d0 <= f.to + 2); outForeign.push({ section: b.section, name: f.station.name, pts: cur.pts }); }
    else outBranches.push({ id: b.id, section: b.section, name: b.name, pts: cur.pts }); };
  for (const d of b.dList) {
    const f = b.isForeignAt(d), w = b.warp(d), p = [R3(w.re), R3(w.im)];
    if (!cur || f !== cur.foreign) { const last = cur && cur.pts[cur.pts.length - 1]; flush(); cur = { foreign: f, d0: d, pts: last ? [last] : [] }; }
    cur.pts.push(p);
  }
  flush();
}
const plen = pts => { let s = 0; for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i-1][0], pts[i][1] - pts[i-1][1]); return s; };

// ---------- 12a. Участки, нарисованные на чертеже условно: форма — реальный путь (OSM), отметки — по пикетажу ----------
const realTracks = [];
const REAL = JSON.parse(fs.readFileSync(path.join(here, 'real-tracks.json'), 'utf8')).tracks;
for (const rt of REAL) {
  const ob = outBranches.find(o => o.id === rt.branch);
  const sFrom = stations.find(s => s.name === rt.from), sTo = stations.find(s => isBorder(s) && s.chain === rt.toChain);
  const wF = sFrom.branch.warp(sFrom.atDraw), wT = sTo.branch.warp(sTo.atDraw);
  const nearestIdx = w => ob.pts.reduce((bi, p, i) => Math.hypot(p[0] - w.re, p[1] - w.im) < Math.hypot(ob.pts[bi][0] - w.re, ob.pts[bi][1] - w.im) ? i : bi, 0);
  const i0 = nearestIdx(wF), i1 = nearestIdx(wT);
  if (i0 >= i1) throw new Error('real-tracks: станции в обратном порядке для ' + rt.from);
  // реальный путь: обрезаем начало ровно по станции
  let pts = rt.coords.map(([la, lo]) => geoProject(lo, la));
  let bestI = 0, bestT = 0, bestD = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i], dx = bx - ax, dz = bz - az, ll = dx * dx + dz * dz;
    const t = ll ? Math.max(0, Math.min(1, ((wF.re - ax) * dx + (wF.im - az) * dz) / ll)) : 0;
    const d = Math.hypot(ax + t * dx - wF.re, az + t * dz - wF.im); if (d < bestD) { bestD = d; bestI = i; bestT = t; }
  }
  pts = [[wF.re, wF.im], ...pts.slice(bestI)];
  pts[pts.length - 1] = [wT.re, wT.im];
  pts = pts.map(p => [R3(p[0]), R3(p[1])]);
  ob.pts = [...ob.pts.slice(0, i0), ...pts, ...ob.pts.slice(i1 + 1)];
  // отметки: км (целые) и пикеты (каждые 100 м), равномерно по пикетажу от chainFrom до chainTo
  const cumR = [0]; for (let i = 1; i < pts.length; i++) cumR.push(cumR[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const Lr = cumR[cumR.length - 1], span = rt.chainFrom - rt.chainTo;
  const at = s => { let i = 1; while (i < cumR.length - 1 && cumR[i] < s) i++; const t = (s - cumR[i - 1]) / (cumR[i] - cumR[i - 1] || 1); return [pts[i - 1][0] + t * (pts[i][0] - pts[i - 1][0]), pts[i - 1][1] + t * (pts[i][1] - pts[i - 1][1])]; };
  let km = 0, pk = 0;
  for (let k = Math.ceil(rt.chainTo * 10 + 1e-6); k < rt.chainFrom * 10 - 1e-6; k++) {
    const c = k / 10, s = ((rt.chainFrom - c) / span) * Lr;
    const [x, z] = at(s), [x1, z1] = at(Math.max(0, s - 0.03)), [x2, z2] = at(Math.min(Lr, s + 0.03));
    const ang = Math.atan2(z2 - z1, x2 - x1) + Math.PI / 2;
    const tick = [R3(x), R3(z), +ang.toFixed(3), sFrom.branch.section, 1, ((k % 10) + 10) % 10];
    if (k % 10 === 0) { ticks.km.push(tick); km++; } else { ticks.pk.push(tick); pk++; }
  }
  const mid = at(Lr / 2);
  realTracks.push({ from: rt.from, toChain: rt.toChain, branch: rt.branch, length: R3(Lr), chainFrom: rt.chainFrom, chainTo: rt.chainTo, source: rt.source, mid: [R3(mid[0]), R3(mid[1])] });
  console.log('  реальный путь', rt.from, '— Сархад', rt.toChain + ':', Lr.toFixed(1), 'км (по пикетажу', span.toFixed(1), 'км), рассчитано км-отметок', km, ', пикетов', pk);
}
for (const ob of outBranches) ob.length = R3(plen(ob.pts));
const outStations = stations.filter(s => !isForeign(s)).map(s => {
  const w = s.branch.warp(s.atDraw);
  const bOut = outBranches.find(o => o.id === s.branch.id);
  let at = 0; { let best = Infinity, acc = 0; for (let i = 0; i < bOut.pts.length; i++) { if (i) acc += Math.hypot(bOut.pts[i][0] - bOut.pts[i-1][0], bOut.pts[i][1] - bOut.pts[i-1][1]); const d = Math.hypot(bOut.pts[i][0] - w.re, bOut.pts[i][1] - w.im); if (d < best) { best = d; at = acc; } } }
  return { id: s.id, name: s.name || null, chain: s.chain, km: parseChain(s.chain), note: s.note, section: s.branch.section, branch: s.branch.id, at: R3(at), x: R3(w.re), z: R3(w.im),
    junction: s.junction, border: isBorder(s) || undefined, geo: !!geoOf(s) };
}).sort((a, b) => order.indexOf(a.branch) - order.indexOf(b.branch) || a.at - b.at);
const foreignStations = stations.filter(isForeign).map(s => { const w = s.branch.warp(s.atDraw); return { name: s.name, country: 'Узбекистан', x: R3(w.re), z: R3(w.im), section: s.branch.section }; });

const out = {
  source: path.basename(dwgPath), generated: new Date().toISOString().slice(0, 10),
  sections: SECTIONS.map(s => ({ id: s.id, name: s.name, region: s.region, color: s.color,
    length: R3(outBranches.filter(b => b.section === s.id).reduce((a, b) => a + b.length, 0)),
    branches: outBranches.filter(b => b.section === s.id) })),
  foreign: outForeign, foreignStations,
  stations: outStations,
  ticks,
  borders: { tj: tjBorder, other: otherBorders, tjPolys },
  labels: LABELS,
  realTracks,
};
fs.writeFileSync(path.join(root, 'data.js'), '// Сгенерировано tools/build-data.mjs из ' + out.source + '\nwindow.RAIL_DATA = ' + JSON.stringify(out) + ';\n');
console.log('Участков:', out.sections.length, '| станций (наших):', outStations.filter(s => !s.border).length, '| Сархад:', outStations.filter(s => s.border).length, '| км-отметок:', ticks.km.length, '| пикетов:', ticks.pk.length);
for (const s of out.sections) console.log(' ', s.name.padEnd(20), s.length.toFixed(1).padStart(6), 'км —', outStations.filter(x => x.section === s.id).map(x => x.name + (x.geo ? '' : '°')).join(', '));
console.log('  иностранные отрезки:', outForeign.map(f => f.name + ' ' + plen(f.pts).toFixed(1) + ' км').join(', '));
console.log('  развилки:', outStations.filter(s => s.junction).map(s => s.name + '→' + s.junction.join('+')).join(', '));
