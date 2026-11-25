// Mesa 3D: geometria dos dados, texturas das faces, física (cannon-es) e render (three).
//
// Como o resultado continua justo: o valor de cada dado é sorteado antes (crypto).
// A física é simulada inteira de uma vez, sem desenhar; quando sabemos qual face
// termina para cima, trocamos os números das faces para que essa face mostre o
// valor sorteado, e então reproduzimos a trajetória gravada.

import * as THREE from "three";
import * as CANNON from "cannon-es";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

const V = THREE.Vector3;
const UP = new V(0, 1, 0);
const TEX = 256;
const RED = "#ff2b3a";
const STEP = 1 / 60;
const SUBSTEPS = 2;
const MAX_FRAMES = 60 * 7;

// ---------------------------------------------------------------------------
// Geometria
// ---------------------------------------------------------------------------

function trianglesOf(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const p = g.attributes.position;
  const tris = [];
  for (let i = 0; i < p.count; i += 3) {
    tris.push([0, 1, 2].map((k) => new V().fromBufferAttribute(p, i + k)));
  }
  return tris;
}

function d10Triangles() {
  // Trapezoedro pentagonal: as faces (pipas) só são planas com esta proporção.
  const h = 0.1;
  const c = Math.cos(Math.PI / 5);
  const H = (h * (1 + c)) / (1 - c);
  const ring = [];
  for (let k = 0; k < 10; k++) {
    const a = (k * Math.PI) / 5;
    ring.push(new V(Math.cos(a), k % 2 ? -h : h, Math.sin(a)));
  }
  const T = new V(0, H, 0);
  const B = new V(0, -H, 0);
  const tris = [];
  for (let k = 0; k < 10; k++) {
    const prev = ring[(k + 9) % 10];
    const cur = ring[k];
    const next = ring[(k + 1) % 10];
    const apex = k % 2 ? T : B; // pipa de cima centrada num vértice baixo e vice-versa
    tris.push([apex, prev, cur], [apex, cur, next]);
  }
  return tris;
}

// Agrupa triângulos coplanares em faces poligonais ordenadas (anti-horário vistas de fora).
function buildShape(tris, radius) {
  let maxR = 0;
  for (const t of tris) for (const v of t) maxR = Math.max(maxR, v.length());
  const s = radius / maxR;

  const verts = [];
  const indexOf = (v) => {
    for (let i = 0; i < verts.length; i++) if (verts[i].distanceToSquared(v) < 1e-8) return i;
    verts.push(v.clone());
    return verts.length - 1;
  };

  const faces = [];
  for (const t of tris) {
    const [a, b, c] = t.map((v) => v.clone().multiplyScalar(s));
    const n = new V().subVectors(b, a).cross(new V().subVectors(c, a)).normalize();
    const cen = a.clone().add(b).add(c).divideScalar(3);
    if (n.dot(cen) < 0) n.negate();
    let f = faces.find((f) => f.normal.dot(n) > 0.9995);
    if (!f) faces.push((f = { normal: n, idx: [] }));
    for (const v of [a, b, c]) {
      const i = indexOf(v);
      if (!f.idx.includes(i)) f.idx.push(i);
    }
  }

  for (const f of faces) {
    const c = new V();
    f.idx.forEach((i) => c.add(verts[i]));
    c.divideScalar(f.idx.length);
    // "cima" do número aponta para o primeiro vértice; "direita" = cima × normal
    const up = verts[f.idx[0]].clone().sub(c).normalize();
    const right = new V().crossVectors(up, f.normal);
    const ang = (i) => {
      const d = verts[i].clone().sub(c);
      return Math.atan2(d.dot(up), d.dot(right));
    };
    f.idx.sort((i, j) => ang(i) - ang(j));
    let R = 0;
    f.idx.forEach((i) => (R = Math.max(R, verts[i].distanceTo(c))));
    let r = Infinity;
    for (let k = 0; k < f.idx.length; k++) {
      const p = verts[f.idx[k]];
      const q = verts[f.idx[(k + 1) % f.idx.length]];
      const line = new THREE.Line3(p, q);
      r = Math.min(r, line.closestPointToPoint(c, true, new V()).distanceTo(c));
    }
    Object.assign(f, { center: c, up, right, R, inradius: r });
  }
  return { verts, faces };
}

