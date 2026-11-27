"""Converte as sprite sheets do herói e do zumbi para o jogo "Meia-Noite" (duelo/).

Cada animação é uma lista de retângulos no PNG original. Quando os efeitos de
corte encostam no quadro vizinho, o grupo é cortado no ponto mais vazio entre os
personagens (centros aproximados em CUTS).

Para cada quadro: fundo preto vira transparente, reduz para o tamanho do jogo,
limpa as cores (k-means) e alinha pelo corpo (as roupas escuras, que não se
confundem com os efeitos claros dos golpes) e pelos pés. Cada animação ganha a
sua própria célula na folha. Grava duelo/sprites/<nome>.png, <nome>-preview.png
(com a âncora marcada) e embute tudo no duelo/index.html entre
/*SPRITE-START*/ e /*SPRITE-END*/.

Uso: python3 tools/extract_duelo.py
"""
import base64
import io
import json
import re
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SPR = ROOT / "duelo/sprites"
GAME = ROOT / "duelo/index.html"
TARGET_H = 40  # altura do personagem em pé, em pixels do jogo


def load(name):
    return np.array(Image.open(SPR / name).convert("RGB")).astype(float)


def column_groups(rgb, x0, x1, y0, y1, masks=(), gap=6, cut=30):
    m = rgb[y0:y1, x0:x1].max(axis=2) > cut
    for (mx0, mx1, my0, my1) in masks:
        m[max(0, my0 - y0):max(0, my1 - y0), max(0, mx0 - x0):max(0, mx1 - x0)] = False
    cols = m.sum(0)
    out, inb, last = [], False, 0
    for x in range(len(cols)):
        if cols[x] > 0:
            if not inb:
                inb, gx = True, x
            last = x
        elif inb and x - last > gap:
            inb = False
            out.append([gx + x0, last + 1 + x0])
    if inb:
        out.append([gx + x0, last + 1 + x0])
    return [g for g in out if g[1] - g[0] > 12], cols


def split_by_centers(rgb, y0, y1, centers, x_start, x_end, masks=()):
    """Corta [x_start, x_end] em len(centers) quadros, no ponto mais vazio entre centros vizinhos."""
    m = rgb[y0:y1].max(axis=2) > 30
    for (mx0, mx1, my0, my1) in masks:
        m[max(0, my0 - y0):max(0, my1 - y0), mx0:mx1] = False
    cols = m.sum(0)
    cuts = [x_start]
    for a, b in zip(centers, centers[1:]):
        lo, hi = a + 25, b - 25
        cuts.append(lo + int(np.argmin(cols[lo:hi])))
    cuts.append(x_end)
    return [[cuts[i], cuts[i + 1]] for i in range(len(centers))]


def rects():
    hm = load("heroi-movimento-original.png")
    ha = load("heroi-ataques-original.png")
    zb = load("zumbi-original.png")
    R = {"hero": {}, "zombie": {}}

    # herói, movimento: mesma folha do "Lá em Cima", recortada pelo mesmo método de lá
    import sys
    sys.path.insert(0, str(ROOT / "tools"))
    from extract_sprites import find_boxes, group_player
    for name, boxes in group_player(find_boxes(hm, 22)).items():
        R["hero"][name] = ("heroi-movimento-original.png", [(x0, x1, y0, y1) for (x0, y0, x1, y1) in sorted(boxes, key=lambda b: b[0])])

    # herói, ataques
    g, _ = column_groups(ha, 0, 1536, 88, 212)
    R["hero"]["basic"] = ("heroi-ataques-original.png", [(a, b, 88, 212) for a, b in g])
    label = [(0, 720, 0, 306)]
    combo = split_by_centers(ha, 285, 476, [88, 255, 425, 568, 690, 845, 1000, 1165, 1300], 30, 1520, label)
    R["hero"]["combo"] = ("heroi-ataques-original.png", [(a, b, 306 if a < 720 else 285, 476) for a, b in combo])
    divider = [(552, 570, 0, 1024)]
    guard = split_by_centers(ha, 585, 752, [84, 244, 400], 30, 552, divider)
    R["hero"]["guard"] = ("heroi-ataques-original.png", [(a, b, 585, 752) for a, b in guard])
    power = split_by_centers(ha, 585, 752, [640, 790, 945, 1255, 1440], 580, 1520, divider)
    R["hero"]["power"] = ("heroi-ataques-original.png", [(a, b, 585, 752) for a, b in power])
    g, _ = column_groups(ha, 0, 1536, 845, 975)
    R["hero"]["powerEnd"] = ("heroi-ataques-original.png", [(a, b, 845, 975) for a, b in g])

    # zumbi
    g, _ = column_groups(zb, 0, 1536, 84, 216)
    R["zombie"]["idle"] = ("zumbi-original.png", [(a, b, 84, 216) for a, b in g[:4]])
    R["zombie"]["walk"] = ("zumbi-original.png", [(a, b, 84, 216) for a, b in g[4:]])
    g, _ = column_groups(zb, 0, 1536, 323, 456)
    R["zombie"]["run"] = ("zumbi-original.png", [(a, b, 323, 456) for a, b in g[:5]])
    R["zombie"]["attack"] = ("zumbi-original.png", [(a, b, 323, 456) for a, b in g[5:]])
    g, _ = column_groups(zb, 0, 1536, 502, 700, [(0, 800, 0, 540)])
    R["zombie"]["combo"] = ("zumbi-original.png", [(a, b, 540, 700) for a, b in g])
    g, _ = column_groups(zb, 0, 1536, 800, 960)
    R["zombie"]["guard"] = ("zumbi-original.png", [(a, b, 800, 960) for a, b in g[:3]])
    R["zombie"]["stun"] = ("zumbi-original.png", [(a, b, 800, 960) for a, b in g[3:6]])
    R["zombie"]["death"] = ("zumbi-original.png", [(a, b, 800, 960) for a, b in g[6:]])
    return R


