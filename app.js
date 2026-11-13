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
const fmtKm = (v) => (v < 10 ? v.toFixed(1) : Math.round(v)).toString().replace('.', ',') + ' км';
const BG = new THREE.Color('#04070d');

// ============================================================
//  Подготовка данных
// ============================================================
const lineById = {};
for (const l of DATA.lines) {
  l.v = l.pts.map(([x, z]) => new THREE.Vector3(x, 0, z));
  l.cum = [0];
  for (let i = 1; i < l.v.length; i++) l.cum.push(l.cum[i - 1] + l.v[i].distanceTo(l.v[i - 1]));
  l.total = l.cum[l.cum.length - 1];
  l.col = new THREE.Color(l.color);
  l.stations = [];
  lineById[l.id] = l;
}
const MAJOR = new Set(['Худжанд', 'Дашанбе-1', 'Дашанбе-2', 'Кулоб', 'Вахдат', 'Исфара', 'Хатлон', 'Вахш', 'Конибодом', 'Регар', 'Ёвон']);
DATA.stations.forEach((s, i) => {
  s.idx = i;
  s.title = s.name || 'Без подписи';
  s.pos = new THREE.Vector3(s.x, 0, s.z);
  s.lineObj = lineById[s.line];
  s.lineObj.stations.push(s);
  s.kind = s.border ? 'border' : s.junction ? 'junction' : 'station';
  s.prio = (MAJOR.has(s.name) ? 3 : 0) + (s.junction ? 2 : 0) + (s.border ? 1 : 0) + (s.name ? 1 : -2) + (s.outside ? -2 : 0);
});
for (const l of DATA.lines) l.stations.sort((a, b) => a.at - b.at);

function pointAt(l, d, out = new THREE.Vector3()) {
  d = Math.max(0, Math.min(l.total, d));
  let lo = 0, hi = l.cum.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (l.cum[m] <= d) lo = m; else hi = m; }
  const seg = l.cum[hi] - l.cum[lo];
  return out.lerpVectors(l.v[lo], l.v[hi], seg ? (d - l.cum[lo]) / seg : 0);
}

// Габариты сети
const bounds = new THREE.Box3();
for (const l of DATA.lines) for (const v of l.v) bounds.expandByPoint(v);
const center = bounds.getCenter(new THREE.Vector3());

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
renderer.toneMappingExposure = 1.0;
container.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(innerWidth, innerHeight);
Object.assign(labelRenderer.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
container.appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
scene.background = BG;
scene.fog = new THREE.FogExp2(BG, 0.0026);

const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.1, 3000);
const controls = new MapControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 4;
controls.maxDistance = 900;
controls.maxPolarAngle = 1.22;
controls.zoomToCursor = true;
controls.screenSpacePanning = false;

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.42, 0.45, 0.22);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// ============================================================
//  Рельеф (декоративный): горы, долины вдоль путей, изолинии
// ============================================================
const PW = 340, PH = 430;
function buildValleyMask() {
  const cw = 1024, ch = Math.round(1024 * PH / PW);
  const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cw, ch);
  const P = (x, z) => [(x / PW + 0.5) * cw, (z / PH + 0.5) * ch];
  const pass = (blur, width, alpha) => {
    ctx.filter = `blur(${blur}px)`;
    ctx.strokeStyle = `rgba(255,255,255,${alpha})`; ctx.lineWidth = width; ctx.lineCap = ctx.lineJoin = 'round';
    for (const l of DATA.lines) { ctx.beginPath(); l.pts.forEach(([x, z], i) => { const [a, b] = P(x, z); i ? ctx.lineTo(a, b) : ctx.moveTo(a, b); }); ctx.stroke(); }
    ctx.fillStyle = `rgba(255,255,255,${alpha})`;
    for (const s of DATA.stations) { const [a, b] = P(s.x, s.z); ctx.beginPath(); ctx.arc(a, b, width * 0.9, 0, 7); ctx.fill(); }
  };
  pass(26, 40, 0.55);   // широкая долина
  pass(6, 14, 1.0);     // ровное полотно у путей
  ctx.filter = 'none';
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  return tex;
}

