# Question extraction and optional AI formatting

Local question suggestions propose **crop rectangles**. Review each rectangle against the source page before adding it. Source crops preserve visible content, including the original fonts, boldness, line breaks, equations, and diagrams. A good number match does not prove that a crop contains the whole question. Manual prose reflow and optional AI formatting use separate review workflows.

## Optional whole-problem AI formatting

Select the whole problem in one crop, or use **Format with AI** on a saved problem to include its original regions, up to six at once. **Generate with AI** sends the selected images and any saved text to OpenAI through a localhost helper. Fresh PDF crops are sent as images; existing saved text regions can also supply text hints. The proposal separates prose from mathematical or diagram regions without requiring a manual split first.

The app renders proposed prose as normal text and takes image regions from the original content. Review the worksheet PDF beside the originals. **Adjust text or image boundaries** allows text, crop, order, and content-type corrections; **Update preview** rebuilds the PDF locally before **Add problem** or **Replace problem** can apply the edited proposal. Original pixels in an image region do not guarantee that its proposed bounds include every symbol. **Restore original** restores the formatted card's original regions and settings; formatting it again also starts from those original regions.

AI-formatted problems use 100% scale and continuation mode. New problems retain remembered writing-height and page-break defaults, and replacements preserve those values from the selected card. Proposed prose is rendered at the current printable width; later paper or margin changes require **Edit text** and **Save text** to rewrap saved prose.

`src/ai-plan.js` defines a strict plan of prose blocks and original-image rectangles, with normalized top-left bounds and explicit source indices. It permits at most 24 blocks across six sources, with 6,000 characters per text block and 16,000 total text characters. The prompt asks for original wording, labels, reading order, and complete-once coverage, without solving or rewriting the problem. Validation checks shape, limits, and bounds; it cannot prove that the content is complete or faithful.

Images sent for recognition are local previews limited to a 1,600-pixel longest side and two megapixels, without upscaling. Retained math and diagram regions are cropped from the original PNG pixels, not these smaller previews. Crop boundaries round to source pixels, preserving the crop's original print scale and proportions. No AI-generated mathematical image is used.

