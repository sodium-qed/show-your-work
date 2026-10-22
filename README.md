# Show Your Work

Drop in the textbook pages you marked up. Every highlighted problem is pulled out, the highlighter is cleaned off, and the problems are laid out as a plain exam sheet with room to work: no titles, no names, no logos. Everything runs in your browser; nothing is uploaded and there is no API key.

![Show Your Work](docs/screenshot.png)

## Three ways to pick problems

- **Highlights.** Highlighter colors are detected from circles around numbers, swipes across a problem, and ticks beside a label, including pale green and thin circles. A connected swipe can select several marked questions without selecting untouched questions inside its bounding rectangle. Each color gets a chip (`Green 23`, `Orange 6`); the most-used color is selected when the file opens. Clicking a chip selects only that color; Shift-click adds a color. The selected numbers stay visible above the preview.
- **Numbers.** Type `11, 13, 15–21 odd`, `41–56 even`, or `第23题和第25题`. A standalone list/range or an explicit `only`, `select`, or `只要` list replaces the numbered selection. For example, `只要15, 17, 19, 23, 27, 29, 31, 33, 37, 39, 41` requests exactly those 11 labels and removes previously selected numbers after 41. Use `add` or `remove` for an incremental change; unnumbered drawn boxes stay selected.
- **Draw.** Drag a box around anything the finder missed. The box is trimmed to the ink.

Click any boxed problem on the page to add or remove it.

If a visible problem has no box, choose **Read page visually** above the source page, then enter its number again. This rereads the page image with OCR while preserving selected problems and drawn boxes. A PDF with readable prose but missing problem labels can be cross-checked visually automatically. Native PDF text is retained where it is reliable; visual reading adds independently observed missing content. Difficult math scans get a second reading of the exercise-number columns. If the reader download fails, the page stays available and the same button retries it.

## The request box

Type what you want in plain English or Chinese:

> 请帮我把所有绿色的问题全部都提取出来……紧凑一些。一页double side。

becomes *23 green problems · 2 sides · fill the page*. Other examples: `remove 47 and 49`, `two columns, lots of room`, `polar grids for the plotting problems`, `A4`, `skip the directions`.

