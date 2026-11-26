// Teste do jogo "Lá em Cima" com Playwright.
// Uso: node tests/jogo.test.cjs [pasta-para-screenshots]
// O jogo é pausado e avançado quadro a quadro (window.jogo), então o resultado
// não depende da velocidade da máquina. Para cada fase o teste prova que cada
// pulo do caminho é possível e que os atalhos proibidos não funcionam, e depois
// atravessa a fase até a porta.
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
  const release = () => { j.key("left", false); j.key("right", false); j.key("jump", false); };
  const settle = (max = 200) => { for (let i = 0; i < max; i++) { j.step(1); if (i > 3 && j.state().onGround) break; } };
  window.T = {
    // Reinicia a fase (opcionalmente liga a alavanca), põe o jogador parado em
    // (x, superfície), espera `wait` quadros, pula segurando `dir` e devolve onde pousou.
    jumpFrom({ level, power, x, y, dir, wait = 0 }) {
      if (level != null) { j.goto(level); if (power) T.powerOn(); }
      release();
      j.teleport(x, y - j.PH);
      j.step(2 + wait);
      j.key(dir, true); j.step(2);
      j.key("jump", true); j.step(1);
      settle(150);
      release(); j.step(1);
      return j.state();
    },
    powerOn() {
      const lv = j.state().lever;
      j.teleport(lv.x, lv.y - j.PH);
      j.step(100);
    },
    walk(dir, frames) { j.key(dir, true); j.step(frames); j.key(dir, false); return j.state(); },
    walkToDoor() {
      const d = j.state().door;
      const dir = j.state().x + j.PW / 2 < d.x + 12 ? "right" : "left";
      j.key(dir, true);
      for (let i = 0; i < 400 && j.state().mode === "play"; i++) j.step(1);
      j.key(dir, false);
      for (let i = 0; i < 200 && !["play", "end"].includes(j.state().mode); i++) j.step(1);
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
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, "jogo-1-titulo.png") });
  let s = await page.evaluate(() => window.jogo.state());
  check(s.mode === "title", "abre na tela de título");
  check(s.spriteReady, "sprite do personagem carregou");

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
  await page.screenshot({ path: path.join(OUT, "jogo-2-fase1.png") });

  // ---------- Daqui em diante, quadro a quadro ----------
  await page.evaluate(() => window.jogo.pause());
  await page.evaluate(HELPERS);
  const J = (args) => page.evaluate((a) => T.jumpFrom(a), args);
  async function reach(level, x0, x1, y, dir, target, extra = {}) {
    let hits = 0;
    for (let x = x0; x <= x1; x += 4) {
      const r = await J({ level, x, y, dir, ...extra });
      if (r.standOn === target) hits++;
    }
    return hits;
  }
  const say = (cond, msg, n) => check(cond, `${msg} (${n} posições)`);

  // ================= FASE 1 =================
  let n;
  n = await reach(0, 4, 60, 240, "right", 0); say(n > 0, "fase 1: chão → 1ª plataforma", n);
  n = await reach(0, 96, 140, 192, "right", 1); say(n > 0, "fase 1: 1ª → 2ª plataforma", n);
  n = await reach(0, 216, 260, 144, "right", 2); say(n > 0, "fase 1: 2ª → 3ª plataforma", n);
  n = await reach(0, 4, 460, 240, "right", 2); say(n === 0, "fase 1: do chão não dá para ir direto à última", n);
  s = await J({ level: 0, x: 240, y: 144, dir: "right" });
  check(s.standOn === 2, "fase 1: na plataforma da porta");
  s = await page.evaluate(() => { window.jogo.key("right", true); window.jogo.step(30); window.jogo.key("right", false); return window.jogo.state(); });
  check(s.doorOpen > 0, `fase 1: porta abre quando chega perto (${s.doorOpen.toFixed(2)})`);
  await page.screenshot({ path: path.join(OUT, "jogo-3-porta.png") });
  s = await page.evaluate(() => T.walkToDoor());
  check(s.level === 1 && s.mode === "play", "fase 1: a porta leva à fase 2");

  // ================= FASE 2 =================
  s = await page.evaluate(() => { const j = window.jogo; j.goto(1); j.teleport(240, 200); j.step(120); return j.state(); });
  check(s.deaths === 1 && s.x < 40, `fase 2: cair no buraco conta uma queda e volta ao início (${s.deaths})`);
  let wait = -1;
  for (let w = 0; w < 300; w += 6) {
    s = await J({ level: 1, x: 140, y: 240, dir: "right", wait: w });
    if (s.standOn === 0) { wait = w; break; }
  }
  check(wait >= 0, `fase 2: dá para pular na plataforma que anda (esperando ${wait} quadros)`);
  s = await page.evaluate(() => {
    const j = window.jogo;
    let maxX = 0;
    for (let i = 0; i < 300 && j.state().standOn === 0; i++) { j.step(1); maxX = Math.max(maxX, j.state().x); }
    return { maxX };
  });
  check(s.maxX > 250, `fase 2: a plataforma leva o jogador (chegou a x=${s.maxX.toFixed(0)})`);
  let crossed = false;
  for (let w = 0; w < 300 && !crossed; w += 6) {
    const r = await page.evaluate((w) => {
      const j = window.jogo;
      j.goto(1);
      j.step(w);
      const pl = j.state().platforms[0];
      j.teleport(pl.x + 20, pl.y - j.PH);
      j.step(2);
      j.key("right", true); j.key("jump", true);
      for (let i = 0; i < 150; i++) { j.step(1); if (i > 4 && j.state().onGround) break; }
      j.key("right", false); j.key("jump", false);
      return j.state();
    }, w);
    crossed = r.standOn === "chão" && r.x > 300;
  }
  check(crossed, "fase 2: da plataforma que anda chega ao chão do outro lado");
  n = await reach(1, 318, 360, 240, "right", 1); say(n > 0, "fase 2: chão direito → plataforma 2", n);
  n = await reach(1, 345, 380, 192, "left", 2); say(n > 0, "fase 2: plataforma 2 → 3", n);
  n = await reach(1, 230, 262, 144, "left", 3); say(n > 0, "fase 2: plataforma 3 → 4 (porta)", n);
  s = await J({ level: 1, x: 236, y: 144, dir: "left" });
  s = await page.evaluate(() => T.walkToDoor());
  check(s.level === 2 && s.mode === "play", "fase 2: a porta leva à fase 3");
  await page.evaluate(() => window.jogo.step(1));
  await page.screenshot({ path: path.join(OUT, "jogo-4-fase3.png") });

  // ================= FASE 3: alavanca + elevador =================
  s = await page.evaluate(() => { const j = window.jogo; j.goto(2); j.step(200); return j.state(); });
  check(!s.power && s.platforms[2].y === 228, "fase 3: elevador parado antes da alavanca");
  n = await reach(2, 4, 40, 240, "right", 0); say(n > 0, "fase 3: chão → plataforma A", n);
  n = await reach(2, 100, 146, 192, "right", 1); say(n > 0, "fase 3: A → plataforma B (com a alavanca)", n);
  n = await reach(2, 190, 286, 144, "right", 3); say(n === 0, "fase 3: de B não dá para pular até a porta", n);
  n = await reach(2, 300, 370, 240, "right", 3); say(n === 0, "fase 3: do chão não dá para pular até a porta", n);
  s = await page.evaluate(() => { const j = window.jogo; j.goto(2); j.teleport(230, 144 - j.PH); j.step(3); return T.walk("right", 30); });
  check(s.power && s.lever.on, "fase 3: encostar na alavanca liga a energia");
  await page.evaluate(() => window.jogo.step(40));
  await page.screenshot({ path: path.join(OUT, "jogo-5-alavanca.png") });
  s = await page.evaluate(() => window.jogo.state());
  check(s.platforms[2].y < 228, `fase 3: elevador começa a subir (y=${s.platforms[2].y.toFixed(0)})`);
  // subir no elevador quando ele está embaixo
  let rode = false;
  for (let w = 0; w < 500 && !rode; w += 8) {
    const r = await page.evaluate((w) => {
      const j = window.jogo;
      j.goto(2); T.powerOn(); j.step(w);
      const e = j.state().platforms[2];
      if (e.y < 200) return { skip: true };
      j.teleport(296, 240 - j.PH); j.step(2);
      j.key("right", true); j.key("jump", true); j.step(10); j.key("right", false);
      for (let i = 0; i < 100; i++) { j.step(1); if (i > 3 && j.state().onGround) break; }
      j.key("jump", false);
      return j.state();
    }, w);
    if (r.standOn === 2) rode = true;
  }
  check(rode, "fase 3: dá para subir no elevador ligado");
  s = await page.evaluate(() => {
    const j = window.jogo;
    let minY = 999;
    for (let i = 0; i < 400 && j.state().standOn === 2; i++) {
      j.step(1);
      minY = Math.min(minY, j.state().y + j.PH);
      if (j.state().platforms[2].y <= 66.5) break;
    }
    return { minY, ...j.state() };
  });
  check(s.minY <= 67, `fase 3: o elevador leva o jogador lá em cima (pés em y=${s.minY.toFixed(0)})`);
  s = await page.evaluate(() => T.walk("right", 30));
  check(s.standOn === 3, "fase 3: do elevador passa para a plataforma da porta");
  s = await page.evaluate(() => T.walkToDoor());
  check(s.level === 3 && s.mode === "play", "fase 3: a porta leva à fase 4");

  // ================= FASE 4: chão que cai + ponte de luz =================
  n = await reach(3, 40, 80, 240, "right", 0); say(n > 0, "fase 4: chão → 1ª plataforma frágil", n);
  n = await reach(3, 140, 170, 222, "right", 1); say(n > 0, "fase 4: frágil 1 → frágil 2", n);
  n = await reach(3, 220, 248, 192, "right", 2); say(n > 0, "fase 4: frágil 2 → frágil 3", n);
  n = await reach(3, 296, 326, 162, "right", 3); say(n > 0, "fase 4: frágil 3 → plataforma da alavanca", n);
  const d0 = await page.evaluate(() => window.jogo.state().deaths);
  s = await page.evaluate(() => { const j = window.jogo; j.goto(3); j.teleport(140, 222 - j.PH); j.step(40); return j.state(); });
  check(!s.platforms[0].solid, "fase 4: plataforma frágil cai se ficar parado nela");
  s = await page.evaluate(() => { window.jogo.step(120); return window.jogo.state(); });
  check(s.deaths === d0 + 1, `fase 4: cair com ela conta uma queda (${d0} → ${s.deaths})`);
  s = await page.evaluate(() => { window.jogo.step(200); return window.jogo.state(); });
  check(s.platforms[0].solid, "fase 4: a plataforma frágil volta depois de um tempo");
  n = await reach(3, 360, 400, 140, "left", 4); say(n === 0, "fase 4: sem a alavanca a ponte de luz não existe", n);
  s = await page.evaluate(() => { const j = window.jogo; j.goto(3); j.teleport(400, 140 - j.PH); j.step(3); T.walk("right", 40); j.step(90); return j.state(); });
  check(s.power && s.platforms[4].solid && s.platforms[5].solid && s.platforms[6].solid, "fase 4: alavanca acende a ponte de luz");
  await page.screenshot({ path: path.join(OUT, "jogo-6-fase4-ponte.png") });
  n = await reach(3, 358, 390, 140, "left", 4, { power: true }); say(n > 0, "fase 4: alavanca → luz 1", n);
  n = await reach(3, 290, 310, 110, "left", 5, { power: true }); say(n > 0, "fase 4: luz 1 → luz 2", n);
  n = await reach(3, 196, 216, 88, "left", 6, { power: true }); say(n > 0, "fase 4: luz 2 → luz 3", n);
  n = await reach(3, 122, 142, 72, "left", 7, { power: true }); say(n > 0, "fase 4: luz 3 → plataforma da porta", n);
  s = await J({ level: 3, power: true, x: 126, y: 72, dir: "left" });
  check(s.standOn === 7, "fase 4: na plataforma da porta");
  s = await page.evaluate(() => T.walkToDoor());
  check(s.mode === "end", "fase 4: a porta leva à tela final");
  await page.evaluate(() => window.jogo.step(40));
  await page.screenshot({ path: path.join(OUT, "jogo-7-fim.png") });

  s = await page.evaluate(() => { const j = window.jogo; j.key("jump", true); j.step(1); j.key("jump", false); j.step(60); return j.state(); });
  check(s.level === 0 && s.mode === "play" && s.deaths === 0, "jogar de novo volta à fase 1 e zera as quedas");

  // ---------- Celular ----------
  const phone = await browser.newContext({ ...devices["iPhone 13 landscape"] });
  const pp = await phone.newPage();
  watch(pp);
  await pp.goto(URL);
  await pp.waitForTimeout(400);
  check(await pp.isVisible('.pad button[data-key="jump"]'), "botões de toque aparecem no celular");
  await pp.tap("canvas");
  await pp.waitForTimeout(800);
  check((await pp.evaluate(() => window.jogo.state().mode)) === "play", "tocar na tela começa o jogo");
  const px0 = await pp.evaluate(() => window.jogo.state().x);
  const fire = (type) => pp.evaluate((type) => document.querySelector('.pad button[data-key="right"]').dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, pointerType: "touch" })), type);
  await fire("pointerdown");
  await pp.waitForTimeout(400);
  await fire("pointerup");
  const px1 = await pp.evaluate(() => window.jogo.state().x);
  check(px1 > px0 + 15, `botão ▶ anda (${px0.toFixed(0)} → ${px1.toFixed(0)})`);
  const fits = await pp.evaluate(() => {
    const c = document.querySelector("canvas").getBoundingClientRect();
    return c.width <= innerWidth + 1 && c.height <= innerHeight + 1;
  });
  check(fits, "o jogo cabe na tela do celular deitado");
  await pp.screenshot({ path: path.join(OUT, "jogo-8-celular.png") });

  check(errors.length === 0, `nenhum erro no console${errors.length ? ": " + [...new Set(errors)].join(" | ") : ""}`);
  await browser.close();
  console.log(`\n${failures ? failures + " falha(s)" : "Tudo passou"}. Screenshots em ${OUT}`);
  process.exit(failures ? 1 : 0);
})();
