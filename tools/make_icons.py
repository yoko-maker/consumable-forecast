# アイコン生成: python tools/make_icons.py web
import math, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

OUT = Path(sys.argv[1])
N = 1024

def lerp(a, b, t): return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

def background(full):
    top, bot = (126, 160, 255), (79, 108, 245)
    bg = Image.new("RGBA", (N, N))
    d = ImageDraw.Draw(bg)
    for y in range(N):
        d.line([(0, y), (N, y)], fill=lerp(top, bot, y / N) + (255,))
    # ふんわりした光
    glow = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    g = ImageDraw.Draw(glow)
    g.ellipse([-150, -200, 520, 420], fill=(255, 255, 255, 60))
    g.ellipse([640, 700, 1150, 1180], fill=(255, 210, 230, 45))
    bg = Image.alpha_composite(bg, glow.filter(ImageFilter.GaussianBlur(60)))
    if not full:
        mask = Image.new("L", (N, N), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, N - 1, N - 1], radius=230, fill=255)
        bg.putalpha(mask)
    return bg

def mascot():
    """ビンのキャラクター（1024 キャンバス中央に描画）"""
    im = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    # 影
    sh = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle([292, 360, 752, 860], radius=130, fill=(30, 40, 120, 90))
    im = Image.alpha_composite(im, sh.filter(ImageFilter.GaussianBlur(28)))
    d = ImageDraw.Draw(im)

    body = [282, 330, 742, 830]
    d.rounded_rectangle(body, radius=130, fill=(255, 255, 255, 255))

    # 中身（はちみつ色）— 波打つ上面
    fill = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    fd = ImageDraw.Draw(fill)
    level = 610
    pts = [(282, 830), (282, level)]
    for x in range(282, 743, 6):
        pts.append((x, level + 16 * math.sin((x - 282) / 460 * 2 * math.pi * 1.5)))
    pts += [(742, level), (742, 830)]
    fd.polygon(pts, fill=(255, 196, 77, 255))
    fd.ellipse([340, 680, 400, 740], fill=(255, 220, 140, 255))  # つや
    fd.ellipse([600, 740, 630, 770], fill=(255, 220, 140, 255))
    jar_mask = Image.new("L", (N, N), 0)
    ImageDraw.Draw(jar_mask).rounded_rectangle([300, 348, 724, 812], radius=112, fill=255)
    clipped = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    clipped.paste(fill, (0, 0), jar_mask)
    im = Image.alpha_composite(im, clipped)
    d = ImageDraw.Draw(im)

    # ガラスのハイライト
    d.rounded_rectangle([330, 390, 360, 540], radius=15, fill=(220, 230, 255, 255))

    # ふた
    d.rounded_rectangle([312, 240, 712, 350], radius=44, fill=(255, 128, 128, 255))
    d.rounded_rectangle([312, 240, 712, 290], radius=44, fill=(255, 160, 160, 255))
    d.rectangle([330, 270, 694, 290], fill=(255, 160, 160, 255))

    # 顔
    ink = (45, 55, 110, 255)
    d.ellipse([418, 440, 466, 500], fill=ink)
    d.ellipse([558, 440, 606, 500], fill=ink)
    d.ellipse([432, 450, 448, 468], fill=(255, 255, 255, 255))
    d.ellipse([572, 450, 588, 468], fill=(255, 255, 255, 255))
    d.arc([462, 470, 562, 560], start=20, end=160, fill=ink, width=16)
    d.ellipse([368, 512, 428, 548], fill=(255, 170, 190, 200))
    d.ellipse([596, 512, 656, 548], fill=(255, 170, 190, 200))

    # きらきら
    def star(cx, cy, r, col):
        p = []
        for i in range(8):
            a = math.pi / 4 * i - math.pi / 2
            rr = r if i % 2 == 0 else r * 0.32
            p.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
        d.polygon(p, fill=col)
    star(790, 270, 70, (255, 236, 150, 255))
    star(205, 700, 40, (255, 255, 255, 230))
    return im

def compose(full, scale):
    bg = background(full)
    m = mascot()
    if scale != 1:
        s = int(N * scale)
        m = m.resize((s, s), Image.LANCZOS)
        layer = Image.new("RGBA", (N, N), (0, 0, 0, 0))
        layer.paste(m, ((N - s) // 2, (N - s) // 2), m)
        m = layer
    return Image.alpha_composite(bg, m)

std = compose(full=False, scale=1.0)
maskable = compose(full=True, scale=0.78)     # セーフゾーン（中央80%）に収める
apple = compose(full=True, scale=0.92)        # iOS は自前で角丸にする

for name, img, size in [
    ("icon-192.png", std, 192), ("icon-512.png", std, 512),
    ("icon-maskable-512.png", maskable, 512),
    ("apple-touch-icon.png", apple.convert("RGB"), 180),
    ("favicon-32.png", std, 32),
]:
    img.resize((size, size), Image.LANCZOS).save(OUT / name, optimize=True)
