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

- Um arquivo só: `jogo/index.html` (HTML + canvas, sem dependências nem build). Toda a arte, a fonte de letras e os sons são feitos no código.
- Fases ficam na lista `LEVELS` no começo do script: chão sólido em `solids`, plataformas em `platforms` (dá para atravessar por baixo; `move` faz andar) e a `door`.
- Testar: `node tests/jogo.test.cjs [pasta-de-screenshots]`. O teste pausa o jogo e avança quadro a quadro com `window.jogo`, prova que cada pulo é possível e joga as fases até o fim. Ao criar ou mudar uma fase, adicione os pulos dela ao teste.
