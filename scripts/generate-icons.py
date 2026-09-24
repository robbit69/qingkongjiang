"""Generate the bundled PNG icon assets. Requires Pillow only when regenerating."""

from pathlib import Path
from PIL import Image, ImageDraw

out = Path('public/icons')
out.mkdir(parents=True, exist_ok=True)

for size in (16, 48, 128):
    scale = 4
    image = Image.new('RGBA', (size * scale, size * scale), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    s = size * scale
    draw.rounded_rectangle((0, 0, s - 1, s - 1), radius=s // 4, fill='#263bdb')
    for offset in (0.28, 0.48):
        x = s * offset
        draw.polygon([(x, s * 0.25), (x + s * 0.25, s * 0.5), (x, s * 0.75)], fill='white')
    image.resize((size, size), Image.Resampling.LANCZOS).save(out / f'icon-{size}.png')
