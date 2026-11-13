"""Render the project's geometric app icon. Optional: python -m pip install pillow."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent / 'public'
for size in (192, 512):
    image = Image.new('RGB', (512, 512), '#f5f4f0')
    draw = ImageDraw.Draw(image)
    draw.rectangle((70, 112, 256, 400), fill='#e4473b')
    draw.rectangle((256, 112, 442, 400), fill='#67b96b')
    for points in (((126, 215), (196, 297)), ((196, 215), (126, 297)), ((306, 256), (336, 291), (394, 220))):
        draw.line(points, fill='#11190f', width=24, joint='curve')
        for x, y in points:
            draw.ellipse((x-12, y-12, x+12, y+12), fill='#11190f')
    image.resize((size, size), Image.Resampling.LANCZOS).save(root / f'icon-{size}.png')
