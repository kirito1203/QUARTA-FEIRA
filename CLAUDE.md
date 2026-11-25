# Instruções do projeto

## Sites

Sempre que for criado ou alterado um site neste repositório:

1. Gerar uma versão final em HTML estático (HTML/CSS/JS prontos para abrir no navegador). Se o site usar um framework ou etapa de build, rodar o build e gerar a saída estática.
2. Testar essa saída com o Playwright (servidor MCP `playwright` definido em `.mcp.json`, ou um script Playwright se o MCP não estiver carregado): abrir as páginas, conferir que carregam sem erros no console, navegar pelos links e interações principais e tirar screenshots.
3. Relatar o resultado dos testes, incluindo o que falhou.
