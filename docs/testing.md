# Testing Margin

These commands are for source development and verification. Using the distributed `margin.html` requires only a supported browser; Node.js, npm, Playwright, and a local server are not runtime requirements for that file.

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
```

`test:e2e` covers the complete crop-to-PDF workflow. `test:ui` runs `tests/preferences-shortcuts.e2e.mjs` for the preferences and keyboard-shortcut regression checks.

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

The browser suite uses Playwright. Running the application in an existing browser does not require a Playwright browser download. If the test browser is unavailable, install Chromium matching the pinned Playwright dependency:

```bash
npx playwright install chromium
```

On a Linux host missing browser system libraries, Playwright's `--with-deps` installation option also installs operating-system dependencies and may require elevated privileges.

Browser checks write screenshots, downloaded PDFs, and `e2e-results.json` to the mode's output directory. The report records the executed steps, browser errors, and network activity, including worker requests. These are generated test artifacts rather than application inputs.

## Test fixtures

The bundled questions and diagrams are original synthetic material generated locally. Fixtures include a text PDF, a raster-only scanned page without an OCR layer, a tall page, a rotated page, an image, and a deliberately corrupt PDF. `tests/fixtures/manifest.json` records the expected crop coordinates used by browser checks.

Fixtures are included in the project; Python is not needed to run the app or its tests. Regeneration is optional:

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
- Change writing height, scale, paper, margins, title, name/date line, manual page breaks, and overflow mode. Check continuation labels, preserved blank space, and warnings for small or oversized content.
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

## Recorded results

Checks were run on 2026-10-19 using Node.js 24.19.0 and Playwright 1.56.1 with headless Chromium 141, against both the source app and the rebuilt standalone HTML.

| Check | Result |
| --- | --- |
| `npm test` | **57 tests passed:** 15 detection, 30 layout, and 12 preference tests. Layout coverage includes 400 seeded cases; detection includes extraction from the sample PDF. |
| Source `npm run test:e2e` | **12 workflow stages passed**, with no runtime errors, failed requests, or external requests. All 13 exported pages matched independent PDF.js renderings pixel for pixel. |
| Source `npm run test:ui` | **8 focused stages passed**, with 12 exported pages inspected for geometry and numbering, and no runtime errors or external requests. |
| Offline HTML `test:e2e` | **12 workflow stages passed** through `file://` with browser networking disabled. All 13 exported pages matched their previews; zero HTTP/HTTPS requests or runtime errors occurred. |
| Offline HTML `test:ui` | **8 focused stages passed**, including shared-column geometry, optional numbering, saved preferences, shortcut safeguards, resets, and storage failures. Zero HTTP/HTTPS requests or runtime errors occurred. |
| `npm run build` | Regenerated identical root and `dist/` standalone HTML files, approximately 7.71 MiB each, with the PDF resources, sample, and license notices embedded. |

The focused UI suite verified:

- P/Q and uppercase shortcuts, plus protection for typing, dialogs, modified/repeated keys, saved-crop editing, preview, and busy processing.
- Defaults inherited by keyboard, button, suggestion, and pasted-text creation; existing cards remain independent.
- Preferences restored after reload while source files and problem cards remain unsaved; scale and settings resets affect the intended values.
- Safe editing with corrupt preferences, denied storage access, and exhausted storage quota.
- Three unequal crops across two pages sharing one centered column based on the widest final crop, including a source crop reduced by **Fit to one page**. Left alignment changes only the shared horizontal position; image bytes, dimensions, aspect ratios, and pagination remain unchanged.
- Remembered optional numbering, off by default with no initial label reserve; additional sequential labels when enabled and neutral **Continued** labels when disabled. Both numbering modes preserve a requested 10 inches of writing space across continuation pages.

The full workflow suite also covered manual scans, multipage questions, reorder/remove/edit controls, source images and Unicode text, preview invalidation, oversized continuation and fit modes, corrupt-file recovery, rotated A4 output, the sample, and a 390-pixel-wide layout. The 13 checked pages comprise a 3-page worksheet, its 4-page revision, 3-page overflow, 1-page shrink, 1-page PNG export, and 1-page rotated A4 export.

Source evidence is in `tests/output/e2e-results.json` and `tests/output/preferences/preferences-shortcuts-results.json`; offline reports use the corresponding `tests/output/offline/` and `tests/output/preferences-offline/` directories. The focused suite writes `centered.pdf`, `left-aligned.pdf`, `numbered.pdf`, `numeric-continuation.pdf`, and `unnumbered-continuation.pdf`, containing 12 pages in total. Actual PDF inspection confirmed that alignment and added labels preserve every embedded crop image. The offline workflow audit recorded only local file and blob resources, including blob workers.

Coverage is limited to Chromium in this environment. Physical printing and other browser engines were not tested. PNG import/export was exercised end to end; JPEG/WebP, password handling, every size-limit boundary, arbitrary damaged PDFs, and complex raster-image patterns need broader coverage. Known examples do not establish universal extraction accuracy or print legibility.

## Manual print review

Automated layout checks cannot establish the legibility of every possible mathematical source. For a worksheet intended for distribution, inspect the generated PDF at 100% and print a representative page at **Actual size**. Low-resolution scans, tiny source notation, missing system-font glyphs in pasted text, and crops split through content require a source or layout adjustment.

## Distribution layout

The development template lives at `src/index.html`; the root `index.html` and `margin.html` are identical standalone distributions. `LICENSE` remains the repository's original MIT license and is also embedded in the HTML notices.
