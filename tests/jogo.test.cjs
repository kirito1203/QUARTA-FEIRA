// Teste do jogo "Lá em Cima" com Playwright.
// Uso: node tests/jogo.test.cjs [pasta-para-screenshots]
// O jogo é pausado e avançado quadro a quadro (window.jogo.step), então o
// resultado não depende da velocidade da máquina.
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

// Roda no navegador: coloca o jogador parado em (x, topo da superfície),
// segura a direção, pula e espera ele pousar. Devolve onde pousou.
async function jumpFrom(page, x, surfaceY, dir, wait = 0) {
  return page.evaluate(({ x, surfaceY, dir, wait }) => {
    const j = window.jogo;
    j.key("left", false); j.key("right", false); j.key("jump", false);
    j.teleport(x, surfaceY - 12);
    j.step(2);
    if (wait) j.step(wait);
    j.key(dir, true);
    j.step(2);
    j.key("jump", true);
    j.step(1);
    let s;
    for (let i = 0; i < 120; i++) {
      j.step(1);
      s = j.state();
      if (i > 4 && s.onGround) break;
    }
    j.key("jump", false); j.key(dir, false);
    j.step(1);
    return j.state();
  }, { x, surfaceY, dir, wait });
}

// Tenta pular de várias posições da superfície de origem; devolve quantas chegam ao alvo.
async function reach(page, fromX0, fromX1, surfaceY, dir, target) {
  let hits = 0;
  for (let x = fromX0; x <= fromX1; x += 4) {
    const s = await jumpFrom(page, x, surfaceY, dir);
    if (s.standOn === target) hits++;
  }
  return hits;
}

