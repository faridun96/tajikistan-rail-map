import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const DATA = window.RAIL_DATA;
const $ = (s) => document.querySelector(s);
const kmText = (c) => 'КМ ' + c.replace(/\s*км/gi, '').replace(' / ', ' · ');
const fmtKm = (v) => (v < 10 ? v.toFixed(1) : Math.round(v)).toString().replace('.', ',') + ' км';
const BG = new THREE.Color('#04070d');
const EX = 3;          // вертикальное преувеличение рельефа
const LIFT = 0.1;      // подъём путей над поверхностью, км

// ============================================================
//  Рендер
// ============================================================
const container = $('#scene');
let renderer;
try { renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' }); }
catch (err) {
  container.innerHTML = '<div style="position:fixed;inset:0;display:grid;place-items:center;color:#8d9bb5;font-size:15px;text-align:center;padding:24px">' +
    'Браузер не поддерживает WebGL или аппаратное ускорение отключено.<br>Откройте карту в Chrome, Edge или Firefox с включённым ускорением.</div>';
  throw err;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
container.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(innerWidth, innerHeight);
Object.assign(labelRenderer.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
container.appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
scene.background = BG;
scene.fog = new THREE.FogExp2(BG, 0.002);

const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.1, 6000);
const controls = new MapControls(camera, renderer.domElement);
Object.assign(controls, { enableDamping: true, dampingFactor: 0.08, minDistance: 1.2, maxDistance: 1500, maxPolarAngle: 1.25, zoomToCursor: true, screenSpacePanning: false });

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.4, 0.45, 0.25);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// ============================================================
//  Реальный рельеф: загрузка карты высот
// ============================================================
async function loadTerrain() {
  const meta = await (await fetch('terrain.json')).json();
  const blob = await (await fetch('terrain.png')).blob();
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const cv = document.createElement('canvas'); cv.width = bmp.width; cv.height = bmp.height;
  const ctx = cv.getContext('2d', { willReadFrequently: true }); ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
  const n = bmp.width * bmp.height, km = new Float32Array(n);
  for (let i = 0; i < n; i++) km[i] = (px[i * 4] * 256 + px[i * 4 + 1]) / 1000;
  return { meta, km };
}

// ============================================================
//  Старт
// ============================================================
const loader = $('#loader');
const T = await loadTerrain().catch((e) => { loader.textContent = 'Не удалось загрузить рельеф: ' + e.message; throw e; });
const M = T.meta, TW = M.width, TH = M.height, PX = M.kmPerPx;
const sizeX = TW * PX, sizeZ = TH * PX;

// точная высота (км) по карте высот
function heightKm(x, z) {
  const fx = (x - M.xMin) / PX - 0.5, fz = (z - M.zMin) / PX - 0.5;
  const i = Math.max(0, Math.min(TW - 2, Math.floor(fx))), j = Math.max(0, Math.min(TH - 2, Math.floor(fz)));
  const u = Math.max(0, Math.min(1, fx - i)), v = Math.max(0, Math.min(1, fz - j));
  const a = T.km[j * TW + i], b = T.km[j * TW + i + 1], c = T.km[(j + 1) * TW + i], d = T.km[(j + 1) * TW + i + 1];
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

// --- сетка поверхности (шаг 3 пикселя = 1,2 км) ---
const STEP = 3;
const GW = Math.floor((TW - 1) / STEP) + 1, GH = Math.floor((TH - 1) / STEP) + 1;
const gridH = new Float32Array(GW * GH);
for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) gridH[j * GW + i] = T.km[(j * STEP) * TW + i * STEP];
const gx0 = M.xMin + PX / 2, gz0 = M.zMin + PX / 2, GS = STEP * PX;
// высота так, как её рисует сетка (на неё «кладём» пути и станции)
function meshH(x, z) {
  const fx = (x - gx0) / GS, fz = (z - gz0) / GS;
  const i = Math.max(0, Math.min(GW - 2, Math.floor(fx))), j = Math.max(0, Math.min(GH - 2, Math.floor(fz)));
  const u = Math.max(0, Math.min(1, fx - i)), v = Math.max(0, Math.min(1, fz - j));
  // те же два треугольника, что у PlaneGeometry-подобной сетки (диагональ a-d)
  const a = gridH[j * GW + i], b = gridH[j * GW + i + 1], c = gridH[(j + 1) * GW + i], d = gridH[(j + 1) * GW + i + 1];
  return u + v <= 1 ? a + (b - a) * u + (c - a) * v : d + (c - d) * (1 - u) + (b - d) * (1 - v);
}

let relief = 1, reliefTarget = 1;
const yAt = (x, z) => meshH(x, z) * EX * relief + LIFT;

const terrainGeo = new THREE.BufferGeometry();
{
  const pos = new Float32Array(GW * GH * 3);
  for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
    const k = (j * GW + i) * 3; pos[k] = gx0 + i * GS; pos[k + 1] = gridH[j * GW + i] * EX; pos[k + 2] = gz0 + j * GS;
  }
  const idx = new Uint32Array((GW - 1) * (GH - 1) * 6); let p = 0;
  for (let j = 0; j < GH - 1; j++) for (let i = 0; i < GW - 1; i++) {
    const a = j * GW + i, b = a + 1, c = a + GW, d = c + 1;
    idx[p++] = a; idx[p++] = c; idx[p++] = b; idx[p++] = b; idx[p++] = c; idx[p++] = d;
  }
  terrainGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  terrainGeo.setIndex(new THREE.BufferAttribute(idx, 1));
}

// текстура высот (полуточная, с линейной фильтрацией) — для теней и изолиний
const half = new Uint16Array(TW * TH);
for (let i = 0; i < half.length; i++) half[i] = THREE.DataUtils.toHalfFloat(T.km[i]);
const heightTex = new THREE.DataTexture(half, TW, TH, THREE.RedFormat, THREE.HalfFloatType);
heightTex.minFilter = heightTex.magFilter = THREE.LinearFilter; heightTex.needsUpdate = true;

