// Build samples/sample.pdf: an original two-column-free exercise page with a student's
// green highlighter circles and one yellow highlighter swipe. Run: npm run sample
import { PDFDocument, StandardFonts, rgb, BlendMode } from 'pdf-lib';
import { writeFile, mkdir } from 'node:fs/promises';

const doc = await PDFDocument.create();
doc.setTitle('Sample exercises');
const page = doc.addPage([612, 792]);
const H = 792;
const roman = await doc.embedFont(StandardFonts.TimesRoman);
const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
const italic = await doc.embedFont(StandardFonts.TimesRomanItalic);
const sans = await doc.embedFont(StandardFonts.HelveticaBold);
const ink = rgb(0.1, 0.1, 0.12);
const text = (s, x, y, font = roman, size = 10, color = ink) => page.drawText(s, { x, y: H - y, size, font, color });

text('SECTION 4.2  Lines, Distance, and Polar Points', 300, 40, sans, 9, rgb(0.15, 0.25, 0.55));
text('4.2 Exercises', 54, 74, sans, 15, rgb(0.75, 0.3, 0.1));
page.drawLine({ start: { x: 54, y: H - 80 }, end: { x: 558, y: H - 80 }, thickness: 1, color: rgb(0.75, 0.3, 0.1) });
text('Skill Building', 54, 104, sans, 12, rgb(0.15, 0.25, 0.55));

const cols = [58, 186, 314, 442];
const sections = [
  { dir: 'In Problems 1–8, solve each equation for x.', items: ['3x + 5 = 20', '2(x - 4) = 10', '7 - x = 3x + 1', 'x/3 + 2 = 6', '5x - 9 = 2x + 6', '0.4x = 1.6', '6 = 2(3 - x)', '9x + 4 = 4x - 11'] },
  { dir: 'In Problems 9–16, graph each line on a coordinate grid.', items: ['y = 2x - 1', 'y = -x + 3', 'y = (1/2)x', 'x = 4', 'y = -2', '2x + y = 4', 'y = 3x + 2', 'x - y = 1'] },
  { dir: 'In Problems 17–24, plot each point given in polar coordinates.', items: ['(3, 45°)', '(2, 120°)', '(-1, 30°)', '(4, 270°)', '(2.5, 210°)', '(-3, 300°)', '(1, 0°)', '(5, 150°)'] },
  { dir: 'In Problems 25–32, find the distance between the two points.', items: ['(1, 2) and (4, 6)', '(0, 0) and (5, 12)', '(-2, 3) and (1, -1)', '(6, 6) and (6, -2)', '(-3, -4) and (0, 0)', '(2, 7) and (8, -1)', '(1.5, 2) and (4.5, 6)', '(-1, -1) and (2, 3)'] },
];
let y = 128, n = 1;
const anchors = {};
for (const s of sections) {
  text(s.dir, 54, y, italic, 10);
  y += 20;
  for (let r = 0; r < s.items.length; r += 4) {
    for (let c = 0; c < 4 && r + c < s.items.length; c++) {
      text(`${n}.`, cols[c], y, bold, 10);
      text(s.items[r + c], cols[c] + bold.widthOfTextAtSize(`${n}.`, 10) + 5, y, roman, 10);
      anchors[n] = { x: cols[c], y };
      n++;
    }
    y += 26;
  }
  y += 10;
}
text('Applications', 54, y + 6, sans, 12, rgb(0.15, 0.25, 0.55));
y += 30;
const word = [
  '33. A ladder leans against a wall. Its foot is at (0, 0) and its top touches the wall at',
  '      (0, 12). The wall is 5 feet from the foot of the ladder. How long is the ladder?',
  '34. A drone starts at the origin and flies to the point with polar coordinates (40, 60°).',
  '      Find its rectangular coordinates, to the nearest tenth of a meter.',
];
word.forEach((line, i) => {
  const [num, ...rest] = line.split(/(?<=^\d+\.)/);
  if (/^\d+\.$/.test(num)) { text(num, 58, y, bold, 10); text(rest.join('').trimStart(), 78, y, roman, 10); anchors[+num] = { x: 58, y }; }
  else text(line.trim(), 78, y, roman, 10);
  y += i % 2 ? 22 : 13;
});

// The student's marks: green circles on some numbers, one yellow swipe across a problem.
const green = rgb(0.80, 0.93, 0.36), yellow = rgb(1, 0.95, 0.35);
for (const k of [2, 3, 5, 10, 12, 17, 19, 22, 26, 29, 34]) {
  const a = anchors[k];
  page.drawEllipse({ x: a.x + 6.5, y: H - a.y + 3.4, xScale: 9.5, yScale: 8.5, color: green, blendMode: BlendMode.Multiply });
}
page.drawRectangle({ x: anchors[31].x - 3, y: H - anchors[31].y - 4, width: 112, height: 14, color: yellow, blendMode: BlendMode.Multiply });
text('Page 212', 54, 760, roman, 8);

await mkdir('samples', { recursive: true });
await writeFile('samples/sample.pdf', await doc.save());
console.log('samples/sample.pdf written; expected yellow 31; green', [2, 3, 5, 10, 12, 17, 19, 22, 26, 29, 34].join(','));