AI image input does not require a PDF text layer, but recognition and region selection can be wrong. Live model quality, latency, and cost have not been verified because the recorded checks used no live API key. Mock-response tests verify integration behavior, not model accuracy. See [local AI setup](../README.md#optional-ai-formatting).

## Numbered-question suggestions

For PDFs with a usable text layer, `detectQuestions(items, pageWidth, pageHeight)` consumes positioned text runs from PDF.js. PDF.js exposes text content, dimensions, and transformation matrices; it does not supply a worksheet-specific question model. See the [PDF.js TextItem API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html#~TextItem) and [PDFPageProxy.getTextContent](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFPageProxy.html#getTextContent).

The local heuristic:

1. Discards invalid/off-page text boxes and exact duplicate text runs.
2. Groups nearby baselines and joins adjacent runs so a separately drawn `1`, `.`, and prompt can still be recognized.
3. Looks for line-start `1.`, `2)`, `Question 3`, or `Problem 4:` labels. It rejects ordinary decimals, adjacent inline references, and parenthesized equation labels such as `(2)`.
4. Groups similar left edges, favors the outer question margin over indented numbered subparts, and looks for increasing question numbers. A single explicit heading or a single left-margin numbered prompt can also be suggested.
5. Permits a second well-separated column when the text geometry supports it. Text crossing the proposed gutter blocks that split.
6. Returns normalized top-left rectangles in column reading order: left column from top to bottom, then right column. Crops stop above the next detected question in that column. The last crop reaches the page bottom, and the final column reaches the right page edge, because diagrams and answer space may have no text-layer bounds.

No OCR, model inference, external API, API key, or file upload is used for this detection. Image imports and image-only scanned PDFs receive no automatic suggestions. A scanned PDF that already contains an OCR text layer may produce suggestions from that existing layer; its recognition errors still need review.

## Reflow selected prose

Select only prose directions and choose **Reflow selected text**. For a PDF with usable text, the selected area's text layer supplies an editable draft. Review the words, symbols, punctuation, and reading order, choose **New problem** or **Append to selected problem**, then confirm with **Add problem** or **Append text**. The reviewed draft becomes normal-weight text wrapped to the current paper's printable width before card scaling, without copying the source paragraph's boldness and fixed line wraps. **Edit text** reopens a saved text region, and **Save text** confirms its changes.

`extractRegionText(items, rect)` reads selected runs row by row, from top to bottom and left to right, and joins ordinary line wraps. A run with at least half its box inside the selection is retained whole; individual characters cannot be clipped reliably from its box. Boundary cuts, possible columns, mixed baselines, and line-end hyphens produce review warnings. Exact duplicate runs are removed, and explicit hyphens are kept rather than silently corrected.

A new reflowed problem uses 100% scale and continuation mode, retaining the remembered writing-height and page-break defaults. Appending and editing preserve the existing problem's settings, so check its scale before judging the result. Ordinary pasted-text problems keep the usual inherited defaults. Images and scans with no usable text open a blank review dialog for manual entry and do not run OCR.

Text is rendered when saved. Later paper or margin changes do not automatically rewrap that image; use **Edit text** and **Save text** to regenerate it for the new printable width.

Keep equations and diagrams as source crops. After adding the prose, select the original mathematical content and press **Q** to append it to the same problem. Existing source crops are not automatically rewritten or removed. Remove or recrop any duplicate directions after checking the replacement.

This is plain-text reflow, not mathematical interpretation or typesetting. PDF text layers can omit symbols, separate superscripts from their bases, or return columns in the wrong order. A selectable text layer does not guarantee correct extraction. Review against the source, and retain complex notation as an image crop. Exported text regions are raster images, even though their text remains editable during the current session.

## Review and manual fallback

Drag a manual crop when no useful suggestions appear. Adjust crop bounds to include a whole graph, fraction, radical, prompt, and required subparts. Remove unrelated headings, neighboring questions, footers, and excess answer space. For a question spanning pages, collect the required regions into one question. Check their order in the output preview.

The detector intentionally supports ordinary one- and two-column worksheets rather than arbitrary page segmentation. It can miss lettered or Roman-numeral questions, unusual punctuation, tiny or rotated text, inconsistent left edges, right-only layouts, three columns, numbering resets, or a numbered prompt without accompanying text. A numbered instruction list can look exactly like a question list. It cannot reliably tell these apart from text geometry alone. Dense mathematics, tables, shared diagrams, and mixed full-width/column layouts need manual crops. An undetected question between two detected ones may be included in the earlier crop. Row-wise numbering in two columns may need reordering.

The last crop may include a footer. A question whose diagram extends above its number or into the adjacent column may need a wider/taller manual crop. An extraction label is only a short navigation aid; it is never substituted for the original page content.

## Local manual tools and networked AI

Question suggestions and **Reflow selected text** use the existing PDF text layer and local geometry rules. These manual tools need no model, inference API, account, or key. The standalone HTML embeds its PDF libraries and supporting resources and supports the manual workflow offline. Scanned pages without a text layer remain available through manual crops and typed prose.

**Format with AI** is a separate optional OpenAI integration. It requires the localhost helper and a server-side API key. Selected images and text leave the computer when **Generate with AI** is used. Keep the key out of the browser, generated HTML, and repository.

## Validation

Run `node --test tests/detection.test.mjs`. The tests cover standard labels, split PDF runs, two-column geometry, subparts, inline references, decimals, duplicate text, invalid inputs, crop bounds, and coordinate scaling. An integration test extracts actual PDF.js text from the bundled sample: its three native pages yield 3, 4, and 2 suggestions, and its image-only scan yields none. These tests validate behavior on known examples, not a general extraction accuracy rate. Real source pages and every suggested crop still require visual review.

The prose extractor has a separate suite at `tests/text-extraction.test.mjs`, included in `npm test`; `npm run test:text` exercises the manual review-to-export workflow in a browser. `tests/ai-plan.test.mjs` checks the pure AI proposal contract, while `npm run test:ai` uses mocked helper responses for browser integration and checks the offline setup fallback. See [testing notes](testing.md) for recorded results and the distinction between mocked integration and live inference.
