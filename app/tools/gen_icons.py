"""生成 llama-desk 图标（渐变圆角方块 + ›_ 终端提示符）。
用法：python tools/gen_icons.py   输出到 src-tauri/icons/
"""
import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "src-tauri", "icons")

C_TOP = (56, 189, 248)     # sky-400
C_BOTTOM = (99, 102, 241)  # indigo-500


def make(size: int) -> Image.Image:
    s = size * 4  # 超采样，缩小时不锯齿
    glyph = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(glyph)

    # 白底图形先画（稍后作为 mask 贴到渐变上）
    w = int(s * 0.078)
    x0, x1 = int(s * 0.27), int(s * 0.51)
    y0, ym, y1 = int(s * 0.29), int(s * 0.50), int(s * 0.71)
    d.line([(x0, y0), (x1, ym), (x0, y1)], fill=(255, 255, 255, 255), width=w, joint="curve")
    bar_y = int(s * 0.635)
    d.rounded_rectangle(
        [int(s * 0.585), bar_y, int(s * 0.795), bar_y + w],
        radius=w // 2,
        fill=(255, 255, 255, 255),
    )

    # 垂直渐变
    grad = Image.new("RGBA", (s, s))
    gd = ImageDraw.Draw(grad)
    for y in range(s):
        t = y / max(1, s - 1)
        col = tuple(int(C_TOP[i] + (C_BOTTOM[i] - C_TOP[i]) * t) for i in range(3)) + (255,)
        gd.line([(0, y), (s, y)], fill=col)

    # 圆角遮罩
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, s - 1, s - 1], radius=int(s * 0.225), fill=255
    )

    out = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    out.paste(grad, (0, 0), mask)
    out.alpha_composite(Image.composite(glyph, Image.new("RGBA", (s, s), (0, 0, 0, 0)), mask))
    return out.resize((size, size), Image.LANCZOS)


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    sizes = [16, 24, 32, 48, 64, 128, 256]
    make(256).save(os.path.join(OUT, "icon.ico"), sizes=[(n, n) for n in sizes])
    make(512).save(os.path.join(OUT, "icon.png"))
    make(32).save(os.path.join(OUT, "32x32.png"))
    make(128).save(os.path.join(OUT, "128x128.png"))
    make(256).save(os.path.join(OUT, "128x128@2x.png"))
    print("icons ->", OUT)


if __name__ == "__main__":
    main()
