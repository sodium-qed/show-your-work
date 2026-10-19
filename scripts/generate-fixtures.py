#!/usr/bin/env python3
"""Generate original math-worksheet fixtures (no network or third-party content).

Run from any directory:
  "$CODEX_PRIMARY_RUNTIME_PYTHON" scripts/generate-fixtures.py

Dependencies: Python 3.10+, reportlab, pypdf, Pillow, and pdftoppm (Poppler).
All coordinate metadata uses the rendered page's top-left origin, in PDF points.
The fourth sample page is intentionally image-only and has no OCR/text layer.
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps
from pypdf import PdfReader, PdfWriter
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from reportlab.platypus import Paragraph


W, H = 612, 792
INK = colors.HexColor("#172C3C")
TEAL = colors.HexColor("#247C83")
MUTED = colors.HexColor("#5D6A72")
RULE = colors.HexColor("#CFDADD")
PALE = colors.HexColor("#EDF4F5")
FONT_DIR = Path("/usr/share/fonts/truetype/dejavu")


def register_fonts() -> None:
    names = {
        "SheetSans": "DejaVuSans.ttf",
        "SheetSansBold": "DejaVuSans-Bold.ttf",
        "SheetSerif": "DejaVuSerif.ttf",
    }
    for name, filename in names.items():
        path = FONT_DIR / filename
        if not path.is_file():
            raise RuntimeError(f"Required fixture font is missing: {path}")
        pdfmetrics.registerFont(TTFont(name, str(path)))
    pdfmetrics.registerFontFamily("SheetSans", normal="SheetSans", bold="SheetSansBold")
    pdfmetrics.registerFontFamily("SheetSerif", normal="SheetSerif", italic="SheetSerif")


def text(c, x, y, value, size=10, font="SheetSans", color=INK):
    """Draw at a top-left coordinate; y is the top of the font em box."""
    c.setFillColor(color)
    c.setFont(font, size)
    c.drawString(x, H - y - size, value)


def paragraph(c, x, y, width, value, size=10, leading=15, color=INK, font="SheetSans"):
    style = ParagraphStyle("fixture", fontName=font, fontSize=size, leading=leading, textColor=color)
    p = Paragraph(value, style)
    _, height = p.wrap(width, H)
    p.drawOn(c, x, H - y - height)
    return height


def line(c, x1, y1, x2, y2, color=RULE, width=0.7):
    c.setStrokeColor(color)
    c.setLineWidth(width)
    c.line(x1, H - y1, x2, H - y2)


def rect(c, x, y, width, height, fill=PALE, stroke=None, radius=0):
    c.setFillColor(fill or colors.white)
    c.setStrokeColor(stroke or colors.white)
    fn = c.roundRect if radius else c.rect
    args = [x, H - y - height, width, height]
    if radius:
        args.append(radius)
    fn(*args, stroke=int(stroke is not None), fill=int(fill is not None))


def circle(c, x, y, radius, stroke=TEAL, fill=None, width=1.3):
    c.setStrokeColor(stroke)
    c.setFillColor(fill or colors.white)
    c.setLineWidth(width)
    c.circle(x, H - y, radius, stroke=1, fill=int(fill is not None))


def fraction(c, x, y, numerator, denominator, size=16, width=74):
    c.setFillColor(INK)
    c.setFont("SheetSerif", size)
    c.drawCentredString(x + width / 2, H - y - size, numerator)
    line(c, x, y + size + 6, x + width, y + size + 6, color=INK, width=0.9)
    c.drawCentredString(x + width / 2, H - y - size * 2 - 11, denominator)


def equation(c, x, y, width, value, size=18):
    return paragraph(c, x, y, width, value, size=size, leading=size * 1.6, font="SheetSerif")


def integral(c, x, y, upper, lower, integrand, size=19):
    """Stack both limits at the same x coordinate rather than advancing inline."""
    text(c, x, y - 4, "∫", size * 1.7, "SheetSerif")
    text(c, x + size * 0.76, y - 6, str(upper), size * 0.6, "SheetSerif")
    text(c, x + size * 0.76, y + size + 5, str(lower), size * 0.6, "SheetSerif")
    equation(c, x + size * 1.55, y + 4, 420, integrand, size)


def writing_lines(c, x, y, width, count=2, gap=27):
    for n in range(count):
        line(c, x, y + n * gap, x + width, y + n * gap)


def question(c, number, title, x, y, width):
    text(c, x, y, f"{number}. {title}", 11.4, "SheetSansBold")
    line(c, x, y + 22, x + width, y + 22)


def header(c, page, title, subtitle, scanned=False):
    text(c, 44, 30, "NORTHSTAR  /  MATH LAB", 8.3, "SheetSansBold", TEAL)
    text(c, 44, 49, title, 24, "SheetSansBold")
    text(c, 44, 84, subtitle, 9.3, color=MUTED)
    text(c, 44, 109, "Name", 8.3, color=MUTED)
    line(c, 75, 121, 308, 121)
    text(c, 352, 109, "Date", 8.3, color=MUTED)
    line(c, 379, 121, 568, 121)
    line(c, 44, 137, 568, 137, color=TEAL, width=1.3)
    text(c, 44, 749, "Show your reasoning. Exact values are welcome.", 7.5, color=MUTED)
    text(c, 495, 749, f"{page}  /  4", 8, "SheetSansBold", MUTED)
    if scanned:
        text(c, 458, 31, "SCANNED COPY", 7.6, "SheetSansBold", MUTED)


def coordinate_plot(c, x, y, width, height):
    """Numbered plane with A(-2,1), B(3,4), and the connecting segment."""
    xmin, xmax, ymin, ymax = -3, 4, -1, 5
    def pt(a, b):
        return x + (a - xmin) / (xmax - xmin) * width, y + height - (b - ymin) / (ymax - ymin) * height
    for a in range(xmin, xmax + 1):
        ax, _ = pt(a, 0)
        line(c, ax, y, ax, y + height, width=0.35)
    for b in range(ymin, ymax + 1):
        _, by = pt(0, b)
        line(c, x, by, x + width, by, width=0.35)
    ax, ay = pt(0, 0)
    line(c, x, ay, x + width + 5, ay, MUTED, 0.8)
    line(c, ax, y - 5, ax, y + height, MUTED, 0.8)
    text(c, x + width + 5, ay - 8, "x", 8)
    text(c, ax + 5, y - 12, "y", 8)
    for a in [-2, -1, 1, 2, 3, 4]:
        px, py = pt(a, 0)
        text(c, px - 2, py + 4, str(a), 6.6, color=MUTED)
    for b in [1, 2, 3, 4, 5]:
        px, py = pt(0, b)
        text(c, px - 11, py - 4, str(b), 6.6, color=MUTED)
    a, b = pt(-2, 1), pt(3, 4)
    line(c, *a, *b, color=TEAL, width=1.8)
    for p, label, dx, dy in [(a, "A", -12, -15), (b, "B", 7, -15)]:
        circle(c, *p, 2.6, fill=TEAL)
        text(c, p[0] + dx, p[1] + dy, label, 8.5, "SheetSansBold", TEAL)


def page_one(c):
    header(c, 1, "Patterns, proofs & practice", "A mixed problem set for algebra, geometry, and early calculus")
    question(c, 1, "Rational equations", 44, 158, 524)
    paragraph(c, 44, 190, 524, "Solve the equation. State the excluded value and check your solution.")
    fraction(c, 95, 221, "3x − 2", "x + 1", width=83)
    text(c, 195, 232, "=", 19, "SheetSerif")
    text(c, 228, 232, "2 +", 19, "SheetSerif")
    fraction(c, 283, 221, "1", "x + 1", width=75)
    text(c, 393, 239, "x ≠ −1", 13, "SheetSerif", MUTED)
    writing_lines(c, 44, 291, 524, 1)

    question(c, 2, "Quadratic structure", 44, 326, 524)
    paragraph(c, 44, 358, 524, "Factor the function, identify its zeros, and write it in completed-square form.")
    equation(c, 73, 390, 470, "f(x) = x<super>2</super> − 6x + 5", 19)
    text(c, 44, 439, "Zeros:", 9.4)
    line(c, 88, 455, 278, 455)
    text(c, 324, 439, "Vertex:", 9.4)
    line(c, 373, 455, 568, 455)
    writing_lines(c, 44, 489, 524, 1)

    question(c, 3, "A line through two points", 44, 520, 524)
    paragraph(c, 44, 553, 260, "The diagram shows A(−2, 1) and B(3, 4).<br/><br/>(a) Find the slope of line AB.<br/>(b) Write an equation of line AB.<br/>(c) Find its y-intercept.", leading=17)
    coordinate_plot(c, 342, 565, 208, 139)
    writing_lines(c, 44, 666, 254, 2, 29)
    c.showPage()


def triangle(c, x, y):
    a, b, top = (x, y + 102), (x + 186, y + 102), (x + 119, y + 12)
    line(c, *a, *b, TEAL, 1.5)
    line(c, *a, *top, TEAL, 1.5)
    line(c, *b, *top, TEAL, 1.5)
    c.setDash(3, 3)
    line(c, top[0], top[1], top[0], b[1], MUTED, 0.8)
    c.setDash()
    line(c, top[0], b[1] - 8, top[0] + 8, b[1] - 8, MUTED)
    line(c, top[0] + 8, b[1] - 8, top[0] + 8, b[1], MUTED)
    text(c, x + 78, y + 110, "12 cm", 9)
    text(c, top[0] + 8, y + 53, "7 cm", 9)
    text(c, a[0] - 10, a[1] - 4, "A", 8)
    text(c, b[0] + 6, b[1] - 4, "B", 8)
    text(c, top[0] - 2, top[1] - 15, "C", 8)


def page_two(c):
    header(c, 2, "Reason across representations", "Work down each column. Label every unit and give exact answers where possible.")
    line(c, 306, 157, 306, 714, width=0.8)
    question(c, 4, "Area from a diagram", 44, 158, 248)
    paragraph(c, 44, 191, 248, "Find the area of triangle ABC. Explain which length is the perpendicular height.")
    triangle(c, 61, 237)
    writing_lines(c, 44, 386, 248, 1)

    question(c, 5, "Simplify with care", 44, 433, 248)
    paragraph(c, 44, 466, 248, "Simplify the expression and list all values excluded by the original denominator.")
    fraction(c, 102, 515, "x² − 9", "x² + 3x", 17, 108)
    writing_lines(c, 44, 598, 248, 4, 30)

    question(c, 6, "Accumulated change", 320, 158, 248)
    paragraph(c, 320, 191, 248, "Evaluate the definite integral. Show an antiderivative and your substitution.")
    integral(c, 342, 242, 2, 0, "(3x<super>2</super> + 1) dx", 18)
    writing_lines(c, 320, 314, 248, 3, 30)

    question(c, 7, "A small data story", 320, 433, 248)
    paragraph(c, 320, 466, 248, "Six students recorded the number of books they read in a month.")
    rect(c, 320, 510, 248, 39, fill=PALE, radius=4)
    text(c, 337, 522, "2     3     3     4     6     6", 13, "SheetSerif")
    paragraph(c, 320, 568, 248, "(a) Find the mean and median.<br/>(b) A seventh student read 11 books. Which measure changes more? Explain.", leading=17)
    writing_lines(c, 320, 657, 248, 2, 30)
    c.showPage()


def rate_graph(c, x, y, width=210, height=124):
    def pt(t, r):
        return x + t / 6 * width, y + height - r / 18 * height
    for t in [0, 2, 4, 6]:
        px, py = pt(t, 0)
        line(c, px, y, px, py, width=0.35)
        text(c, px - 2, py + 5, str(t), 7)
    for r in [0, 4, 8, 12, 16]:
        px, py = pt(0, r)
        line(c, px, py, x + width, py, width=0.35)
        text(c, px - 17, py - 4, str(r), 7)
    line(c, x, y + height, x + width + 7, y + height, MUTED, 0.9)
    line(c, x, y - 6, x, y + height, MUTED, 0.9)
    line(c, *pt(0, 4), *pt(6, 16), TEAL, 1.8)
    text(c, x + 36, y - 20, "R(t), litres/min", 8.3, color=MUTED)
    text(c, x + width - 44, y + height + 19, "t, minutes", 7.8, color=MUTED)


def page_three(c):
    header(c, 3, "Connect rates and totals", "Read the model carefully. Question 9 continues on the scanned fourth page.")
    question(c, 8, "A curve and its derivative", 44, 158, 524)
    paragraph(c, 44, 191, 524, "For g(x) = x<super>3</super> − 3x, find g′(x) and all stationary points. Then evaluate:")
    integral(c, 76, 231, 3, 1, "x<super>2</super> dx", 21)
    text(c, 281, 249, "Give the exact value as a fraction.", 9.6, color=MUTED)
    writing_lines(c, 44, 303, 524, 2, 30)

    question(c, 9, "A tank, a rate, and a decision", 44, 378, 524)
    paragraph(c, 44, 412, 524, "A tank initially contains 12 litres of water. Water enters at the rate R(t) = 4 + 2t litres per minute, where t is measured in minutes and 0 ≤ t ≤ 6. No water leaves the tank.", leading=16)
    rate_graph(c, 75, 514)
    paragraph(c, 331, 503, 237, "(a) Use the graph or an integral to find the amount of water added during the first 3 minutes.<br/><br/>Explain why your answer differs from the total water in the tank at t = 3.", leading=16)
    writing_lines(c, 331, 638, 237, 2, 29)
    rect(c, 44, 693, 524, 29, fill=PALE, radius=3)
    text(c, 57, 702, "Continue Question 9 on page 4. Keep the same tank model.", 9, "SheetSansBold", TEAL)
    c.showPage()


def page_four(c):
    header(c, 4, "Follow the flow", "A scanned supplement: continue the model, then solve the geometry question.", scanned=True)
    question(c, 9, "Tank model (continued)", 44, 158, 524)
    paragraph(c, 44, 193, 524, "Use R(t) = 4 + 2t litres per minute and the initial volume V(0) = 12 litres from page 3.")
    paragraph(c, 44, 235, 524, "(b) Write a formula for V(t), the total volume in the tank after t minutes.<br/><br/>(c) Find the first time the tank contains 60 litres. Check that your time lies within 0 ≤ t ≤ 6.", leading=17)
    writing_lines(c, 44, 333, 524, 4, 28)

    question(c, 10, "Geometry from a scan", 44, 462, 524)
    paragraph(c, 44, 497, 287, "A circle has radius 6 cm. A sector has central angle 60°.<br/><br/>(a) Find the length of the minor arc.<br/>(b) Find the area of the sector.<br/><br/>Give both answers in terms of π.", leading=17)
    cx, cy, radius = 455, 586, 75
    circle(c, cx, cy, radius)
    end = (cx + radius * 0.5, cy - radius * math.sqrt(3) / 2)
    line(c, cx, cy, cx + radius, cy, TEAL, 1.4)
    line(c, cx, cy, *end, TEAL, 1.4)
    c.setStrokeColor(TEAL)
    c.setLineWidth(0.9)
    c.arc(cx - 24, H - cy - 24, cx + 24, H - cy + 24, 0, 60)
    text(c, cx + 29, cy - 24, "60°", 10, "SheetSerif")
    text(c, cx + 27, cy + 7, "6 cm", 9.4)
    circle(c, cx, cy, 1.8, fill=TEAL)
    writing_lines(c, 44, 675, 287, 2, 27)
    c.showPage()


def new_canvas(path, size=(W, H)):
    c = canvas.Canvas(str(path), pagesize=size, pageCompression=1, invariant=1)
    c.setTitle("Northstar Math Lab - Original integration fixture")
    c.setAuthor("Worksheet Studio fixture generator")
    c.setSubject("Original math problems for crop, scan, rotation, and export testing")
    return c


def render_pdf(pdf, prefix, dpi=144, page=None):
    command = ["pdftoppm", "-png", "-r", str(dpi)]
    if page is not None:
        command += ["-f", str(page), "-l", str(page), "-singlefile"]
    command += [str(pdf), str(prefix)]
    subprocess.run(command, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return Path(str(prefix) + (".png" if page is not None else "-1.png"))


def region(number, page, box, title, content, kind="native"):
    x, y, width, height = box
    return {
        "id": f"q{number}" + ("-continued" if page == 4 and number == 9 else ""),
        "questionNumber": number,
        "page": page,
        "pageIndex": page - 1,
        "title": title,
        "kind": kind,
        "rectPt": {"x": x, "y": y, "width": width, "height": height},
        "rectNormalized": {"x": x / W, "y": y / H, "width": width / W, "height": height / H},
        "expectedContent": content,
    }


def build_manifest():
    regions = [
        region(1, 1, [40, 152, 532, 153], "Rational equations", ["3x − 2", "x + 1", "excluded value"]),
        region(2, 1, [40, 320, 532, 182], "Quadratic structure", ["f(x)", "Zeros", "Vertex"]),
        region(3, 1, [40, 514, 532, 202], "A line through two points", ["A(−2, 1)", "B(3, 4)", "slope", "coordinate diagram"]),
        region(4, 2, [40, 152, 256, 252], "Area from a diagram", ["triangle ABC", "12 cm", "7 cm"]),
        region(5, 2, [40, 427, 256, 286], "Simplify with care", ["x² − 9", "x² + 3x", "excluded"]),
        region(6, 2, [316, 152, 256, 252], "Accumulated change", ["definite integral", "3x", "antiderivative"]),
        region(7, 2, [316, 427, 256, 286], "A small data story", ["books", "mean", "median"]),
        region(8, 3, [40, 152, 532, 198], "A curve and its derivative", ["stationary points", "exact value", "fraction"]),
        region(9, 3, [40, 372, 532, 354], "A tank, a rate, and a decision", ["12 litres", "4 + 2t", "Continue Question 9 on page 4"]),
        region(9, 4, [40, 152, 532, 279], "Tank model (continued)", ["V(0) = 12", "60 litres", "0 ≤ t ≤ 6"], "scan"),
        region(10, 4, [40, 456, 532, 257], "Geometry from a scan", ["radius 6 cm", "60°", "sector", "π"], "scan"),
    ]
    return {
        "version": 1,
        "description": "Original deterministic fixtures. Rectangle origins are top-left, in displayed PDF coordinates.",
        "generator": "scripts/generate-fixtures.py",
        "sample": {
            "path": "public/samples/sample.pdf", "url": "/samples/sample.pdf", "pageCount": 4,
            "pages": [
                {"page": 1, "pageIndex": 0, "widthPt": W, "heightPt": H, "rotation": 0, "kind": "native", "questionIds": ["q1", "q2", "q3"]},
                {"page": 2, "pageIndex": 1, "widthPt": W, "heightPt": H, "rotation": 0, "kind": "native", "columns": 2, "questionIds": ["q4", "q5", "q6", "q7"]},
                {"page": 3, "pageIndex": 2, "widthPt": W, "heightPt": H, "rotation": 0, "kind": "native", "questionIds": ["q8", "q9"]},
                {"page": 4, "pageIndex": 3, "widthPt": W, "heightPt": H, "rotation": 0, "kind": "scan", "expectedExtractedText": "", "questionIds": ["q9-continued", "q10"]},
            ],
            "regions": regions,
            "multiPageQuestion": {"questionNumber": 9, "segments": ["q9", "q9-continued"], "expectedTitle": "A tank, a rate, and a decision"},
            "usefulManualCrop": "q10",
            "usefulNativeCrop": "q1",
            "readingOrder": [r["id"] for r in regions],
        },
        "cropUnits": "crops[].rect is normalized 0–1; crops[].rectPt and sample.regions[].rectPt are PDF points; every origin is top-left",
        "crops": [{"id": "q9-start" if r["id"] == "q9" else "q9-continuation" if r["id"] == "q9-continued" else r["id"], "page": r["page"], "pageIndex": r["pageIndex"], "rect": {"x": r["rectPt"]["x"] / W, "y": r["rectPt"]["y"] / H, "w": r["rectPt"]["width"] / W, "h": r["rectPt"]["height"] / H}, "rectPt": {"x": r["rectPt"]["x"], "y": r["rectPt"]["y"], "w": r["rectPt"]["width"], "h": r["rectPt"]["height"]}} for r in regions],
        "rotated": {"path": "public/samples/rotated.pdf", "url": "/samples/rotated.pdf", "pageCount": 1, "sourcePage": 1, "rotation": 90, "mediaBoxPt": {"width": W, "height": H}, "displaySizePt": {"width": H, "height": W}, "expectedContent": "Rational equations"},
        "oversize": {"path": "public/samples/oversize.pdf", "url": "/samples/oversize.pdf", "pageCount": 1, "widthPt": 1800, "heightPt": 5400, "expectedContent": "Oversized page rendering fixture", "markers": [{"label": "TOP / 01", "rectPt": {"x": 100, "y": 100, "width": 1600, "height": 180}}, {"label": "MIDDLE / 02", "rectPt": {"x": 100, "y": 2595, "width": 1600, "height": 180}}, {"label": "BOTTOM / 03", "rectPt": {"x": 100, "y": 5045, "width": 1600, "height": 180}}]},
        "image": {"path": "public/samples/example.png", "url": "/samples/example.png", "duplicatePath": "tests/fixtures/example.png", "widthPx": W * 2, "heightPx": H * 2, "expectedContent": "Patterns, proofs & practice"},
        "corrupt": {"path": "tests/fixtures/corrupt.pdf", "expectedResult": "Graceful error without losing existing worksheet state"},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    root = args.output_root.resolve()
    samples, test_fixtures = root / "public/samples", root / "tests/fixtures"
    samples.mkdir(parents=True, exist_ok=True)
    test_fixtures.mkdir(parents=True, exist_ok=True)
    register_fonts()
    with tempfile.TemporaryDirectory(prefix="worksheet-fixtures-") as temp_dir:
        temp = Path(temp_dir)
        native_path, scan_source_path = temp / "native.pdf", temp / "scan-source.pdf"
        c = new_canvas(native_path)
        page_one(c)
        page_two(c)
        page_three(c)
        c.save()
        c = new_canvas(scan_source_path)
        page_four(c)
        c.save()
        scan_png = render_pdf(scan_source_path, temp / "scan", page=1)
        with Image.open(scan_png) as img:
            scan = ImageOps.grayscale(img).convert("RGB")
        # Blend faint scanner texture so every original ink stroke stays intact.
        texture = Image.new("RGB", scan.size, "white")
        draw = ImageDraw.Draw(texture)
        for y in range(17, scan.height, 103):
            draw.line([(10, y), (scan.width - 10, y)], fill=(220, 220, 218), width=1)
        scan = Image.blend(scan, texture, 0.02)
        scan = Image.blend(scan, Image.new("RGB", scan.size, "#f3f1e9"), 0.025)
        scan.save(scan_png)
        raster_path = temp / "scan-image-only.pdf"
        c = new_canvas(raster_path)
        c.drawImage(ImageReader(scan), 0, 0, W, H, mask="auto")
        c.showPage()
        c.save()
        writer = PdfWriter()
        writer.append(native_path)
        writer.append(raster_path)
        writer.add_metadata({"/Title": "Northstar Math Lab - Patterns, proofs & practice", "/Author": "Worksheet Studio", "/Subject": "Original 4-page mixed native/scanned worksheet fixture"})
        sample_path = samples / "sample.pdf"
        with sample_path.open("wb") as target:
            writer.write(target)
        sample_reader = PdfReader(sample_path)
        assert len(sample_reader.pages) == 4
        assert sample_reader.pages[3].extract_text().strip() == "", "Scan must contain no text layer"
        for index in range(3):
            assert len(sample_reader.pages[index].extract_text()) > 100
        rotated_writer = PdfWriter()
        rotated_writer.add_page(sample_reader.pages[0])
        rotated_writer.pages[0].rotate(90)
        with (samples / "rotated.pdf").open("wb") as target:
            rotated_writer.write(target)
        c = new_canvas(samples / "oversize.pdf", (1800, 5400))
        c.setFillColor(INK)
        c.setFont("SheetSansBold", 50)
        c.drawString(100, 5240, "Oversized page rendering fixture")
        c.setFont("SheetSans", 30)
        c.drawString(100, 5160, "TOP / 01     Solve x² − 5x + 6 = 0 and explain both roots.")
        c.setStrokeColor(RULE)
        c.setLineWidth(2)
        for y in range(450, 5000, 190):
            c.line(100, y, 1700, y)
        for baseline, label, formula in [(2690, "MIDDLE / 02", "2. Evaluate the integral of 2x from 0 to 3."), (240, "BOTTOM / 03", "3. Draw a right triangle with hypotenuse 13 cm.")]:
            c.setFillColor(PALE)
            c.rect(100, baseline - 35, 1600, 150, fill=1, stroke=0)
            c.setFillColor(INK)
            c.setFont("SheetSansBold", 34)
            c.drawString(130, baseline + 45, label)
            c.setFont("SheetSans", 30)
            c.drawString(130, baseline - 5, formula)
        c.setFont("SheetSans", 20)
        c.drawString(100, 100, "1800 × 5400 PDF points · Tall page with top, middle, and bottom markers")
        c.showPage()
        c.save()
        image_path = render_pdf(sample_path, temp / "example", page=1)
        shutil.copyfile(image_path, samples / "example.png")
        shutil.copyfile(image_path, test_fixtures / "example.png")
    (test_fixtures / "corrupt.pdf").write_bytes(b"%PDF-1.7\n% Intentionally truncated integration fixture\n1 0 obj\n<< /Type /Catalog /Pages 99 0 R >>\nendobj\n")
    manifest_path = test_fixtures / "manifest.json"
    manifest_path.write_text(json.dumps(build_manifest(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"created": [str(samples / name) for name in ["sample.pdf", "rotated.pdf", "oversize.pdf", "example.png"]], "manifest": str(manifest_path), "samplePages": 4, "scanPage": 4}, indent=2))


if __name__ == "__main__":
    main()
