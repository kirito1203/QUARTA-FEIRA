"""Converte a sprite sheet do personagem (jogo/sprites/original.png) para o jogo.

1. Acha cada quadro (componentes conectados) e separa por animação pela posição.
2. Reduz para o tamanho do jogo (média por área) e limpa as cores para uma paleta
   pequena (k-means), para virar pixel art nítida.
3. Alinha todos os quadros pelos pés, põe contorno escuro e monta uma folha única.
4. Grava jogo/sprites/personagem.png e embute a imagem (base64) no jogo/index.html
   entre os marcadores /*SPRITE-START*/ e /*SPRITE-END*/.

Uso: python3 tools/extract_sprites.py
"""
import base64
import io
import json
import re
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "jogo/sprites/original.png"
OUT_PNG = ROOT / "jogo/sprites/personagem.png"
OUT_PREVIEW = ROOT / "jogo/sprites/preview.png"
GAME = ROOT / "jogo/index.html"

SCALE = 0.19        # ~164 px de altura no original -> ~31 px no jogo
COLORS = 8          # cores da paleta final (fora o contorno)
OUTLINE = (12, 10, 20, 255)


def find_frames(rgb):
    mask = rgb.max(axis=2) > 28
    h, w = mask.shape
    cs = 4
    g = mask[: h // cs * cs, : w // cs * cs].reshape(h // cs, cs, w // cs, cs).any(axis=(1, 3))
    gd = g.copy()
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            gd |= np.roll(np.roll(g, dy, 0), dx, 1)
    lab = np.zeros(gd.shape, int)
    n = 0
    boxes = []
    for y in range(gd.shape[0]):
        for x in range(gd.shape[1]):
            if gd[y, x] and not lab[y, x]:
                n += 1
                q = deque([(y, x)])
                lab[y, x] = n
                ys, xs = [y], [x]
                while q:
                    cy, cx = q.popleft()
                    for ny, nx in ((cy + 1, cx), (cy - 1, cx), (cy, cx + 1), (cy, cx - 1)):
                        if 0 <= ny < gd.shape[0] and 0 <= nx < gd.shape[1] and gd[ny, nx] and not lab[ny, nx]:
                            lab[ny, nx] = n
                            q.append((ny, nx))
                            ys.append(ny)
                            xs.append(nx)
                boxes.append((min(xs) * cs, min(ys) * cs, (max(xs) + 1) * cs, (max(ys) + 1) * cs))
    return [b for b in boxes if b[3] - b[1] > 60]  # tira legendas e linhas


def group(boxes):
    anims = {"idle": [], "run": [], "jump": [], "fall": [], "land": []}
    for b in boxes:
        cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
        if cy < 320:
            anims["idle" if cx < 560 else "run"].append(b)
        elif cy < 680:
            anims["jump" if cx < 960 else "fall"].append(b)
        else:
            anims["land"].append(b)
    for k in anims:
        anims[k].sort(key=lambda b: b[0])
    return anims


def kmeans(pixels, k, iters=30, seed=3):
    rng = np.random.default_rng(seed)
    cent = pixels[rng.choice(len(pixels), k, replace=False)].astype(float)
    for _ in range(iters):
        d = ((pixels[:, None, :] - cent[None]) ** 2).sum(-1)
        lab = d.argmin(1)
        for i in range(k):
            if (lab == i).any():
                cent[i] = pixels[lab == i].mean(0)
    return cent


def main():
    rgb = np.array(Image.open(SRC).convert("RGB")).astype(float)
    anims = group(find_frames(rgb))
    assert [len(anims[k]) for k in anims] == [4, 7, 6, 4, 5], {k: len(v) for k, v in anims.items()}

    # 1) reduz cada quadro: alpha vem do brilho (fundo preto)
    small = {}
    for name, boxes in anims.items():
        small[name] = []
        for (x0, y0, x1, y1) in boxes:
            crop = rgb[y0:y1, x0:x1]
            alpha = np.clip((crop.max(axis=2) - 22) / 30, 0, 1)
            rgba = np.dstack([crop * alpha[..., None], alpha * 255]).astype(np.uint8)
            im = Image.fromarray(rgba, "RGBA")
            tw, th = max(1, round((x1 - x0) * SCALE)), max(1, round((y1 - y0) * SCALE))
            im = im.resize((tw, th), Image.BOX)
            a = np.array(im).astype(float)
            al = a[..., 3:4] / 255
            col = np.clip(np.where(al > 0, a[..., :3] / np.maximum(al, 1e-6), 0), 0, 255)  # desfaz a pré-multiplicação
            small[name].append((col, a[..., 3] > 110))

    # 2) paleta comum a todos os quadros
    allpx = np.concatenate([c[m] for fr in small.values() for c, m in fr])
    pal = kmeans(allpx, COLORS)
    pal = pal[np.argsort(pal.sum(1))]

    # 3) quantiza, acha âncora (pés) e põe contorno
    frames = {}
    for name, fr in small.items():
        frames[name] = []
        for col, m in fr:
            h, w = m.shape
            idx = ((col[..., None, :] - pal[None, None]) ** 2).sum(-1).argmin(-1)
            img = np.zeros((h, w, 4), np.uint8)
            img[m, :3] = pal[idx[m]].round().astype(np.uint8)
            img[m, 3] = 255
            ys, xs = np.nonzero(m)
            # pés: linha mais baixa perto do centro (ignora a poeira dos lados)
            cx_all = xs.mean()
            central = np.abs(xs - cx_all) < w * 0.28
            feet = ys[central].max() + 1
            # centro horizontal: tronco (faixa entre 50% e 80% da altura)
            top = ys.min()
            band = (ys > top + (feet - top) * 0.5) & (ys < top + (feet - top) * 0.8)
            ax = xs[band].mean() if band.any() else cx_all
            # contorno de 1 px
            pad = np.zeros((h + 2, w + 2, 4), np.uint8)
            pad[1:-1, 1:-1] = img
            om = pad[..., 3] > 0
            ring = np.zeros_like(om)
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                ring |= np.roll(np.roll(om, dy, 0), dx, 1)
            ring &= ~om
            pad[ring] = OUTLINE
            frames[name].append((pad, ax + 1, feet + 1))

    # 4) célula comum: tudo alinhado pelos pés e pelo centro do tronco
    left = max(int(np.ceil(ax)) for f in frames.values() for _, ax, _ in f)
    right = max(int(np.ceil(p.shape[1] - ax)) for f in frames.values() for p, ax, _ in f)
    up = max(int(feet) for f in frames.values() for _, _, feet in f)
    down = max(int(p.shape[0] - feet) for f in frames.values() for p, _, feet in f)
    cw, ch = left + right, up + down
    order = ["idle", "run", "jump", "fall", "land"]
    rows = []
    sheet = Image.new("RGBA", (cw * max(len(frames[k]) for k in order), ch * len(order)), (0, 0, 0, 0))
    meta = {"cell": [cw, ch], "anchor": [left, up], "anims": {}}
    for r, name in enumerate(order):
        meta["anims"][name] = {"row": r, "frames": len(frames[name])}
        for i, (p, ax, feet) in enumerate(frames[name]):
            ox = cw * i + left - int(round(ax))
            oy = ch * r + up - int(feet)
            sheet.alpha_composite(Image.fromarray(p, "RGBA"), (ox, oy))
    sheet.save(OUT_PNG)
    prev = Image.new("RGBA", sheet.size, (24, 22, 40, 255))
    prev.alpha_composite(sheet)
    prev.resize((sheet.width * 6, sheet.height * 6), Image.NEAREST).save(OUT_PREVIEW)

    buf = io.BytesIO()
    sheet.save(buf, "PNG", optimize=True)
    b64 = base64.b64encode(buf.getvalue()).decode()
    js = f"const SPRITE = {json.dumps(meta)};\n  SPRITE.src = 'data:image/png;base64,{b64}';"
    html = GAME.read_text()
    html, n = re.subn(r"/\*SPRITE-START\*/.*?/\*SPRITE-END\*/", f"/*SPRITE-START*/\n  {js}\n  /*SPRITE-END*/", html, flags=re.S)
    assert n == 1, "marcadores não encontrados no jogo/index.html"
    GAME.write_text(html)
    print("célula", cw, "x", ch, "âncora", left, up, "| paleta", [tuple(int(v) for v in c) for c in pal], "| bytes", len(buf.getvalue()))


if __name__ == "__main__":
    main()
