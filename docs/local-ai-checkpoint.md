# Local AI checkpoint

Work paused at the user's request on 2026-10-19 UTC. This branch is a source checkpoint, not a finished release.

## Implemented

- Replaced the cloud AI helper with local Ollama at `http://localhost:11434`, defaulting to the Apache 2.0-licensed `qwen3-vl:4b-instruct` model.
- No API key, remote endpoint, cloud fallback, automatic model download, or inference retry.
- Installed vision-model checks, rejection of cloud metadata, structured output validation, cancellation, ten-minute inference timeout, and bounded requests/responses.
- Context truncation and shifting disabled; tiny or extremely narrow source images receive an adjustment message.
- Updated local setup guidance and added **Check Ollama again** without losing the current selection.
- Preserved editable proposal review, original image crops, exact preview/export, restore original, and offline manual tools.
- Added the opt-in `npm run test:ai:local` command and local setup documentation.

## Verification at pause

- Source syntax checks and one HTML build passed before the final backend safeguards landed.
- The first backend mock run passed 35 of 36 tests. Its sole failure was a test message regex, subsequently corrected. The final file now has 39 tests; those final edits have not been run.
- The stopped-Ollama smoke check failed promptly with the expected actionable message and exit code 1.
- Updated browser tests are prepared. The source run completed two stages (missing-runtime recovery and whole-selection review without inference), then was interrupted at the user's pause request. Six source stages remain; packaged HTTP and offline runs were not started.
- No real model inference has been performed. The environment has no installed Ollama model and limited available memory. Mock integration checks do not establish transcription accuracy or performance.

## Resume

1. Run `npm test`, resolve any failures, then `npm run build`.
2. Run `npm run test:ai` for source HTTP, packaged HTTP (`E2E_DIST=1`), and offline HTML (`BASE_URL` set to the absolute file URL). Inspect the generated PDF artifacts and confirm original mathematical pixels and writing space remain intact.
3. Record actual counts and limitations in `docs/testing.md`. Run real local inference only on a computer with Ollama and the downloaded model available.
4. Review the diff, regenerate both standalone HTML distributions, and publish the finished revision to `main`.

The committed root `index.html` and `margin.html` on this checkpoint branch remain the previous release's generated files. All source changes needed to reproduce the new HTML are saved; `npm run build` regenerates both. Local generated copies may already contain the new interface. Do not use the checkpoint's committed HTML to judge the new local-AI setup until rebuilding.
