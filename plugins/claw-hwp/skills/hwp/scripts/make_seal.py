#!/usr/bin/env python3
"""Generate a simple 4-character square seal (날인) PNG with a transparent
background — a red-bordered square with the 4 chars laid out 2x2 in reading
order (top-left, top-right, bottom-left, bottom-right). For users who don't have
a real signature/seal image. A proper signature should come from the user's own
transparent PNG (e.g. macOS Preview > Markup > Signature) — see SKILL.md.

  python3 make_seal.py --text "홍길동인" --out ~/.claw-hwp/seal.png
  python3 make_seal.py --name "홍길동" --out seal.png      # appends 印 → 홍길동印

Output: transparent RGBA PNG, square. Default ~600px (scale-independent — size
on the page is set when inserting via insert_image width_mm/height_mm).
"""
import argparse, sys, os

def find_font(size, bold=True):
    candidates = [
        "/System/Library/Fonts/Supplemental/AppleGothic.ttf",
        "/System/Library/Fonts/AppleSDGothicNeo.ttc",
        "/Library/Fonts/AppleGothic.ttf",
        "/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf",
        "/usr/share/fonts/truetype/nanum/NanumGothic.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ]
    from PIL import ImageFont
    for p in candidates:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", help="exactly 4 characters (e.g. 홍길동인)")
    ap.add_argument("--name", help="name; 印 is appended to make 4 chars (e.g. 홍길동 → 홍길동印)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--px", type=int, default=600)
    ap.add_argument("--color", default="#C8102E")  # 인주(seal) red
    args = ap.parse_args()

    text = args.text
    if not text and args.name:
        nm = args.name.strip()
        text = (nm + "印") if len(nm) == 3 else (nm if len(nm) == 4 else (nm + "印"))
    if not text:
        print("error: need --text (4 chars) or --name", file=sys.stderr); sys.exit(1)
    chars = list(text)[:4]
    while len(chars) < 4:
        chars.append("印")

    from PIL import Image, ImageDraw
    S = args.px
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))  # transparent
    d = ImageDraw.Draw(img)
    red = args.color
    # square border (double line for a seal feel)
    bw = max(6, S // 40)
    m = S // 14
    d.rectangle([m, m, S - m, S - m], outline=red, width=bw)
    inset = m + bw + S // 28
    d.rectangle([inset, inset, S - inset, S - inset], outline=red, width=max(3, bw // 2))
    # 2x2 cells, reading order TL, TR, BL, BR
    pad = inset + S // 22
    cw = (S - 2 * pad) / 2
    cell_font = find_font(int(cw * 0.86))
    centers = [
        (pad + cw * 0.5, pad + cw * 0.5),  # TL
        (pad + cw * 1.5, pad + cw * 0.5),  # TR
        (pad + cw * 0.5, pad + cw * 1.5),  # BL
        (pad + cw * 1.5, pad + cw * 1.5),  # BR
    ]
    for ch, (cx, cy) in zip(chars, centers):
        bb = d.textbbox((0, 0), ch, font=cell_font)
        w, h = bb[2] - bb[0], bb[3] - bb[1]
        d.text((cx - w / 2 - bb[0], cy - h / 2 - bb[1]), ch, font=cell_font, fill=red)

    out = os.path.expanduser(args.out)
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    img.save(out)
    try:
        os.chmod(out, 0o600)
    except Exception:
        pass
    print('{"wrote": "%s", "chars": "%s", "px": %d, "transparent": true}' % (out, "".join(chars), S))

if __name__ == "__main__":
    main()
