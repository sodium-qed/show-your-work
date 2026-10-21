"""Regenerate the original, lossless CMYK JPEG2000 embedded by pdf-images.e2e.mjs.

This optional fixture-authoring script needs Pillow with OpenJPEG. Routine tests
use the embedded bytes and need only the repository's Node dependencies.
"""
import base64
from io import BytesIO

from PIL import Image, ImageDraw

image = Image.new("RGB", (240, 180), "white")
draw = ImageDraw.Draw(image)
# A pale solid has visible pixels outside its dark construction lines. A crop
# inferred only from dark ink would cut off most of the original illustration.
for inset in range(16):
    draw.ellipse((10 + inset, 15 + inset, 230 - inset, 165 - inset),
                 fill=(255 - 3 * inset, 235 - 3 * inset, 190 - 3 * inset))
draw.polygon([(120, 38), (68, 143), (184, 143)], fill=(225, 218, 171))
draw.line([(120, 72), (120, 137), (169, 137)], fill=(35, 35, 35), width=2)
draw.line([(121, 128), (129, 128), (129, 137)], fill=(35, 35, 35), width=1)
buffer = BytesIO()
image.convert("CMYK").save(buffer, format="JPEG2000", irreversible=False)
print(base64.b64encode(buffer.getvalue()).decode())