EXPECT = {
    "hero": {"idle": 4, "run": 7, "jump": 6, "fall": 4, "land": 5, "basic": 5, "combo": 9, "guard": 3, "power": 5, "powerEnd": 5},
    "zombie": {"idle": 4, "walk": 6, "run": 5, "attack": 4, "combo": 8, "guard": 3, "stun": 3, "death": 4},
}
# altura do personagem em pé em cada folha (para todas ficarem na mesma escala)
STANDING = {"heroi-movimento-original.png": ("idle", 0), "heroi-ataques-original.png": ("powerEnd", 4), "zumbi-original.png": ("idle", 0)}


def body_anchor(crop):
    """Centro do corpo (pixels escuros = roupa) e linha dos pés."""
    mx = crop.max(axis=2)
    opaque = mx > 30
    dark = opaque & (mx < 125)
    ys, xs = np.nonzero(dark if dark.sum() > 40 else opaque)
    cx = float(np.median(xs))
    oy, ox = np.nonzero(opaque)
    near = np.abs(ox - cx) < crop.shape[1] * 0.18 + 12
    feet = float(oy[near].max() + 1)
    return cx, feet


def kmeans(pixels, k, iters=25, seed=5):
    rng = np.random.default_rng(seed)
    cent = pixels[rng.choice(len(pixels), k, replace=False)].astype(float)
    for _ in range(iters):
        lab = ((pixels[:, None, :] - cent[None]) ** 2).sum(-1).argmin(1)
        for i in range(k):
            if (lab == i).any():
                cent[i] = pixels[lab == i].mean(0)
    return cent


