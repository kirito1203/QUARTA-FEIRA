import { Table, webglAvailable } from "./dice3d.js";

const MAX_DICE = 16;
const MAX_HISTORY = 40;
const SIDES = [4, 6, 8, 10, 12, 20, 100];
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

// ---------- Sorteio justo (crypto, sem viés de módulo) ----------
function rollDie(sides) {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / sides) * sides;
  let x;
  do {
    crypto.getRandomValues(buf);
    x = buf[0];
  } while (x >= limit);
  return (x % sides) + 1;
}

// ---------- Elementos ----------
const $ = (id) => document.getElementById(id);
const stage = $("stage");
const diceRow = $("dice-row");
const rollBtn = $("roll");
const formulaEl = $("formula");
const modValue = $("mod-value");
const modeGroup = $("mode");
const resultEl = $("result");
const totalEl = $("total");
const detailEl = $("detail");
const verdictEl = $("verdict");
const hintEl = $("hint");
const drawer = $("drawer");
const scrim = $("scrim");
const historyList = $("history-list");
const historyEmpty = $("history-empty");
const historyClear = $("history-clear");
const toastEl = $("toast");

if (!webglAvailable()) {
  hintEl.textContent = "Seu navegador não tem suporte a 3D (WebGL).";
  throw new Error("WebGL indisponível");
}

const table = new Table(stage, { reducedMotion: reduceMotion });

// ---------- Estado ----------
const state = {
  pool: [], // { sides, bodies: Die[], value, kept, dropped }
  mod: 0,
  mode: "normal",
  history: [],
  rolling: false,
};
let rollId = 0;
let loaded = false;

// ---------- Botões de dado ----------
const ICONS = {
  4: '<polygon class="shape" points="32,6 59,54 5,54"/>',
  6: '<rect class="shape" x="9" y="9" width="46" height="46" rx="6"/>',
  8: '<polygon class="shape" points="32,3 61,32 32,61 3,32"/>',
  10: '<polygon class="shape" points="32,3 60,26 32,61 4,26"/>',
  12: '<polygon class="shape" points="32,4 60,24 50,58 14,58 4,24"/>',
  20: '<polygon class="shape" points="32,2 59,17 59,47 32,62 5,47 5,17"/>',
  100: '<circle class="shape" cx="32" cy="32" r="28"/>',
};
const LABEL_Y = { 4: 40, 10: 29, 12: 34 };
const pickers = new Map();
for (const s of SIDES) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "die-btn";
  btn.dataset.sides = s;
  btn.setAttribute("aria-label", `Adicionar d${s}`);
  const fs = s === 100 ? 19 : s >= 10 ? 23 : 27;
  btn.innerHTML = `<span class="count" aria-hidden="true">0</span><svg viewBox="0 0 64 64" aria-hidden="true">${ICONS[s]}<text class="lbl" x="32" y="${LABEL_Y[s] || 32}" style="font-size:${fs}px">${s === 100 ? "%" : s}</text></svg>`;
  attachPress(btn, () => addDie(s), () => removeOfType(s));
  diceRow.appendChild(btn);
  pickers.set(s, btn);
}

// clique adiciona; botão direito, shift+clique ou toque longo remove
function attachPress(btn, onAdd, onRemove) {
  let timer = null;
  let long = false;
  btn.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") return;
    long = false;
    timer = setTimeout(() => {
      long = true;
      onRemove();
      navigator.vibrate?.(12);
    }, 450);
  });
  const cancel = () => clearTimeout(timer);
  ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => btn.addEventListener(ev, cancel));
  btn.addEventListener("click", (e) => {
    if (long) return void (long = false);
    e.shiftKey ? onRemove() : onAdd();
  });
  btn.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (!long) onRemove();
  });
}

// ---------- Pool ----------
function bodiesFor(sides, mode) {
  if (sides === 100) return ["d10t", "d10u"];
  if (sides === 20 && mode !== "normal") return ["d20", "d20"];
  return [`d${sides}`];
}

function stopRoll() {
  if (!state.rolling) return;
  rollId++;
  state.rolling = false;
  table.stop();
}

function addDie(sides, { quiet = false } = {}) {
  stopRoll();
  if (state.pool.length >= MAX_DICE) {
    toast(`Máximo de ${MAX_DICE} dados na mesa`);
    shake(pickers.get(sides));
    return;
  }
  const die = { sides, bodies: bodiesFor(sides, state.mode).map((k) => table.add(k)), value: null };
  state.pool.push(die);
  if (!quiet) hideResult();
  refresh();
}

