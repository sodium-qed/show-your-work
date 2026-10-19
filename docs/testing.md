# Testing Margin

These commands are for source development and verification. Manual use of the distributed `margin.html` requires only a supported browser. Optional AI formatting requires the localhost Node server, Ollama, and a downloaded local vision model; it is not available from the offline file alone. It requires no API key.

## Automated checks

Install project dependencies with Node.js 22 or later:

```bash
npm ci
```

Run the Node test suite:

```bash
npm test
```

Run browser integration checks:

```bash
npm run test:e2e
npm run test:ui
npm run test:text
npm run test:ai
```

`test:e2e` covers the complete crop-to-PDF workflow. `test:ui` runs `tests/preferences-shortcuts.e2e.mjs` for preferences and keyboard shortcuts. `test:text` runs `tests/reflow-text.e2e.mjs` for reviewed prose, mixed text/image problems, text editing, and manual entry when no text layer is available. `test:ai` runs `tests/ai-format.e2e.mjs` with mocked AI responses; its integration checks require no Ollama installation or model download and run no real inference.

By default, the suite starts a local source server at `http://localhost:4173` when none is already running, and stops any server it starts. It can reuse an existing server. `BASE_URL` selects another target. An HTTP target whose hostname is not `localhost` must already be running; a `file://` target runs without a server and disables browser network access. `BROWSER_EXECUTABLE` optionally selects an installed Chromium executable.

Build the HTML before testing its packaged modes:

```bash
npm run build
```

Run `npm run test:e2e` with the appropriate environment configuration:

| Mode | Configuration | Default artifacts |
| --- | --- | --- |
| Source over HTTP | No additional variables | `tests/output/` |
| Standalone HTML offline | Set `BASE_URL` to the absolute `file://` URL of `dist/margin.html` or `dist/index.html` | `tests/output/offline/` |
| Packaged HTML over HTTP | Set `E2E_DIST=1`; optionally set `E2E_OUTPUT=tests/output/bundled` | `tests/output/`, or the specified directory |

`E2E_OUTPUT` overrides the artifact directory in any mode. Stop an existing source server before using `E2E_DIST=1`, so the suite starts the intended built-site server rather than reusing the source server.

`npm run test:ui` accepts the same target and browser variables. Its default output is `tests/output/preferences/`, or `tests/output/preferences-offline/` for a file target. Results are written to `preferences-shortcuts-results.json` with PDF and screenshot artifacts.

`npm run test:text` also accepts these variables. Its output defaults to `tests/output/text/`, or `tests/output/text-offline/` for a file target, with results in `reflow-text-results.json`.

`npm run test:ai` uses the same target variables. Source and packaged HTTP runs intercept helper endpoints with deterministic responses; a file target instead checks local setup guidance and manual export with networking disabled. Default artifacts are `tests/output/ai/`, `tests/output/ai-bundled/`, or `tests/output/ai-offline/`, respectively, with results in `ai-format-results.json`.

The browser suite uses Playwright. Running the application in an existing browser does not require a Playwright browser download. If the test browser is unavailable, install Chromium matching the pinned Playwright dependency:

```bash
npx playwright install chromium
```

On a Linux host missing browser system libraries, Playwright's `--with-deps` installation option also installs operating-system dependencies and may require elevated privileges.

Browser checks write screenshots, downloaded PDFs, and a results report to the mode's output directory. The main workflow report is `e2e-results.json`; the focused suites use the filenames above. Reports record executed steps, browser errors, and network activity, including worker requests. These are generated test artifacts rather than application inputs.

## Optional real-model check