def build(who, anims):
    images = {}
    scale = {}
    for src, (anim, idx) in STANDING.items():
        if anim not in anims or anims[anim][0] != src:
            continue
        rgb = images.setdefault(src, load(src))
        x0, x1, y0, y1 = anims[anim][1][idx]
        m = rgb[y0:y1, x0:x1].max(axis=2) > 30
        ys = np.nonzero(m.any(axis=1))[0]
        scale[src] = TARGET_H / (ys.max() - ys.min() + 1)
    # personagem com folhas sem quadro "em pé" usa a escala de outra folha do mesmo personagem
    for name, (src, _) in anims.items():
        images.setdefault(src, load(src))
    small = {}
    for name, (src, boxes) in anims.items():
        rgb = images[src]
        s = scale[src]
        small[name] = []
        for (x0, x1, y0, y1) in boxes:
            crop = rgb[y0:y1, x0:x1]
            ax, ay = body_anchor(crop)
            alpha = np.clip((crop.max(axis=2) - 22) / 26, 0, 1)
            rgba = np.dstack([crop * alpha[..., None], alpha * 255]).astype(np.uint8)
            tw, th = max(1, round((x1 - x0) * s)), max(1, round((y1 - y0) * s))
            a = np.array(Image.fromarray(rgba, "RGBA").resize((tw, th), Image.BOX)).astype(float)
            al = a[..., 3:4] / 255
            col = np.clip(np.where(al > 0, a[..., :3] / np.maximum(al, 1e-6), 0), 0, 255)
            small[name].append((col, a[..., 3] > 105, ax * tw / (x1 - x0), ay * th / (y1 - y0)))
    allpx = np.concatenate([c[m] for fr in small.values() for c, m, _, _ in fr])
    pal = kmeans(allpx, 10)
    pal = pal[np.argsort(pal.sum(1))]
    outline = (10, 8, 18, 255)

    rows = []
    for name, fr in small.items():
        frames = []
        for col, m, ax, ay in fr:
            h, w = m.shape
            idx = ((col[..., None, :] - pal[None, None]) ** 2).sum(-1).argmin(-1)
            img = np.zeros((h + 2, w + 2, 4), np.uint8)
            img[1:-1, 1:-1][m, :3] = pal[idx[m]].round().astype(np.uint8)
            img[1:-1, 1:-1][m, 3] = 255
            om = img[..., 3] > 0
            ring = np.zeros_like(om)
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                ring |= np.roll(np.roll(om, dy, 0), dx, 1)
            img[ring & ~om] = outline
            frames.append((img, ax + 1, ay + 1))
        left = max(int(np.ceil(ax)) for _, ax, _ in frames)
        right = max(int(np.ceil(p.shape[1] - ax)) for p, ax, _ in frames)
        up = max(int(np.ceil(ay)) for _, _, ay in frames)
        down = max(int(np.ceil(p.shape[0] - ay)) for p, _, ay in frames)
        rows.append((name, frames, left + right, up + down, left, up))

    width = max(cw * len(fr) for _, fr, cw, _, _, _ in rows)
    height = sum(ch for _, _, _, ch, _, _ in rows)
    sheet = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    meta = {"anims": {}}
    y = 0
    for name, frames, cw, ch, left, up in rows:
        meta["anims"][name] = {"y": y, "cell": [cw, ch], "anchor": [left, up], "frames": len(frames)}
        for i, (p, ax, ay) in enumerate(frames):
            sheet.alpha_composite(Image.fromarray(p, "RGBA"), (cw * i + left - int(round(ax)), y + up - int(round(ay))))
        y += ch
    sheet.save(SPR / f"{who}.png")
    # prévia: fundo escuro, ampliada, com a âncora (pés) marcada
    prev = Image.new("RGBA", sheet.size, (26, 22, 44, 255))
    prev.alpha_composite(sheet)
    prev = prev.resize((sheet.width * 4, sheet.height * 4), Image.NEAREST)
    d = ImageDraw.Draw(prev)
    for name, a in meta["anims"].items():
        cw, ch = a["cell"]
        ax, ay = a["anchor"]
        for i in range(a["frames"]):
            px, py = (cw * i + ax) * 4, (a["y"] + ay) * 4
            d.line([(px - 6, py), (px + 6, py)], fill=(255, 220, 80, 255), width=2)
            d.line([(px, py - 6), (px, py)], fill=(255, 220, 80, 255), width=2)
        d.text((4, a["y"] * 4 + 2), name, fill=(255, 220, 80, 255))
    prev.save(SPR / f"{who}-preview.png")
    buf = io.BytesIO()
    sheet.save(buf, "PNG", optimize=True)
    meta["src"] = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
    print(who, "escala", {k: round(v, 3) for k, v in scale.items()}, "folha", sheet.size, len(buf.getvalue()), "bytes")
    return meta


def main():
    R = rects()
    for who, exp in EXPECT.items():
        got = {k: len(v[1]) for k, v in R[who].items()}
        assert got == exp, (who, got)
    sprites = {
        "hero": build("heroi", R["hero"]),
        "zombie": build("zumbi", R["zombie"]),
    }
    if GAME.exists():
        js = "const SPRITES = " + json.dumps(sprites, separators=(",", ":")) + ";"
        html = GAME.read_text()
        html, n = re.subn(r"/\*SPRITE-START\*/.*?/\*SPRITE-END\*/", lambda _: f"/*SPRITE-START*/\n  {js}\n  /*SPRITE-END*/", html, flags=re.S)
        assert n == 1, "marcadores não encontrados em duelo/index.html"
        GAME.write_text(html)


if __name__ == "__main__":
    main()
