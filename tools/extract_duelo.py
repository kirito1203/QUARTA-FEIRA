"""Converte as sprite sheets do herói e do zumbi para o jogo "Meia-Noite" (duelo/).

Usa as folhas v2 (duelo/sprites/v2-*-original.png). Cada animação é uma seção
retangular da folha (SECTIONS); a seção é dividida no número de quadros dado,
cortando no ponto mais vazio perto de cada divisão (os efeitos dos golpes
encostam nos vizinhos), ou em cortes manuais quando a lista é dada.

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


P2 = "v2-personagens-original.png"
Z2 = "v2-zumbi-original.png"

# Seções das folhas novas: (arquivo, x0, x1, y0, y1, quadros ou cortes manuais)
SECTIONS = {
    "hero": {
        "idle": (P2, 15, 480, 85, 168, 5), "walk": (P2, 515, 960, 85, 168, 7), "run": (P2, 985, 1525, 85, 168, 7),
        "jump": (P2, 12, 565, 212, 322, 6), "fall": (P2, 585, 1020, 225, 318, 5), "land": (P2, 1045, 1525, 225, 324, 5),
        "basic": (P2, 12, 495, 360, 452, 6), "combo": (P2, 512, 1188, 340, 454, [515, 595, 683, 795, 858, 990, 1080, 1184]), "guard": (P2, 1198, 1525, 355, 472, 4),
        "power": (P2, 12, 995, 462, 588, [18, 128, 228, 325, 460, 625, 745, 984]),
        "death": (P2, 1010, 1525, 495, 590, 7),
    },
    "zombie": {
        "idle": (Z2, 20, 750, 95, 222, 7), "walk": (Z2, 775, 1525, 100, 222, 8), "run": (Z2, 20, 780, 290, 414, 6),
        "jump": (Z2, 800, 1525, 282, 414, 6), "attack": (Z2, 15, 975, 470, 594, [50, 175, 290, 392, 533, 790, 935]), "guard": (Z2, 1000, 1525, 470, 596, 4),
        "combo": (Z2, 15, 1525, 640, 764, 9), "stun": (Z2, 15, 575, 825, 974, 5), "death": (Z2, 590, 1190, 825, 974, 5),
        "rise": (Z2, 1195, 1525, 785, 1000, [1195, 1525]),
    },
}
# títulos das seções que ficam dentro do retângulo de algumas animações
LABELS = [(P2, 512, 700, 336, 356), (P2, 12, 240, 462, 488)]


def occupancy(rgb, x0, x1, y0, y1):
    m = rgb[y0:y1, x0:x1].max(axis=2) > 40
    for r in range(m.shape[0]):
        if m[r].sum() > (x1 - x0) * 0.5:
            m[r] = False  # linhas divisórias
    return m


def even_split(rgb, x0, x1, y0, y1, n):
    """Divide a seção em n quadros (as folhas têm espaçamento quase regular),
    cortando no ponto mais vazio perto de cada divisão."""
    cols = occupancy(rgb, x0, x1, y0, y1).sum(0)
    xs = np.nonzero(cols)[0]
    a, b = int(xs.min()), int(xs.max()) + 1
    step = (b - a) / n
    cuts = [a]
    for i in range(1, n):
        mid = a + step * i
        lo, hi = int(mid - step * 0.35), int(mid + step * 0.35)
        cuts.append(lo + int(np.argmin(cols[lo:hi] + np.abs(np.arange(lo, hi) - mid) * 0.02)))
    cuts.append(b)
    return [(x0 + cuts[i], x0 + cuts[i + 1]) for i in range(n)]


def erase_thin_lines(rgb):
    """Apaga as linhas finas das legendas (traço horizontal comprido com fundo
    escuro logo acima e abaixo). Os cortes de espada são grossos e ficam."""
    m = rgb.max(axis=2) > 40
    h, w = m.shape
    for y in range(2, h - 2):
        row = m[y]
        x = 0
        while x < w:
            if not row[x]:
                x += 1
                continue
            x0 = x
            while x < w and row[x]:
                x += 1
            if x - x0 >= 40:
                band = slice(x0, x)
                above = m[y - 2, band].mean()
                below = m[y + 2, band].mean()
                if above < 0.3 and below < 0.3:
                    rgb[y - 1:y + 2, band] = 0
    return rgb


def rects():
    images = {P2: erase_thin_lines(load(P2)), Z2: erase_thin_lines(load(Z2))}
    for src, x0, x1, y0, y1 in LABELS:
        images[src][y0:y1, x0:x1] = 0
    R = {"hero": {}, "zombie": {}}
    for who, secs in SECTIONS.items():
        for name, (src, x0, x1, y0, y1, n) in secs.items():
            if isinstance(n, list):
                cols = list(zip(n, n[1:]))
            else:
                cols = even_split(images[src], x0, x1, y0, y1, n)
            R[who][name] = (src, [(a, b, y0, y1) for a, b in cols])
        # só o efeito de cada golpe, para o rastro que se desfaz no jogo
        for name in FX_ANIMS[who]:
            R[who][name + "_fx"] = R[who][name]
    return R, images


FX_ANIMS = {"hero": ["basic", "combo", "power"], "zombie": ["attack", "combo"]}


EXPECT = {
    "hero": {"idle": 5, "walk": 7, "run": 7, "jump": 6, "fall": 5, "land": 5, "basic": 6, "combo": 7, "guard": 4, "power": 7, "death": 7},
    "zombie": {"idle": 7, "walk": 8, "run": 6, "jump": 6, "attack": 6, "guard": 4, "combo": 9, "stun": 5, "death": 5, "rise": 1},
}
# quadro "em pé" de cada folha, para todos ficarem na mesma altura no jogo
STANDING = {"hero": ("idle", 0), "zombie": ("idle", 0)}


def _dilate(m, r=1):
    out = m.copy()
    for _ in range(r):
        acc = out.copy()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            acc |= np.roll(np.roll(out, dy, 0), dx, 1)
        out = acc
    return out


def _components(mask):
    """Rótulos de componentes conectados (4 vizinhos)."""
    lab = np.zeros(mask.shape, int)
    n = 0
    h, w = mask.shape
    for y, x in zip(*np.nonzero(mask)):
        if lab[y, x]:
            continue
        n += 1
        lab[y, x] = n
        q = deque([(y, x)])
        while q:
            cy, cx = q.popleft()
            for ny, nx in ((cy + 1, cx), (cy - 1, cx), (cy, cx + 1), (cy, cx - 1)):
                if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not lab[ny, nx]:
                    lab[ny, nx] = n
                    q.append((ny, nx))
    return lab, n


def body_mask(crop):
    """O corpo é o maior bloco de pixels escuros (roupa). Efeitos e poeira são claros ou soltos."""
    mx = crop.max(axis=2)
    dark = (mx > 30) & (mx < 120)
    lab, n = _components(_dilate(dark, 2))
    if n == 0:
        return mx > 30
    sizes = np.bincount(lab.ravel())[1:]
    return (lab == 1 + int(np.argmax(sizes))) & dark


def body_anchor(crop):
    """Centro do tronco e linha dos pés, medidos só no corpo (não na poeira nem nos cortes)."""
    body = body_mask(crop)
    ys, xs = np.nonzero(body)
    top, bot = ys.min(), ys.max()
    band = (ys > top + (bot - top) * 0.25) & (ys < top + (bot - top) * 0.6)
    cx = float(xs[band].mean()) if band.any() else float(xs.mean())
    # pés: pixels opacos ligados ao corpo, nas colunas do corpo (as botas são claras)
    op = crop.max(axis=2) > 30
    near = _dilate(body, 4)
    feet = op & near
    fy = np.nonzero(feet.any(axis=1))[0]
    return cx, float(fy.max() + 1)


def fx_only(crop):
    """Só o efeito do golpe: pixels claros longe do corpo e da cabeça."""
    body = body_mask(crop)
    ys, xs = np.nonzero(body)
    top, bot = ys.min(), ys.max()
    hgt = bot - top
    region = _dilate(body, 5)
    # cabeça/cabelo: acima do corpo, na largura do tronco
    head = np.zeros_like(region)
    head[max(0, int(top - hgt * 0.45)):int(top + hgt * 0.2), max(0, xs.min() - 6):xs.max() + 7] = True
    mx = crop.max(axis=2)
    bright = crop.min(axis=2) > 120
    fx = (mx > 30) & bright & ~(region | head)
    fx = _dilate(fx, 1) & (mx > 30) & ~region
    out = crop.copy()
    out[~fx] = 0
    return out


def kmeans(pixels, k, iters=25, seed=5):
    rng = np.random.default_rng(seed)
    cent = pixels[rng.choice(len(pixels), k, replace=False)].astype(float)
    for _ in range(iters):
        lab = ((pixels[:, None, :] - cent[None]) ** 2).sum(-1).argmin(1)
        for i in range(k):
            if (lab == i).any():
                cent[i] = pixels[lab == i].mean(0)
    return cent


def build(who, anims, images, standing):
    anim, idx = standing
    src0 = anims[anim][0]
    x0, x1, y0, y1 = anims[anim][1][idx]
    m = images[src0][y0:y1, x0:x1].max(axis=2) > 40
    ys = np.nonzero(m.any(axis=1))[0]
    s = TARGET_H / (ys.max() - ys.min() + 1)
    scale = {src0: s}
    small = {}
    for name, (src, boxes) in anims.items():
        rgb = images[src]
        small[name] = []
        for (x0, x1, y0, y1) in boxes:
            crop = rgb[y0:y1, x0:x1]
            ax, ay = body_anchor(crop)
            if name.endswith("_fx"):
                crop = fx_only(crop)
            alpha = np.clip((crop.max(axis=2) - 22) / 26, 0, 1)
            rgba = np.dstack([crop * alpha[..., None], alpha * 255]).astype(np.uint8)
            tw, th = max(1, round((x1 - x0) * s)), max(1, round((y1 - y0) * s))
            a = np.array(Image.fromarray(rgba, "RGBA").resize((tw, th), Image.BOX)).astype(float)
            al = a[..., 3:4] / 255
            col = np.clip(np.where(al > 0, a[..., :3] / np.maximum(al, 1e-6), 0), 0, 255)
            small[name].append((col, a[..., 3] > 105, ax * tw / (x1 - x0), ay * th / (y1 - y0)))
    allpx = np.concatenate([c[m] for k, fr in small.items() if not k.endswith("_fx") for c, m, _, _ in fr])
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
    R, images = rects()
    for who, exp in EXPECT.items():
        got = {k: len(v[1]) for k, v in R[who].items() if not k.endswith("_fx")}
        assert got == exp, (who, got)
    sprites = {
        "hero": build("heroi", R["hero"], images, STANDING["hero"]),
        "zombie": build("zumbi", R["zombie"], images, STANDING["zombie"]),
    }
    if GAME.exists():
        js = "const SPRITES = " + json.dumps(sprites, separators=(",", ":")) + ";"
        html = GAME.read_text()
        html, n = re.subn(r"/\*SPRITE-START\*/.*?/\*SPRITE-END\*/", lambda _: f"/*SPRITE-START*/\n  {js}\n  /*SPRITE-END*/", html, flags=re.S)
        assert n == 1, "marcadores não encontrados em duelo/index.html"
        GAME.write_text(html)


if __name__ == "__main__":
    main()
