# Releasing Show Your Work

Requirements: Node.js 22.3.0 or newer, npm, Python 3, Git.

1. Keep the version in `package.json` aligned with `package-lock.json`. Select the matching `vX.Y.Z` tag.
2. Install the locked development dependencies with `npm ci`.
3. Run `npm test`, install the browser with `npx playwright install chromium`, then run:

   ```bash
   npm run test:e2e -- samples/sample.pdf 2,3,5,10,12,17,19,22,26,29,34
   ```

   Confirm the selection matches, a PDF downloads successfully, its pages open, plus no application errors appear.
4. Commit the release changes. Run `npm run release:package` from that commit. The generated `version.json` records the commit. The ZIP includes the entry point, source modules, PDF libraries, dependency licenses, sample PDF, local server, plus a minimal package manifest. Build outputs stay outside Git.
5. Extract the ZIP into a fresh directory. Run `npm start` there without installing dependencies; load the sample, then download the PDF.
6. Push the release commit to `main`. Create the matching tag at that exact commit. Publish a GitHub release with the ZIP, `SHA256SUMS`, release notes, test results, plus relevant limitations.

The packaging script sorts entries, fixes ZIP timestamps, records file permissions, rejects symlinks, plus emits SHA-256 checksums. Rebuilding an unchanged commit produces the same ZIP.

OCR assets plus the optional local AI model require network downloads. The model needs WebGPU. Keep these requirements in the release notes; a packaged app is not a fully offline OCR/model bundle.
