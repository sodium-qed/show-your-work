// Copy the pinned browser builds of PDF.js and pdf-lib into vendor/ (committed, so the
// site runs from any static host such as GitHub Pages with no build step).
import { cp, mkdir, rm } from 'node:fs/promises';

await rm('vendor', { recursive: true, force: true });
await mkdir('vendor/pdfjs', { recursive: true });
for (const f of ['pdf.min.mjs', 'pdf.worker.min.mjs']) await cp(`node_modules/pdfjs-dist/build/${f}`, `vendor/pdfjs/${f}`);
for (const d of ['cmaps', 'standard_fonts', 'wasm']) await cp(`node_modules/pdfjs-dist/${d}`, `vendor/pdfjs/${d}`, { recursive: true });
await cp('node_modules/pdfjs-dist/LICENSE', 'vendor/pdfjs/LICENSE');
await cp('node_modules/pdf-lib/dist/pdf-lib.esm.min.js', 'vendor/pdf-lib.esm.min.js');
await cp('node_modules/pdf-lib/LICENSE.md', 'vendor/pdf-lib.LICENSE.md');
console.log('vendor/ updated');
