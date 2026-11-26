"""Converte as sprite sheets (fundo preto) em folhas de pixel art para o jogo.

Para cada sprite em SHEETS:
1. Acha cada quadro (componentes conectados) e separa por animação pela posição.
2. Reduz para o tamanho do jogo (média por área) e limpa as cores para uma paleta
   pequena (k-means), para virar pixel art nítida.
3. Alinha os quadros (pelos pés ou pelo centro), põe contorno (opcional) e monta
   uma folha única por sprite.
4. Grava jogo/sprites/<nome>.png e <nome>-preview.png e embute tudo (base64) no
   jogo/index.html entre os marcadores /*SPRITE-START*/ e /*SPRITE-END*/.

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
SPR = ROOT / "jogo/sprites"
GAME = ROOT / "jogo/index.html"


def group_player(boxes):
    anims = {"idle": [], "run": [], "jump": [], "fall": [], "land": []}
    for b in boxes:
        cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
        if cy < 320:
            anims["idle" if cx < 560 else "run"].append(b)
        elif cy < 680:
            anims["jump" if cx < 960 else "fall"].append(b)
        else:
            anims["land"].append(b)
    return anims


def group_ghost(boxes):
    # 8 quadros em duas linhas de 4, lidos da esquerda para a direita
    frames = sorted([b for b in boxes if b[1] > 120], key=lambda b: (b[1] > 520, b[0]))
    return {"float": frames}


SHEETS = [
    {
        "name": "player",
        "src": "personagem-original.png",
        "out": "personagem",
        "scale": 0.19,          # ~164 px -> ~31 px
        "colors": 8,
        "cut": (22, 30),        # alpha = (brilho - 22) / 30
        "outline": (12, 10, 20, 255),
        "anchor": "feet",
        "group": group_player,
        "expect": {"idle": 4, "run": 7, "jump": 6, "fall": 4, "land": 5},
    },
    {
        "name": "ghost",
        "src": "fantasma-original.png",
        "out": "fantasma",
        "scale": 0.13,          # ~265 px -> ~34 px
        "colors": 6,
        "cut": (10, 22),        # corpo bem escuro: corte mais baixo
        "outline": None,
        "anchor": "center",
        "group": group_ghost,
        "expect": {"float": 8},
    },
]


def find_boxes(rgb, cut):
    mask = rgb.max(axis=2) > cut + 6
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
    return [b for b in boxes if b[3] - b[1] > 60]  # tira legendas, linhas e partículas soltas


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


def build(cfg):
    rgb = np.array(Image.open(SPR / cfg["src"]).convert("RGB")).astype(float)
    anims = cfg["group"](find_boxes(rgb, cfg["cut"][0]))
    for k in anims:
        anims[k].sort(key=lambda b: (b[1] > 520, b[0])) if cfg["name"] == "ghost" else anims[k].sort(key=lambda b: b[0])
    got = {k: len(v) for k, v in anims.items()}
    assert got == cfg["expect"], (cfg["name"], got)

    c0, cr = cfg["cut"]
    small = {}
    for name, boxes in anims.items():
        small[name] = []
        for (x0, y0, x1, y1) in boxes:
            crop = rgb[y0:y1, x0:x1]
            alpha = np.clip((crop.max(axis=2) - c0) / cr, 0, 1)
            rgba = np.dstack([crop * alpha[..., None], alpha * 255]).astype(np.uint8)
            tw, th = max(1, round((x1 - x0) * cfg["scale"])), max(1, round((y1 - y0) * cfg["scale"]))
            a = np.array(Image.fromarray(rgba, "RGBA").resize((tw, th), Image.BOX)).astype(float)
            al = a[..., 3:4] / 255
            col = np.clip(np.where(al > 0, a[..., :3] / np.maximum(al, 1e-6), 0), 0, 255)
            small[name].append((col, a[..., 3] > 110))

    allpx = np.concatenate([c[m] for fr in small.values() for c, m in fr])
    pal = kmeans(allpx, cfg["colors"])
    pal = pal[np.argsort(pal.sum(1))]

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
            if cfg["anchor"] == "feet":
                central = np.abs(xs - xs.mean()) < w * 0.28
                ay = ys[central].max() + 1
                top = ys.min()
                band = (ys > top + (ay - top) * 0.5) & (ys < top + (ay - top) * 0.8)
                ax = xs[band].mean() if band.any() else xs.mean()
            else:
                # centro: pela cabeça/olhos (parte de cima), estável entre quadros
                bright = img[..., :3].max(axis=2) > 180
                if bright.any():
                    by, bx = np.nonzero(bright)
                    ax, ay = bx.mean(), by.mean()
                else:
                    ax, ay = xs.mean(), ys.mean()
            pad = np.zeros((h + 2, w + 2, 4), np.uint8)
            pad[1:-1, 1:-1] = img
            if cfg["outline"]:
                om = pad[..., 3] > 0
                ring = np.zeros_like(om)
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ring |= np.roll(np.roll(om, dy, 0), dx, 1)
                pad[ring & ~om] = cfg["outline"]
            frames[name].append((pad, ax + 1, ay + 1))

    left = max(int(np.ceil(ax)) for f in frames.values() for _, ax, _ in f)
    right = max(int(np.ceil(p.shape[1] - ax)) for f in frames.values() for p, ax, _ in f)
    up = max(int(np.ceil(ay)) for f in frames.values() for _, _, ay in f)
    down = max(int(np.ceil(p.shape[0] - ay)) for f in frames.values() for p, _, ay in f)
    cw, ch = left + right, up + down
    order = list(frames)
    sheet = Image.new("RGBA", (cw * max(len(frames[k]) for k in order), ch * len(order)), (0, 0, 0, 0))
    meta = {"cell": [cw, ch], "anchor": [left, up], "anims": {}}
    for r, name in enumerate(order):
        meta["anims"][name] = {"row": r, "frames": len(frames[name])}
        for i, (p, ax, ay) in enumerate(frames[name]):
            sheet.alpha_composite(Image.fromarray(p, "RGBA"), (cw * i + left - int(round(ax)), ch * r + up - int(round(ay))))
    sheet.save(SPR / f"{cfg['out']}.png")
    prev = Image.new("RGBA", sheet.size, (24, 22, 40, 255))
    prev.alpha_composite(sheet)
    prev.resize((sheet.width * 6, sheet.height * 6), Image.NEAREST).save(SPR / f"{cfg['out']}-preview.png")
    buf = io.BytesIO()
    sheet.save(buf, "PNG", optimize=True)
    meta["src"] = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
    print(f"{cfg['name']}: célula {cw}x{ch}, âncora {left},{up}, {len(buf.getvalue())} bytes")
    return meta


def main():
    sprites = {cfg["name"]: build(cfg) for cfg in SHEETS}
    js = "const SPRITES = " + json.dumps(sprites, separators=(",", ":")) + ";"
    html = GAME.read_text()
    html, n = re.subn(r"/\*SPRITE-START\*/.*?/\*SPRITE-END\*/", lambda _: f"/*SPRITE-START*/\n  {js}\n  /*SPRITE-END*/", html, flags=re.S)
    assert n == 1, "marcadores não encontrados no jogo/index.html"
    GAME.write_text(html)


if __name__ == "__main__":
    main()