const NOISE_GLSL = /* glsl */`
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec2 mod289(vec2 x){return x-floor(x*(1.0/289.0))*289.0;}
vec3 permute(vec3 x){return mod289(((x*34.0)+1.0)*x);}
float snoise(vec2 v){
  const vec4 C=vec4(0.211324865405187,0.366025403784439,-0.577350269189626,0.024390243902439);
  vec2 i=floor(v+dot(v,C.yy)); vec2 x0=v-i+dot(i,C.xx);
  vec2 i1=(x0.x>x0.y)?vec2(1.0,0.0):vec2(0.0,1.0);
  vec4 x12=x0.xyxy+C.xxzz; x12.xy-=i1; i=mod289(i);
  vec3 p=permute(permute(i.y+vec3(0.0,i1.y,1.0))+i.x+vec3(0.0,i1.x,1.0));
  vec3 m=max(0.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),0.0); m=m*m; m=m*m;
  vec3 x=2.0*fract(p*C.www)-1.0; vec3 h=abs(x)-0.5; vec3 ox=floor(x+0.5); vec3 a0=x-ox;
  m*=1.79284291400159-0.85373472095314*(a0*a0+h*h);
  vec3 g; g.x=a0.x*x0.x+h.x*x0.y; g.yz=a0.yz*x12.xz+h.yz*x12.yw; return 130.0*dot(m,g);
}
float terrain(vec2 p){
  float h=0.0, a=0.5, f=0.011;
  for(int i=0;i<4;i++){ h+=a*snoise(p*f); f*=2.0; a*=0.45; }
  float r=1.0-abs(snoise(p*0.016+vec2(7.3,1.9))); r=r*r*r;
  float r2=1.0-abs(snoise(p*0.034+vec2(2.1,9.4))); r2=r2*r2;
  float base=max(0.0, 0.5*h+0.6*r+0.12*r2-0.12);
  // крупные хребты: между севером и центром, к востоку — выше
  float band=exp(-pow((p.y+70.0)/24.0,2.0));
  float east=smoothstep(30.0,120.0,p.x);
  float south=smoothstep(40.0,140.0,p.y)*0.35;
  return base*(0.85+2.1*band+1.3*east-south);
}
`;

const valleyTex = buildValleyMask();
const terrainUniforms = {
  uMask: { value: valleyTex },
  uRelief: { value: 1 },
  uHeight: { value: 5.5 },
  uBg: { value: BG.clone() },
  uFogDensity: { value: scene.fog.density },
  uSize: { value: new THREE.Vector2(PW, PH) },
};
const terrainMat = new THREE.ShaderMaterial({
  uniforms: terrainUniforms,
  vertexShader: /* glsl */`
    uniform sampler2D uMask; uniform float uRelief; uniform float uHeight;
    varying vec3 vPos; varying float vH; varying float vMask; varying float vDepth;
    ${NOISE_GLSL}
    void main(){
      vec3 p = (modelMatrix * vec4(position,1.0)).xyz;
      float m = texture2D(uMask, uv).r;
      float flat_ = smoothstep(0.0, 0.85, 1.0 - m);
      float h = terrain(p.xz) * flat_ * uHeight * uRelief;
      p.y = h - 0.02;
      vPos = p; vH = h; vMask = m;
      vec4 mv = viewMatrix * vec4(p,1.0);
      vDepth = -mv.z;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */`
    uniform vec3 uBg; uniform float uFogDensity; uniform vec2 uSize; uniform float uRelief; uniform float uHeight;
    varying vec3 vPos; varying float vH; varying float vMask; varying float vDepth;
    float gridLine(float c, float w){ float d = abs(fract(c - 0.5) - 0.5) / fwidth(c); return 1.0 - smoothstep(0.0, w, d); }
    void main(){
      vec3 n = normalize(cross(dFdx(vPos), dFdy(vPos)));
      if (n.y < 0.0) n = -n;
      vec3 L = normalize(vec3(-0.55, 0.75, -0.35));
      float diff = clamp(dot(n, L), 0.0, 1.0);
      float hn = clamp(vH / max(uHeight * 1.6, 0.001), 0.0, 1.0);
      vec3 low = vec3(0.0045, 0.0085, 0.017);
      vec3 mid = vec3(0.012, 0.022, 0.040);
      vec3 high = vec3(0.055, 0.072, 0.100);
      vec3 snow = vec3(0.22, 0.27, 0.34);
      vec3 col = mix(low, mid, smoothstep(0.0, 0.25, hn));
      col = mix(col, high, smoothstep(0.25, 0.65, hn));
      col = mix(col, snow, smoothstep(0.72, 0.95, hn) * 0.6);
      col *= 0.45 + 0.95 * diff;
      // изолинии
      float step_ = 0.45;
      float c1 = gridLine(vH / step_, 1.0) * step(0.03, vH);
      float c5 = gridLine(vH / (step_ * 5.0), 1.3) * step(0.03, vH);
      col += vec3(0.12, 0.26, 0.40) * (c1 * 0.10 + c5 * 0.18) * uRelief;
      // координатная сетка 10 км
      float g = max(gridLine(vPos.x / 10.0, 1.0), gridLine(vPos.z / 10.0, 1.0));
      col += vec3(0.10, 0.18, 0.30) * g * 0.08;
      // свечение долин вдоль путей
      col += vec3(0.02, 0.06, 0.10) * smoothstep(0.15, 1.0, vMask) * 0.5;
      // туман и затухание к краям
      float fog = 1.0 - exp(-pow(uFogDensity * vDepth, 2.0));
      vec2 e = abs(vPos.xz) / (uSize * 0.5);
      float edge = smoothstep(0.66, 0.98, max(e.x, e.y));
      col = mix(col, uBg, clamp(max(fog, edge), 0.0, 1.0));
      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
});
const terrainGeo = new THREE.PlaneGeometry(PW, PH, 340, 430);
terrainGeo.rotateX(-Math.PI / 2);
const terrain = new THREE.Mesh(terrainGeo, terrainMat);
terrain.frustumCulled = false; // маска и плоскость в координатах карты (центр сети ≈ 0)
scene.add(terrain);

// ============================================================
//  Пути
// ============================================================
const lineGroup = new THREE.Group(); scene.add(lineGroup);
const lineMats = [];
const Y_LINE = 0.06;
for (const l of DATA.lines) {
  const pos = []; for (const v of l.v) pos.push(v.x, Y_LINE, v.z);
  const geo = new LineGeometry(); geo.setPositions(pos);
  const mkMat = (o) => { const m = new LineMaterial({ transparent: true, depthWrite: false, ...o }); lineMats.push(m); return m; };
  const glowCol = l.col.clone().multiplyScalar(0.9);
  const glow = new Line2(geo, mkMat({ color: glowCol, linewidth: 10, opacity: 0.12 }));
  const base = new Line2(geo, mkMat({ color: l.col.clone(), linewidth: 3.6, opacity: 1 }));
  const dash = new Line2(geo, mkMat({ color: 0xffffff, linewidth: 1.6, opacity: 0.0, dashed: true, dashSize: 0.5, gapSize: 0.5 }));
  dash.computeLineDistances();
  for (const o of [glow, base, dash]) { o.renderOrder = 2; o.frustumCulled = false; lineGroup.add(o); }
  dash.position.y = base.position.y = 0.01;
  l.objs = { glow, base, dash, geo, segs: l.v.length - 1 };
}

// ============================================================
//  Км-отметки и пикеты (instanced)
// ============================================================
function buildTicks(list, w, len, opacity) {
  const geo = new THREE.PlaneGeometry(len, w); geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity, depthWrite: false, fog: true });
  const mesh = new THREE.InstancedMesh(geo, mat, list.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const c = new THREE.Color();
  list.forEach(([x, z, a, id], i) => {
    p.set(x, Y_LINE + 0.02, z); q.setFromAxisAngle(up, -a); m.compose(p, q, s); mesh.setMatrixAt(i, m);
    c.copy(lineById[id].col).lerp(new THREE.Color(1, 1, 1), 0.55); mesh.setColorAt(i, c);
  });
  mesh.renderOrder = 3; mesh.frustumCulled = false; mesh.userData.base = opacity;
  scene.add(mesh); return mesh;
}
const kmTicks = buildTicks(DATA.ticks.km, 0.05, 0.42, 0.6);
const pkTicks = buildTicks(DATA.ticks.pk, 0.022, 0.2, 0.5);