// маска «внутри Таджикистана»
function buildCountryMask() {
  const w = 1024, h = Math.round((1024 * TH) / TW);
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#fff'; ctx.beginPath();
  for (const poly of DATA.borders.tjPolys) for (const ring of poly) ring.forEach(([x, z], i) => {
    const a = ((x - M.xMin) / sizeX) * w, b = ((z - M.zMin) / sizeZ) * h; i ? ctx.lineTo(a, b) : ctx.moveTo(a, b);
  });
  ctx.fill('evenodd');
  const tex = new THREE.CanvasTexture(cv); tex.flipY = false; tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

const terrainUniforms = {
  uHeight: { value: heightTex }, uMask: { value: buildCountryMask() },
  uMin: { value: new THREE.Vector2(M.xMin, M.zMin) }, uSize: { value: new THREE.Vector2(sizeX, sizeZ) },
  uTexel: { value: new THREE.Vector2(1 / TW, 1 / TH) }, uPx: { value: PX },
  uRelief: { value: 1 }, uEx: { value: EX }, uBg: { value: BG.clone() }, uFog: { value: scene.fog.density },
};
const terrainMat = new THREE.ShaderMaterial({
  uniforms: terrainUniforms,
  vertexShader: /* glsl */`
    uniform float uRelief; varying vec3 vPos; varying float vDepth;
    void main(){
      vec3 p = position; p.y *= uRelief;
      vPos = p; vec4 mv = modelViewMatrix * vec4(p, 1.0); vDepth = -mv.z;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D uHeight, uMask; uniform vec2 uMin, uSize, uTexel; uniform float uPx, uEx, uRelief, uFog; uniform vec3 uBg;
    varying vec3 vPos; varying float vDepth;
    float H(vec2 uv){ return texture2D(uHeight, uv).r; }
    float iso(float v, float w){ float d = abs(fract(v - 0.5) - 0.5) / max(fwidth(v), 1e-5); return 1.0 - smoothstep(0.0, w, d); }
    void main(){
      vec2 uv = (vPos.xz - uMin) / uSize;
      float h = H(uv);                                   // км над уровнем моря
      float hl = H(uv - vec2(uTexel.x, 0.0)), hr = H(uv + vec2(uTexel.x, 0.0));
      float hu = H(uv - vec2(0.0, uTexel.y)), hd = H(uv + vec2(0.0, uTexel.y));
      vec3 n = normalize(vec3(-(hr - hl) * uEx / (2.0 * uPx), 1.0, -(hd - hu) * uEx / (2.0 * uPx)));
      float shade = clamp(dot(n, normalize(vec3(-0.6, 0.7, -0.4))), 0.0, 1.0);
      // гипсометрическая окраска по реальной высоте
      vec3 c0 = vec3(0.012, 0.032, 0.036);   // долины 300–800 м
      vec3 c1 = vec3(0.022, 0.040, 0.052);   // предгорья
      vec3 c2 = vec3(0.045, 0.055, 0.075);   // горы 2–3 км
      vec3 c3 = vec3(0.095, 0.105, 0.135);   // высокогорье
      vec3 c4 = vec3(0.42, 0.47, 0.55);      // снега > 4,5 км
      vec3 col = mix(c0, c1, smoothstep(0.6, 1.4, h));
      col = mix(col, c2, smoothstep(1.4, 2.8, h));
      col = mix(col, c3, smoothstep(2.8, 4.2, h));
      col = mix(col, c4, smoothstep(4.3, 5.4, h) * 0.75);
      col *= 0.35 + 1.15 * shade;
      // изолинии: каждые 250 м, утолщённые — каждые 1000 м
      col += vec3(0.10, 0.22, 0.32) * (iso(h * 4.0, 1.0) * 0.07 + iso(h, 1.2) * 0.13);
      // за пределами Таджикистана — темнее и бледнее
      float inside = texture2D(uMask, uv).r;
      float g = dot(col, vec3(0.3, 0.55, 0.15));
      col = mix(mix(vec3(g), col, 0.35) * 0.42, col, inside);
      // туман и край карты
      float fog = 1.0 - exp(-pow(uFog * vDepth, 2.0));
      vec2 e = abs(uv - 0.5) * 2.0;
      float edge = smoothstep(0.86, 1.0, max(e.x, e.y));
      col = mix(col, uBg, clamp(max(fog, edge), 0.0, 1.0));
      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
});
const terrain = new THREE.Mesh(terrainGeo, terrainMat);
terrain.frustumCulled = false;
scene.add(terrain);

// ============================================================
//  Данные сети
// ============================================================
const sectionById = {};
const branchById = {};
for (const s of DATA.sections) {
  s.col = new THREE.Color(s.color); s.stations = []; sectionById[s.id] = s;
  for (const b of s.branches) { b.sec = s; b.stations = []; branchById[b.id] = b; }
}
const MAJOR = new Set(['Худжанд', 'Дашанбе-1', 'Дашанбе-2', 'Кулоб', 'Вахдат', 'Исфара', 'Хатлон', 'Вахш', 'Конибодом', 'Регар', 'Ёвон', 'Шахритус', 'Дангара']);
DATA.stations.forEach((s, i) => {
  s.idx = i; s.title = s.name || 'Без подписи';
  s.sec = sectionById[s.section]; s.br = branchById[s.branch];
  s.sec.stations.push(s); s.br.stations.push(s);
  s.prio = (MAJOR.has(s.name) ? 3 : 0) + (s.junction ? 2 : 0) + (s.border ? 1 : 0) + (s.name ? 1 : -2);
  s.elev = Math.round(heightKm(s.x, s.z) * 1000);
  s.pos = new THREE.Vector3(s.x, 0, s.z);
});
for (const b of Object.values(branchById)) b.stations.sort((a, c) => a.at - c.at);
const ourStations = DATA.stations.filter((s) => !s.border);

// уплотнение линии (чтобы ровно лежала на рельефе)
function densify(pts, step) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    if (i) { const [x0, z0] = pts[i - 1], [x1, z1] = pts[i], n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / step);
      for (let k = 1; k < n; k++) out.push([x0 + ((x1 - x0) * k) / n, z0 + ((z1 - z0) * k) / n]); }
    out.push(pts[i]);
  }
  return out;
}
const bounds = new THREE.Box3();
for (const s of DATA.sections) for (const b of s.branches) for (const [x, z] of b.pts) bounds.expandByPoint(new THREE.Vector3(x, 0, z));

// ============================================================
//  Линии на рельефе: пути, границы
// ============================================================
const lineMats = [];
const draped = [];   // всё, что надо пересчитать при смене рельефа
function drapedLine(pts2d, step, mats, extraLift = 0) {
  const p2 = densify(pts2d, step);
  const geo = new LineGeometry();
  const objs = mats.map((m) => { const o = new Line2(geo, m); o.frustumCulled = false; scene.add(o); if (!lineMats.includes(m)) lineMats.push(m); return o; });
  const item = { p2, geo, objs, extraLift, update() {
    const pos = new Float32Array(p2.length * 3);
    p2.forEach(([x, z], i) => { pos[i * 3] = x; pos[i * 3 + 1] = yAt(x, z) + extraLift; pos[i * 3 + 2] = z; });
    geo.setPositions(pos); if (objs.some((o) => o.material.dashed)) objs.forEach((o) => o.computeLineDistances());
  } };
  item.update(); draped.push(item);
  return item;
}
const LM = (o) => new LineMaterial({ transparent: true, depthWrite: false, ...o });

// границы
const tjBorderMat = LM({ color: new THREE.Color('#ff7d8c'), linewidth: 1.8, opacity: 0.75 });
const tjBorderGhost = LM({ color: new THREE.Color('#ff7d8c'), linewidth: 1.2, opacity: 0.18, depthTest: false });
for (const l of DATA.borders.tj) drapedLine(l, 1.0, [tjBorderGhost, tjBorderMat], 0.05).objs.forEach((o, i) => (o.renderOrder = i ? 2 : 1));
const otherMat = LM({ color: new THREE.Color('#8391ad'), linewidth: 1, opacity: 0.35 });
for (const l of DATA.borders.other) drapedLine(l, 1.5, [otherMat], 0.05);

// пути: подложка-свечение, призрак сквозь горы, основная линия, «шпалы» вблизи
for (const s of DATA.sections) {
  s.mats = {
    ghost: LM({ color: s.col, linewidth: 2.5, opacity: 0.35, depthTest: false }),
    glow: LM({ color: s.col.clone().multiplyScalar(0.9), linewidth: 10, opacity: 0.13 }),
    base: LM({ color: s.col, linewidth: 3.6, opacity: 1 }),
    dash: LM({ color: 0xffffff, linewidth: 1.5, opacity: 0, dashed: true, dashSize: 0.5, gapSize: 0.5 }),
  };
  for (const b of s.branches) {
    b.line = drapedLine(b.pts, 0.35, [s.mats.ghost, s.mats.glow, s.mats.base, s.mats.dash]);
    b.line.objs.forEach((o, i) => (o.renderOrder = [3, 4, 5, 6][i]));
  }
}
// участки за границей (Узбекистан)
const foreignMat = LM({ color: new THREE.Color('#9aa6bd'), linewidth: 2, opacity: 0.55, dashed: true, dashSize: 0.6, gapSize: 0.5 });
for (const f of DATA.foreign) drapedLine(f.pts, 0.35, [foreignMat]);

// 3D-точки путей (для поездов) — берём из уплотнённой линии
function branchPath(b) {
  const v = b.line.p2.map(([x, z]) => new THREE.Vector3(x, 0, z));
  const cum = [0]; for (let i = 1; i < v.length; i++) cum.push(cum[i - 1] + Math.hypot(v[i].x - v[i - 1].x, v[i].z - v[i - 1].z));
  return { v, cum, total: cum[cum.length - 1] };
}
function refreshPathY(path) { for (const p of path.v) p.y = yAt(p.x, p.z); }
const paths = [];
for (const s of DATA.sections) for (const b of s.branches) { b.path = branchPath(b); paths.push(b.path); }
function pointAt(path, d, out) {
  d = Math.max(0, Math.min(path.total, d));
  let lo = 0, hi = path.cum.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (path.cum[m] <= d) lo = m; else hi = m; }
  const seg = path.cum[hi] - path.cum[lo];
  return out.lerpVectors(path.v[lo], path.v[hi], seg ? (d - path.cum[lo]) / seg : 0);
}

// ============================================================
//  Км-отметки и пикеты
// ============================================================
function buildTicks(list, w, len, opacity) {
  const geo = new THREE.PlaneGeometry(len, w); geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity, depthWrite: false });
  const mesh = new THREE.InstancedMesh(geo, mat, list.length);
  const c = new THREE.Color();
  const calc = new THREE.Color('#ffc861'); // отметки, рассчитанные по километражу (на чертеже их нет)
  list.forEach((t, i) => { if (t[4]) c.copy(calc); else c.copy(sectionById[t[3]].col).lerp(new THREE.Color(1, 1, 1), 0.55); mesh.setColorAt(i, c); });
  mesh.renderOrder = 7; mesh.frustumCulled = false; mesh.userData = { base: opacity, list };
  scene.add(mesh); return mesh;
}
const kmTicks = buildTicks(DATA.ticks.km, 0.05, 0.42, 0.6);
const pkTicks = buildTicks(DATA.ticks.pk, 0.022, 0.2, 0.5);

// Подписи пикетов ПК1…ПК9: одна текстура-атлас на все, рисуются точками (тысячи подписей без нагрузки на страницу)
const pkLabels = (() => {
  const cell = 64, cv = document.createElement('canvas'); cv.width = cell * 9; cv.height = cell;
  const ctx = cv.getContext('2d');
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = '700 21px Inter, system-ui, sans-serif'; ctx.lineJoin = 'round';
  for (let n = 1; n <= 9; n++) {
    const x = (n - 0.5) * cell, y = cell / 2;
    ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(4,7,13,0.92)'; ctx.strokeText('ПК' + n, x, y);
    ctx.fillStyle = '#fff'; ctx.fillText('ПК' + n, x, y);
  }
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
  const list = DATA.ticks.pk, n = list.length;
  const geo = new THREE.BufferGeometry();
  const num = new Float32Array(n), col = new Float32Array(n * 3);
  const cBase = new THREE.Color('#cfd8e8').multiplyScalar(0.8), cCalc = new THREE.Color('#ffc861').multiplyScalar(0.85);
  list.forEach((t, i) => { num[i] = t[5] || 0; const c = t[4] ? cCalc : cBase; col.set([c.r, c.g, c.b], i * 3); });
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geo.setAttribute('aNum', new THREE.BufferAttribute(num, 1));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTex: { value: tex }, uPR: { value: renderer.getPixelRatio() }, uSize: { value: 46 }, uOpacity: { value: 0 } },
    transparent: true, depthWrite: false, depthTest: false,
    vertexShader: `attribute float aNum; attribute vec3 aColor; varying float vNum; varying vec3 vC; uniform float uPR, uSize;
      void main(){ vNum = aNum; vC = aColor; gl_PointSize = uSize * uPR; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform sampler2D uTex; uniform float uOpacity; varying float vNum; varying vec3 vC;
      void main(){ if (vNum < 0.5) discard; vec4 t = texture2D(uTex, vec2((gl_PointCoord.x + vNum - 1.0) / 9.0, 1.0 - gl_PointCoord.y));
        if (t.a < 0.02) discard; gl_FragColor = vec4(mix(vec3(0.016, 0.027, 0.05), vC, t.r), t.a * uOpacity); }`,
  });
  const pts = new THREE.Points(geo, mat); pts.frustumCulled = false; pts.renderOrder = 13; pts.visible = false; scene.add(pts);
  return { pts, mat, list,
    place() { // подпись — у конца штриха пикета, сбоку от пути
      const a = geo.attributes.position.array;
      list.forEach(([x, z, ang], i) => { const ox = x + Math.cos(ang) * 0.2, oz = z + Math.sin(ang) * 0.2; a[i * 3] = ox; a[i * 3 + 1] = yAt(ox, oz) + 0.05; a[i * 3 + 2] = oz; });
      geo.attributes.position.needsUpdate = true;
    } };
})();
function placeTicks(mesh) {
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  mesh.userData.list.forEach(([x, z, a], i) => { p.set(x, yAt(x, z) + 0.02, z); q.setFromAxisAngle(up, -a); m.compose(p, q, s); mesh.setMatrixAt(i, m); });
  mesh.instanceMatrix.needsUpdate = true;
}

// ============================================================
//  Станции
// ============================================================
const ringGeo = new THREE.RingGeometry(0.62, 1, 40); ringGeo.rotateX(-Math.PI / 2);
const discGeo = new THREE.CircleGeometry(0.62, 40); discGeo.rotateX(-Math.PI / 2);
const haloGeo = new THREE.CircleGeometry(1, 48); haloGeo.rotateX(-Math.PI / 2);
const diamondGeo = new THREE.OctahedronGeometry(0.75, 0);
const beamGeo = new THREE.CylinderGeometry(0.09, 0.09, 1, 10, 1, true); beamGeo.translate(0, 0.5, 0);
const additive = (frag, vert, col) => new THREE.ShaderMaterial({
  uniforms: { uColor: { value: col }, uOpacity: { value: 0.6 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  vertexShader: vert, fragmentShader: frag,
});
const haloMat = (col) => additive(
  `uniform vec3 uColor; uniform float uOpacity; varying vec2 vUv; void main(){ float d = length(vUv - 0.5) * 2.0; float a = pow(1.0 - clamp(d,0.0,1.0), 2.2); gl_FragColor = vec4(uColor * a * uOpacity, 1.0); }`,
  `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`, col);
const beamMat = (col) => additive(
  `uniform vec3 uColor; uniform float uOpacity; varying float vY; void main(){ float a = pow(1.0 - vY, 1.6); gl_FragColor = vec4(uColor * a * uOpacity, 1.0); }`,
  `varying float vY; void main(){ vY = position.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`, col);

const RED = new THREE.Color('#ff4d5e');
for (const s of DATA.stations) {
  const g = new THREE.Group();
  const col = s.border ? RED : s.sec.col;
  const ringMat = new THREE.MeshBasicMaterial({ color: s.junction ? 0xffffff : col.clone().multiplyScalar(1.3), transparent: true, depthWrite: false, depthTest: false });
  const discMat = new THREE.MeshBasicMaterial({ color: s.junction ? col.clone().multiplyScalar(1.4) : 0x0b111c, transparent: true, depthWrite: false, depthTest: false });
  const disc = new THREE.Mesh(discGeo, discMat); disc.renderOrder = 9;
  const ring = new THREE.Mesh(ringGeo, ringMat); ring.renderOrder = 10;
  const halo = new THREE.Mesh(haloGeo, haloMat(col.clone())); halo.scale.setScalar(3.2); halo.renderOrder = 8;
  g.add(halo, disc, ring);
  const beamH = MAJOR.has(s.name) ? 7 : s.junction ? 5 : s.border ? 4 : 2.6;
  const beam = new THREE.Mesh(beamGeo, beamMat(col.clone())); beam.scale.y = beamH; beam.renderOrder = 11;
  g.add(beam);
  let diamond = null;
  if (s.border) { diamond = new THREE.Mesh(diamondGeo, new THREE.MeshBasicMaterial({ color: RED.clone().multiplyScalar(1.6) })); diamond.position.y = 2.2; diamond.scale.set(0.7, 1, 0.7); g.add(diamond); }
  s.obj = { g, ring, disc, halo, beam, diamond, ringMat, discMat, beamH };
  scene.add(g);
}

// ============================================================
//  Подписи
// ============================================================
for (const s of DATA.stations) {
  const anchor = document.createElement('div'); anchor.className = 'anchor';
  const el = document.createElement('div');
  el.className = 'st-label' + (s.prio >= 3 ? ' major' : '') + (s.border ? ' border' : '') + (s.name ? '' : ' unnamed');
  el.style.setProperty('--c', s.sec.color);
  el.innerHTML = '<span class="nm"></span><span class="ch"></span>';
  el.querySelector('.nm').textContent = s.border ? 'Сархад' : s.title;
  el.querySelector('.ch').textContent = s.chain ? kmText(s.chain) : '';
  el.addEventListener('click', (e) => { e.stopPropagation(); selectStation(s, true); });
  el.addEventListener('pointerenter', () => setHover(s));
  el.addEventListener('pointerleave', () => setHover(null));
  anchor.appendChild(el);
  const obj = new CSS2DObject(anchor); scene.add(obj);
  s.label = { el, obj };
}
// крупные подписи: страны, области, станции за границей
const bigLabels = [];
function addBig(text, x, z, cls) {
  const el = document.createElement('div'); el.className = cls; el.textContent = text;
  const o = new CSS2DObject(el); o.position.set(x, 0, z); scene.add(o);
  bigLabels.push({ el, o, x, z, cls }); return el;
}
for (const l of DATA.labels) addBig(l.t, l.x, l.z, l.k === 'country' ? 'geo-label country' : 'geo-label region');
for (const f of DATA.foreignStations) addBig('→ ' + f.name + ' (' + f.country + ')', f.x, f.z, 'geo-label foreign');
for (const r of DATA.realTracks || []) addBig('путь по OpenStreetMap · КМ и ПК рассчитаны', r.mid[0], r.mid[1], 'geo-label foreign calc');

// ============================================================
//  Поезда
// ============================================================
const TRAIL = 16, SPACING = 0.28;
const trains = [];
for (const s of DATA.sections) for (const b of s.branches) {
  const n = Math.max(1, Math.round(b.path.total / 40));
  for (let i = 0; i < n; i++) trains.push({ b, s, phase: (i / n) * 2 * b.path.total + Math.random() * 10, speed: 7 + Math.random() * 3 });
}
const trainGeo = new THREE.BufferGeometry();
const tPos = new Float32Array(trains.length * TRAIL * 3), tCol = new Float32Array(trains.length * TRAIL * 3), tSize = new Float32Array(trains.length * TRAIL);
trains.forEach((t, i) => {
  const c = t.s.col.clone().lerp(new THREE.Color(1, 1, 1), 0.35);
  for (let k = 0; k < TRAIL; k++) {
    const j = i * TRAIL + k, f = 1 - k / TRAIL, cc = k === 0 ? new THREE.Color(1, 1, 1) : c;
    tCol.set([cc.r * f, cc.g * f, cc.b * f], j * 3); tSize[j] = k === 0 ? 9 : 7 * f + 1.5;
  }
});
trainGeo.setAttribute('position', new THREE.BufferAttribute(tPos, 3));
trainGeo.setAttribute('aColor', new THREE.BufferAttribute(tCol, 3));
trainGeo.setAttribute('size', new THREE.BufferAttribute(tSize, 1));
const trainMat = new THREE.ShaderMaterial({
  uniforms: { uPR: { value: renderer.getPixelRatio() } }, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
  vertexShader: `attribute float size; attribute vec3 aColor; varying vec3 vC; uniform float uPR;
    void main(){ vC = aColor; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = size * uPR; gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `varying vec3 vC; void main(){ float d = length(gl_PointCoord - 0.5) * 2.0; float a = pow(max(0.0, 1.0 - d), 1.8); gl_FragColor = vec4(vC * a * 1.6, 1.0); }`,
});
const trainPoints = new THREE.Points(trainGeo, trainMat);
trainPoints.frustumCulled = false; trainPoints.renderOrder = 12; scene.add(trainPoints);
const tmpV = new THREE.Vector3();
function updateTrains(time) {
  trains.forEach((t, i) => {
    const P = t.b.path, L = P.total, s = (t.phase + time * t.speed) % (2 * L), d = s < L ? s : 2 * L - s, dir = s < L ? 1 : -1;
    for (let k = 0; k < TRAIL; k++) { pointAt(P, d - dir * k * SPACING, tmpV); tPos.set([tmpV.x, tmpV.y + 0.05, tmpV.z], (i * TRAIL + k) * 3); }
  });
  trainGeo.attributes.position.needsUpdate = true;
}

// ============================================================
//  Всё, что лежит на рельефе, — пересчёт высот
// ============================================================
function applyRelief() {
  terrainUniforms.uRelief.value = relief;
  for (const d of draped) d.update();
  for (const p of paths) refreshPathY(p);
  for (const s of DATA.stations) { s.pos.y = yAt(s.x, s.z); s.obj.g.position.copy(s.pos); s.label.obj.position.copy(s.pos); }
  for (const l of bigLabels) l.o.position.y = yAt(l.x, l.z) + (l.cls.includes('foreign') ? 0 : 1.5);
  placeTicks(kmTicks); placeTicks(pkTicks); pkLabels.place();
}
applyRelief();

// ============================================================
//  Интерфейс: статистика, легенда, поиск, карточка
// ============================================================
const totalLen = DATA.sections.reduce((a, s) => a + s.length, 0);
$('#stats').innerHTML = [
  [Math.round(totalLen), 'км путей'], [ourStations.length, 'станций'], [DATA.sections.length, 'участка'], [DATA.stations.length - ourStations.length, 'погранперехода'],
].map(([v, t]) => `<div class="stat"><b>${v}</b><span>${t}</span></div>`).join('');

const ul = $('#lines');
for (const s of DATA.sections) {
  const li = document.createElement('li');
  const n = s.stations.filter((x) => !x.border).length;
  li.innerHTML = `<i class="swatch" style="color:${s.color}"></i>
    <div><div class="ln-name"></div><div class="ln-sub"></div><div class="ln-branches"></div></div>
    <div class="ln-len">${fmtKm(s.length)}<small>${n} ст.</small></div>`;
  li.querySelector('.ln-name').textContent = s.name;
  li.querySelector('.ln-sub').textContent = s.region;
  li.querySelector('.ln-branches').innerHTML = s.branches.map(() => '<div></div>').join('');
  li.querySelectorAll('.ln-branches div').forEach((d, i) => (d.textContent = s.branches[i].name + ' · ' + fmtKm(s.branches[i].length)));
  li.addEventListener('click', () => focusSection(activeSection === s ? null : s));
  ul.appendChild(li); s.li = li;
}
$('#showAll').addEventListener('click', () => focusSection(null));

// Поиск
const search = $('#search'), results = $('#results');
const norm = (t) => t.toLowerCase().replace(/ё/g, 'е').replace(/ҷ/g, 'ч').replace(/ӯ/g, 'у').replace(/ҳ/g, 'х').replace(/қ/g, 'к').replace(/ғ/g, 'г').replace(/ӣ/g, 'и')
  .replace(/дж/g, 'ч').replace(/душ/g, 'даш');
let resIdx = 0, resList = [];
function renderResults() {
  const q = search.value.trim();
  if (!q) { results.classList.remove('open'); return; }
  resList = DATA.stations.filter((s) => norm(s.title).includes(norm(q)) || (s.chain || '').includes(q)).slice(0, 12);
  resIdx = 0;
  results.innerHTML = resList.length ? '' : '<div class="empty">Ничего не найдено</div>';
  resList.forEach((s, i) => {
    const b = document.createElement('button'); if (i === 0) b.className = 'active';
    b.innerHTML = `<i class="swatch" style="color:${s.border ? '#ff4d5e' : s.sec.color};width:14px"></i><span></span><small></small>`;
    b.querySelector('span').textContent = s.title;
    b.querySelector('small').textContent = s.chain ? kmText(s.chain) : '';
    b.addEventListener('click', () => { selectStation(s, true); results.classList.remove('open'); search.blur(); });
    results.appendChild(b);
  });
  results.classList.add('open');
}
search.addEventListener('input', renderResults);
search.addEventListener('focus', renderResults);
search.addEventListener('blur', () => setTimeout(() => results.classList.remove('open'), 150));
search.addEventListener('keydown', (e) => {
  const btns = [...results.querySelectorAll('button')];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault(); if (!btns.length) return;
    resIdx = (resIdx + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length;
    btns.forEach((b, i) => b.classList.toggle('active', i === resIdx));
  } else if (e.key === 'Enter' && resList[resIdx]) { selectStation(resList[resIdx], true); results.classList.remove('open'); search.blur(); }
  else if (e.key === 'Escape') { search.value = ''; results.classList.remove('open'); search.blur(); }
});

// расстояние между станциями: по километражу, если он согласуется с картой, иначе по карте
function distance(a, b) {
  const g = Math.abs(a.at - b.at);
  let best = null;
  for (const x of a.km || []) for (const y of b.km || []) { const d = Math.abs(x - y); if (d > g * 0.6 && d < g * 1.8 && (best == null || Math.abs(d - g) < Math.abs(best - g))) best = d; }
  return best != null ? { km: best, how: 'по километражу' } : { km: g, how: '≈ по карте' };
}

let selected = null;
function selectStation(s, fly) {
  if (selected) selected.label.el.classList.remove('selected');
  selected = s;
  if (!s) { $('#card').hidden = true; return; }
  s.label.el.classList.add('selected');
  const sec = s.sec;
  $('#cardLine').innerHTML = `<i style="background:${sec.color};box-shadow:0 0 8px ${sec.color}"></i><span></span>`;
  $('#cardLine span').textContent = sec.name + ' · ' + s.br.name;
  $('#cardName').textContent = s.border ? 'Сархад' : s.title;
  const badges = [];
  if (s.junction) badges.push(['white', 'Узловая станция']);
  if (MAJOR.has(s.name) && !s.junction) badges.push(['', 'Крупная станция']);
  if (s.border) badges.push(['red', 'Пограничный переход (Узбекистан)']);
  $('#cardBadges').innerHTML = badges.map(([c, t]) => `<span class="badge ${c}">${t}</span>`).join('');
  const facts = [];
  if (s.chain) facts.push(['Километр', kmText(s.chain)]);
  if (s.note) facts.push(['Примечание', s.note]);
  facts.push(['Высота', s.elev + ' м над уровнем моря']);
  facts.push(['Участок', sec.name + ' (' + sec.region + ')']);
  if (s.junction) facts.push(['Примыкание', s.junction.map((id) => branchById[id].name).join('; ')]);
  if (!s.geo && !s.border) facts.push(['Положение', 'по чертежу (нет точных координат)']);
  for (const r of DATA.realTracks || []) if (s.name === r.from || (s.border && s.chain === r.toChain))
    facts.push(['До Сархад', 'путь по OpenStreetMap (' + fmtKm(r.length) + '); КМ и ПК рассчитаны от КМ ' + r.chainFrom.toFixed(3).replace('.', '+') + ' до КМ ' + r.toChain]);
  $('#cardFacts').innerHTML = facts.map(() => '<dt></dt><dd></dd>').join('');
  const dts = $('#cardFacts').querySelectorAll('dt'), dds = $('#cardFacts').querySelectorAll('dd');
  facts.forEach(([k, v], i) => { dts[i].textContent = k; dds[i].textContent = v; });
  const nb = $('#cardNeighbors'); nb.innerHTML = '';
  const st = s.br.stations, i = st.indexOf(s);
  const addBtn = (n, arrow, sub, color) => {
    const b = document.createElement('button');
    b.innerHTML = `<span class="arrow"${color ? ` style="color:${color}"` : ''}>${arrow}</span><span></span><small></small>`;
    b.querySelector('span:nth-child(2)').textContent = n.border ? 'Сархад (граница)' : n.title;
    b.querySelector('small').textContent = sub;
    b.addEventListener('click', () => selectStation(n, true));
    nb.appendChild(b);
  };
  for (const [n, arrow] of [[st[i - 1], '←'], [st[i + 1], '→']]) if (n) { const d = distance(s, n); addBtn(n, arrow, fmtKm(d.km) + ' ' + d.how); }
  for (const id of s.junction || []) {
    const ob = branchById[id];
    const first = ob.stations.filter((x) => x !== s).sort((a, b) => a.pos.distanceTo(s.pos) - b.pos.distanceTo(s.pos))[0];
    if (first) addBtn(first, '↳', ob.name.split(' — ').slice(-1)[0], ob.sec.color);
  }
  $('#card').hidden = false;
  if (fly) flyTo(s.pos, Math.min(controls.getDistance(), 34), 0.85);
  dismissHint();
}
$('#cardClose').addEventListener('click', () => selectStation(null));

// Фокус на участке
let activeSection = null;
function focusSection(sec) {
  activeSection = sec;
  $('#showAll').hidden = !sec;
  for (const x of DATA.sections) {
    const on = !sec || x === sec;
    x.li.classList.toggle('active', x === sec); x.li.classList.toggle('dim', !on);
    x.mats.base.opacity = on ? 1 : 0.22; x.mats.glow.opacity = on ? 0.13 : 0.03; x.mats.ghost.opacity = on ? 0.35 : 0.08;
  }
  for (const s of DATA.stations) {
    const on = !sec || s.sec === sec;
    s.dim = !on;
    s.obj.ringMat.opacity = on ? 1 : 0.2; s.obj.discMat.opacity = on ? 1 : 0.2;
    s.obj.beam.visible = on; s.obj.halo.visible = on;
    s.label.el.classList.toggle('dim', !on);
  }
  const box = new THREE.Box3();
  for (const x of sec ? [sec] : DATA.sections) for (const b of x.branches) for (const [px, pz] of b.pts) box.expandByPoint(new THREE.Vector3(px, 0, pz));
  fitBox(box);
}

// ============================================================
//  Камера: перелёты
// ============================================================
let tween = null;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
function flyToState(target, position, dur = 1.4) {
  tween = { t0: performance.now(), dur: dur * 1000, fromT: controls.target.clone(), fromP: camera.position.clone(), toT: target.clone(), toP: position.clone() };
}
const sphericalAround = (target, dist, polar, az) => new THREE.Vector3().setFromSpherical(new THREE.Spherical(dist, polar, az)).add(target);
function currentAzimuth() { const o = camera.position.clone().sub(controls.target); return Math.atan2(o.x, o.z); }
function flyTo(target, dist, polar = 0.85, az = currentAzimuth()) {
  const t = target.clone(); t.y = yAt(t.x, t.z) - LIFT;
  flyToState(t, sphericalAround(t, dist, polar, az));
}
function fitBox(box, polar = 0.7) {
  const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const side = innerWidth > 760 ? 360 : 0;
  const effAspect = (innerWidth - side) / innerHeight;
  const needH = Math.max(size.z * 1.05, (size.x * 1.05) / effAspect) + 10;
  const dist = ((needH / 2) / Math.tan(fov / 2)) * 1.08;
  const shift = side ? (side / innerWidth) * dist * Math.tan(fov / 2) * camera.aspect * 0.95 : 0;
  const az = currentAzimuth();
  const target = c.clone().add(new THREE.Vector3(-Math.cos(az), 0, Math.sin(az)).multiplyScalar(shift));
  flyTo(target, Math.min(dist, controls.maxDistance), polar, az);
}

// ============================================================
//  Наведение и клики
// ============================================================
const tooltip = $('#tooltip');
let hovered = null;
function setHover(s) { hovered = s; renderer.domElement.style.cursor = s ? 'pointer' : ''; if (!s) tooltip.classList.remove('show'); }
const proj = new THREE.Vector3();
function stationAtScreen(x, y) {
  let best = null, bd = 16;
  for (const s of DATA.stations) {
    proj.copy(s.pos).project(camera); if (proj.z > 1) continue;
    const d = Math.hypot((proj.x * 0.5 + 0.5) * innerWidth - x, (-proj.y * 0.5 + 0.5) * innerHeight - y);
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}
let downAt = null;
renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; dismissHint(); });
renderer.domElement.addEventListener('pointermove', (e) => {
  const s = stationAtScreen(e.clientX, e.clientY);
  setHover(s);
  if (s) {
    tooltip.innerHTML = '<span></span><small></small>';
    tooltip.firstChild.textContent = s.border ? 'Сархад' : s.title; tooltip.lastChild.textContent = s.chain ? kmText(s.chain) : '';
    tooltip.style.left = e.clientX + 'px'; tooltip.style.top = e.clientY + 'px'; tooltip.classList.add('show');
  }
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  const s = stationAtScreen(e.clientX, e.clientY); if (s) selectStation(s, true);
});
renderer.domElement.addEventListener('pointerleave', () => setHover(null));

// ============================================================
//  Переключатели и виды
// ============================================================
const toggles = { labels: true, chain: true, ticks: true, relief: true, trains: true };
document.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', () => {
  const k = b.dataset.toggle; toggles[k] = !toggles[k]; b.classList.toggle('on', toggles[k]);
  if (k === 'relief') reliefTarget = toggles.relief ? 1 : 0;
  if (k === 'trains') trainPoints.visible = toggles.trains;
}));
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
  const v = b.dataset.view, d = controls.getDistance();
  if (v === 'top') flyTo(controls.target, d, 0.001, 0);
  if (v === '3d') flyTo(controls.target, d, 0.95);
  if (v === 'reset') { selectStation(null); focusSection(null); }
  if (v === 'country') { selectStation(null); fitBox(new THREE.Box3(new THREE.Vector3(M.xMin + 20, 0, M.zMin + 20), new THREE.Vector3(M.xMin + sizeX - 20, 0, M.zMin + sizeZ - 20)), 0.75); }
}));
$('#compass').addEventListener('click', () => flyTo(controls.target, controls.getDistance(), Math.max(0.001, controls.getPolarAngle()), 0));
const hintEl = $('#hint');
function dismissHint() { hintEl.classList.add('gone'); }
setTimeout(dismissHint, 9000);
$('#legendToggle').addEventListener('click', () => $('#legend').classList.toggle('open'));
addEventListener('keydown', (e) => {
  if (e.target === search) return;
  if (e.key === 'Escape') selectStation(null);
  if (e.key === '/') { e.preventDefault(); search.focus(); }
});

