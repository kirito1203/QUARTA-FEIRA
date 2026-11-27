# Instruções do projeto

## Sites

Sempre que for criado ou alterado um site neste repositório:

1. Gerar uma versão final em HTML estático (HTML/CSS/JS prontos para abrir no navegador). Se o site usar um framework ou etapa de build, rodar o build e gerar a saída estática.
2. Testar essa saída com o Playwright (servidor MCP `playwright` definido em `.mcp.json`, ou um script Playwright se o MCP não estiver carregado): abrir as páginas, conferir que carregam sem erros no console, navegar pelos links e interações principais e tirar screenshots.
3. Relatar o resultado dos testes, incluindo o que falhou.

## Dado Solto (site de dados 3D)

- Código-fonte em `src/` (Three.js + cannon-es). O site pronto fica em `site/` e abre direto pelo `site/index.html`.
- Compilar: `npm install` e depois `npm run build` (gera `site/app.js`). Sempre recompilar antes de testar ou fazer commit.
- Testar: `node tests/site.test.cjs [pasta-de-screenshots]` (no ambiente na nuvem use `NODE_PATH=$(npm root -g)` para achar o Playwright).
- O resultado vem de `crypto.getRandomValues`; a física só decide a trajetória e os números das faces são trocados para que a face de cima mostre o valor sorteado. O teste confere isso.

## Lá em Cima (jogo de plataforma)

- Um arquivo só: `jogo/index.html` (HTML + canvas, sem dependências). Cenário, fonte de letras e sons são feitos no código; personagem e fantasma vêm das sprite sheets do usuário.
- Sprites: originais em `jogo/sprites/*-original.png`. `python3 tools/extract_sprites.py` recorta, reduz, limpa as cores e embute as folhas no `jogo/index.html` (entre `/*SPRITE-START*/` e `/*SPRITE-END*/`); os `*-preview.png` mostram o resultado ampliado. Para uma sprite nova, adicione uma entrada em `SHEETS` no script.
- Tema: noite, paleta lavanda/branco/roxo escuro (objeto `C`). Resolução 480×270. Controles: setas/A-D, Espaço pula, X/J atira, M som, Esc volta (no celular, botão Voltar no topo).
- Fases na lista `LEVELS`: `solids` (sólido), `platforms` (atravessa por baixo; `move`, `crumble`, `power: 'move'|'appear'` + `ch`), `levers` e `plates` (dão energia ao canal `ch`, 'a' ou 'b'), `gates` (abrem com energia), `boxes`, `ghosts` (x,y = olhos; `hp`, padrão 2; tiro tira 1, pisão tira 2), `flames` (+1 tiro), `ammo`, `wires` (decorativo) e `door`.
- Encostar num fantasma ou cair recomeça a fase inteira e conta uma queda.
- Editor de fases embutido (botão "Editor de fases" ou tecla E no título): cria fases no mesmo formato de `LEVELS`, salva no `localStorage` (`laemcima-editor-v1`), testa na hora e exporta/importa em JSON. Fases do editor sem `wires` ganham fios automáticos (`autoWires`). Para colocar uma fase criada pelo usuário no jogo oficial, cole o JSON exportado na lista `LEVELS` e adicione os passos dela ao teste.
- Testar: `node tests/jogo.test.cjs [pasta-de-screenshots]`. O teste pausa o jogo e avança quadro a quadro com `window.jogo` (desliga os fantasmas nos testes de caminho), prova que cada pulo é possível, que os atalhos não funcionam, e atravessa as fases até o fim. Ao criar ou mudar uma fase, adicione os passos dela ao teste.

## Meia-Noite (jogo de luta contra zumbis)

- Um arquivo só: `duelo/index.html` (canvas 384×216, sem dependências). Cenário de cemitério, fonte e sons feitos no código.
- Sprites: folhas v2 do usuário em `duelo/sprites/v2-personagens-original.png` (herói com espada) e `v2-zumbi-original.png`. `python3 tools/extract_duelo.py` recorta cada animação pelas seções em `SECTIONS` (divide em N quadros no ponto mais vazio, ou usa cortes manuais), apaga as linhas finas das legendas, alinha pelo corpo escuro e pelos pés, embute no HTML entre `/*SPRITE-START*/` e `/*SPRITE-END*/` e grava `*-preview.png` com a âncora marcada. As folhas v1 (`heroi-*-original.png`, `zumbi-original.png`) não são mais usadas.
- Combate: combo de 4 golpes (`HERO_STEPS`, o último acerta duas vezes), pausa curta a cada acerto, defesa segurando K e parry se apertar até `PARRY_WINDOW` quadros antes do golpe (flash amarelo na defesa, som `parry`). Teclas apertadas durante a pausa de impacto valem no quadro seguinte. Parry abaixa a postura (barra vermelha, só aparece depois do 1º parry); zerada = atordoado (dano ×1,6). Vida do zumbi escondida; acerto dá flash branco fraco. Poder carrega acertando, bloqueando e com parry; L solta os "Cortes Avançados" em todos à frente.
- Zumbis (`Z_ATTACKS`): ataque lento, sequência de 4 golpes rápidos e salto (`leap`) de longe, todos com aviso vermelho no olho; às vezes defendem; surgem do chão (arte `rise`). Onda 1: 1 zumbi, ondas 2-3: 2, onda 4+: 3; no máximo 2 atacam ao mesmo tempo, os outros rondam.
- Celular: em pé, a página gira o `#app` 90° (classe `rotated`) para o jogo ficar deitado; também tenta tela cheia + `screen.orientation.lock('landscape')` ao tocar no título.
- Testar: `node tests/duelo.test.cjs [pasta-de-screenshots]`. Usa `window.duelo` (pausa, avança quadros, `ai(false)`, `zombieAttack(tipo)`, `wave(n)`, `state().zombie.nextHit` para acertar o parry no quadro certo).