Requests are read instantly by a rule reader. Choose **Use local AI** to add a small language model, [Qwen3.5-0.8B](https://huggingface.co/onnx-community/Qwen3.5-0.8B-Text-ONNX), running in the browser on WebGPU with [Transformers.js](https://huggingface.co/docs/transformers.js). It downloads once (about 470 MB) and is cached. Without WebGPU the rule reader keeps working on its own. The model handles phrasing the rules don't know ("print it on European paper", "put three problems on each line"); every field it proposes is checked against the words in your request, so it can't invent problem numbers or change settings you didn't mention. The rule reader passes all 28 requests in `tests/agent.eval.mjs`; separate regression tests cover exact bilingual lists, mixed layout requests, and unsupported model proposals.

Explicit lists and ranges always use the rule reader, even with Local AI on. For example, `1–50, omit (1, 2, 6, 7, 9, 12, 15, 16, 19, 20, 22, 42), look at all pages` requests exactly 38 exercises across the loaded pages. Source-page scope does not change the number of printed sides. Selection waits for queued page reading. If some requested labels are missing, the app selects the detected subset and lists the missing labels; if none are found, it keeps the previous selection. A chosen manual crop takes precedence over the automatic crop for that exercise. When a file repeats a number in Quick Review and its main exercises, number requests prefer the main exercise.

Local AI interprets the request text. Page reading uses the PDF text layer and neural OCR; the language model does not inspect page images. Layout analysis checks the exercise columns, rows, directions, and figures before creating crops.

If local AI inference stalls or its worker crashes, requests fall back to the rule reader. A failed model can be retried. Graph dimensions and page counts are not interpreted as question numbers; model-suggested ranges cannot invent numbers between explicitly listed endpoints.

## What the exam looks like

- Problems are the original pixels from the page, so every fraction, radical and figure is exactly as printed. Problem numbers line up on one baseline per row.
- Problems are grouped under their directions, with the "In Problems 11–18," prefix removed. Shared figures (the A/B/C/D graph for a matching set) come along once per group.
- Work areas follow the directions: polar grids, coordinate planes, complex planes with Re/Im axes, number lines, and answer lines. Ruled lines and dot grids are also available from each group's menu, alongside blank space and (a)/(b)/(c) lines.
- Graph ranges adapt to readable coordinates and common polar amplitudes instead of stopping at 3. Tick spacing remains readable for large numbers, with negative coordinates labeled. The range reader is a heuristic, not a symbolic equation solver: use each group's **Range ±** or **Radius** field to override it, or clear the field to return to automatic sizing. Requests such as `complex planes, radius 10` also set the range.
- New sessions default to **Fewest** pages and **Compact** spacing, preserving natural text size and tightening margins and gaps. **Save paper** applies this preset to existing saved settings. Export is disabled while the revised PDF is being built, so an old selection cannot be downloaded accidentally.
- **Pages** fits the sheet to 1, 2 (one sheet, double-sided), 3 or 4 sides, scaling problems between 75% and 125% and sharing the leftover room as writing space. **Fewest** uses as few sides as possible.
- Colored print (orange problem numbers, cyan arrows) is turned into dark gray for black-and-white printing.

## How it works

| Step | Where | How |
| --- | --- | --- |
| Read the page | `src/textlayer.js`, `src/document.js`, `src/ocr.js` | PDF text layer through PDF.js (with bold / italic / math-font detection). Scans, photos, and PDFs without detected problem numbers use [tesseract.js](https://github.com/naptha/tesseract.js) at 300 dpi with highlighter removed first. Visual reading cross-checks partial text layers; math scans use targeted number-column rereads. |
| Find problems | `src/analyze.js` | Printed problem numbers, aligned plain exercise labels, directions lines (`In Problems 11–18, …`, `Exer. 43–44: …`), headings, and which text belongs to which problem, from word geometry. Separates independently staggered columns, retains tall formulas, and follows text around owned figures. Explicit review and exercise headings distinguish repeated numbering. |
| Find marks and figures | `src/raster.js`, `src/document.js` | Highlighter strokes: light, single-hue blobs that survive a morphological close/open. Printed fills with matching diagram outlines are excluded from highlights. Figures combine non-text ink with native PDF image bounds, preserving pale illustration edges. The bundled JPEG2000 decoder renders embedded images. Crops grow to include fraction bars and radicals that touch the text. |
| Lay out | `src/layout.js` | Columns, baseline alignment, work aids and fitting to a page count. Pure functions, unit-tested. |
| Draw the PDF | `src/render-pdf.js` | pdf-lib. Polar and Cartesian grids are vector drawings. |
| Read requests | `src/rules.js`, `src/agent*.js` | Rule reader, local model in a Web Worker, and the evidence check that combines them. |

## Run it

### Download a release

Download `show-your-work-1.1.0.zip` from [GitHub Releases](https://github.com/sodium-qed/show-your-work/releases/latest), extract the complete folder, then run `npm start` inside it with Node.js 22.3.0 or newer. Open `http://localhost:4173`. The release includes the PDF libraries; no `npm install` is needed. Keep the extracted files together; opening `index.html` directly does not support the app's module loading.

### Run from source

It's a static site. Open the hosted copy, or run it locally:

```bash
npm install
npm start          # http://localhost:4173
```

Any static host works (GitHub Pages: Settings → Pages → Deploy from branch → `main` / root). PDF.js and pdf-lib are committed in `vendor/` (`npm run vendor` refreshes them). Tesseract.js, Transformers.js and the model weights load from public CDNs only when a page needs OCR or you turn on the local AI.

### Build a release

`npm run build` stages the complete runnable app in `dist/show-your-work-1.1.0/`. `npm run release:package` also creates the ZIP plus `dist/SHA256SUMS` (Python 3 required for packaging). Build from the release commit so `version.json` records its source revision. See [the release checklist](docs/RELEASING.md).

## Tests

```bash
npm test                                   # unit tests: numbers, request reader, page analysis, layout
npx playwright install chromium            # once
npm run test:e2e -- samples/sample.pdf 2,3,5,10,12,17,19,22,26,29,34
npm run test:selection                     # plain/split/glued labels, loading, missing-number feedback, PDF download
npm run test:ranges                        # exact ranges, exclusions, manual crops, review/main selection
npm run test:ocr                           # real browser OCR, incomplete text layers, download failure and retry (network required)
npm run test:scan                          # raster math, exact even selection, complete/exclusive crop pixels
npm run test:images                        # bundled image decoder, complete pale figures, PDF export
npm run test:workspace                     # color replacement, work aids, ranges, compact layout, PDF labels
node tests/ai.e2e.mjs                      # local model in the browser (WebGPU; see the file for a CPU stand-in)
node tests/agent.eval.mjs rules            # request box scores; see the file for model runs
```

`npm run sample` regenerates `samples/sample.pdf`, an original exercise page with green circles and one yellow swipe.

## Limits

- Problems are found from their printed numbers (`12.`, `12)`) or plain labels supported by aligned numbering and exercise directions. Ambiguous numbers, lettered problems, or unnumbered prompts may need **Draw**.
- Photos should be reasonably flat and lit; strongly skewed pages may confuse OCR.
- Pages over 80 per file are not read.

MIT licensed.