function buildGeometry(shape) {
  const pos = [];
  const nor = [];
  const uv = [];
  const geo = new THREE.BufferGeometry();
  let start = 0;
  shape.faces.forEach((f, fi) => {
    const P = f.idx.map((i) => shape.verts[i]);
    const toUV = (p) => {
      const d = p.clone().sub(f.center);
      return [0.5 + d.dot(f.right) / (2 * f.R), 0.5 + d.dot(f.up) / (2 * f.R)];
    };
    let count = 0;
    for (let k = 1; k < P.length - 1; k++) {
      for (const p of [P[0], P[k], P[k + 1]]) {
        pos.push(p.x, p.y, p.z);
        nor.push(f.normal.x, f.normal.y, f.normal.z);
        uv.push(...toUV(p));
        count++;
      }
    }
    geo.addGroup(start, count, fi);
    start += count;
    f.uvs = P.map(toUV);
  });
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  return geo;
}

// ---------------------------------------------------------------------------
// Tipos de dado
// ---------------------------------------------------------------------------

const range = (a, b, step = 1) => Array.from({ length: Math.floor((b - a) / step) + 1 }, (_, i) => a + i * step);

const KINDS = {
  d4: { tris: () => trianglesOf(new THREE.TetrahedronGeometry(1)), radius: 1.2, values: range(1, 4), vertexLabels: true },
  d6: { tris: () => trianglesOf(new THREE.BoxGeometry(1, 1, 1)), radius: 0.95, values: range(1, 6) },
  d8: { tris: () => trianglesOf(new THREE.OctahedronGeometry(1)), radius: 1.0, values: range(1, 8) },
  d10: { tris: d10Triangles, radius: 0.98, values: range(1, 10) },
  d10t: { tris: d10Triangles, radius: 0.98, values: range(0, 90, 10), text: (v) => String(v).padStart(2, "0") },
  d10u: { tris: d10Triangles, radius: 0.98, values: range(0, 9) },
  d12: { tris: () => trianglesOf(new THREE.DodecahedronGeometry(1)), radius: 1.02, values: range(1, 12) },
  d20: { tris: () => trianglesOf(new THREE.IcosahedronGeometry(1)), radius: 1.08, values: range(1, 20) },
};

const shapeCache = new Map();
function kindData(kind) {
  if (!shapeCache.has(kind)) {
    const k = KINDS[kind];
    const shape = buildShape(k.tris(), k.radius);
    const geometry = buildGeometry(shape);
    const edges = new THREE.EdgesGeometry(geometry, 10);
    shapeCache.set(kind, { ...k, shape, geometry, edges });
  }
  return shapeCache.get(kind);
}

function labelText(kind, v) {
  const k = KINDS[kind];
  const t = k.text ? k.text(v) : String(v);
  if ((t === "6" || t === "9") && kind !== "d6" && kind !== "d4") return t + ".";
  return t;
}

// ---------------------------------------------------------------------------
// Texturas
// ---------------------------------------------------------------------------

const FONT = '700 {px}px "SF Pro Display", "Segoe UI", system-ui, -apple-system, Roboto, sans-serif';

function makeCanvas() {
  const c = document.createElement("canvas");
  c.width = c.height = TEX;
  return c;
}

function fitFont(ctx, text, maxW, px) {
  ctx.font = FONT.replace("{px}", px);
  const w = ctx.measureText(text).width;
  if (w > maxW) {
    px = Math.floor((px * maxW) / w);
    ctx.font = FONT.replace("{px}", px);
  }
  return px;
}

// Duas versões de cada face: cor (fundo grafite, número vermelho) e emissiva (só o número).
function paintFace(color, glow, face, draw) {
  for (const [canvas, emissive] of [[color, false], [glow, true]]) {
    const ctx = canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = emissive ? "#000" : "#141416";
    ctx.fillRect(0, 0, TEX, TEX);
    if (!emissive) {
      // leve vinheta para dar volume à face
      const g = ctx.createRadialGradient(TEX / 2, TEX / 2, 0, TEX / 2, TEX / 2, TEX * 0.5);
      g.addColorStop(0, "#1d1d21");
      g.addColorStop(1, "#0d0d0f");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, TEX, TEX);
    }
    ctx.fillStyle = emissive ? "#ff3344" : RED;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    draw(ctx, face);
  }
}