async function walkToDoor(page) {
  return page.evaluate(() => {
    const j = window.jogo;
    const d = j.state().door;
    const dir = j.state().x + 4 < d.x + 8 ? "right" : "left";
    j.key(dir, true);
    for (let i = 0; i < 400 && j.state().mode === "play"; i++) j.step(1);
    j.key(dir, false);
    for (let i = 0; i < 200 && j.state().mode !== "play" && j.state().mode !== "end"; i++) j.step(1);
    return j.state();
  });
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const watch = (p) => {
    p.on("pageerror", (e) => errors.push(e.message));
    p.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  };

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  watch(page);
  await page.goto(URL);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, "jogo-1-titulo.png") });
  check((await page.evaluate(() => window.jogo.state().mode)) === "title", "abre na tela de título");

  // ---------- Teclado de verdade, em tempo real ----------
  await page.keyboard.press("Space");
  await page.waitForTimeout(800);
  check((await page.evaluate(() => window.jogo.state().mode)) === "play", "Espaço começa o jogo");
  const x0 = await page.evaluate(() => window.jogo.state().x);
  await page.keyboard.down("ArrowRight");
  await page.waitForTimeout(400);
  await page.keyboard.up("ArrowRight");
  const x1 = await page.evaluate(() => window.jogo.state().x);
  check(x1 > x0 + 10, `seta para a direita anda (${x0.toFixed(0)} → ${x1.toFixed(0)})`);
  await page.keyboard.down("Space");
  await page.waitForTimeout(150);
  const air = await page.evaluate(() => window.jogo.state());
  await page.keyboard.up("Space");
  check(!air.onGround && air.y < 148, "Espaço pula");
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, "jogo-2-fase1.png") });

  // ---------- Daqui em diante, quadro a quadro ----------
  await page.evaluate(() => window.jogo.pause());

  // Fase 1: chão → P0 → P1 → P2 (porta)
  let hits = await reach(page, 4, 40, 160, "right", 0);
  check(hits > 0, `fase 1: do chão dá para subir na 1ª plataforma (${hits} posições)`);
  hits = await reach(page, 60, 96, 126, "right", 1);
  check(hits > 0, `fase 1: da 1ª dá para subir na 2ª (${hits} posições)`);
  hits = await reach(page, 140, 176, 92, "right", 2);
  check(hits > 0, `fase 1: da 2ª dá para subir na 3ª (${hits} posições)`);
  hits = await reach(page, 4, 300, 160, "right", 2);
  check(hits === 0, "fase 1: não dá para pular do chão direto para a última");

  // Porta abre e leva à fase 2
  let s = await jumpFrom(page, 160, 92, "right");
  check(s.standOn === 2, "jogador na plataforma da porta");
  const opening = await page.evaluate(() => {
    const j = window.jogo;
    j.key("right", true);
    for (let i = 0; i < 400 && j.state().doorOpen === 0; i++) j.step(1);
    j.step(8);
    j.key("right", false);
    return j.state().doorOpen;
  });
  check(opening > 0, `porta começa a abrir quando o jogador chega perto (${opening.toFixed(2)})`);
  await page.screenshot({ path: path.join(OUT, "jogo-3-porta-abrindo.png") });
  s = await walkToDoor(page);
  check(s.level === 1 && s.mode === "play", "entrar na porta leva à fase 2");
  await page.evaluate(() => window.jogo.step(1));
  await page.screenshot({ path: path.join(OUT, "jogo-4-fase2.png") });

  // Fase 2: buraco mata e volta ao início
  s = await page.evaluate(() => {
    const j = window.jogo;
    j.teleport(160, 120);
    j.step(120);
    return j.state();
  });
  check(s.deaths === 1 && s.x < 30, `cair no buraco conta uma queda e volta ao início (quedas: ${s.deaths})`);

  // Plataforma que anda: existe um momento certo para pular nela
  let okWait = -1;
  for (let w = 0; w < 240; w += 6) {
    s = await jumpFrom(page, 96, 160, "right", w);
    if (s.standOn === 0) { okWait = w; break; }
  }
  check(okWait >= 0, `fase 2: dá para pular na plataforma que anda (esperando ${okWait} quadros)`);
  // e ela leva o jogador para o outro lado
  s = await page.evaluate(() => {
    const j = window.jogo;
    let maxX = 0;
    for (let i = 0; i < 240; i++) {
      j.step(1);
      const st = j.state();
      if (st.standOn !== 0) break;
      maxX = Math.max(maxX, st.x);
    }
    return { maxX, ...j.state() };
  });
  check(s.maxX > 170, `a plataforma carrega o jogador (chegou a x=${s.maxX.toFixed(0)})`);
  let fromMoving = false;
  for (let w = 0; w < 240 && !fromMoving; w += 6) {
    const r = await page.evaluate((w) => {
      const j = window.jogo;
      j.key("left", false); j.key("right", false); j.key("jump", false);
      const pl = j.state().platforms[0];
      j.teleport(pl.x + 14, pl.y - 12);
      j.step(2 + w);
      j.key("right", true); j.key("jump", true);
      for (let i = 0; i < 120; i++) { j.step(1); if (i > 4 && j.state().onGround) break; }
      j.key("right", false); j.key("jump", false);
      j.step(1);
      return j.state();
    }, w);
    if (r.standOn === "chão" && r.x > 200) fromMoving = true;
  }
  check(fromMoving, "fase 2: da plataforma que anda dá para chegar ao chão do outro lado");

  hits = await reach(page, 212, 236, 160, "right", 1);
  check(hits > 0, `fase 2: do chão direito sobe na plataforma 2 (${hits} posições)`);
  hits = await reach(page, 230, 250, 126, "left", 2);
  check(hits > 0, `fase 2: da plataforma 2 sobe na 3 (${hits} posições)`);
  hits = await reach(page, 150, 170, 92, "left", 3);
  check(hits > 0, `fase 2: da plataforma 3 sobe na 4, a da porta (${hits} posições)`);

  s = await jumpFrom(page, 150, 92, "left");
  check(s.standOn === 3, "jogador na plataforma da porta da fase 2");
  s = await walkToDoor(page);
  check(s.mode === "end", "a porta da fase 2 leva à tela final");
  await page.evaluate(() => window.jogo.step(40));
  await page.screenshot({ path: path.join(OUT, "jogo-5-fim.png") });

  // Jogar de novo
  s = await page.evaluate(() => {
    const j = window.jogo;
    j.key("jump", true); j.step(1); j.key("jump", false);
    j.step(60);
    return j.state();
  });
  check(s.level === 0 && s.mode === "play" && s.deaths === 0, "jogar de novo volta à fase 1 e zera as quedas");

  // ---------- Celular: botões de toque ----------
  const phone = await browser.newContext({ ...devices["iPhone 13 landscape"] });
  const pp = await phone.newPage();
  watch(pp);
  await pp.goto(URL);
  await pp.waitForTimeout(300);
  const padVisible = await pp.isVisible('.pad button[data-key="jump"]');
  check(padVisible, "botões de toque aparecem no celular");
  await pp.tap("canvas");
  await pp.waitForTimeout(800);
  check((await pp.evaluate(() => window.jogo.state().mode)) === "play", "tocar na tela começa o jogo");
  const box = await pp.locator('.pad button[data-key="right"]').boundingBox();
  const px0 = await pp.evaluate(() => window.jogo.state().x);
  await pp.evaluate(() => {
    const b = document.querySelector('.pad button[data-key="right"]');
    b.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 7, pointerType: "touch" }));
  });
  await pp.waitForTimeout(400);
  await pp.evaluate(() => {
    const b = document.querySelector('.pad button[data-key="right"]');
    b.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 7, pointerType: "touch" }));
  });
  const px1 = await pp.evaluate(() => window.jogo.state().x);
  check(box && px1 > px0 + 10, `botão ▶ anda (${px0.toFixed(0)} → ${px1.toFixed(0)})`);
  const fits = await pp.evaluate(() => {
    const c = document.querySelector("canvas").getBoundingClientRect();
    return c.width <= innerWidth + 1 && c.height <= innerHeight + 1;
  });
  check(fits, "o jogo cabe na tela do celular deitado");
  await pp.screenshot({ path: path.join(OUT, "jogo-6-celular.png") });

  check(errors.length === 0, `nenhum erro no console${errors.length ? ": " + [...new Set(errors)].join(" | ") : ""}`);
  await browser.close();
  console.log(`\n${failures ? failures + " falha(s)" : "Tudo passou"}. Screenshots em ${OUT}`);
  process.exit(failures ? 1 : 0);
})();