After following the [local AI setup](../README.md#optional-ai-formatting), keep Ollama running and run:

```bash
npm run test:ai:local
```

This opt-in command uses the already installed model and local computing resources. It starts a temporary localhost helper, submits the original synthetic `public/samples/example.png`, and validates the returned plan. Only a successful response writes `tests/output/local-ai/plan.json`. It never starts Ollama or downloads weights. A successful run checks the connection and plan structure; review the prose and crop bounds separately to assess accuracy.

## Test fixtures

The bundled questions and diagrams are original synthetic material generated locally. Fixtures include a text PDF, a raster-only scanned page without an OCR layer, a tall page, a rotated page, an image, and a deliberately corrupt PDF. `tests/fixtures/manifest.json` records the expected crop coordinates used by browser checks.

The separate `tests/fixtures/reflow.pdf` contains dense bold directions and an equation; `reflow.json` records its original prose, crop bounds, and typography. These checked-in reflow assets are not regenerated by the command below.

`tests/fixtures/ai-plan.json` contains a deterministic proposal for the same synthetic material. It is test data, not a recorded live model response or an accuracy benchmark.

Fixtures are included in the project; Python is not needed to run the app or its tests. Regenerating the core fixtures is optional:

```bash
python3 scripts/generate-fixtures.py
```

The generator requires Python 3.10 or later, `reportlab`, `pypdf`, and `Pillow`, plus `pdftoppm` on `PATH`. Its current font configuration expects DejaVu Sans regular/bold and DejaVu Serif under `/usr/share/fonts/truetype/dejavu`, so another operating system may require adapting those font paths. PDF metadata is generated deterministically.

## Review checklist

These checks describe the intended verification scope. A listed check is not a claim that it has passed; the recorded results below distinguish executed checks from remaining review.

- Import a normal text PDF, a scan-only PDF, and each supported image format. Reject unsupported, corrupt, password-protected, and over-limit inputs with a useful message.
- Navigate a multipage source, switch between source files, draw a crop, drag it, resize it, and edit its percentage coordinates. Confirm cropped content matches the visible source.
- Append a continuation from another page or file to an existing problem. Reorder and remove both problems and individual regions, then edit an existing crop.
- Review numbered-text suggestions on single-column and multicolumn PDFs. Confirm scans remain available for manual selection without an OCR promise.
- Add pasted text with Unicode math, line breaks, and long lines. Verify rendering stays within the crop and unsupported typesetting syntax is not presented as parsed math.
- Select only prose directions in a text PDF and use **Reflow selected text**. Review the extracted draft against the selection, correct symbols and reading order, and confirm normal-weight text wraps to the current paper's printable width before scaling. Check new-problem and append targets, cancellation, saved-region **Edit text**, and preview regeneration after edits. Verify new reflow starts at 100% with continuation while retaining writing-height/page-break defaults; pasted text inherits ordinary defaults, and append/edit preserves existing card settings.
- Change paper size or margins after saving text. Confirm existing text remains a saved image, then use **Edit text** and **Save text** to regenerate wrapping at the new printable width.
- Append the original equation or diagram crop with **Q** after adding reviewed prose. Confirm its pixels and proportions remain intact and ordinary crop behavior is unchanged. For images and scans without usable text, check the manual typing path without implying OCR or automatic math typesetting.
- Change writing height, scale, paper, margins, title, name/date line, manual page breaks, and overflow mode. Check continuation labels, preserved blank space, and warnings for small or oversized content.
- Verify **Balanced** is the default **Page spacing** choice and shares spare page room evenly below complete problems while retaining at least the requested writing height. Compare **Compact** for exact requested spacing. Confirm both modes keep crop dimensions, page count, and manual page breaks unchanged, and pages containing continuing problems retain exact spacing. Cover single-problem and final pages, zero requested writing space, and saved/reset spacing preferences.
- Exercise **P** to add a crop and **Q** to append to a selected problem. Confirm neither shortcut activates while typing, a dialog is open, processing is busy, preview is active, or a saved crop is being edited.
- Change problem defaults and worksheet preferences, then reload. Verify preferences return while imported files and question cards do not. Confirm **Reset saved settings** preserves existing card settings and **Reset to 100%** updates the intended problem.
- Check that **Centered** gives different-width crops one shared left edge based on the widest final crop, while **Left aligned** places that edge at the margin. Confirm alignment leaves crop dimensions and internal padding unchanged.
- Verify **Add worksheet numbers** defaults off and is remembered. With it off, check preserved source numbers, no initial label reserve, and neutral **Continued** labels. With it on, check additional sequential numbers without altering the source crop.
- Check plain generated worksheet fonts, unchanged source-crop appearance, and usable desktop/mobile scrolling.
- Preview and export the worksheet, then edit it and export again. Confirm each export reflects current state and the preview uses the exported PDF bytes.
- Inspect the downloaded PDF for page dimensions, complete question content, sensible pagination, and readable notation at actual print size.
- Build the static output and load it through `npm run preview`. Confirm PDF rendering, its worker, font assets, the sample, and export work without CDN requests.
- Open the standalone HTML through `file://` with network access disabled. Exercise its embedded sample, imported PDF/image, text input, crop controls, preview, and PDF download. Confirm no external HTTP requests or missing-asset errors occur.
- Check the interface at desktop and narrow viewport widths, keyboard operation of form controls, clear disabled states, and useful empty/error states.
- With a mocked AI helper, select a whole crop or a saved problem with multiple regions. Confirm opening the review does not request model inference; **Generate with AI** submits only the selected images/text. Inspect the proposed PDF, edit prose and bounds, update the preview locally, then add or replace the problem and exercise **Restore original**.
- Verify AI cancellation, unavailable Ollama, missing models, inference failures, and malformed proposals leave existing work usable. Reject text-only models, cloud model names/metadata, and remote endpoint configuration before submitting source content. Confirm the standalone/manual workflow remains usable without AI or network access.

## AI test scope

The verification environment has no Ollama installation or GPU and had approximately 1.6 GB available memory, so the default 4B model has not been run here. `test:ai` intercepts the browser's local helper requests with deterministic responses. `tests/ai-service.test.mjs` separately injects mock Ollama responses into the real local server. These checks cover integration behavior, not live formatting quality, mathematical recognition accuracy, latency, or model memory requirements.

The Node suites check the proposal contract and backend request limits, origin restrictions, local model validation, inference failures, cancellation, timeouts, and static-file restrictions. Browser checks cover the review controls, original-image preservation, exact preview/export, replacement, and restoration.

## Recorded results

Verification of the local Ollama revision is pending. Earlier provider-integration results are not counted as checks of this revision. Current results will be recorded after the updated suites run.

| Check | Result |
| --- | --- |
| `npm test` | Current run pending. |
| Source `npm run test:ai` | Current mocked Ollama run pending. |
| Packaged HTTP `test:ai` | Current mocked Ollama run pending. |
| Offline HTML `test:ai` | Current fallback/manual run pending. |
| Manual workflow regressions | Current run selection and results pending. |
| `npm run build` | Current build result pending. |
| `npm run test:ai:local` | The unavailable-Ollama path correctly exited with status 1 and a clear instruction to start Ollama. No real-model inference was run. |

The README illustration is a previously visually reviewed **manual prose-reflow** example using synthetic material. It demonstrates normal-weight prose and preserved source math, not live AI formatting quality.

Coverage is limited to Chromium in this environment. Physical printing and other browser engines were not tested. PNG import/export is covered end to end; JPEG/WebP, password handling, every size-limit boundary, arbitrary damaged PDFs, and complex raster-image patterns need broader coverage. Known examples do not establish universal extraction accuracy or print legibility.

## Manual print review

Automated layout checks cannot establish the legibility of every possible mathematical source. For a worksheet intended for distribution, inspect the generated PDF at 100% and print a representative page at **Actual size**. Low-resolution scans, tiny source notation, missing system-font glyphs in pasted text, and crops split through content require a source or layout adjustment.

## Distribution layout

The development template lives at `src/index.html`; the root `index.html` and `margin.html` are identical standalone distributions. `LICENSE` remains the repository's original MIT license and is also embedded in the HTML notices.
