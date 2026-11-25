// Teste do site com Playwright.
// Uso: npm run build && node tests/site.test.cjs [pasta-para-screenshots]
// O ponto principal: o número que fica para cima em cada dado 3D tem que ser
// exatamente o valor sorteado, e o total tem que bater com a soma.
const { chromium, devices } = require("playwright");
const path = require("path");
const fs = require("fs");

const URL = "file://" + path.resolve(__dirname, "../site/index.html");
const OUT = path.resolve(process.argv[2] || path.join(__dirname, "screenshots"));
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
function check(cond, msg) {
  console.log(`${cond ? "ok  " : "FAIL"}  ${msg}`);
  if (!cond) failures++;
}

const dice = (page) => page.evaluate(() => window.dadoSolto.dice());
async function rollAndWait(page, how = () => page.click("#roll")) {
  await how();
  await page.waitForFunction(() => window.dadoSolto.isRolling(), null, { timeout: 3000 }).catch(() => {});
  await page.waitForFunction(() => !window.dadoSolto.isRolling(), null, { timeout: 20000 });
  await page.waitForTimeout(450);
}

// Confere: valores no intervalo, face visível = valor sorteado, total = soma + mod.
async function verify(page, mod, label) {
  const ds = await dice(page);
  const total = Number(await page.textContent("#total"));
  let sum = 0;
  let inRange = true;
  let visibleOk = true;
  for (const d of ds) {
    sum += d.value;
    if (!(d.value >= 1 && d.value <= d.sides)) inRange = false;
    if (d.sides === 100) {
      const shown = (d.visible[0] + d.visible[1]) || 100;
      if (shown !== d.value) visibleOk = false;
    } else if (d.parts) {
      if (d.visible[0] !== d.parts[0] || d.visible[1] !== d.parts[1]) visibleOk = false;
    } else if (d.visible[0] !== d.value) {
      visibleOk = false;
    }
  }
  check(inRange, `${label}: valores dentro do intervalo`);
  check(visibleOk, `${label}: a face de cima de cada dado mostra o valor sorteado`);
  check(total === sum + mod, `${label}: total ${total} = soma ${sum} ${mod >= 0 ? "+" : "-"} ${Math.abs(mod)}`);
  return ds;
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const watch = (page) => {
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  };

  // ---------- Desktop ----------
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  watch(page);
  await page.goto(URL);
  await page.waitForTimeout(300);

  check(await page.isDisabled("#roll"), "Rolar desativado com a mesa vazia");
  check((await page.$$("canvas")).length === 1, "canvas 3D criado");

  // vários dados de uma vez
  for (const s of [20, 6, 6, 6, 8, 12, 4]) await page.click(`.die-btn[data-sides="${s}"]`);
  await page.waitForTimeout(700);
  check((await dice(page)).length === 7, "7 dados na mesa");
  check((await page.textContent("#formula")) === "1d4 + 3d6 + 1d8 + 1d12 + 1d20", "fórmula 1d4 + 3d6 + 1d8 + 1d12 + 1d20");
  check((await page.textContent('.die-btn[data-sides="6"] .count')) === "3", "contador do d6 mostra 3");
  await page.screenshot({ path: path.join(OUT, "1-mesa.png") });

  await page.click('.die-btn[data-sides="12"]', { button: "right" });
  await page.waitForTimeout(300);
  check((await dice(page)).length === 6, "botão direito remove o d12");

  await page.click("#mod-plus");
  await page.click("#mod-plus");
  await page.click("#mod-plus");
  check((await page.textContent("#mod-value")) === "+3", "modificador +3");

  // rolagem com screenshot no meio do voo
  const moving = await page.evaluate(() => {
    document.getElementById("roll").click();
    return window.dadoSolto.isRolling();
  });
  check(moving, "dados em movimento logo após rolar");
  await page.screenshot({ path: path.join(OUT, "2-rolando.png") });
  await page.waitForFunction(() => !window.dadoSolto.isRolling(), null, { timeout: 20000 });
  await page.waitForTimeout(450);
  await verify(page, 3, "rolagem 1");
  await page.screenshot({ path: path.join(OUT, "3-resultado.png") });

  // várias rolagens seguidas
  for (let i = 0; i < 4; i++) {
    await rollAndWait(page);
    await verify(page, 3, `rolagem extra ${i + 1}`);
  }

  // vantagem: 2d20, fica o maior
  await page.click('[data-mode="adv"]');
  await page.waitForTimeout(500);
  check((await page.textContent("#formula")).includes("vantagem"), "fórmula indica vantagem");
  await rollAndWait(page);
  let ds = await verify(page, 3, "vantagem");
  let d20 = ds.find((d) => d.sides === 20);
  check(d20.parts && d20.value === Math.max(...d20.parts), `vantagem fica com o maior (${d20.parts} → ${d20.value})`);
  await page.screenshot({ path: path.join(OUT, "4-vantagem.png") });

  // desvantagem
  await page.click('[data-mode="dis"]');
  await rollAndWait(page);
  ds = await verify(page, 3, "desvantagem");
  d20 = ds.find((d) => d.sides === 20);
  check(d20.parts && d20.value === Math.min(...d20.parts), `desvantagem fica com o menor (${d20.parts} → ${d20.value})`);

  // desligar o modo tirando o segundo d20
  await page.click('[data-mode="dis"]');
  await page.waitForTimeout(300);
  check((await dice(page)).find((d) => d.sides === 20).visible.length === 1, "voltar ao normal tira o segundo d20");

  // interromper no meio e rolar de novo
  await page.click("#roll");
  await page.waitForTimeout(250);
  await rollAndWait(page);
  await verify(page, 3, "rolagem interrompida e refeita");

  // d100 (dois d10: dezenas + unidades) e tecla Espaço
  await page.keyboard.press("Escape");
  await page.click("#mod-minus");
  await page.click("#mod-minus");
  await page.click("#mod-minus");
  await page.click('.die-btn[data-sides="100"]');
  await page.click('.die-btn[data-sides="10"]');
  await page.waitForTimeout(600);
  await rollAndWait(page, () => page.keyboard.press("Space"));
  await verify(page, 0, "d100 + d10 pela tecla Espaço");

  // tocar na mesa também rola
  await rollAndWait(page, () => page.mouse.click(680, 400));
  await verify(page, 0, "clique na mesa");

  // histórico
  await page.click("#history-open");
  await page.waitForTimeout(500);
  const hist = await page.$$eval(".h-item", (els) => els.length);
  check(hist === 11, `histórico tem 11 rolagens (${hist})`);
  await page.screenshot({ path: path.join(OUT, "5-historico.png") });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  check(!(await page.$eval("#drawer", (d) => d.classList.contains("open"))), "Esc fecha o histórico");

  // persistência
  await page.reload();
  await page.waitForTimeout(800);
  check((await dice(page)).length === 2, "mesa restaurada após recarregar");
  check((await page.$$(".h-item")).length === 11, "histórico restaurado após recarregar");

  // rolar de novo pelo histórico
  await page.click("#history-open");
  await page.waitForTimeout(400);
  await page.click(".h-item:nth-child(3) .h-again");
  await page.waitForTimeout(700);
  await page.waitForFunction(() => !window.dadoSolto.isRolling(), null, { timeout: 20000 });
  await page.waitForTimeout(450);
  check((await page.$$(".h-item")).length === 12, "'Rolar de novo' cria nova entrada");

  // limite de dados
  await page.keyboard.press("Escape");
  for (let i = 0; i < 17; i++) await page.click('.die-btn[data-sides="6"]', { delay: 0 });
  await page.waitForTimeout(300);
  check((await dice(page)).length === 16, "limite de 16 dados respeitado");
  check(await page.$eval("#toast", (t) => t.classList.contains("show")), "aviso de limite aparece");
  await rollAndWait(page);
  const curMod = Number((await page.textContent("#mod-value")).replace("−", "-"));
  await verify(page, curMod, "16d6");
  await page.screenshot({ path: path.join(OUT, "6-16d6.png") });

  // ---------- Movimento reduzido: muitas rolagens rápidas ----------
  const fast = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 1000, height: 760 } });
  const fp = await fast.newPage();
  watch(fp);
  await fp.goto(URL);
  for (const s of [4, 6, 8, 10, 12, 20, 100]) await fp.click(`.die-btn[data-sides="${s}"]`);
  const seen = new Map();
  let allVisible = true;
  for (let i = 0; i < 40; i++) {
    await fp.click("#roll");
    await fp.waitForFunction(() => !window.dadoSolto.isRolling());
    for (const d of await dice(fp)) {
      if (!seen.has(d.sides)) seen.set(d.sides, new Set());
      seen.get(d.sides).add(d.value);
      const shown = d.sides === 100 ? (d.visible[0] + d.visible[1]) || 100 : d.visible[0];
      if (shown !== d.value || d.value < 1 || d.value > d.sides) allVisible = false;
    }
  }
  check(allVisible, "40 rolagens com 7 tipos: face de cima sempre igual ao sorteado");
  check(seen.get(4).size === 4, "d4 mostrou as 4 faces");
  check(seen.get(6).size === 6, "d6 mostrou as 6 faces");
  await fast.close();

  // ---------- Celular ----------
  const phone = await browser.newContext({ ...devices["iPhone 13"] });
  const pp = await phone.newPage();
  watch(pp);
  await pp.goto(URL);
  for (const s of [20, 12, 8, 6, 4]) await pp.tap(`.die-btn[data-sides="${s}"]`);
  await pp.waitForTimeout(700);
  await rollAndWait(pp, () => pp.tap("#roll"));
  await verify(pp, 0, "celular");
  const overflow = await pp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check(!overflow, "sem rolagem horizontal no celular");
  await pp.screenshot({ path: path.join(OUT, "7-celular.png") });

  check(errors.length === 0, `nenhum erro no console${errors.length ? ": " + [...new Set(errors)].join(" | ") : ""}`);

  await browser.close();
  console.log(`\n${failures ? failures + " falha(s)" : "Tudo passou"}. Screenshots em ${OUT}`);
  process.exit(failures ? 1 : 0);
})();