// ============================================================
//  Подписи: раскладка без наложений
// ============================================================
let markerSc = 1;
const labelOrder = DATA.stations.slice().sort((a, b) => b.prio - a.prio);
function layoutLabels(dist) {
  const W = innerWidth, H = innerHeight, rects = [];
  const showChain = toggles.chain && dist < 95;
  const overlaps = (r) => rects.some((o) => r.x < o.x + o.w && r.x + r.w > o.x && r.y < o.y + o.h && r.y + r.h > o.y);
  const pts = new Map();
  for (const s of DATA.stations) {
    proj.copy(s.pos).project(camera);
    const sx = (proj.x * 0.5 + 0.5) * W, sy = (-proj.y * 0.5 + 0.5) * H;
    pts.set(s, [sx, sy, proj.z < 1]);
    if (proj.z < 1) rects.push({ x: sx - 6, y: sy - 6, w: 12, h: 12 });
  }
  for (const el of [$('#card'), $('.title-card'), $('#legend'), $('#toolbar')]) {
    if (!el || el.hidden || el.getClientRects().length === 0) continue;
    const r = el.getBoundingClientRect(); rects.push({ x: r.left, y: r.top, w: r.width, h: r.height });
  }
  const kmPerPx = (2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / H;
  const minPrio = dist > 420 ? 4 : dist > 300 ? 3 : dist > 200 ? 2 : dist > 130 ? 1 : -99;
  const todo = [];
  for (const s of labelOrder) {
    const el = s.label.el, [, , vis] = pts.get(s);
    const chain = (showChain && s.chain && (s.prio >= 1 || dist < 60)) || (s === selected && !!s.chain);
    el.classList.toggle('nochain', !chain);
    let want = toggles.labels && vis && (s.prio >= minPrio || s === selected || s === hovered);
    if (s.dim && s !== selected) want = want && dist < 120;
    if (want) todo.push(s); else el.classList.remove('show');
  }
  for (const s of todo) { s.label.w = s.label.el.offsetWidth || s.title.length * 8 + 4; s.label.h = s.label.el.offsetHeight || 18; }
  for (const s of todo) {
    const L = s.label, el = L.el, [sx, sy] = pts.get(s), w = L.w, h = L.h;
    const off = Math.max(8, (markerSc * (s.prio >= 3 ? 1.25 : 1) * (s === hovered || s === selected ? 1.45 : 1)) / kmPerPx + 5);
    const cands = [['r', sx + off, sy - h / 2], ['l', sx - off - w, sy - h / 2], ['t', sx - w / 2, sy - h - off], ['b', sx - w / 2, sy + off]];
    let placed = null;
    for (const [side, x, y] of cands) { const r = { x, y, w, h }; if (s === selected || !overlaps(r)) { placed = [side, r]; break; } }
    if (!placed) { el.classList.remove('show'); continue; }
    const [side, r] = placed; rects.push(r);
    el.style.left = r.x - sx + 'px'; el.style.top = r.y - sy + 'px';
    el.style.textAlign = side === 'l' ? 'right' : side === 'r' ? 'left' : 'center';
    el.classList.add('show');
  }
  // крупные подписи: страны видны издалека, области — на среднем масштабе, «за границей» — вблизи
  for (const l of bigLabels) {
    const op = l.cls.includes('country') ? THREE.MathUtils.smoothstep(dist, 140, 320)
      : l.cls.includes('region') ? THREE.MathUtils.smoothstep(dist, 90, 200) * (1 - THREE.MathUtils.smoothstep(dist, 700, 1100))
      : 1 - THREE.MathUtils.smoothstep(dist, 60, 140);
    l.el.style.opacity = toggles.labels ? op : 0;
  }
}

// ============================================================
//  HUD
// ============================================================
const needle = $('#compass .needle'), scaleBar = $('#scaleBar'), scaleText = $('#scaleText');
function updateHud(dist) {
  needle.style.transform = `rotate(${THREE.MathUtils.radToDeg(controls.getAzimuthalAngle())}deg)`;
  const kmPerPx = (2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / innerHeight;
  const target = kmPerPx * 110, p = Math.pow(10, Math.floor(Math.log10(target)));
  const nice = [1, 2, 5, 10].map((m) => m * p).filter((v) => v <= target).pop() || p;
  scaleBar.style.width = nice / kmPerPx + 'px';
  scaleText.textContent = nice >= 1 ? `${nice} км` : `${Math.round(nice * 1000)} м`;
}

// ============================================================
//  Запуск и цикл
// ============================================================
const netCenter = bounds.getCenter(new THREE.Vector3());
camera.position.copy(sphericalAround(netCenter, 1400, 0.3, 0));
controls.target.copy(netCenter);
controls.update();
const intro = { t0: performance.now(), dur: 2600 };

function applyHash() {
  const h = new URLSearchParams(decodeURIComponent(location.hash.slice(1)));
  const st = h.get('s') && DATA.stations.find((x) => norm(x.title) === norm(h.get('s')));
  const sec = h.get('l') && sectionById[h.get('l')];
  if (st) { selectStation(st, true); if (h.get('d')) flyTo(st.pos, +h.get('d'), h.get('top') ? 0.001 : 0.85); }
  else if (sec) focusSection(sec);
  else if (h.get('v') === 'country') document.querySelector('[data-view=country]').click();
  else fitBox(bounds, 0.68);
}
addEventListener('hashchange', applyHash);
setTimeout(applyHash, 50);

let userMoved = false;
controls.addEventListener('start', () => { userMoved = true; tween = null; });
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight); labelRenderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight); bloom.resolution.set(innerWidth, innerHeight);
  if (!userMoved && !selected) { clearTimeout(window.__refit); window.__refit = setTimeout(applyHash, 150); }
});