function removeDie(die) {
  stopRoll();
  const i = state.pool.indexOf(die);
  if (i === -1) return;
  state.pool.splice(i, 1);
  die.bodies.forEach((b) => table.remove(b));
  hideResult();
  refresh();
}

function removeOfType(sides) {
  for (let i = state.pool.length - 1; i >= 0; i--) {
    if (state.pool[i].sides === sides) return removeDie(state.pool[i]);
  }
  shake(pickers.get(sides));
}

function clearAll() {
  stopRoll();
  state.pool.splice(0).forEach((d) => d.bodies.forEach((b) => table.remove(b)));
  hideResult();
  refresh();
}

function setMode(mode) {
  stopRoll();
  state.mode = mode;
  modeGroup.querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.mode === mode)));
  // d20 ganha (ou perde) o segundo dado
  for (const d of state.pool) {
    if (d.sides !== 20) continue;
    const want = mode === "normal" ? 1 : 2;
    while (d.bodies.length < want) d.bodies.push(table.add("d20"));
    while (d.bodies.length > want) table.remove(d.bodies.pop());
    d.bodies.forEach((b) => b.setFocus(null));
  }
  hideResult();
  refresh();
}
modeGroup.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b) setMode(state.mode === b.dataset.mode ? "normal" : b.dataset.mode);
});

function setMod(v) {
  state.mod = Math.max(-99, Math.min(99, v));
  modValue.textContent = signed(state.mod);
  hideResult();
  refresh();
}
$("mod-minus").addEventListener("click", () => setMod(state.mod - 1));
$("mod-plus").addEventListener("click", () => setMod(state.mod + 1));

// ---------- Texto ----------
function signed(n) {
  return n >= 0 ? `+${n}` : `−${Math.abs(n)}`;
}
function formulaText(sides, mod, mode) {
  if (!sides.length) return "Mesa vazia";
  const counts = new Map();
  sides.forEach((s) => counts.set(s, (counts.get(s) || 0) + 1));
  let t = [...counts].sort((a, b) => a[0] - b[0]).map(([s, c]) => `${c}d${s}`).join(" + ");
  if (mod) t += ` ${mod > 0 ? "+" : "−"} ${Math.abs(mod)}`;
  if (mode !== "normal" && sides.includes(20)) t += mode === "adv" ? " · vantagem" : " · desvantagem";
  return t;
}

function refresh() {
  const sides = state.pool.map((d) => d.sides);
  formulaEl.textContent = formulaText(sides, state.mod, state.mode);
  formulaEl.classList.toggle("filled", sides.length > 0);
  rollBtn.disabled = sides.length === 0;
  for (const [s, btn] of pickers) {
    const c = sides.filter((x) => x === s).length;
    const badge = btn.querySelector(".count");
    if (c && btn.classList.contains("has") && badge.textContent !== String(c) && !reduceMotion.matches) {
      badge.animate([{ transform: "translate(-50%,0) scale(1.4)" }, { transform: "translate(-50%,0) scale(1)" }], { duration: 240, easing: "cubic-bezier(0.22,1,0.36,1)" });
    }
    if (c) badge.textContent = c;
    btn.classList.toggle("has", c > 0);
    btn.setAttribute("aria-label", c ? `Adicionar d${s} (${c} na mesa)` : `Adicionar d${s}`);
  }
  // escala dos dados para caber muitos na mesa
  const bodies = state.pool.reduce((n, d) => n + d.bodies.length, 0);
  table.setScale(bodies > 6 ? Math.max(0.62, Math.sqrt(6 / bodies)) : 1);
  updateHint();
  save();
}

function updateHint() {
  if (state.rolling || resultEl.classList.contains("show")) return hintEl.classList.add("hide");
  hintEl.textContent = state.pool.length ? "Toque na mesa ou aperte Espaço para rolar" : "Escolha seus dados lá embaixo";
  hintEl.classList.remove("hide");
}

function hideResult() {
  resultEl.classList.remove("show", "crit", "fumble");
  updateHint();
}

