# Question extraction

The app suggests **crop rectangles**, not rewritten mathematics. Review each rectangle against the source page before adding it. The rendered source crop supplies the question's visible content, including equations and diagrams. A good number match does not prove that a crop contains the whole question.

## What is implemented

For PDFs with a usable text layer, `detectQuestions(items, pageWidth, pageHeight)` consumes positioned text runs from PDF.js. PDF.js exposes text content, dimensions, and transformation matrices; it does not supply a worksheet-specific question model. See the [PDF.js TextItem API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html#~TextItem) and [PDFPageProxy.getTextContent](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFPageProxy.html#getTextContent).

The local heuristic:

1. Discards invalid/off-page text boxes and exact duplicate text runs.
2. Groups nearby baselines and joins adjacent runs so a separately drawn `1`, `.`, and prompt can still be recognized.
3. Looks for line-start `1.`, `2)`, `Question 3`, or `Problem 4:` labels. It rejects ordinary decimals, adjacent inline references, and parenthesized equation labels such as `(2)`.
4. Groups similar left edges, favors the outer question margin over indented numbered subparts, and looks for increasing question numbers. A single explicit heading or a single left-margin numbered prompt can also be suggested.
5. Permits a second well-separated column when the text geometry supports it. Text crossing the proposed gutter blocks that split.
6. Returns normalized top-left rectangles in column reading order: left column from top to bottom, then right column. Crops stop above the next detected question in that column. The last crop reaches the page bottom, and the final column reaches the right page edge, because diagrams and answer space may have no text-layer bounds.

No OCR, model inference, external API, API key, or file upload is used for this detection. Image imports and image-only scanned PDFs receive no automatic suggestions. A scanned PDF that already contains an OCR text layer may produce suggestions from that existing layer; its recognition errors still need review.

## Review and manual fallback

Drag a manual crop when no useful suggestions appear. Adjust crop bounds to include a whole graph, fraction, radical, prompt, and required subparts. Remove unrelated headings, neighboring questions, footers, and excess answer space. For a question spanning pages, collect the required regions into one question. Check their order in the output preview.

The detector intentionally supports ordinary one- and two-column worksheets rather than arbitrary page segmentation. It can miss lettered or Roman-numeral questions, unusual punctuation, tiny or rotated text, inconsistent left edges, right-only layouts, three columns, numbering resets, or a numbered prompt without accompanying text. A numbered instruction list can look exactly like a question list. It cannot reliably tell these apart from text geometry alone. Dense mathematics, tables, shared diagrams, and mixed full-width/column layouts need manual crops. An undetected question between two detected ones may be included in the earlier crop. Row-wise numbering in two columns may need reordering.

The last crop may include a footer. A question whose diagram extends above its number or into the adjacent column may need a wider/taller manual crop. An extraction label is only a short navigation aid; it is never substituted for the original page content.

## No AI or OCR dependency

Question suggestions use only the existing PDF text layer and local geometry rules. No model, inference API, account, token, or AI download is present. The standalone HTML embeds its PDF libraries and supporting resources, and works offline after download. Scanned pages without a text layer remain available through manual selection.

## Validation

Run `node --test tests/detection.test.mjs`. The tests cover standard labels, split PDF runs, two-column geometry, subparts, inline references, decimals, duplicate text, invalid inputs, crop bounds, and coordinate scaling. An integration test extracts actual PDF.js text from the bundled sample: its three native pages yield 3, 4, and 2 suggestions, and its image-only scan yields none. These tests validate behavior on known examples, not a general extraction accuracy rate. Real source pages and every suggested crop still require visual review.
