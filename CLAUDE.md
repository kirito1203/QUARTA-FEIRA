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