// ============================================================
//  Станции
// ============================================================
const stationGroup = new THREE.Group(); scene.add(stationGroup);
const ringGeo = new THREE.RingGeometry(0.62, 1, 40); ringGeo.rotateX(-Math.PI / 2);
const discGeo = new THREE.CircleGeometry(0.62, 40); discGeo.rotateX(-Math.PI / 2);
const haloGeo = new THREE.CircleGeometry(1, 48); haloGeo.rotateX(-Math.PI / 2);
const diamondGeo = new THREE.OctahedronGeometry(0.75, 0);
const beamGeo = new THREE.CylinderGeometry(0.09, 0.09, 1, 10, 1, true); beamGeo.translate(0, 0.5, 0);

const haloMat = (col) => new THREE.ShaderMaterial({
  uniforms: { uColor: { value: col }, uOpacity: { value: 0.55 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `uniform vec3 uColor; uniform float uOpacity; varying vec2 vUv; void main(){ float d = length(vUv - 0.5) * 2.0; float a = pow(1.0 - clamp(d,0.0,1.0), 2.2); gl_FragColor = vec4(uColor * a * uOpacity, 1.0); }`,
});
const beamMat = (col) => new THREE.ShaderMaterial({
  uniforms: { uColor: { value: col }, uOpacity: { value: 0.9 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  vertexShader: `varying float vY; void main(){ vY = position.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `uniform vec3 uColor; uniform float uOpacity; varying float vY; void main(){ float a = pow(1.0 - vY, 1.6); gl_FragColor = vec4(uColor * a * uOpacity, 1.0); }`,
});

const RED = new THREE.Color('#ff4d5e');
for (const s of DATA.stations) {
  const g = new THREE.Group(); g.position.set(s.x, Y_LINE + 0.03, s.z);
  const col = s.border ? RED : s.lineObj.col;
  const ringMat = new THREE.MeshBasicMaterial({ color: s.junction ? 0xffffff : col.clone().multiplyScalar(1.3), transparent: true, depthWrite: false });
  const discMat = new THREE.MeshBasicMaterial({ color: s.junction ? col.clone().multiplyScalar(1.4) : 0x0b111c, transparent: true, depthWrite: false });
  const disc = new THREE.Mesh(discGeo, discMat); disc.renderOrder = 4;
  const ring = new THREE.Mesh(ringGeo, ringMat); ring.renderOrder = 5;
  const halo = new THREE.Mesh(haloGeo, haloMat(col.clone())); halo.scale.setScalar(3.2); halo.renderOrder = 3; halo.position.y = -0.01;
  g.add(halo, disc, ring);
  const beamH = MAJOR.has(s.name) ? 7 : s.junction ? 5 : s.border ? 4 : 2.6;
  const beam = new THREE.Mesh(beamGeo, beamMat(col.clone())); beam.scale.y = beamH; beam.renderOrder = 6;
  g.add(beam);
  let diamond = null;
  if (s.border) {
    diamond = new THREE.Mesh(diamondGeo, new THREE.MeshBasicMaterial({ color: RED.clone().multiplyScalar(1.6) }));
    diamond.position.y = 2.2; diamond.scale.set(0.7, 1, 0.7); g.add(diamond);
  }
  if (s.outside) { ringMat.opacity = 0.55; discMat.opacity = 0.55; }
  s.obj = { g, ring, disc, halo, beam, diamond, ringMat, discMat, beamH };
  stationGroup.add(g);
}

// ============================================================
//  Подписи
// ============================================================
for (const s of DATA.stations) {
  const anchor = document.createElement('div'); anchor.className = 'anchor';
  const el = document.createElement('div');
  el.className = 'st-label' + (s.prio >= 3 ? ' major' : '') + (s.border ? ' border' : '') + (s.outside ? ' outside' : '') + (s.name ? '' : ' unnamed');
  el.style.setProperty('--c', s.lineObj.color);
  el.innerHTML = `<span class="nm"></span><span class="ch"></span>`;
  el.querySelector('.nm').textContent = s.title;
  el.querySelector('.ch').textContent = s.chain ? 'ПК ' + s.chain : '';
  if (!s.chain) el.classList.add('nochain-always');
  el.addEventListener('click', (e) => { e.stopPropagation(); selectStation(s, true); });
  el.addEventListener('pointerenter', () => setHover(s));
  el.addEventListener('pointerleave', () => setHover(null));
  anchor.appendChild(el);
  const obj = new CSS2DObject(anchor); obj.position.set(s.x, Y_LINE, s.z);
  scene.add(obj);
  s.label = { el, obj, w: 0, h: 0, side: 'r' };
}

// Названия регионов (крупные полупрозрачные)
// позиции — в стороне от путей: над северным участком, под центральным, левее южного
const regions = [
  { text: 'Согдийская область', ids: ['north', 'isfara'], at: (b) => [(b.min.x + b.max.x) / 2 - 12, b.min.z - 24] },
  { text: 'Душанбе · РРП', ids: ['center', 'regar'], at: (b) => [(b.min.x + b.max.x) / 2 - 10, b.max.z + 14] },
  { text: 'Хатлонская область', ids: ['south', 'kulob', 'link'], at: (b) => [b.min.x - 4, (b.min.z + b.max.z) / 2 + 30] },
];
const regionLabels = regions.map((r) => {
  const b = new THREE.Box3(); for (const id of r.ids) for (const v of lineById[id].v) b.expandByPoint(v);
  const [x, z] = r.at(b);
  const el = document.createElement('div'); el.className = 'region-label'; el.textContent = r.text;
  const o = new CSS2DObject(el); o.position.set(x, 0, z); scene.add(o);
  return el;
});

// ============================================================
//  Поезда
// ============================================================
const TRAIL = 16, TRAIN_SPACING = 0.28;
const trains = [];
for (const l of DATA.lines) {
  const n = Math.max(1, Math.round(l.total / 40));
  for (let i = 0; i < n; i++) trains.push({ l, phase: (i / n) * 2 * l.total + Math.random() * 10, speed: 7 + Math.random() * 3 });
}
const trainGeo = new THREE.BufferGeometry();
const tPos = new Float32Array(trains.length * TRAIL * 3), tCol = new Float32Array(trains.length * TRAIL * 3), tSize = new Float32Array(trains.length * TRAIL);
trains.forEach((t, i) => {
  const c = t.l.col.clone().lerp(new THREE.Color(1, 1, 1), 0.35);
  for (let k = 0; k < TRAIL; k++) {
    const j = i * TRAIL + k, f = 1 - k / TRAIL;
    const cc = k === 0 ? new THREE.Color(1, 1, 1) : c;
    tCol.set([cc.r * f, cc.g * f, cc.b * f], j * 3);
    tSize[j] = k === 0 ? 9 : 7 * f + 1.5;
  }
});
trainGeo.setAttribute('position', new THREE.BufferAttribute(tPos, 3));
trainGeo.setAttribute('aColor', new THREE.BufferAttribute(tCol, 3));
trainGeo.setAttribute('size', new THREE.BufferAttribute(tSize, 1));
const trainMat = new THREE.ShaderMaterial({
  uniforms: { uPR: { value: renderer.getPixelRatio() }, uOpacity: { value: 1 } },
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  vertexShader: `attribute float size; attribute vec3 aColor; varying vec3 vC; uniform float uPR;
    void main(){ vC = aColor; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = size * uPR; gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `varying vec3 vC; uniform float uOpacity; void main(){ float d = length(gl_PointCoord - 0.5) * 2.0; float a = pow(max(0.0, 1.0 - d), 1.8); gl_FragColor = vec4(vC * a * 1.6 * uOpacity, 1.0); }`,
});
const trainPoints = new THREE.Points(trainGeo, trainMat);
trainPoints.frustumCulled = false; trainPoints.renderOrder = 7;
scene.add(trainPoints);
const tmpV = new THREE.Vector3();
function updateTrains(time) {
  trains.forEach((t, i) => {
    const L = t.l.total, s = (t.phase + time * t.speed) % (2 * L);
    const d = s < L ? s : 2 * L - s, dir = s < L ? 1 : -1;
    for (let k = 0; k < TRAIL; k++) {
      pointAt(t.l, d - dir * k * TRAIN_SPACING, tmpV);
      tPos.set([tmpV.x, Y_LINE + 0.12, tmpV.z], (i * TRAIL + k) * 3);
    }
  });
  trainGeo.attributes.position.needsUpdate = true;
}

// ============================================================
//  Интерфейс: статистика, легенда, поиск, карточка
// ============================================================
const totalLen = DATA.lines.reduce((a, l) => a + l.length, 0);
$('#stats').innerHTML = [
  [Math.round(totalLen), 'км путей*'],
  [DATA.stations.filter((s) => s.name && !s.outside).length, 'станций'],
  [DATA.lines.length, 'участков'],
].map(([v, t]) => `<div class="stat"><b>${v}</b><span>${t}</span></div>`).join('');
$('#stats').title = '* Длина измерена по геометрии чертежа (1 ед. чертежа ≈ 1 м)';

const ul = $('#lines');
for (const l of DATA.lines) {
  const li = document.createElement('li'); li.dataset.id = l.id;
  const n = l.stations.filter((s) => s.name && !s.outside).length;
  li.innerHTML = `<i class="swatch" style="color:${l.color}"></i>
    <div><div class="ln-name"></div><div class="ln-sub"></div></div>
    <div class="ln-len">${fmtKm(l.total)}<small>${n} ст.</small></div>`;
  li.querySelector('.ln-name').textContent = l.name;
  li.querySelector('.ln-sub').textContent = l.region;
  li.addEventListener('click', () => focusLine(activeLine === l ? null : l));
  ul.appendChild(li);
  l.li = li;
}
$('#showAll').addEventListener('click', () => focusLine(null));

// Поиск
const search = $('#search'), results = $('#results');
let resIdx = 0, resList = [];
function renderResults() {
  const q = search.value.trim().toLowerCase();
  if (!q) { results.classList.remove('open'); return; }
  const norm = (t) => t.toLowerCase().replace(/ё/g, 'е').replace(/душ/g, 'даш');
  resList = DATA.stations.filter((s) => norm(s.title).includes(norm(q)) || (s.chain || '').includes(q)).slice(0, 12);
  resIdx = 0;
  results.innerHTML = resList.length ? '' : '<div class="empty">Ничего не найдено</div>';
  resList.forEach((s, i) => {
    const b = document.createElement('button'); if (i === 0) b.className = 'active';
    b.innerHTML = `<i class="swatch" style="color:${s.lineObj.color};width:14px"></i><span></span><small></small>`;
    b.querySelector('span').textContent = s.title;
    b.querySelector('small').textContent = s.chain ? 'ПК ' + s.chain : '';
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

// Карточка станции
let selected = null;
function neighborsOf(s) {
  const st = s.lineObj.stations, i = st.indexOf(s);
  return [st[i - 1], st[i + 1]];
}
function selectStation(s, fly) {
  if (selected) selected.label.el.classList.remove('selected');
  selected = s;
  if (!s) { $('#card').hidden = true; return; }
  s.label.el.classList.add('selected');
  const l = s.lineObj;
  $('#cardLine').innerHTML = `<i style="background:${l.color};box-shadow:0 0 8px ${l.color}"></i><span></span>`;
  $('#cardLine span').textContent = l.name;
  $('#cardName').textContent = s.title;
  const badges = [];
  if (s.junction) badges.push(['white', 'Узловая станция']);
  if (MAJOR.has(s.name) && !s.junction) badges.push(['', 'Крупная станция']);
  if (s.border) badges.push(['red', 'Сархад — граница']);
  if (s.outside) badges.push(['grey', 'Показана полупрозрачной на чертеже']);
  if (!s.name) badges.push(['grey', 'Без подписи на чертеже']);
  $('#cardBadges').innerHTML = badges.map(([c, t]) => `<span class="badge ${c}">${t}</span>`).join('');
  const facts = [];
  if (s.chain) facts.push(['Пикетаж', s.chain.replace(' / ', ' · ')]);
  if (s.note) facts.push(['Примечание', s.note]);
  facts.push(['Участок', l.region]);
  facts.push(['От начала участка', fmtKm(s.at) + ' по схеме']);
  if (s.junction) facts.push(['Примыкание', s.junction.map((id) => lineById[id].name).join('; ')]);
  $('#cardFacts').innerHTML = facts.map(() => '<dt></dt><dd></dd>').join('');
  const dts = $('#cardFacts').querySelectorAll('dt'), dds = $('#cardFacts').querySelectorAll('dd');
  facts.forEach(([k, v], i) => { dts[i].textContent = k; dds[i].textContent = v; });
  const nb = $('#cardNeighbors'); nb.innerHTML = '';
  const [prev, next] = neighborsOf(s);
  for (const [n, arrow] of [[prev, '←'], [next, '→']]) {
    if (!n) continue;
    const b = document.createElement('button');
    b.innerHTML = `<span class="arrow">${arrow}</span><span></span><small>${fmtKm(Math.abs(n.at - s.at))}</small>`;
    b.querySelector('span:nth-child(2)').textContent = n.title;
    b.addEventListener('click', () => selectStation(n, true));
    nb.appendChild(b);
  }
  // переход на другие участки
  for (const id of s.junction || []) {
    const ol = lineById[id];
    const first = ol.stations.slice().sort((a, b) => a.pos.distanceTo(s.pos) - b.pos.distanceTo(s.pos)).find((x) => x !== s);
    if (!first) continue;
    const b = document.createElement('button');
    b.innerHTML = `<span class="arrow" style="color:${ol.color}">↳</span><span></span><small>${ol.region.split(' ')[0]}</small>`;
    b.querySelector('span:nth-child(2)').textContent = first.title + ' (' + ol.name.split(' — ').pop() + ')';
    b.addEventListener('click', () => selectStation(first, true));
    nb.appendChild(b);
  }
  $('#card').hidden = false;
  if (fly) flyTo(s.pos, Math.min(controls.getDistance(), 34), 0.85);
  dismissHint();
}
$('#cardClose').addEventListener('click', () => selectStation(null));

// Фокус на участке
let activeLine = null;
function focusLine(l) {
  activeLine = l;
  $('#showAll').hidden = !l;
  for (const x of DATA.lines) {
    const on = !l || x === l;
    x.li.classList.toggle('active', x === l); x.li.classList.toggle('dim', !on);
    x.objs.base.material.opacity = on ? 1 : 0.22;
    x.objs.glow.material.opacity = on ? 0.12 : 0.03;
  }
  for (const s of DATA.stations) {
    const on = !l || s.lineObj === l || (s.junction || []).includes(l.id);
    s.obj.g.visible = true;
    s.dim = !on;
    s.obj.ringMat.opacity = on ? (s.outside ? 0.55 : 1) : 0.2;
    s.obj.discMat.opacity = on ? 1 : 0.2;
    s.obj.beam.visible = on;
    s.obj.halo.visible = on;
    s.label.el.classList.toggle('dim', !on);
  }
  if (l) fitBox(new THREE.Box3().setFromPoints(l.v));
  else fitBox(bounds);
}

// ============================================================
//  Камера: перелёты
// ============================================================
let tween = null;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
function flyToState(target, position, dur = 1.4) {
  tween = { t0: performance.now(), dur: dur * 1000, fromT: controls.target.clone(), fromP: camera.position.clone(), toT: target.clone(), toP: position.clone() };
}
function sphericalAround(target, dist, polar, azimuth) {
  return new THREE.Vector3().setFromSpherical(new THREE.Spherical(dist, polar, azimuth)).add(target);
}
function currentAzimuth() { const o = camera.position.clone().sub(controls.target); return Math.atan2(o.x, o.z); }
function flyTo(target, dist, polar = 0.85, azimuth = currentAzimuth()) {
  flyToState(target, sphericalAround(target, dist, polar, azimuth));
}
function fitBox(box, polar = 0.72) {
  const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const sidePanel = innerWidth > 760 ? 360 : 0;
  const effAspect = (innerWidth - sidePanel) / innerHeight;
  const needH = Math.max(size.z * 1.05, (size.x * 1.05) / effAspect) + 8;
  const dist = (needH / 2) / Math.tan(fov / 2) * 1.08;
  // сдвиг центра вправо, если слева легенда
  const shift = sidePanel ? (sidePanel / innerWidth) * dist * Math.tan(fov / 2) * camera.aspect * 0.95 : 0;
  const az = currentAzimuth();
  const target = c.clone().add(new THREE.Vector3(-Math.cos(az), 0, Math.sin(az)).multiplyScalar(shift));
  flyTo(target, Math.min(dist, controls.maxDistance), polar, az);
}

// ============================================================
//  Наведение и клики по станциям (экранное расстояние)
// ============================================================
const tooltip = $('#tooltip');
let hovered = null;
function setHover(s) {
  hovered = s;
  renderer.domElement.style.cursor = s ? 'pointer' : '';
  if (!s) { tooltip.classList.remove('show'); return; }
}
const proj = new THREE.Vector3();
function stationAtScreen(x, y) {
  let best = null, bd = 16;
  for (const s of DATA.stations) {
    if (!s.obj.g.visible) continue;
    proj.copy(s.pos).project(camera);
    if (proj.z > 1) continue;
    const sx = (proj.x * 0.5 + 0.5) * innerWidth, sy = (-proj.y * 0.5 + 0.5) * innerHeight;
    const d = Math.hypot(sx - x, sy - y);
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
    tooltip.firstChild.textContent = s.title; tooltip.lastChild.textContent = s.chain ? 'ПК ' + s.chain : '';
    tooltip.style.left = e.clientX + 'px'; tooltip.style.top = e.clientY + 'px';
    tooltip.classList.add('show');
  }
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  const s = stationAtScreen(e.clientX, e.clientY);
  if (s) selectStation(s, true);
});
renderer.domElement.addEventListener('pointerleave', () => setHover(null));

// ============================================================
//  Переключатели и виды
// ============================================================
const toggles = { labels: true, chain: true, ticks: true, relief: true, trains: true };
let reliefTarget = 1;
document.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', () => {
  const k = b.dataset.toggle; toggles[k] = !toggles[k]; b.classList.toggle('on', toggles[k]);
  if (k === 'relief') reliefTarget = toggles.relief ? 1 : 0;
  if (k === 'trains') trainPoints.visible = toggles.trains;
}));
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
  const v = b.dataset.view, d = controls.getDistance();
  if (v === 'top') flyTo(controls.target, d, 0.001, 0);
  if (v === '3d') flyTo(controls.target, d, 0.95);
  if (v === 'reset') { selectStation(null); focusLine(null); }
}));
$('#compass').addEventListener('click', () => flyTo(controls.target, controls.getDistance(), Math.max(0.001, controls.getPolarAngle()), 0));
const hintEl = $('#hint');
function dismissHint() { hintEl.classList.add('gone'); }
setTimeout(dismissHint, 9000);
$('#legendToggle').addEventListener('click', () => $('#legend').classList.toggle('open'));
addEventListener('keydown', (e) => {
  if (e.target === search) return;
  if (e.key === 'Escape') { selectStation(null); }
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
  // карточка и панели — тоже препятствия
  for (const el of [$('#card'), $('.title-card'), $('#legend'), $('#toolbar')]) {
    if (!el || el.hidden || el.getClientRects().length === 0) continue;
    const r = el.getBoundingClientRect(); rects.push({ x: r.left, y: r.top, w: r.width, h: r.height });
  }
  const kmPerPx = (2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / H;
  // проход 1: решаем, что показывать (только запись классов)
  const minPrio = dist > 330 ? 3 : dist > 220 ? 2 : dist > 140 ? 1 : -99;
  const todo = [];
  for (const s of labelOrder) {
    const el = s.label.el, [, , vis] = pts.get(s);
    const chain = (showChain && s.chain && (s.prio >= 1 || dist < 60)) || (s === selected && !!s.chain);
    el.classList.toggle('nochain', !chain);
    let want = toggles.labels && vis && (s.prio >= minPrio || s === selected || s === hovered);
    if (s.dim && s !== selected) want = want && dist < 120;
    if (want) todo.push(s); else el.classList.remove('show');
  }
  // проход 2: читаем размеры (одна перекомпоновка)
  for (const s of todo) { s.label.w = s.label.el.offsetWidth || s.title.length * 8 + 4; s.label.h = s.label.el.offsetHeight || 18; }
  // проход 3: раскладываем без наложений
  for (const s of todo) {
    const L = s.label, el = L.el, [sx, sy] = pts.get(s), w = L.w, h = L.h;
    const off = Math.max(8, markerSc * (s.prio >= 3 ? 1.25 : 1) * (s === hovered || s === selected ? 1.45 : 1) / kmPerPx + 5);
    const cands = [['r', sx + off, sy - h / 2], ['l', sx - off - w, sy - h / 2], ['t', sx - w / 2, sy - h - off], ['b', sx - w / 2, sy + off]];
    let placed = null;
    for (const [side, x, y] of cands) {
      const r = { x, y, w, h };
      if (s === selected || !overlaps(r)) { placed = [side, r]; break; }
    }
    if (!placed) { el.classList.remove('show'); continue; }
    const [side, r] = placed;
    rects.push(r);
    el.style.left = (r.x - sx) + 'px'; el.style.top = (r.y - sy) + 'px';
    el.style.textAlign = side === 'l' ? 'right' : side === 'r' ? 'left' : 'center';
    el.classList.add('show');
  }
  const rOp = THREE.MathUtils.smoothstep(dist, 120, 260);
  regionLabels.forEach((el) => (el.style.opacity = toggles.labels ? rOp : 0));
}

// ============================================================
//  HUD: компас и масштаб
// ============================================================
const needle = $('#compass .needle'), scaleBar = $('#scaleBar'), scaleText = $('#scaleText');
function updateHud(dist) {
  const az = controls.getAzimuthalAngle();
  needle.style.transform = `rotate(${THREE.MathUtils.radToDeg(az)}deg)`;
  const kmPerPx = (2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / innerHeight;
  const target = kmPerPx * 110;
  const p = Math.pow(10, Math.floor(Math.log10(target)));
  const nice = [1, 2, 5, 10].map((m) => m * p).filter((v) => v <= target).pop() || p;
  scaleBar.style.width = nice / kmPerPx + 'px';
  scaleText.textContent = nice >= 1 ? `${nice} км` : `${Math.round(nice * 1000)} м`;
}

// ============================================================
//  Старт и цикл анимации
// ============================================================
camera.position.copy(sphericalAround(center, 900, 0.35, 0));
controls.target.copy(center);
controls.update();
const intro = { t0: performance.now(), dur: 2600 };
// Ссылки вида  #s=Худжанд  или  #l=kulob  открывают станцию / участок
function applyHash() {
  const h = new URLSearchParams(decodeURIComponent(location.hash.slice(1)));
  const st = h.get('s') && DATA.stations.find((x) => x.title.toLowerCase() === h.get('s').toLowerCase());
  const ln = h.get('l') && lineById[h.get('l')];
  if (st) { selectStation(st, true); if (h.get('d')) flyTo(st.pos, +h.get('d'), h.get('top') ? 0.001 : 0.85); }
  else if (ln) focusLine(ln);
  else fitBox(bounds, 0.68);
  if (h.get('debug')) window.__debug = { DATA, camera, controls };
}
addEventListener('hashchange', applyHash);
setTimeout(applyHash, 50);

let userMoved = false;
controls.addEventListener('start', () => { userMoved = true; tween = null; });
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  if (!userMoved && !selected) { clearTimeout(window.__refit); window.__refit = setTimeout(applyHash, 150); }
  renderer.setSize(innerWidth, innerHeight); labelRenderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight); bloom.resolution.set(innerWidth, innerHeight);
});

const clock = new THREE.Clock();
const res = new THREE.Vector2();
function frame() {
  const now = performance.now(), dt = Math.min(clock.getDelta(), 0.05), time = clock.elapsedTime;

  if (tween) {
    const k = Math.min(1, (now - tween.t0) / tween.dur), e = ease(k);
    controls.target.lerpVectors(tween.fromT, tween.toT, e);
    camera.position.lerpVectors(tween.fromP, tween.toP, e);
    if (k >= 1) tween = null;
  }
  controls.update();
  const dist = controls.getDistance();
  // туман зависит от высоты камеры: цель всегда чёткая, дальний план растворяется
  scene.fog.density = 0.62 / Math.max(dist, 30);
  terrainUniforms.uFogDensity.value = scene.fog.density;

  // проявление путей при загрузке
  const ik = Math.min(1, (now - intro.t0) / intro.dur), ie = ease(ik);
  for (const l of DATA.lines) {
    const n = Math.max(1, Math.ceil(l.objs.segs * ie));
    l.objs.glow.geometry.instanceCount = n;
  }
  for (const s of DATA.stations) {
    const appear = THREE.MathUtils.clamp((ie - s.at / s.lineObj.total * 0.9) * 6, 0, 1);
    s.appear = appear;
  }

  // разрешение линий
  renderer.getDrawingBufferSize(res);
  for (const m of lineMats) m.resolution.set(innerWidth, innerHeight);

  // пунктир «ж/д» виден вблизи
  const dashOp = 1 - THREE.MathUtils.smoothstep(dist, 25, 60);
  for (const l of DATA.lines) {
    l.objs.dash.material.opacity = dashOp * (activeLine && activeLine !== l ? 0.2 : 0.95);
    l.objs.dash.visible = dashOp > 0.01;
  }

  // км-отметки / пикеты
  kmTicks.material.opacity = toggles.ticks ? kmTicks.userData.base * (1 - THREE.MathUtils.smoothstep(dist, 70, 140)) : 0;
  pkTicks.material.opacity = toggles.ticks ? pkTicks.userData.base * (1 - THREE.MathUtils.smoothstep(dist, 14, 30)) : 0;
  kmTicks.visible = kmTicks.material.opacity > 0.01; pkTicks.visible = pkTicks.material.opacity > 0.01;

  // рельеф (плавно)
  terrainUniforms.uRelief.value += (reliefTarget - terrainUniforms.uRelief.value) * Math.min(1, dt * 4);

  // размер маркеров — почти постоянный на экране
  const sc = (markerSc = THREE.MathUtils.clamp(dist * 0.0105, 0.18, 4.5));
  for (const s of DATA.stations) {
    const o = s.obj, hov = s === hovered || s === selected;
    const big = (s.prio >= 3 ? 1.25 : 1) * (hov ? 1.45 : 1) * (s.appear ?? 1);
    o.g.scale.setScalar(Math.max(0.0001, sc * big));
    o.beam.scale.y = o.beamH * (0.75 + 0.25 * Math.sin(time * 1.6 + s.idx)) * (hov ? 1.5 : 1);
    o.halo.material.uniforms.uOpacity.value = 0.45 + 0.25 * Math.sin(time * 2 + s.idx * 0.7) + (hov ? 0.4 : 0);
    if (o.diamond) { o.diamond.rotation.y = time * 1.4; o.diamond.position.y = 2.2 + Math.sin(time * 2 + s.idx) * 0.25; }
  }

  if (toggles.trains) updateTrains(time);
  trainMat.uniforms.uOpacity.value = ik;

  updateHud(dist);
  composer.render();
  labelRenderer.render(scene, camera);
  layoutLabels(dist);
  requestAnimationFrame(frame);
}
frame();