// ---------- Rolagem ----------
async function roll() {
  if (!state.pool.length) return;
  const id = ++rollId;
  state.rolling = true;
  hideResult();
  hintEl.classList.add("hide");

  if (!reduceMotion.matches) {
    rollBtn.animate([{ transform: "scale(1)" }, { transform: "scale(0.94)" }, { transform: "scale(1)" }], { duration: 240, easing: "cubic-bezier(0.22,1,0.36,1)" });
  }

  // decide tudo antes; a animação só revela
  const targets = new Map();
  for (const d of state.pool) {
    d.dropped = null;
    if (d.sides === 100) {
      const r = rollDie(100);
      targets.set(d.bodies[0], Math.floor((r % 100) / 10) * 10);
      targets.set(d.bodies[1], r % 10);
      d.value = r;
      d.parts = null;
    } else if (d.sides === 20 && d.bodies.length === 2) {
      const a = rollDie(20);
      const b = rollDie(20);
      targets.set(d.bodies[0], a);
      targets.set(d.bodies[1], b);
      const keepFirst = state.mode === "adv" ? a >= b : a <= b;
      d.value = keepFirst ? a : b;
      d.parts = [a, b];
      d.dropped = d.bodies[keepFirst ? 1 : 0];
    } else {
      d.value = rollDie(d.sides);
      d.parts = null;
      targets.set(d.bodies[0], d.value);
    }
  }

  const ok = await table.roll(targets);
  if (!ok || id !== rollId) return;
  state.rolling = false;
  finish();
}

function finish() {
  const sum = state.pool.reduce((s, d) => s + d.value, 0);
  const total = sum + state.mod;

  for (const d of state.pool) if (d.dropped) table.dim(d.dropped);

  const groups = new Map();
  for (const d of state.pool) {
    if (!groups.has(d.sides)) groups.set(d.sides, []);
    groups.get(d.sides).push(d.parts ? `${d.value} [${d.parts[0] === d.value ? d.parts[1] : d.parts[0]}]` : d.value);
  }
  const parts = [...groups].sort((a, b) => a[0] - b[0]).map(([s, v]) => `d${s}: ${v.join(" + ")}`);
  if (state.mod) parts.push(`mod ${signed(state.mod)}`);
  const detail = parts.join("  ·  ");

  const d20s = state.pool.filter((d) => d.sides === 20);
  let kind = "";
  let verdict = "";
  if (d20s.some((d) => d.value === 20)) {
    kind = "crit";
    verdict = "Acerto crítico";
  } else if (d20s.length && d20s.every((d) => d.value === 1)) {
    kind = "fumble";
    verdict = "Falha crítica";
  } else if (state.pool.length > 1 && state.pool.every((d) => d.value === d.sides)) {
    kind = "crit";
    verdict = "Tudo no máximo";
  }

  if (kind === "crit") {
    table.flash(1);
    for (const d of state.pool) {
      if (d.value === d.sides) d.bodies.filter((b) => b !== d.dropped).forEach((b) => table.pulse(b));
    }
  }

  totalEl.textContent = total;
  detailEl.textContent = detail;
  verdictEl.textContent = verdict;
  verdictEl.className = `result-verdict ${kind}`;
  resultEl.classList.remove("crit", "fumble");
  if (kind) resultEl.classList.add(kind);
  void resultEl.offsetWidth;
  resultEl.classList.add("show");
  if (kind === "fumble" && !reduceMotion.matches) {
    totalEl.animate(
      [{ transform: "translateX(0)" }, { transform: "translateX(-6px)" }, { transform: "translateX(6px)" }, { transform: "translateX(-3px)" }, { transform: "translateX(0)" }],
      { duration: 360, delay: 120, easing: "ease-out" }
    );
  }
  updateHint();

  pushHistory({
    formula: formulaText(state.pool.map((d) => d.sides), state.mod, state.mode),
    dice: state.pool.map((d) => d.sides),
    mod: state.mod,
    mode: state.mode,
    total,
    detail,
    kind,
  });
}

// ---------- Histórico ----------
function historyItem(h) {
  const li = document.createElement("li");
  li.className = `h-item ${h.kind || ""}`;
  li.innerHTML = '<span class="h-formula"></span><span class="h-total"></span><span class="h-detail"></span><button type="button" class="h-again">Rolar de novo</button>';
  li.querySelector(".h-formula").textContent = h.formula;
  li.querySelector(".h-total").textContent = h.total;
  li.querySelector(".h-detail").textContent = h.detail;
  li.querySelector(".h-again").addEventListener("click", () => {
    closeDrawer();
    clearAll();
    setMod(h.mod);
    setMode(h.mode);
    h.dice.forEach((s) => addDie(s, { quiet: true }));
    setTimeout(roll, reduceMotion.matches ? 0 : 450);
  });
  return li;
}

