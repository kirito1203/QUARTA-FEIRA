// Teste do jogo "Meia-Noite" (duelo/index.html) com Playwright.
// Uso: node tests/duelo.test.cjs [pasta-para-screenshots]
// O jogo é pausado e avançado quadro a quadro (window.duelo), então os testes de
// parry acertam o quadro exato do golpe, sem depender da velocidade da máquina.
const { chromium, devices } = require("playwright");
const path = require("path");
const fs = require("fs");

const URL = "file://" + path.resolve(__dirname, "../duelo/index.html");
const OUT = path.resolve(process.argv[2] || path.join(__dirname, "screenshots"));
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
function check(cond, msg) {
  console.log(`${cond ? "ok  " : "FAIL"}  ${msg}`);
  if (!cond) failures++;
}

// Roda dentro da página
const HELPERS = () => {
  const D = window.duelo;
  window.T = {
    // arena limpa: zumbi parado (sem IA) a `dist` pixels à direita do herói
    fresh(dist = 34) { D.start(); D.ai(false); D.place(150, 150 + dist); D.step(1); D.clearSounds(); },
    // quadros até o golpe do zumbi sair (lento: 1º golpe; sequência: lista dos 4)
    slowHitIn: 8 + 8 + 9 + 8,
    comboHitsIn: [16, 16 + 7 + 6, 16 + 7 + 6 + 7 + 6 + 6, 16 + 7 + 6 + 7 + 6 + 6 + 7 + 6],
    // aperta a defesa (fresca: solta e aperta de novo) `early` quadros antes de cada golpe do zumbi
    guardEach(early, maxFrames = 400) {
      let pressedFor = null;
      for (let i = 0; i < maxFrames; i++) {
        const z = D.state().zombie;
        if (!["attack", "combo", "leap"].includes(z.state)) break;
        if (z.nextHit === early && pressedFor !== z.f + ":" + z.state) {
          pressedFor = z.f + ":" + z.state;
          D.key("guard", false); D.step(1); D.key("guard", true);
        }
        D.step(1);
      }
      D.key("guard", false);
      D.step(1);
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

  const ctx = await browser.newContext({ viewport: { width: 1344, height: 756 } });
  const page = await ctx.newPage();
  watch(page);
  await page.goto(URL);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, "duelo-1-titulo.png") });
  let s = await page.evaluate(() => window.duelo.state());
  check(s.mode === "title" && s.ready, "abre no título com as sprites do herói e do zumbi carregadas");

  // ---------- teclado de verdade ----------
  await page.keyboard.press("Space");
  await page.waitForTimeout(200);
  check((await page.evaluate(() => window.duelo.state().mode)) === "play", "Espaço começa a luta");
  await page.keyboard.down("KeyJ");
  await page.waitForTimeout(60);
  s = await page.evaluate(() => window.duelo.state());
  await page.keyboard.up("KeyJ");
  check(s.hero.state === "attack" && s.hero.anim === "basic", `J ataca (${s.hero.state}/${s.hero.anim})`);
  await page.waitForTimeout(400);
  await page.keyboard.down("KeyK");
  await page.waitForTimeout(80);
  s = await page.evaluate(() => window.duelo.state());
  await page.keyboard.up("KeyK");
  check(s.hero.state === "guard" && s.hero.anim === "guard", "K defende");

  await page.evaluate(() => window.duelo.pause());
  await page.evaluate(HELPERS);
  const E = (fn, arg) => page.evaluate(fn, arg);

  // ---------- combo de 4 golpes ----------
  s = await E(() => {
    const D = window.duelo;
    T.fresh(30);
    const hp0 = D.state().zombie.hp;
    const hits = [];
    let maxStep = 0, flashSeen = 0, last = hp0;
    D.tap("attack");
    for (let i = 0; i < 140; i++) {
      const st = D.state();
      if (st.hero.state === "attack" && i % 5 === 0) D.tap("attack"); else D.step(1);
      const now = D.state();
      maxStep = Math.max(maxStep, now.hero.step);
      if (now.zombie.hp < last) { hits.push(+(last - now.zombie.hp).toFixed(1)); last = now.zombie.hp; flashSeen = Math.max(flashSeen, now.zombie.flash); }
    }
    return { hits, maxStep, flashSeen, sounds: D.sounds() };
  });
  check(s.maxStep === 3 && s.hits.length === 5, `combo de 4 golpes encadeados, o último acerta 2 vezes (${s.hits.join(" + ")})`);
  check(s.hits[4] > s.hits[0], "o golpe final é o mais forte");
  check(s.flashSeen > 0 && s.flashSeen <= 4, "acerto dá um flash curto no zumbi");
  check(s.sounds.filter((x) => x === "hit").length === 5, "cada acerto tem som de impacto");
  s = await E(() => { const D = window.duelo; T.fresh(30); D.tap("attack"); D.step(60); return D.state(); });
  check(s.hero.state === "move" && s.hero.step === 0, "sem apertar de novo, o combo para no 1º golpe");

  // ---------- defesa: parry, bloqueio e sem defesa ----------
  s = await E(() => {
    const D = window.duelo;
    T.fresh(30);
    D.zombieAttack("slow");
    D.key("guard", false); D.step(T.slowHitIn - 6); D.key("guard", true); D.step(7);
    const at = D.state();
    D.key("guard", false);
    return { at, sounds: D.sounds() };
  });
  check(s.at.hero.hp === s.at.hero.maxHp && s.sounds.includes("parry"), "parry no ataque lento: sem dano e com som próprio");
  check(s.at.hero.parryT > 0, "parry acende o flash amarelo na defesa");
  check(s.at.zombie.posture < 100 && s.at.zombie.barAlpha === 1, `parry faz aparecer a barra vermelha diminuindo (${s.at.zombie.posture})`);
  check(s.at.hero.power === 12, `parry carrega o poder (${s.at.hero.power})`);
  check(s.at.hitstop > 0, "parry dá uma pausa curta de impacto");
  await page.screenshot({ path: path.join(OUT, "duelo-3-parry.png") });

  s = await E(() => {
    const D = window.duelo;
    T.fresh(30);
    D.zombieAttack("slow");
    D.key("guard", true);
    D.step(T.slowHitIn + 4);
    D.key("guard", false);
    return { st: D.state(), sounds: D.sounds() };
  });
  check(s.st.hero.hp > 110 && s.st.hero.hp < 120 && s.sounds.includes("block") && !s.sounds.includes("parry"), `defender cedo demais só bloqueia: pouco dano (vida ${s.st.hero.hp})`);
  check(s.st.zombie.posture === 100, "bloqueio não mexe na barra vermelha");

  s = await E(() => { const D = window.duelo; T.fresh(30); D.zombieAttack("slow"); D.step(T.slowHitIn + 3); return D.state(); });
  check(s.hero.hp === 106 && s.hero.state === "hurt", `sem defesa, o ataque lento tira 14 de vida (${s.hero.hp})`);

  // ---------- sequência de 4 golpes rápidos ----------
  s = await E(() => {
    const D = window.duelo;
    T.fresh(30);
    D.zombieAttack("combo");
    T.guardEach(4);
    return { st: D.state(), sounds: D.sounds() };
  });
  check(s.sounds.filter((x) => x === "parry").length === 4 && s.st.hero.hp === 120, "dá para dar parry nos 4 golpes da sequência rápida");
  check(s.st.zombie.posture === 100 - (15 + 15 + 16 + 22), `cada parry da sequência abaixa a barra (${s.st.zombie.posture})`);
  s = await E(() => { const D = window.duelo; T.fresh(30); D.zombieAttack("combo"); D.step(120); return D.state(); });
  check(s.hero.hp < 120, `sem defesa, a sequência acerta (vida ${s.hero.hp})`);

  // ---------- postura zera → atordoado ----------
  s = await E(() => {
    const D = window.duelo;
    T.fresh(30);
    for (let k = 0; k < 3; k++) {
      D.zombieAttack("slow");
      T.guardEach(5);
      D.step(20);
    }
    return { st: D.state(), sounds: D.sounds() };
  });
  check(s.st.zombie.state === "stun" && s.sounds.includes("break"), "3 parries no ataque lento zeram a barra: zumbi atordoado");
  await E(() => window.duelo.step(4));
  await page.screenshot({ path: path.join(OUT, "duelo-4-atordoado.png") });
  s = await E(() => {
    const D = window.duelo;
    const hp0 = D.state().zombie.hp;
    D.tap("attack"); D.step(14);
    return { dmg: hp0 - D.state().zombie.hp };
  });
  check(Math.abs(s.dmg - 8 * 1.6) < 0.01, `atordoado leva mais dano (${s.dmg.toFixed(1)} em vez de 8)`);
  s = await E(() => { window.duelo.step(170); return window.duelo.state(); });
  check(s.zombie.state !== "stun" && s.zombie.posture === 100, "depois de um tempo ele se recupera e a postura volta cheia");

  // ---------- poder ----------
  s = await E(() => {
    const D = window.duelo;
    T.fresh(30);
    D.tap("attack");
    for (let i = 0; i < 100; i++) { if (D.state().hero.state === "attack" && i % 5 === 0) D.tap("attack"); else D.step(1); }
    const afterCombo = D.state().hero.power;
    D.zombieAttack("slow");
    T.guardEach(5);
    return { afterCombo, afterParry: D.state().hero.power };
  });
  check(s.afterCombo === 35 && s.afterParry === 47, `poder carrega atacando (${s.afterCombo}) e com parry (${s.afterParry})`);
  s = await E(() => { const D = window.duelo; T.fresh(30); D.set({ hero: { power: 60 } }); D.tap("power"); D.step(2); return D.state(); });
  check(s.hero.state !== "power" && s.hero.power === 60, "poder incompleto não sai");
  s = await E(() => {
    const D = window.duelo;
    T.fresh(30);
    D.set({ hero: { power: 100 } });
    const hp0 = D.state().zombie.hp;
    D.tap("power");
    const during = D.state().hero.state;
    D.step(14);
    const mid = D.state();
    D.step(60);
    return { during, hp0, mid, end: D.state(), sounds: D.sounds() };
  });
  check(s.during === "power" && s.sounds.includes("power"), "poder cheio: 'Cortes Avançados'");
  check(s.hp0 - s.end.zombie.hp >= 40, `o poder causa dano grande (${(s.hp0 - s.end.zombie.hp).toFixed(0)})`);
  check(s.end.hero.power === 0 && s.end.hero.state === "move" && s.sounds.includes("boom"), "termina com a explosão do 'Final do Poder' e zera o poder");
  s = await E(() => { const D = window.duelo; T.fresh(30); D.set({ hero: { power: 100 } }); D.tap("power"); D.step(16); return D.state(); });
  await page.screenshot({ path: path.join(OUT, "duelo-5-poder.png") });

  // ---------- ondas e derrota ----------
  s = await E(() => {
    const D = window.duelo;
    T.fresh(30);
    D.set({ zombie: { hp: 5 } });
    D.tap("attack"); D.step(20);
    const dead = D.state().zombie.state;
    D.step(130);
    return { dead, after: D.state() };
  });
  check(s.dead === "dead" && s.after.wave === 2 && s.after.zombies.length === 2 && s.after.zombie.hp === 114 && s.after.kills === 1, "derrotar o zumbi chama a onda 2: dois zumbis, mais fortes");
  check(s.after.zombies.every((z) => z.state === "spawn" || z.state === "idle" || z.state === "walk" || z.state === "run"), "os zumbis da onda nova surgem do chão");
  s = await E(() => { const D = window.duelo; T.fresh(30); D.set({ hero: { hp: 5 } }); D.zombieAttack("slow"); D.step(T.slowHitIn + 90); return D.state(); });
  check(s.mode === "over", "vida zerada: fim de jogo");
  await page.screenshot({ path: path.join(OUT, "duelo-6-fim.png") });
  s = await E(() => { const D = window.duelo; D.tap("attack"); return D.state(); });
  check(s.mode === "play" && s.wave === 1 && s.hero.hp === 120, "dá para lutar de novo");

  // ---------- IA: aproxima e usa os dois tipos de ataque ----------
  s = await E(() => {
    const D = window.duelo;
    D.start(); D.ai(true); D.place(60, 330); D.clearSounds();
    const seen = new Set();
    let minDist = 999;
    for (let i = 0; i < 4000; i++) {
      D.set({ hero: { hp: 100, inv: 0 } });
      D.step(1);
      const st = D.state();
      seen.add(st.zombie.state);
      minDist = Math.min(minDist, Math.abs(st.zombie.x - st.hero.x));
    }
    return { seen: [...seen], minDist, growls: D.sounds().filter((x) => x === "growl").length };
  });
  check(s.seen.includes("run") && s.seen.includes("walk") && s.minDist < 40, `zumbi corre e anda até o herói (estados: ${s.seen.join(", ")})`);
  check(s.seen.includes("attack") && s.seen.includes("combo"), "zumbi usa o ataque lento e a sequência de 4");
  check(s.seen.includes("leap"), "zumbi também salta em cima do herói de longe");

  // ---------- salto do zumbi ----------
  s = await E(() => {
    const D = window.duelo;
    T.fresh(110);
    const x0 = D.state().zombie.x;
    D.zombieAttack("leap");
    let maxUp = 0;
    for (let i = 0; i < 80; i++) { D.step(1); maxUp = Math.max(maxUp, 184 - D.state().zombie.y); if (D.state().zombie.state === "idle") break; }
    return { x0, st: D.state(), maxUp, sounds: D.sounds() };
  });
  check(s.maxUp > 10 && Math.abs(s.st.zombie.x - s.st.hero.x) < 40, `salto: sobe ${s.maxUp.toFixed(0)} px e cai perto do herói`);
  check(s.sounds.includes("thud") && s.st.hero.hp < 120, "a queda do salto acerta quem não defende");
  s = await E(() => { const D = window.duelo; T.fresh(110); D.zombieAttack("leap"); T.guardEach(4); return { st: D.state(), sounds: D.sounds() }; });
  check(s.sounds.includes("parry") && s.st.hero.hp === 120, "dá para dar parry na queda do salto");

  // ---------- vários zumbis ----------
  s = await E(() => {
    const D = window.duelo;
    D.start(); D.ai(true); D.wave(4); D.clearSounds();
    const n = D.state().zombies.length;
    const spawning = D.state().zombies.every((z) => z.state === "spawn");
    let maxAtk = 0;
    for (let i = 0; i < 2500; i++) {
      D.set({ hero: { hp: 120, inv: 0 } });
      D.step(1);
      const atk = D.state().zombies.filter((z) => ["attack", "combo", "leap"].includes(z.state)).length;
      maxAtk = Math.max(maxAtk, atk);
    }
    return { n, spawning, maxAtk };
  });
  check(s.n === 3 && s.spawning, "onda 4: três zumbis surgindo do chão");
  check(s.maxAtk >= 2 && s.maxAtk <= 2, `no máximo dois atacam ao mesmo tempo (máximo visto: ${s.maxAtk})`);
  await E(() => { const D = window.duelo; D.start(); D.ai(true); D.wave(4); D.step(160); });
  await page.screenshot({ path: path.join(OUT, "duelo-8-tres-zumbis.png") });

  // cena de combate para olhar
  await E(() => { const D = window.duelo; T.fresh(30); D.tap("attack"); for (let i = 0; i < 40; i++) { if (i % 5 === 0) D.tap("attack"); else D.step(1); } });
  await page.screenshot({ path: path.join(OUT, "duelo-2-combo.png") });

  // ---------- celular ----------
  const phone = await browser.newContext({ ...devices["iPhone 13 landscape"] });
  const pp = await phone.newPage();
  watch(pp);
  await pp.goto(URL);
  await pp.waitForTimeout(400);
  const btns = await pp.$$eval(".pad button", (bs) => bs.filter((b) => b.offsetParent !== null).map((b) => b.dataset.key));
  check(["left", "right", "jump", "attack", "guard", "power"].every((k) => btns.includes(k)), `botões de toque: ${btns.join(", ")}`);
  await pp.tap("canvas");
  await pp.waitForTimeout(200);
  check((await pp.evaluate(() => window.duelo.state().mode)) === "play", "tocar na tela começa");
  const fire = (key, type) => pp.evaluate(([key, type]) => document.querySelector(`.pad button[data-key="${key}"]`).dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 3, pointerType: "touch" })), [key, type]);
  await fire("attack", "pointerdown");
  await pp.waitForTimeout(50);
  const atk = await pp.evaluate(() => window.duelo.state().hero.state);
  await fire("attack", "pointerup");
  check(atk === "attack", "botão ATAQUE ataca");
  await pp.waitForTimeout(400);
  await fire("guard", "pointerdown");
  await pp.waitForTimeout(80);
  const grd = await pp.evaluate(() => window.duelo.state().hero.state);
  await fire("guard", "pointerup");
  check(grd === "guard", "botão DEFESA defende");
  await pp.screenshot({ path: path.join(OUT, "duelo-7-celular.png") });
  check(await pp.isVisible("#back-btn"), "botão Menu aparece durante a luta no celular");
  await pp.tap("#back-btn");
  check((await pp.evaluate(() => window.duelo.state().mode)) === "title", "Menu volta ao título");
  const fits = await pp.evaluate(() => { const c = document.querySelector("canvas").getBoundingClientRect(); return c.width <= innerWidth + 1 && c.height <= innerHeight + 1; });
  check(fits, "o jogo cabe na tela do celular deitado");

  // celular em pé: o jogo gira e fica deitado
  const tall = await browser.newContext({ ...devices["iPhone 13"] });
  const tp = await tall.newPage();
  watch(tp);
  await tp.goto(URL);
  await tp.waitForTimeout(400);
  const rot = await tp.evaluate(() => {
    const c = document.querySelector("canvas").getBoundingClientRect();
    const btns = [...document.querySelectorAll(".pad button")].map((b) => b.getBoundingClientRect());
    const inside = btns.every((r) => r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 && r.width > 0);
    return { rotated: window.duelo.state().rotated, cw: c.width, ch: c.height, vw: innerWidth, vh: innerHeight, inside };
  });
  check(rot.rotated && rot.ch > rot.cw, `celular em pé: o jogo gira para ficar deitado (ocupa ${Math.round(rot.cw)}×${Math.round(rot.ch)} numa tela ${rot.vw}×${rot.vh})`);
  check(rot.ch > rot.vh * 0.85, "celular em pé: o jogo girado ocupa quase toda a altura da tela");
  check(rot.inside, "celular em pé: os botões ficam dentro da tela");
  await tp.tap("canvas");
  await tp.waitForTimeout(300);
  check((await tp.evaluate(() => window.duelo.state().mode)) === "play", "celular em pé: tocar começa a luta");
  await tp.screenshot({ path: path.join(OUT, "duelo-9-celular-em-pe.png") });

  check(errors.length === 0, `nenhum erro no console${errors.length ? ": " + [...new Set(errors)].join(" | ") : ""}`);
  await browser.close();
  console.log(`\n${failures ? failures + " falha(s)" : "Tudo passou"}. Screenshots em ${OUT}`);
  process.exit(failures ? 1 : 0);
})();