const faceCanvasCache = new Map();
function numberCanvases(kind, faceIdx, value) {
  const key = `${kind}|${faceIdx}|${value}`;
  if (faceCanvasCache.has(key)) return faceCanvasCache.get(key);
  const data = kindData(kind);
  const face = data.shape.faces[faceIdx];
  const color = makeCanvas();
  const glow = makeCanvas();
  const text = labelText(kind, value);
  const ratio = face.inradius / face.R; // 0.5 triângulo, ~0.7 quadrado, 0.8 pentágono
  paintFace(color, glow, face, (ctx) => {
    const maxW = TEX * ratio * 0.95;
    let px = Math.round(TEX * ratio * (text.length > 2 ? 0.55 : 0.72));
    px = fitFont(ctx, text, maxW, px);
    ctx.fillText(text, TEX / 2, TEX / 2 + px * 0.04);
  });
  const out = { color, glow };
  faceCanvasCache.set(key, out);
  return out;
}

// d4: cada face mostra três números, um perto de cada vértice; vale o do vértice de cima.
function paintD4Face(color, glow, face, vertexLabels) {
  paintFace(color, glow, face, (ctx) => {
    const px = Math.round(TEX * 0.17);
    ctx.font = FONT.replace("{px}", px);
    face.idx.forEach((vi, k) => {
      const [u, v] = face.uvs[k];
      const cx = TEX / 2;
      const cy = TEX / 2;
      const x = u * TEX;
      const y = (1 - v) * TEX;
      const px2 = cx + (x - cx) * 0.56;
      const py2 = cy + (y - cy) * 0.56;
      ctx.save();
      ctx.translate(px2, py2);
      ctx.rotate(Math.atan2(x - cx, -(y - cy)));
      ctx.fillText(String(vertexLabels[vi]), 0, 0);
      ctx.restore();
    });
  });
}

// ---------------------------------------------------------------------------
// Dado (corpo)
// ---------------------------------------------------------------------------

let uid = 0;

class Die {
  constructor(kind) {
    this.id = ++uid;
    this.kind = kind;
    this.data = kindData(kind);
    const { shape, geometry, edges, values } = this.data;
    this.materials = [];
    this.textures = [];
    if (this.data.vertexLabels) {
      this.labels = shape.verts.map((_, i) => values[i]);
      this.d4Canvases = shape.faces.map(() => ({ color: makeCanvas(), glow: makeCanvas() }));
    } else {
      this.labels = shape.faces.map((_, i) => values[i % values.length]);
    }
    shape.faces.forEach((_, fi) => {
      const mat = new THREE.MeshPhysicalMaterial({
        color: 0xffffff,
        roughness: 0.32,
        metalness: 0.15,
        clearcoat: 0.6,
        clearcoatRoughness: 0.25,
        emissive: new THREE.Color(1, 0.1, 0.12),
        emissiveIntensity: 1.4,
      });
      this.materials.push(mat);
    });
    this.paintAll();
    this.mesh = new THREE.Mesh(geometry, this.materials);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.edgeMat = new THREE.LineBasicMaterial({ color: 0x5a0e14, transparent: true, opacity: 0.9 });
    this.mesh.add(new THREE.LineSegments(edges, this.edgeMat));
    this.mesh.userData.die = this;
    this.glow = 1;
    this.focus = null;
    this.focusAmt = 0;
  }

  setTexture(fi, canvases) {
    const mat = this.materials[fi];
    const make = (c) => {
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      t.center.set(0.5, 0.5);
      t.anisotropy = 4;
      return t;
    };
    mat.map?.dispose();
    mat.emissiveMap?.dispose();
    mat.map = make(canvases.color);
    mat.emissiveMap = make(canvases.glow);
    mat.needsUpdate = true;
  }

  paintAll() {
    const { shape } = this.data;
    if (this.data.vertexLabels) {
      shape.faces.forEach((f, fi) => {
        const c = this.d4Canvases[fi];
        paintD4Face(c.color, c.glow, f, this.labels);
        if (this.materials[fi].map) {
          this.materials[fi].map.needsUpdate = true;
          this.materials[fi].emissiveMap.needsUpdate = true;
        } else {
          this.setTexture(fi, c);
        }
      });
    } else {
      shape.faces.forEach((_, fi) => this.setTexture(fi, numberCanvases(this.kind, fi, this.labels[fi])));
    }
  }

