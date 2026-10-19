import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';

// Build one portable file without a bundler or runtime network dependencies.
// The library version is pinned; checked replacements fail on upstream changes.
const text = path => readFile(path, 'utf8');
const base64 = async path => (await readFile(path)).toString('base64');
const pack = value => Buffer.from(value).toString('base64');
function replaceOnce(source, needle, replacement) {
  if (source.split(needle).length !== 2) throw new Error(`Expected exactly one build anchor: ${needle}`);
  return source.replace(needle, replacement);
}
const assets = {};
const notices = [`Show Your Work (MIT)\n${await text('LICENSE')}`];
for (const directory of ['cmaps', 'standard_fonts', 'wasm']) {
  for (const name of (await readdir(`node_modules/pdfjs-dist/${directory}`)).sort()) {
    const path = `node_modules/pdfjs-dist/${directory}/${name}`;
    if (/LICENSE/i.test(name)) notices.push(`${directory}/${name}\n${await text(path)}`);
    else assets[`${directory}/${name}`] = await base64(path);
  }
}
notices.unshift(`PDF.js (Apache-2.0)\n${await text('node_modules/pdfjs-dist/LICENSE')}`,
  `PDF-Lib (MIT)\n${await text('node_modules/pdf-lib/LICENSE.md')}`);
notices.push('Offline adaptation: this build supplies embedded resources to PDF.js binary readers and its JavaScript JPEG2000 fallback. Original licenses are retained above.');

let worker = await text('node_modules/pdfjs-dist/build/pdf.worker.mjs');
worker = replaceOnce(worker, 'async function fetchBinaryData(url) {', 'async function fetchBinaryData(url) {\n  const embedded = marginReadAsset(url);\n  if (embedded) return embedded;');
worker = replaceOnce(worker, 'function fetchSync(url) {', 'function fetchSync(url) {\n  const embedded = marginReadAsset(url);\n  if (embedded) return embedded.buffer;');
worker = replaceOnce(worker, 'const path = `${this.#wasmUrl}openjpeg_nowasm_fallback.js`;',
  'const path = this.#wasmUrl.startsWith("margin-asset:") ? marginModuleAsset("wasm/openjpeg_nowasm_fallback.js") : `${this.#wasmUrl}openjpeg_nowasm_fallback.js`;');
worker = worker.replace(/^\/\/# sourceMappingURL=.*$/gm, '');
const modules = {
  pdfjs: await base64('node_modules/pdfjs-dist/build/pdf.mjs'),
  worker: pack(worker),
  layout: await base64('src/layout.js'),
  detection: await base64('src/detection.js'),
  preferences: await base64('src/preferences.js'),
  engine: await base64('src/pdf-engine.js'),
  app: await base64('src/app.js'),
};
const payload = { modules, assets, sample: await base64('public/samples/sample.pdf') };

// Embedded data is JSON/base64, never executable user content. Only checked
// first-party source and the pinned PDF libraries form the module graph.
const bootstrap = String.raw`
const main = document.querySelector('main');
main.inert = true;
try {
  const payload = JSON.parse(document.getElementById('margin-bundle').textContent);
  const bytes = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
  const decode = value => new TextDecoder().decode(bytes(value));
  const moduleURL = value => URL.createObjectURL(new Blob([value], { type: 'text/javascript' }));
  const pdfjsURL = moduleURL(decode(payload.modules.pdfjs));
  const layoutURL = moduleURL(decode(payload.modules.layout));
  const detectionURL = moduleURL(decode(payload.modules.detection));
  const preferencesURL = moduleURL(decode(payload.modules.preferences));
  const workerPrefix = 'const marginAssets = ' + JSON.stringify(payload.assets) + ';\n' +
    'function marginReadAsset(url) { if (typeof url !== "string" || !url.startsWith("margin-asset:/")) return null; const key=url.slice("margin-asset:/".length); const encoded=marginAssets[key]; if (!encoded) throw new Error("Missing embedded PDF resource: "+key); return Uint8Array.from(atob(encoded), c=>c.charCodeAt(0)); }\n' +
    'function marginModuleAsset(key) { return URL.createObjectURL(new Blob([marginReadAsset("margin-asset:/"+key)], {type:"text/javascript"})); }\n';
  const workerURL = moduleURL(workerPrefix + decode(payload.modules.worker));
  const pdfOptions = { cMapUrl: 'margin-asset:/cmaps/', standardFontDataUrl: 'margin-asset:/standard_fonts/', wasmUrl: 'margin-asset:/wasm/', useWorkerFetch: true };
  globalThis.MARGIN_EMBEDDED = { pdfjsURL, workerURL, pdfOptions, sample: bytes(payload.sample) };
  const engineURL = moduleURL(decode(payload.modules.engine)
    .replace("'/vendor/pdfjs/build/pdf.mjs'", JSON.stringify(pdfjsURL))
    .replace("'./layout.js'", JSON.stringify(layoutURL))
    .replace("'./detection.js'", JSON.stringify(detectionURL)));
  const appURL = moduleURL(decode(payload.modules.app)
    .replace("'./pdf-engine.js'", JSON.stringify(engineURL))
    .replace("'./layout.js'", JSON.stringify(layoutURL))
    .replace("'./preferences.js'", JSON.stringify(preferencesURL)));
  await import(appURL);
  const download = document.getElementById('download-html');
  if (location.protocol !== 'file:') {
    download.href = './margin.html';
    download.hidden = false;
  }
  document.body.dataset.bundleReady = 'true';
} catch (error) {
  const notice = document.getElementById('notice');
  notice.textContent = 'Unable to start this HTML file. Use a current Chrome, Edge, or Firefox browser. ' + error.message;
  notice.classList.add('error'); notice.hidden = false;
  console.error(error);
} finally { main.inert = false; }
`;
let html = await text('src/index.html');
html = replaceOnce(html, '<link rel="stylesheet" href="/styles.css">', `<style>${await text('styles.css')}</style>`);
html = replaceOnce(html, '<script src="/vendor/pdf-lib.min.js" defer></script>', '');
html = replaceOnce(html, '<script type="module" src="/src/app.js"></script>', '');
const escapeScript = value => value.replace(/<\//g, '<\\/');
const escapeText = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
html = replaceOnce(html, '</body>', [
  `<script type="text/plain" id="third-party-notices">${escapeText(notices.join('\n\n'))}</script>`,
  `<script id="margin-pdf-lib">${escapeScript(await text('node_modules/pdf-lib/dist/pdf-lib.min.js'))}</script>`,
  `<script type="application/json" id="margin-bundle">${JSON.stringify(payload).replaceAll('<', '\\u003c')}</script>`,
  `<script type="module">${bootstrap}</script>`,
  '</body>',
].join('\n'));
await mkdir('dist', { recursive: true });
await writeFile('dist/index.html', html);
await writeFile('dist/margin.html', html);
await writeFile('index.html', html);
await writeFile('margin.html', html);
console.log(`Built standalone HTML: ${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MiB; PDF engine, worker, ${Object.keys(assets).length} resources, and sample included.`);