function pushHistory(h) {
  state.history.unshift(h);
  state.history.length = Math.min(state.history.length, MAX_HISTORY);
  historyList.prepend(historyItem(h));
  while (historyList.children.length > MAX_HISTORY) historyList.lastElementChild.remove();
  syncHistory();
  save();
}

function syncHistory() {
  historyEmpty.hidden = state.history.length > 0;
  historyClear.disabled = state.history.length === 0;
}

historyClear.addEventListener("click", () => {
  state.history = [];
  historyList.replaceChildren();
  syncHistory();
  save();
});

let lastFocus = null;
function openDrawer() {
  lastFocus = document.activeElement;
  drawer.classList.add("open");
  scrim.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
  $("history-close").focus({ preventScroll: true });
}
function closeDrawer() {
  if (!drawer.classList.contains("open")) return;
  drawer.classList.remove("open");
  scrim.classList.remove("open");
  drawer.setAttribute("aria-hidden", "true");
  lastFocus?.focus?.({ preventScroll: true });
}
$("history-open").addEventListener("click", openDrawer);
$("history-close").addEventListener("click", closeDrawer);
scrim.addEventListener("click", closeDrawer);

// ---------- Pequenos efeitos ----------
let toastTimer = 0;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1800);
}
function shake(el) {
  if (!el || reduceMotion.matches) return;
  el.animate(
    [{ transform: "translateX(0)" }, { transform: "translateX(-4px)" }, { transform: "translateX(4px)" }, { transform: "translateX(0)" }],
    { duration: 240, easing: "ease-out" }
  );
}

// ---------- Persistência ----------
function save() {
  if (!loaded) return;
  try {
    localStorage.setItem("dado-solto-3d", JSON.stringify({ dice: state.pool.map((d) => d.sides), mod: state.mod, mode: state.mode, history: state.history }));
  } catch {}
}
function load() {
  try {
    const data = JSON.parse(localStorage.getItem("dado-solto-3d") || "null");
    if (!data) return;
    state.history = Array.isArray(data.history) ? data.history.slice(0, MAX_HISTORY) : [];
    state.history.forEach((h) => historyList.appendChild(historyItem(h)));
    setMod(Number(data.mod) || 0);
    setMode(["adv", "dis"].includes(data.mode) ? data.mode : "normal");
    (data.dice || []).filter((s) => SIDES.includes(s)).slice(0, MAX_DICE).forEach((s) => addDie(s, { quiet: true }));
  } catch {}
}

// ---------- Layout: diz à mesa quanto espaço as barras ocupam ----------
function syncInsets() {
  const dock = $("dock").getBoundingClientRect();
  const top = $("topbar").getBoundingClientRect();
  document.documentElement.style.setProperty("--dock-h", `${window.innerHeight - dock.top}px`);
  table.setInsets({ top: top.bottom + 150, bottom: window.innerHeight - dock.top + 50 });
}
window.addEventListener("resize", syncInsets);

// ---------- Entrada ----------
rollBtn.addEventListener("click", roll);
$("clear").addEventListener("click", () => {
  clearAll();
  setMod(0);
});

let down = null;
stage.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY }));
stage.addEventListener("pointerup", (e) => {
  if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 8) roll();
  down = null;
});

document.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "Escape") {
    if (drawer.classList.contains("open")) closeDrawer();
    else clearAll();
  } else if (drawer.classList.contains("open")) {
    return;
  } else if (e.key === " " || (e.key === "Enter" && !(e.target instanceof HTMLButtonElement))) {
    e.preventDefault();
    roll();
  } else if (e.key === "Backspace" && state.pool.length) {
    e.preventDefault();
    removeDie(state.pool[state.pool.length - 1]);
  } else if (e.key === "h" || e.key === "H") {
    openDrawer();
  }
});

syncInsets();
setMode("normal");
load();
loaded = true;
syncHistory();
refresh();

// Gancho para os testes automatizados: compara o que a mesa mostra com o sorteado.
window.dadoSolto = {
  isRolling: () => state.rolling,
  dice: () =>
    state.pool.map((d) => ({
      sides: d.sides,
      value: d.value,
      parts: d.parts,
      visible: d.bodies.map((b) => b.readTop()),
    })),
};
