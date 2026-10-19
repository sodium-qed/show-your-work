import { createServer } from 'node:http';
import { readFile, stat, realpath } from 'node:fs/promises';
import { resolve, extname, sep, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAiService, OLLAMA_TIMEOUT_MS, OLLAMA_METADATA_TIMEOUT_MS } from './ai-service.mjs';
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.pdf': 'application/pdf', '.png': 'image/png', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.bcmap': 'application/octet-stream', '.ttf': 'font/ttf', '.pfb': 'application/octet-stream' };

export function loadOptionalEnv(directory = process.cwd()) {
  try { process.loadEnvFile(resolve(directory, '.env')); return true; }
  catch (error) {
    if (error.code === 'ENOENT') return false;
    throw new Error('The optional .env file could not be read. Check its permissions and syntax.');
  }
}

export function createWorksheetServer({ prod = false, root = resolve(prod ? 'dist' : '.'), host = 'localhost', env = process.env, fetchImpl = globalThis.fetch, timeoutMs = OLLAMA_TIMEOUT_MS, metadataTimeoutMs = OLLAMA_METADATA_TIMEOUT_MS } = {}) {
  root = resolve(root);
  const ai = createAiService({ env, host, fetchImpl, timeoutMs, metadataTimeoutMs });
  return createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (await ai(req, res, path)) return;
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
    if (path === '/' || path === '/index.html') path = prod ? '/index.html' : '/src/index.html';
    if (!prod) {
      if (path.startsWith('/vendor/pdfjs/')) path = path.replace('/vendor/pdfjs/', '/node_modules/pdfjs-dist/');
      else if (path === '/vendor/pdf-lib.min.js') path = '/node_modules/pdf-lib/dist/pdf-lib.min.js';
      else if (path.startsWith('/samples/')) path = `/public${path}`;
    }
    const target = resolve(root, `.${path}`);
    const forbidden = value => value.split(/[\\/]/).some(p => p.startsWith('.') || p === 'scripts' || p === 'tests');
    const allowed = prod ? /^\/(index\.html$|styles\.css$|src\/|samples\/|vendor\/)/ : /^\/(styles\.css$|src\/|public\/samples\/|node_modules\/(pdfjs-dist|pdf-lib)\/)/;
    if (!target.startsWith(root + sep) || forbidden(path) || !allowed.test(path)) {
      res.writeHead(403); return res.end('Forbidden');
    }
    const actualRoot = await realpath(root), actualTarget = await realpath(target);
    if (!actualTarget.startsWith(actualRoot + sep) || forbidden(relative(actualRoot, actualTarget))) { res.writeHead(403); return res.end('Forbidden'); }
    if (!(await stat(target)).isFile()) throw new Error('Not a file');
    const data = await readFile(target);
    res.writeHead(200, { 'Content-Type': types[extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch { res.writeHead(404); res.end('Not found'); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  loadOptionalEnv();
  const port = Number(process.env.PORT || 4173), host = process.env.HOST || 'localhost';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid local server port.');
  const server = createWorksheetServer({ prod: process.argv.includes('--dist'), host });
  server.listen(port, host, () => console.log(`Margin running at http://${host}:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}