loader.classList.add('gone');
setTimeout(() => (loader.style.display = 'none'), 700);
const clock = new THREE.Clock();
function frame() {
  const now = performance.now(), dt = Math.min(clock.getDelta(), 0.05), time = clock.elapsedTime;
  if (tween) {
    const k = Math.min(1, (now - tween.t0) / tween.dur), e = ease(k);
    controls.target.lerpVectors(tween.fromT, tween.toT, e); camera.position.lerpVectors(tween.fromP, tween.toP, e);
    if (k >= 1) tween = null;
  }
  controls.update();
  const dist = controls.getDistance();
  scene.fog.density = 0.55 / Math.max(dist, 30);
  terrainUniforms.uFog.value = scene.fog.density;

  // рельеф вкл/выкл — плавно
  if (Math.abs(reliefTarget - relief) > 0.001) { relief += (reliefTarget - relief) * Math.min(1, dt * 5); if (Math.abs(reliefTarget - relief) < 0.002) relief = reliefTarget; applyRelief(); }

  // проявление путей
  const ik = Math.min(1, (now - intro.t0) / intro.dur), ie = ease(ik);
  for (const s of DATA.sections) for (const b of s.branches) b.line.geo.instanceCount = Math.max(1, Math.ceil((b.line.p2.length - 1) * ie));
  for (const m of lineMats) m.resolution.set(innerWidth, innerHeight);
  const dashOp = 1 - THREE.MathUtils.smoothstep(dist, 25, 60);
  for (const s of DATA.sections) s.mats.dash.opacity = dashOp * (activeSection && activeSection !== s ? 0.2 : 0.9);

  kmTicks.material.opacity = toggles.ticks ? kmTicks.userData.base * (1 - THREE.MathUtils.smoothstep(dist, 70, 140)) : 0;
  pkTicks.material.opacity = toggles.ticks ? pkTicks.userData.base * (1 - THREE.MathUtils.smoothstep(dist, 14, 30)) : 0;
  kmTicks.visible = kmTicks.material.opacity > 0.01; pkTicks.visible = pkTicks.material.opacity > 0.01;
  pkLabels.mat.uniforms.uOpacity.value = toggles.ticks ? 1 - THREE.MathUtils.smoothstep(dist, 4.5, 7) : 0;
  pkLabels.pts.visible = pkLabels.mat.uniforms.uOpacity.value > 0.01;

  const sc = (markerSc = THREE.MathUtils.clamp(dist * 0.0085, 0.012, 3.2));
  for (const s of DATA.stations) {
    const o = s.obj, hov = s === hovered || s === selected;
    const appear = THREE.MathUtils.clamp((ie - (s.at / s.br.length) * 0.9) * 6, 0, 1);
    o.g.scale.setScalar(Math.max(0.0001, sc * (s.prio >= 3 ? 1.25 : 1) * (hov ? 1.45 : 1) * appear));
    o.beam.scale.y = o.beamH * (0.75 + 0.25 * Math.sin(time * 1.6 + s.idx)) * (hov ? 1.5 : 1);
    o.halo.material.uniforms.uOpacity.value = 0.45 + 0.25 * Math.sin(time * 2 + s.idx * 0.7) + (hov ? 0.4 : 0);
    if (o.diamond) { o.diamond.rotation.y = time * 1.4; o.diamond.position.y = 2.2 + Math.sin(time * 2 + s.idx) * 0.25; }
  }
  if (toggles.trains) updateTrains(time);
  trainPoints.visible = toggles.trains && ik > 0.6;

  updateHud(dist);
  composer.render();
  labelRenderer.render(scene, camera);
  layoutLabels(dist);
  if (ik >= 1 && !window.__mapReady) window.__mapReady = true; // для автоматических проверок
  requestAnimationFrame(frame);
}
frame();