  // Índice da face (ou vértice, no d4) que está para cima com o quaternion dado.
  topIndex(q = this.mesh.quaternion) {
    const { shape } = this.data;
    if (this.data.vertexLabels) {
      let best = 0;
      let bestY = -Infinity;
      shape.verts.forEach((v, i) => {
        const y = v.clone().applyQuaternion(q).y;
        if (y > bestY) { bestY = y; best = i; }
      });
      return best;
    }
    let best = 0;
    let bestDot = -Infinity;
    shape.faces.forEach((f, i) => {
      const d = f.normal.clone().applyQuaternion(q).dot(UP);
      if (d > bestDot) { bestDot = d; best = i; }
    });
    return best;
  }

  readTop() {
    return this.labels[this.topIndex()];
  }

  // Faz a face de cima (na orientação final q) mostrar `value`, legível para a câmera.
  assign(value, q) {
    const top = this.topIndex(q);
    const j = this.labels.indexOf(value);
    if (this.data.vertexLabels) {
      if (j !== top) {
        [this.labels[top], this.labels[j]] = [this.labels[j], this.labels[top]];
        this.paintAll();
      }
      return;
    }
    if (j !== top) {
      [this.labels[top], this.labels[j]] = [this.labels[j], this.labels[top]];
      this.setTexture(top, numberCanvases(this.kind, top, this.labels[top]));
      this.setTexture(j, numberCanvases(this.kind, j, this.labels[j]));
    }
    // gira o número da face de cima para ficar de pé em relação à câmera
    const f = this.data.shape.faces[top];
    const n = f.normal.clone().applyQuaternion(q);
    const up = f.up.clone().applyQuaternion(q);
    const want = new V(0, 0, -1).projectOnPlane(n).normalize();
    const theta = Math.atan2(n.dot(new V().crossVectors(up, want)), up.dot(want));
    this.materials.forEach((m) => {
      m.map.rotation = 0;
      m.emissiveMap.rotation = 0;
    });
    this.materials[top].map.rotation = theta;
    this.materials[top].emissiveMap.rotation = theta;
  }

  // focus: índice da face em destaque (a de cima) e quanto do destaque aplicar (0..1).
  setFocus(index, amount = 1) {
    this.focus = this.data.vertexLabels ? null : index;
    this.focusAmt = amount;
    this.setGlow(this.glow);
  }

  setGlow(k) {
    this.glow = k;
    const a = this.focus == null ? 0 : this.focusAmt;
    this.materials.forEach((m, i) => {
      const target = i === this.focus ? 2.8 : 0.32;
      m.emissiveIntensity = (1.4 + (target - 1.4) * a) * k;
    });
    this.edgeMat.opacity = 0.35 + 0.55 * Math.min(1, k);
  }

  // Altura de repouso: menor y dos vértices girados.
  restY(q, scale) {
    let minY = Infinity;
    for (const v of this.data.shape.verts) minY = Math.min(minY, v.clone().applyQuaternion(q).y);
    return -minY * scale;
  }

  dispose() {
    this.materials.forEach((m) => {
      m.map?.dispose();
      m.emissiveMap?.dispose();
      m.dispose();
    });
    this.edgeMat.dispose();
  }
}

// ---------------------------------------------------------------------------
// Mesa
// ---------------------------------------------------------------------------

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
function easeOutBounce(t) {
  const n = 7.5625;
  const d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
}

export class Table {
  constructor(container, { reducedMotion }) {
    this.container = container;
    this.reducedMotion = reducedMotion;
    this.dice = [];
    this.scale = 1;
    this.tweens = [];
    this.playback = null;
    this.insets = { top: 80, bottom: 200 };
    this.awake = 0;

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x060607);
    scene.fog = new THREE.Fog(0x060607, 22, 40);
    this.scene = scene;

