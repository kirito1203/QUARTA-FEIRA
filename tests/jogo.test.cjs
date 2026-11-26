// Teste do jogo "Lá em Cima" com Playwright.
// Uso: node tests/jogo.test.cjs [pasta-para-screenshots]
// O jogo é pausado e avançado quadro a quadro (window.jogo), então o resultado
// não depende da velocidade da máquina. Para cada fase o teste prova que cada
// pulo do caminho é possível, que os atalhos proibidos não funcionam e atravessa
// a fase até a porta. Os testes de caminho desligam os fantasmas; o combate é
// testado à parte.
const { chromium, devices } = require("playwright");
const path = require("path");
const fs = require("fs");

const URL = "file://" + path.resolve(__dirname, "../jogo/index.html");
const OUT = path.resolve(process.argv[2] || path.join(__dirname, "screenshots"));
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
function check(cond, msg) {
  console.log(`${cond ? "ok  " : "FAIL"}  ${msg}`);
  if (!cond) failures++;
}

// Funções auxiliares que rodam dentro da página.
const HELPERS = () => {
  const j = window.jogo;
  const release = () => { for (const k of ["left", "right", "jump", "fire"]) j.key(k, false); };
  window.T = {
    release,
    level(i, { enemies = false, power = false } = {}) {
      j.goto(i);
      j.enemies(enemies);
      if (power) T.powerOn();
    },
    // Põe o jogador parado em (x, superfície), espera `wait` quadros, pula
    // segurando `dir` e devolve onde pousou.
    jumpFrom({ level, power, x, y, dir, wait = 0 }) {
      if (level != null) T.level(level, { power });
      release();
      j.teleport(x, y - j.PH);
      j.step(2 + wait);
      j.key(dir, true); j.step(2);
      j.key("jump", true); j.step(1);
      for (let i = 0; i < 150; i++) { j.step(1); if (i > 3 && j.state().onGround) break; }
      release(); j.step(1);
      return j.state();
    },
    powerOn() {
      for (const lv of j.state().levers) { j.teleport(lv.x, lv.y - j.PH); j.step(4); }
      j.step(90);
    },
    walk(dir, frames) { j.key(dir, true); j.step(frames); j.key(dir, false); j.step(1); return j.state(); },
    walkUntil(dir, cond, max = 600) {
      j.key(dir, true);
      for (let i = 0; i < max && !cond(j.state()); i++) j.step(1);
      j.key(dir, false); j.step(1);
      return j.state();
    },
    walkToDoor() {
      const d = j.state().door;
      const dir = j.state().x + j.PW / 2 < d.x + 12 ? "right" : "left";
      j.key(dir, true);
      for (let i = 0; i < 400 && j.state().mode === "play"; i++) j.step(1);
      j.key(dir, false);
      for (let i = 0; i < 200 && !["play", "end"].includes(j.state().mode); i++) j.step(1);
      return j.state();
    },
    // espera a plataforma `idx` ficar perto de (x, y) e pula nela a partir de (fx, fy)
    rideFrom({ idx, fx, fy, dir, when, max = 500, hold = 16 }) {
      for (let w = 0; w < max; w += 4) {
        j.teleport(fx, fy - j.PH);
        j.step(4);
        if (!when(j.state().platforms[idx])) continue;
        j.key(dir, true); j.key("jump", true);
        for (let i = 0; i < 120; i++) { j.step(1); if (i === hold) j.key(dir, false); if (i > 3 && j.state().onGround) break; }
        release(); j.step(1);
        if (j.state().standOn === idx) return j.state();
      }
      return j.state();
    },
  };
};

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const watch = (p) => {
    p.on("pageerror", (e) => errors.push(e.message));
    p.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  };

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  watch(page);
  await page.goto(URL);
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, "jogo-01-titulo.png") });
  let s = await page.evaluate(() => window.jogo.state());
  check(s.mode === "title", "abre na tela de título");
  check(s.spriteReady, "sprites do personagem e do fantasma carregaram");
  check((await page.evaluate(() => window.jogo.levels)) === 8, "o jogo tem 8 fases");

  // ---------- Teclado de verdade, em tempo real ----------
  await page.keyboard.press("Space");
  await page.waitForTimeout(800);
  check((await page.evaluate(() => window.jogo.state().mode)) === "play", "Espaço começa o jogo");
  const x0 = await page.evaluate(() => window.jogo.state().x);
  await page.keyboard.down("ArrowRight");
  await page.waitForTimeout(250);
  const running = await page.evaluate(() => window.jogo.state().anim);
  await page.waitForTimeout(250);
  await page.keyboard.up("ArrowRight");
  const x1 = await page.evaluate(() => window.jogo.state().x);
  check(x1 > x0 + 15, `seta para a direita anda (${x0.toFixed(0)} → ${x1.toFixed(0)})`);
  check(running === "run", `animação de corrida ao andar (${running})`);
  await page.keyboard.down("Space");
  await page.waitForTimeout(150);
  const air = await page.evaluate(() => window.jogo.state());
  await page.keyboard.up("Space");
  check(!air.onGround && ["jump", "fall"].includes(air.anim), `Espaço pula, com animação de pulo (${air.anim})`);
  await page.waitForTimeout(900);

  // ---------- Daqui em diante, quadro a quadro ----------
  await page.evaluate(() => window.jogo.pause());
  await page.evaluate(HELPERS);
  const E = (fn, arg) => page.evaluate(fn, arg);
  const J = (args) => E((a) => T.jumpFrom(a), args);
  async function reach(level, x0, x1, y, dir, target, extra = {}) {
    let hits = 0;
    for (let x = x0; x <= x1; x += 4) if ((await J({ level, x, y, dir, ...extra })).standOn === target) hits++;
    return hits;
  }
  const can = (n, msg) => check(n > 0, `${msg} (${n} posições)`);
  const cannot = (n, msg) => check(n === 0, `${msg} (${n} posições)`);
  const shot = (name) => page.screenshot({ path: path.join(OUT, name) });

  // ================= FASE 1 =================
  can(await reach(0, 4, 60, 240, "right", 0), "fase 1: chão → 1ª plataforma");
  can(await reach(0, 84, 114, 192, "right", 1), "fase 1: 1ª → 2ª");
  can(await reach(0, 190, 218, 144, "right", 2), "fase 1: 2ª → 3ª");
  cannot(await reach(0, 4, 460, 240, "right", 2), "fase 1: do chão não dá para ir direto à última");
  s = await J({ level: 0, x: 210, y: 144, dir: "right" });
  s = await E(() => T.walkToDoor());
  check(s.level === 1, "fase 1 → fase 2 pela porta");

  // ================= FASE 2 =================
  s = await E(() => { T.level(1); window.jogo.teleport(240, 200); window.jogo.step(120); return window.jogo.state(); });
  check(s.x < 40 && s.mode === "play", "fase 2: cair no buraco recomeça a fase");
  s = await E(() => { T.level(1); return T.rideFrom({ idx: 0, fx: 140, fy: 240, dir: "right", when: (p) => p.x < 175 }); });
  check(s.standOn === 0, "fase 2: dá para pular na plataforma que anda");
  s = await E(() => { const j = window.jogo; for (let i = 0; i < 300 && j.state().platforms[0].x < 265; i++) j.step(1); j.key("right", true); j.key("jump", true); for (let i = 0; i < 120; i++) { j.step(1); if (i > 3 && j.state().onGround) break; } T.release(); j.step(20); return j.state(); });
  check((s.standOn === "chão" || s.standOn === 1) && s.x > 300, `fase 2: a plataforma leva até o outro lado (pousou em ${s.standOn})`);
  can(await reach(1, 318, 360, 240, "right", 1), "fase 2: chão direito → plataforma");
  can(await reach(1, 345, 380, 192, "left", 2), "fase 2: → plataforma de cima");
  can(await reach(1, 237, 270, 144, "left", 3), "fase 2: → plataforma da porta");
  await J({ level: 1, x: 240, y: 144, dir: "left" });
  s = await E(() => T.walkToDoor());
  check(s.level === 2, "fase 2 → fase 3 pela porta");

  // ================= FASE 3: alavanca + elevador =================
  s = await E(() => { T.level(2); window.jogo.step(200); return window.jogo.state(); });
  check(!s.power.a && s.platforms[2].y === 228, "fase 3: elevador parado antes da alavanca");
  can(await reach(2, 4, 40, 240, "right", 0), "fase 3: chão → plataforma A");
  can(await reach(2, 84, 118, 192, "right", 1), "fase 3: A → plataforma B");
  cannot(await reach(2, 174, 262, 144, "right", 3), "fase 3: de B não dá para pular até a porta");
  s = await E(() => { const j = window.jogo; T.level(2); j.teleport(214, 144 - j.PH); j.step(3); return T.walk("right", 30); });
  check(s.power.a && s.levers[0].on, "fase 3: encostar na alavanca liga a energia");
  s = await E(() => { T.level(2, { power: true }); return T.rideFrom({ idx: 2, fx: 296, fy: 240, dir: "right", when: (p) => p.y > 215 }); });
  check(s.standOn === 2, "fase 3: dá para subir no elevador ligado");
  s = await E(() => { const j = window.jogo; for (let i = 0; i < 400 && j.state().platforms[2].y > 66.5; i++) j.step(1); return T.walk("right", 30); });
  check(s.standOn === 3, "fase 3: o elevador leva até a plataforma da porta");
  s = await E(() => T.walkToDoor());
  check(s.level === 3, "fase 3 → fase 4 pela porta");

  // ================= FASE 4: chão que cai + ponte de luz =================
  can(await reach(3, 40, 80, 240, "right", 0), "fase 4: chão → frágil 1");
  can(await reach(3, 136, 164, 222, "right", 1), "fase 4: frágil 1 → 2");
  can(await reach(3, 220, 248, 192, "right", 2), "fase 4: frágil 2 → 3");
  can(await reach(3, 304, 332, 162, "right", 3), "fase 4: frágil 3 → plataforma da alavanca");
  s = await E(() => { const j = window.jogo; T.level(3); j.teleport(146, 222 - j.PH); j.step(40); return j.state(); });
  check(!s.platforms[0].solid, "fase 4: plataforma frágil cai se ficar parado nela");
  cannot(await reach(3, 388, 420, 140, "left", 4), "fase 4: sem a alavanca a ponte de luz não existe");
  can(await reach(3, 388, 410, 140, "left", 4, { power: true }), "fase 4: alavanca → luz 1");
  can(await reach(3, 300, 320, 110, "left", 5, { power: true }), "fase 4: luz 1 → luz 2");
  can(await reach(3, 212, 232, 88, "left", 6, { power: true }), "fase 4: luz 2 → luz 3");
  can(await reach(3, 128, 150, 72, "left", 7, { power: true }), "fase 4: luz 3 → porta");
  await J({ level: 3, power: true, x: 132, y: 72, dir: "left" });
  s = await E(() => T.walkToDoor());
  check(s.level === 4, "fase 4 → fase 5 pela porta");
  await E(() => window.jogo.step(1));
  await shot("jogo-02-fase5.png");

  // ================= FASE 5: fantasmas e fogo =================
  can(await reach(4, 240, 300, 240, "right", 0), "fase 5: chão → plataforma 1");
  can(await reach(4, 300, 330, 192, "left", 1), "fase 5: plataforma 1 → 2");
  can(await reach(4, 216, 244, 144, "right", 2), "fase 5: plataforma 2 → porta");
  // tiro: flash, empurrão leve; fantasma normal tem 2 de vida
  s = await E(() => {
    const j = window.jogo;
    T.level(4, { enemies: true });
    j.moveGhost(0, 200, 216); j.moveGhost(1, 400, 74);
    j.teleport(100, 240 - j.PH); j.step(2);
    T.walk("right", 2); j.step(4);
    const before = j.state();
    const hits = [];
    for (let k = 0; k < 2; k++) {
      j.key("fire", true); j.step(1); j.key("fire", false);
      const hp0 = j.state().ghosts[0].hp;
      let maxOx = 0, flash = 0, got = null;
      for (let i = 0; i < 40; i++) {
        j.step(1);
        const g = j.state().ghosts[0];
        if (!g) break;
        maxOx = Math.max(maxOx, g.ox); flash = Math.max(flash, g.flash);
        if (!got && g.hp < hp0) got = { hp: g.hp, dead: g.dead, ammo: j.state().ammo };
      }
      hits.push({ ...got, maxOx, flash });
    }
    j.step(40);
    return { before, hits, after: j.state() };
  });
  check(s.before.ghosts[0].hp === 2, `fantasma normal tem 2 de vida (${s.before.ghosts[0].hp})`);
  check(s.hits[0].hp === 1 && !s.hits[0].dead && s.hits[0].flash > 0, "1º tiro: o fantasma pisca branco e continua vivo");
  check(s.hits[0].maxOx > 6 && s.hits[0].maxOx < 20, `1º tiro: empurrão leve (${s.hits[0].maxOx.toFixed(1)} px)`);
  check(s.hits[1].dead, "2º tiro derruba o fantasma");
  check(s.before.ammo === 4 && s.hits[1].ammo === 2, `cada tiro gasta uma chama (${s.before.ammo} → ${s.hits[1].ammo})`);
  check(s.after.ghosts.length === 1, "o fantasma derrotado some");
  // munição acaba
  s = await E(() => {
    const j = window.jogo;
    T.level(4, { enemies: false });
    let fired = 0;
    for (let i = 0; i < 8; i++) { const a = j.state().ammo; j.key("fire", true); j.step(1); j.key("fire", false); j.step(20); if (j.state().ammo < a) fired++; }
    return { fired, ammo: j.state().ammo };
  });
  check(s.fired === 4 && s.ammo === 0, `o fogo é limitado: 8 tentativas, ${s.fired} tiros`);
  // pular em cima: tira 2, derrota o normal
  s = await E(() => {
    const j = window.jogo;
    T.level(4, { enemies: true });
    j.moveGhost(0, 200, 216); j.moveGhost(1, 400, 74);
    j.teleport(194, 150); j.step(1);
    let bounced = false, killed = false;
    for (let i = 0; i < 40; i++) { j.step(1); const st = j.state(); if (st.ghosts[0] && st.ghosts[0].dead) killed = true; if (killed && st.vy < 0) bounced = true; }
    return { killed, bounced, mode: j.state().mode, ammo: j.state().ammo };
  });
  check(s.killed && s.bounced && s.mode === "play", "pular em cima derrota o fantasma normal e quica");
  check(s.ammo === 4, "pular em cima não gasta fogo");
  // encostar
  s = await E(() => {
    const j = window.jogo;
    T.level(4, { enemies: true });
    j.moveGhost(0, 120, 216); j.moveGhost(1, 400, 74);
    const d0 = j.state().deaths;
    j.teleport(60, 240 - j.PH); j.step(2);
    j.key("right", true);
    let died = false;
    for (let i = 0; i < 80; i++) { j.step(1); if (j.state().mode === "dead") { died = true; break; } }
    T.release();
    j.step(70);
    return { died, d0, after: j.state() };
  });
  check(s.died, "encostar no fantasma faz perder");
  check(s.after.deaths === s.d0 + 1 && s.after.mode === "play" && s.after.x < 40, "depois de perder, conta uma queda e a fase recomeça");
  // atravessa a fase 5 com fantasmas usando os 4 tiros
  s = await E(() => {
    const j = window.jogo;
    T.level(4, { enemies: true });
    j.moveGhost(0, 200, 216); j.moveGhost(1, 380, 74);
    for (let k = 0; k < 2; k++) { j.key("fire", true); j.step(1); j.key("fire", false); j.step(30); }
    j.step(40);
    return j.state();
  });
  check(s.ghosts.length === 1, "fase 5: dois tiros limpam o caminho no chão");
  await E(() => { window.jogo.enemies(false); });
  await J({ x: 236, y: 144, dir: "right" });
  s = await E(() => { const j = window.jogo; j.enemies(true); for (let k = 0; k < 2; k++) { j.key("fire", true); j.step(1); j.key("fire", false); j.step(30); } j.step(40); return j.state(); });
  check(s.ghosts.length === 0, "fase 5: mais dois tiros derrubam o fantasma da porta");
  s = await E(() => T.walkToDoor());
  check(s.level === 5, "fase 5 → fase 6 pela porta");
  await E(() => window.jogo.step(1));
  await shot("jogo-03-fase6.png");

  // ================= FASE 6: caixa + botão + portão =================
  s = await E(() => { const j = window.jogo; T.level(5); j.teleport(390, 240 - j.PH); j.step(2); return T.walk("right", 60); });
  check(s.x + 12 <= 414.5 && s.gates[0].open === 0, "fase 6: portão fechado bloqueia a porta");
  s = await E(() => { const j = window.jogo; T.level(5); j.teleport(336, 240 - j.PH); j.step(30); return j.state(); });
  check(s.plates[0].down && s.power.a && s.gates[0].open > 0.9, "fase 6: ficar no botão abre o portão");
  s = await E(() => { T.walk("left", 40); window.jogo.step(40); return window.jogo.state(); });
  check(s.gates[0].open === 0, "fase 6: sair do botão fecha o portão");
  s = await E(() => {
    const j = window.jogo;
    T.level(5);
    j.teleport(152, 192 - j.PH); j.step(3);
    T.walkUntil("right", (st) => st.boxes[0].y > 200 || st.x > 240, 300);
    j.step(40);
    return j.state();
  });
  check(s.boxes[0].onGround && s.boxes[0].y === 222, `fase 6: empurrar a caixa para fora da plataforma faz ela cair no chão (x=${s.boxes[0].x.toFixed(0)})`);
  s = await E(() => {
    const j = window.jogo;
    const b = j.state().boxes[0];
    j.teleport(b.x - 14, 240 - j.PH); j.step(3);
    T.walkUntil("right", (st) => st.boxes[0].x >= 334, 500);
    j.step(30);
    return j.state();
  });
  check(s.plates[0].down && s.gates[0].open === 1, `fase 6: caixa no botão mantém o portão aberto (caixa x=${s.boxes[0].x.toFixed(0)})`);
  s = await E(() => { const j = window.jogo; T.walk("left", 8); j.key("right", true); j.key("jump", true); for (let i = 0; i < 120; i++) { j.step(1); if (i > 3 && j.state().onGround) break; } T.release(); j.step(5); return j.state(); });
  check(s.x > s.boxes[0].x + 18 && s.plates[0].down, "fase 6: pula por cima da caixa sem tirá-la do botão");
  s = await E(() => T.walkToDoor());
  check(s.level === 6, "fase 6 → fase 7 pela porta");
  await E(() => window.jogo.step(1));
  await shot("jogo-04-fase7.png");

  // ================= FASE 7: duas alavancas =================
  can(await reach(6, 60, 100, 240, "right", 0), "fase 7: chão → degrau 1");
  can(await reach(6, 140, 158, 192, "right", 1), "fase 7: degrau 1 → degrau da alavanca B");
  cannot(await reach(6, 214, 278, 144, "right", 3), "fase 7: sem elevador não chega no alto");
  s = await E(() => { const j = window.jogo; T.level(6, { enemies: true }); const a = j.state().ammo; j.teleport(136, 192 - j.PH); j.step(3); return { a, b: j.state().ammo, flames: j.state().flames }; });
  check(s.b === s.a + 1 && s.flames === 0, `fase 7: pegar a chama recarrega o fogo (${s.a} → ${s.b})`);
  s = await E(() => {
    const j = window.jogo;
    T.level(6, { enemies: true });
    j.moveGhost(1, 200, 216);
    j.teleport(136, 192 - j.PH); j.step(3); // pega a chama do degrau: 3 + 1 tiros
    j.teleport(120, 240 - j.PH); j.step(30);
    const hp = [j.state().ghosts[1].hp];
    for (let k = 0; k < 4; k++) {
      j.key("fire", true); j.step(1); j.key("fire", false);
      j.step(30);
      const g = j.state().ghosts[1];
      hp.push(g ? (g.dead ? "x" : g.hp) : "x");
    }
    return { hp, ammo: j.state().ammo };
  });
  check(s.hp.join(",") === "4,3,2,1,x", `fantasma forte: 4 de vida, cai no 4º tiro (${s.hp.join(" → ")})`);
  s = await E(() => {
    const j = window.jogo;
    T.level(6, { enemies: true });
    j.moveGhost(1, 200, 216);
    j.teleport(194, 150); j.step(1);
    let hpAfter = null, bounced = false;
    for (let i = 0; i < 50; i++) { j.step(1); const st = j.state(); const g = st.ghosts[1]; if (g && g.hp < 4 && hpAfter == null) hpAfter = g.hp; if (hpAfter != null && st.vy < 0) bounced = true; }
    return { hpAfter, bounced, mode: j.state().mode };
  });
  check(s.hpAfter === 2 && s.bounced && s.mode === "play", `pisão no fantasma forte tira 2 e não faz perder (vida ${s.hpAfter})`);
  s = await E(() => { const j = window.jogo; T.level(6); j.teleport(230, 144 - j.PH); j.step(3); return T.walk("right", 30); });
  check(s.power.b && !s.power.a, "fase 7: alavanca B liga só o elevador (canal b)");
  s = await E(() => { const j = window.jogo; for (let i = 0; i < 40; i++) j.step(1); return j.state(); });
  check(s.platforms[2].y < 228 && !s.platforms[4].solid, "fase 7: elevador anda, ponte continua apagada");
  s = await E(() => T.rideFrom({ idx: 2, fx: 376, fy: 240, dir: "right", when: (p) => p.y > 215 }));
  check(s.standOn === 2, "fase 7: sobe no elevador");
  s = await E(() => { const j = window.jogo; for (let i = 0; i < 400 && j.state().platforms[2].y > 80.5; i++) j.step(1); return T.walkUntil("right", (st) => st.power.a, 60); });
  check(s.power.a && s.levers[1].on, "fase 7: lá em cima, a alavanca A acende a ponte");
  s = await E(() => {
    const j = window.jogo;
    T.walkUntil("left", (st) => st.x < 420, 40);
    j.step(4);
    if (j.state().standOn !== 2) return j.state();
    j.key("left", true); j.key("jump", true);
    for (let i = 0; i < 120; i++) { j.step(1); if (i === 14) j.key("left", false); if (i > 3 && j.state().onGround) break; }
    T.release();
    return j.state();
  });
  check(s.standOn === 4, `fase 7: do elevador pula para a ponte de luz (pousou em ${s.standOn})`);
  can(await reach(6, 248, 280, 76, "left", 6, { power: true }), "fase 7: luz 2 → luz 3");
  can(await reach(6, 336, 368, 80, "left", 5, { power: true }), "fase 7: luz 1 → luz 2");
  can(await reach(6, 160, 192, 72, "left", 7, { power: true }), "fase 7: luz 3 → porta");
  await J({ level: 6, power: true, x: 164, y: 72, dir: "left" });
  s = await E(() => T.walkToDoor());
  check(s.level === 7, "fase 7 → fase 8 pela porta");
  await E(() => window.jogo.step(1));
  await shot("jogo-05-fase8.png");

  // ================= FASE 8: tudo junto =================
  can(await reach(7, 200, 240, 240, "right", 1), "fase 8: chão → frágil 1");
  can(await reach(7, 252, 280, 196, "right", 2), "fase 8: frágil 1 → frágil 2");
  s = await E(() => { T.level(7); return T.rideFrom({ idx: 3, fx: 336, fy: 152, dir: "left", when: (p) => p.x > 280 }); });
  check(s.standOn === 3, "fase 8: frágil 2 → plataforma que anda");
  s = await E(() => { const j = window.jogo; T.level(7); return T.rideFrom({ idx: 3, fx: 330, fy: 240, dir: "left", when: () => false, max: 0 }) && (function () { j.teleport(186, 110 - j.PH); for (let i = 0; i < 400 && j.state().platforms[3].x > 191; i++) j.step(1); j.teleport(j.state().platforms[3].x + 4, 110 - j.PH); j.step(2); j.key("left", true); j.key("jump", true); for (let i = 0; i < 120; i++) { j.step(1); if (i > 3 && j.state().onGround) break; } T.release(); return j.state(); })(); });
  check(s.standOn === 0 && s.x >= 120, `fase 8: da plataforma que anda chega à beira da porta (x=${s.x.toFixed(0)})`);
  s = await E(() => T.walk("left", 60));
  check(s.x >= 119.5 && s.level === 7 && s.mode === "play", "fase 8: portão fechado bloqueia a porta");
  s = await E(() => {
    const j = window.jogo;
    T.level(7);
    j.teleport(40, 240 - j.PH); j.step(3);
    T.walkUntil("right", (st) => st.boxes[0].x >= 384, 900);
    j.step(30);
    return j.state();
  });
  check(s.plates[0].down && s.gates[0].open === 1, `fase 8: caixa empurrada até o botão abre o portão (caixa x=${s.boxes[0].x.toFixed(0)})`);
  s = await E(() => { const j = window.jogo; j.teleport(124, 66 - j.PH); j.step(2); return T.walkToDoor(); });
  check(s.mode === "end", "fase 8: com o portão aberto, a porta leva à tela final");
  await E(() => window.jogo.step(40));
  await shot("jogo-06-fim.png");

  // cenas para olhar
  await E(() => { const j = window.jogo; T.level(4, { enemies: true }); j.teleport(110, 240 - j.PH); j.step(2); T.walk("right", 2); j.key("fire", true); j.step(1); j.key("fire", false); j.step(16); });
  await shot("jogo-07-tiro.png");
  await E(() => { const j = window.jogo; j.step(6); });
  await shot("jogo-08-flash.png");
  await E(() => { const j = window.jogo; T.level(7, { enemies: true }); j.step(60); });
  await shot("jogo-09-fase8-inicio.png");

  // ---------- Editor de fases ----------
  {
    const ectx = await browser.newContext({ viewport: { width: 1440, height: 860 } });
    const ep = await ectx.newPage();
    watch(ep);
    await ep.goto(URL);
    await ep.waitForTimeout(400);
    const st = () => ep.evaluate(() => window.jogo.editor.state());
    const at = (x, y) => ep.evaluate(([x, y]) => window.jogo.editor.screen(x, y), [x, y]);
    const drag = async (x0, y0, x1, y1) => { const a = await at(x0, y0), b = await at(x1, y1); await ep.mouse.move(a.x, a.y); await ep.mouse.down(); await ep.mouse.move(b.x, b.y, { steps: 6 }); await ep.mouse.up(); };
    const click = async (x, y) => { const a = await at(x, y); await ep.mouse.click(a.x, a.y); };
    const tool = (id) => ep.click(`[data-tool="${id}"]`);

    check(await ep.isVisible("#open-editor"), "editor: botão 'Editor de fases' na tela de título");
    await ep.click("#open-editor");
    let es = await st();
    check(es.mode === "editor" && (await ep.isVisible("#ed-tools")), "editor: abre com ferramentas e painel");
    check(es.level.platforms.length === 0 && es.level.solids.length === 1, "editor: fase nova começa só com chão, início e porta");

    await tool("plat"); await drag(100, 192, 180, 192);
    await tool("plat"); await drag(210, 150, 270, 150);
    await tool("ghost"); await click(320, 216);
    await tool("lever"); await click(140, 190);
    await tool("elevator"); await drag(380, 228, 424, 228);
    es = await st();
    const plat = es.level.platforms[0];
    check(es.level.platforms.length === 3 && plat.x === 100 && plat.w === 80 && plat.y === 192, `editor: arrastar cria plataforma (x=${plat.x}, largura=${plat.w})`);
    check(es.level.ghosts && es.level.ghosts.length === 1, "editor: clique coloca fantasma");
    check(es.level.levers && es.level.levers[0].y === 192, "editor: alavanca gruda na plataforma embaixo do clique");
    check(es.level.platforms[2].elevator && es.level.platforms[2].move.to === 228, "editor: cria elevador");

    await tool("select"); await click(130, 196);
    es = await st();
    check(es.sel && es.sel.kind === "platforms" && es.sel.i === 0, "editor: 'Mover' seleciona a plataforma");
    await ep.fill('[data-field="Largura"]', "96");
    await ep.press('[data-field="Largura"]', "Tab");
    check((await st()).level.platforms[0].w === 96, "editor: mudar a largura no painel");
    await ep.selectOption('[data-field="Tipo"]', "crumble");
    check((await st()).level.platforms[0].crumble === true, "editor: trocar o tipo para frágil");
    await ep.click("#ed-undo");
    check(!(await st()).level.platforms[0].crumble, "editor: desfazer");
    await drag(130, 196, 150, 180);
    es = await st();
    check(es.level.platforms[0].x === 120 && es.level.platforms[0].y === 176, `editor: arrastar move (x=${es.level.platforms[0].x}, y=${es.level.platforms[0].y})`);
    await tool("erase"); await click(320, 216);
    check(!(await st()).level.ghosts, "editor: 'Apagar' remove o fantasma");
    await tool("ghost"); await click(320, 216);
    await ep.screenshot({ path: path.join(OUT, "jogo-11-editor.png") });

    // testar a fase
    await ep.click("#ed-test");
    await ep.waitForTimeout(700);
    es = await ep.evaluate(() => window.jogo.state());
    check(es.fromEditor && ["play", "iris-in"].includes(es.mode) && es.platforms.length === 3, "editor: 'Testar' joga a fase criada");
    await ep.keyboard.press("Escape");
    check((await st()).mode === "editor", "editor: Esc volta para o editor");
    es = await ep.evaluate(() => {
      const j = window.jogo;
      document.getElementById("ed-test").click();
      j.pause(); j.step(40);
      const lv = j.state().levers[0];
      j.teleport(lv.x, lv.y - j.PH); j.step(60);
      return j.state();
    });
    check(es.power.a && es.platforms[2].y < 228, "editor: alavanca liga o elevador na fase testada");
    es = await ep.evaluate(() => {
      const j = window.jogo;
      j.enemies(false);
      const d = j.state().door;
      j.teleport(d.x - 40, d.y - j.PH); j.step(2);
      j.key("right", true);
      for (let i = 0; i < 300 && j.state().mode !== "editor"; i++) j.step(1);
      j.key("right", false);
      j.enemies(true);
      j.resume();
      return window.jogo.editor.state();
    });
    check(es.mode === "editor" && es.toast.startsWith("FASE CONCLUÍDA"), `editor: chegar na porta volta ao editor (${es.toast})`);

    // exportar / importar
    await ep.click("#ed-export");
    const code = await ep.inputValue("#ed-text");
    const parsed = JSON.parse(code);
    check(parsed.platforms.length === 3 && parsed.door && parsed.start, "editor: exportar mostra o código da fase");
    await ep.click("#ed-close");
    parsed.name = "IMPORTADA";
    await ep.click("#ed-import");
    await ep.fill("#ed-text", JSON.stringify(parsed));
    await ep.click("#ed-load");
    es = await st();
    check(es.slots === 2 && es.level.name === "IMPORTADA", "editor: importar código cria uma fase nova");
    await ep.click("#ed-import");
    await ep.fill("#ed-text", "isso não é código");
    await ep.click("#ed-load");
    check((await ep.textContent("#ed-msg")).includes("Não consegui"), "editor: código inválido mostra aviso");
    await ep.click("#ed-close");
    await ep.selectOption("#ed-copy", "6");
    es = await st();
    check(es.slots === 3 && es.level.name.startsWith("CÓPIA") && es.level.levers.length === 2, "editor: dá para começar a partir de uma fase do jogo");

    // fica salvo
    await ep.reload();
    await ep.waitForTimeout(400);
    await ep.click("#open-editor");
    es = await st();
    check(es.slots === 3 && es.slot === 2, "editor: fases continuam salvas depois de recarregar");

    // jogar todas
    await ep.click("#ed-playall");
    await ep.waitForTimeout(700);
    es = await ep.evaluate(() => window.jogo.state());
    check(!es.fromEditor && ["play", "iris-in"].includes(es.mode) && es.level === 0 && es.platforms.length === 3, "editor: 'Jogar minhas fases' joga as fases criadas em sequência");
    await ep.evaluate(() => { window.jogo.pause(); });
    await ep.keyboard.press("Escape");
    await ep.evaluate(() => window.jogo.editor.open());
    await ep.click("#ed-exit");
    check((await ep.evaluate(() => window.jogo.state().mode)) === "title", "editor: 'Sair' volta para o título");
    await ep.evaluate(() => window.jogo.goto(1));
    check(!(await ep.isVisible("#back-btn")), "computador: botão Voltar fica escondido (usa Esc)");
    await ep.keyboard.press("Escape");
    check((await ep.evaluate(() => window.jogo.state().mode)) === "title", "computador: Esc no jogo volta para o título");
    await ectx.close();
  }

  // ---------- Celular ----------
  const phone = await browser.newContext({ ...devices["iPhone 13 landscape"] });
  const pp = await phone.newPage();
  watch(pp);
  await pp.goto(URL);
  await pp.waitForTimeout(400);
  check(await pp.isVisible('.pad button[data-key="fire"]'), "botão de fogo aparece no celular");
  await pp.tap("canvas");
  await pp.waitForTimeout(800);
  check((await pp.evaluate(() => window.jogo.state().mode)) === "play", "tocar na tela começa o jogo");
  const fire = (key, type) => pp.evaluate(([key, type]) => document.querySelector(`.pad button[data-key="${key}"]`).dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, pointerType: "touch" })), [key, type]);
  const px0 = await pp.evaluate(() => window.jogo.state().x);
  await fire("right", "pointerdown");
  await pp.waitForTimeout(400);
  await fire("right", "pointerup");
  const px1 = await pp.evaluate(() => window.jogo.state().x);
  check(px1 > px0 + 15, `botão ▶ anda (${px0.toFixed(0)} → ${px1.toFixed(0)})`);
  await pp.evaluate(() => { window.jogo.goto(4); });
  await fire("fire", "pointerdown");
  await pp.waitForTimeout(100);
  await fire("fire", "pointerup");
  check((await pp.evaluate(() => window.jogo.state().ammo)) === 3, "botão FOGO atira");
  const fits = await pp.evaluate(() => {
    const c = document.querySelector("canvas").getBoundingClientRect();
    return c.width <= innerWidth + 1 && c.height <= innerHeight + 1;
  });
  check(fits, "o jogo cabe na tela do celular deitado");
  await pp.screenshot({ path: path.join(OUT, "jogo-10-celular.png") });

  // botão voltar no celular
  await pp.evaluate(() => { window.jogo.goto(2); });
  await pp.waitForTimeout(200);
  check(await pp.isVisible("#back-btn"), "celular: botão Voltar aparece durante o jogo");
  check((await pp.textContent("#back-btn")).trim() === "Menu", "celular: no jogo normal o botão diz 'Menu'");
  await pp.tap("#back-btn");
  await pp.waitForTimeout(200);
  check((await pp.evaluate(() => window.jogo.state().mode)) === "title" && !(await pp.isVisible("#back-btn")), "celular: Voltar leva ao título e some");
  await pp.evaluate(() => window.jogo.editor.open());
  await pp.tap("#ed-test");
  await pp.waitForTimeout(600);
  check((await pp.textContent("#back-btn")).trim() === "Editor", "celular: testando fase do editor o botão diz 'Editor'");
  await pp.tap("#back-btn");
  await pp.waitForTimeout(200);
  check((await pp.evaluate(() => window.jogo.state().mode)) === "editor", "celular: Voltar leva de volta ao editor");
  await pp.tap("#ed-exit");


  check(errors.length === 0, `nenhum erro no console${errors.length ? ": " + [...new Set(errors)].join(" | ") : ""}`);
  await browser.close();
  console.log(`\n${failures ? failures + " falha(s)" : "Tudo passou"}. Screenshots em ${OUT}`);
  process.exit(failures ? 1 : 0);
})();