    this.camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);

    // chão
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(80, 80),
      new THREE.MeshStandardMaterial({ color: 0x0b0b0d, roughness: 0.92, metalness: 0 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    // brilho vermelho difuso no centro da mesa
    const gc = document.createElement("canvas");
    gc.width = gc.height = 256;
    const g = gc.getContext("2d");
    const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    grad.addColorStop(0, "rgba(255,30,45,0.22)");
    grad.addColorStop(0.5, "rgba(255,30,45,0.06)");
    grad.addColorStop(1, "rgba(255,30,45,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 256);
    const halo = new THREE.Mesh(
      new THREE.PlaneGeometry(22, 14),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(gc), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
    );
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = 0.01;
    scene.add(halo);
    this.halo = halo;

    // luzes
    scene.add(new THREE.AmbientLight(0xffffff, 0.35));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(-4, 14, 6);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -14;
    key.shadow.camera.right = 14;
    key.shadow.camera.top = 14;
    key.shadow.camera.bottom = -14;
    key.shadow.radius = 6;
    key.shadow.bias = -0.0005;
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xff2233, 2.4);
    rim.position.set(6, 4, -10);
    scene.add(rim);
    const fill = new THREE.DirectionalLight(0x8899ff, 0.25);
    fill.position.set(8, 6, 8);
    scene.add(fill);
    this.flashLight = new THREE.PointLight(0xff2233, 0, 30, 1.6);
    this.flashLight.position.set(0, 4, 0);
    scene.add(this.flashLight);

    // pós-processamento: bloom só nos números
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.85, 0.45, 0.55);
    composer.addPass(this.bloom);
    composer.addPass(new OutputPass());
    this.composer = composer;

    this.resize();
    new ResizeObserver(() => this.resize()).observe(container);

    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  setInsets(insets) {
    this.insets = insets;
    this.resize();
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w, h);
    const aspect = w / h;
    this.camera.aspect = aspect;
    const far = aspect < 1 ? Math.min(2.1, 0.95 / aspect) : 1;
    this.camera.position.set(0, 15.5 * far, 7.5 * far);
    this.camera.lookAt(0, 0, 0.6);
    this.camera.updateProjectionMatrix();
    this.computeBounds();
    this.wake();
  }

  // Área do chão visível entre a barra de cima e o painel de baixo.
  computeBounds() {
    const h = this.container.clientHeight || 1;
    const yTop = 1 - (2 * this.insets.top) / h;
    const yBot = -1 + (2 * this.insets.bottom) / h;
    const hit = (x, y) => {
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(x, y), this.camera);
      const p = new V();
      ray.ray.intersectPlane(new THREE.Plane(UP, 0), p);
      return p;
    };
    const tl = hit(-1, yTop);
    const bl = hit(-1, yBot);
    const halfX = Math.min(Math.abs(tl.x), Math.abs(bl.x)) - 0.4;
    this.bounds = {
      minX: -halfX,
      maxX: halfX,
      minZ: tl.z + 0.5,
      maxZ: bl.z - 0.3,
    };
    const b = this.bounds;
    this.halo.position.set(0, 0.01, (b.minZ + b.maxZ) / 2);
  }

  setScale(s) {
    this.scale = s;
    this.wake();
  }

  wake(ms = 400) {
    this.awake = Math.max(this.awake, performance.now() + ms);
  }

  tween(dur, update, done) {
    const t = { start: performance.now(), dur, update, done };
    this.tweens.push(t);
    this.wake(dur + 100);
    return t;
  }

  freeSpot() {
    const b = this.bounds;
    const minD = 2.0 * this.scale;
    let best = null;
    let bestD = -1;
    for (let i = 0; i < 80; i++) {
      const p = new V(THREE.MathUtils.lerp(b.minX + 0.6, b.maxX - 0.6, Math.random()), 0, THREE.MathUtils.lerp(b.minZ + 0.6, b.maxZ - 0.6, Math.random()));
      let d = Infinity;
      for (const o of this.dice) d = Math.min(d, o.mesh.position.distanceTo(p));
      if (d >= minD) return p;
      if (d > bestD) { bestD = d; best = p; }
    }
    return best;
  }

  add(kind) {
    const die = new Die(kind);
    const { shape } = die.data;
    // pousa com uma face para cima (no d4, uma face para baixo)
    const f = shape.faces[Math.floor(Math.random() * shape.faces.length)];
    const q = new THREE.Quaternion().setFromUnitVectors(f.normal, die.data.vertexLabels ? UP.clone().negate() : UP);
    q.premultiply(new THREE.Quaternion().setFromAxisAngle(UP, Math.random() * Math.PI * 2));
    const spot = this.freeSpot();
    const restY = die.restY(q, this.scale);
    die.mesh.quaternion.copy(q);
    die.mesh.position.set(spot.x, restY, spot.z);
    die.mesh.scale.setScalar(this.scale);
    this.scene.add(die.mesh);
    this.dice.push(die);

    if (this.reducedMotion.matches) {
      this.wake();
      return die;
    }
    const spin = new THREE.Quaternion();
    const extra = (Math.random() < 0.5 ? -1 : 1) * 0.9;
    this.tween(
      520,
      (p) => {
        die.mesh.position.y = restY + 4 * (1 - easeOutBounce(p));
        spin.setFromAxisAngle(UP, extra * (1 - easeOutCubic(p)));
        die.mesh.quaternion.copy(q).premultiply(spin);
        die.mesh.scale.setScalar(this.scale * (0.6 + 0.4 * easeOutCubic(Math.min(1, p * 2))));
      },
      () => {
        die.mesh.quaternion.copy(q);
        die.mesh.position.y = restY;
        die.mesh.scale.setScalar(this.scale);
      }
    );
    return die;
  }

  remove(die) {
    const i = this.dice.indexOf(die);
    if (i === -1) return;
    this.dice.splice(i, 1);
    const finish = () => {
      this.scene.remove(die.mesh);
      die.dispose();
    };
    if (this.reducedMotion.matches) return finish(), this.wake();
    const s0 = die.mesh.scale.x;
    const y0 = die.mesh.position.y;
    this.tween(
      200,
      (p) => {
        const e = p * p;
        die.mesh.scale.setScalar(s0 * (1 - e));
        die.mesh.position.y = y0 + e * 0.8;
      },
      finish
    );
  }

  // targets: Map<Die, valor>. Resolve true quando os dados param; false se interrompido.
  roll(targets) {
    if (this.playback) this.playback.resolve(false);
    this.tweens = this.tweens.filter((t) => (t.done?.(), false));

    const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -42, 0) });
    world.allowSleep = true;
    world.solver.iterations = 14;
    world.defaultContactMaterial.friction = 0.28;
    world.defaultContactMaterial.restitution = 0.32;

    const plane = (pos, euler) => {
      const body = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() });
      body.position.set(...pos);
      body.quaternion.setFromEuler(...euler);
      world.addBody(body);
    };
    const b = this.bounds;
    plane([0, 0, 0], [-Math.PI / 2, 0, 0]);
    plane([b.minX, 0, 0], [0, Math.PI / 2, 0]);
    plane([b.maxX, 0, 0], [0, -Math.PI / 2, 0]);
    plane([0, 0, b.minZ], [0, 0, 0]);
    plane([0, 0, b.maxZ], [0, Math.PI, 0]);

    const s = this.scale;
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;
    const bodies = this.dice.map((die) => {
      const { shape } = die.data;
      const hull = new CANNON.ConvexPolyhedron({
        vertices: shape.verts.map((v) => new CANNON.Vec3(v.x * s, v.y * s, v.z * s)),
        faces: shape.faces.map((f) => f.idx),
      });
      const m = die.mesh;
      const body = new CANNON.Body({
        mass: 1,
        shape: hull,
        position: new CANNON.Vec3(m.position.x, m.position.y + 0.8 * s, m.position.z),
        quaternion: new CANNON.Quaternion(m.quaternion.x, m.quaternion.y, m.quaternion.z, m.quaternion.w),
        linearDamping: 0.12,
        angularDamping: 0.12,
        allowSleep: true,
        sleepSpeedLimit: 0.25,
        sleepTimeLimit: 0.2,
      });
      const r = (a) => (Math.random() * 2 - 1) * a;
      body.velocity.set((cx - m.position.x) * 0.9 + r(5), 9 + Math.random() * 4, (cz - m.position.z) * 0.9 + r(5));
      body.angularVelocity.set(r(22), r(22), r(22));
      world.addBody(body);
      return body;
    });

    // simula tudo de uma vez e grava os quadros
    const n = bodies.length;
    const frames = [];
    for (let f = 0; f < MAX_FRAMES; f++) {
      for (let k = 0; k < SUBSTEPS; k++) world.step(STEP / SUBSTEPS);
      const fr = new Float32Array(n * 7);
      bodies.forEach((body, i) => {
        fr.set([body.position.x, body.position.y, body.position.z, body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w], i * 7);
      });
      frames.push(fr);
      if (f > 20 && bodies.every((body) => body.sleepState === CANNON.Body.SLEEPING)) break;
    }

    // troca os números para que a face de cima seja a sorteada
    const last = frames[frames.length - 1];
    this.dice.forEach((die, i) => {
      die.focus = null;
      die.setGlow(1);
      if (!targets.has(die)) return;
      const q = new THREE.Quaternion(last[i * 7 + 3], last[i * 7 + 4], last[i * 7 + 5], last[i * 7 + 6]);
      die.assign(targets.get(die), q);
    });

    const dice = this.dice.slice();
    return new Promise((resolve) => {
      const apply = (fi, t) => {
        const a = frames[fi];
        const bF = frames[Math.min(fi + 1, frames.length - 1)];
        const qa = new THREE.Quaternion();
        const qb = new THREE.Quaternion();
        dice.forEach((die, i) => {
          const o = i * 7;
          die.mesh.position.set(
            a[o] + (bF[o] - a[o]) * t,
            a[o + 1] + (bF[o + 1] - a[o + 1]) * t,
            a[o + 2] + (bF[o + 2] - a[o + 2]) * t
          );
          qa.set(a[o + 3], a[o + 4], a[o + 5], a[o + 6]);
          qb.set(bF[o + 3], bF[o + 4], bF[o + 5], bF[o + 6]);
          die.mesh.quaternion.slerpQuaternions(qa, qb, t);
          die.mesh.scale.setScalar(s);
        });
      };
      const pb = {
        dice,
        start: performance.now(),
        frames: frames.length,
        apply,
        resolve: (ok) => {
          if (this.playback === pb) this.playback = null;
          resolve(ok);
        },
      };
      if (this.reducedMotion.matches) {
        apply(frames.length - 1, 0);
        dice.forEach((d) => d.setFocus(d.topIndex(), 1));
        this.wake();
        resolve(true);
        return;
      }
      this.playback = pb;
      this.wake(frames.length * 17 + 200);
    });
  }

  // Ao parar: acende a face de cima e apaga as outras.
  settle(dice) {
    const idx = dice.map((d) => d.topIndex());
    this.tween(380, (p) => dice.forEach((d, i) => d.setFocus(idx[i], easeOutCubic(p))));
  }

  flash(strength = 1) {
    if (this.reducedMotion.matches) return;
    this.tween(900, (p) => {
      this.flashLight.intensity = 60 * strength * Math.pow(1 - p, 2) * Math.min(1, p * 8);
    }, () => (this.flashLight.intensity = 0));
  }

  pulse(die) {
    if (this.reducedMotion.matches) return;
    this.tween(1100, (p) => die.setGlow(1 + 2.2 * Math.sin(Math.PI * Math.min(1, p * 1.4)) * (1 - p * 0.3)), () => die.setGlow(1));
  }

  dim(die) {
    if (this.reducedMotion.matches) return die.setGlow(0.25);
    this.tween(400, (p) => die.setGlow(1 - 0.75 * easeOutCubic(p)));
  }

  // Interrompe a reprodução, deixando os dados onde iriam parar.
  stop() {
    const pb = this.playback;
    if (!pb) return;
    pb.apply(pb.frames - 1, 0);
    pb.resolve(false);
    this.wake();
  }

  isRolling() {
    return !!this.playback;
  }

  loop(now) {
    this.raf = requestAnimationFrame(this.loop);
    if (this.playback) {
      const pb = this.playback;
      const f = Math.max(0, (now - pb.start) / (1000 * STEP));
      if (f >= pb.frames - 1) {
        pb.apply(pb.frames - 1, 0);
        this.settle(pb.dice);
        pb.resolve(true);
      } else {
        pb.apply(Math.floor(f), f - Math.floor(f));
      }
      this.wake(200);
    }
    if (this.tweens.length) {
      this.tweens = this.tweens.filter((t) => {
        const p = Math.min(1, (now - t.start) / t.dur);
        t.update(p);
        if (p >= 1) {
          t.done?.();
          return false;
        }
        return true;
      });
    }
    if (now < this.awake) this.composer.render();
  }
}

export function webglAvailable() {
  try {
    const c = document.createElement("canvas");
    return !!(window.WebGLRenderingContext && (c.getContext("webgl2") || c.getContext("webgl")));
  } catch {
    return false;
  }
}
