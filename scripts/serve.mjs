import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
const prod = process.argv.includes('--dist');
const root = resolve(prod ? 'dist' : '.');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.pdf': 'application/pdf', '.png': 'image/png', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.bcmap': 'application/octet-stream', '.ttf': 'font/ttf', '.pfb': 'application/octet-stream' };
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || 'localhost';
const server = createServer(async (req, res) => {
  try {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
    let path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (path === '/' || path === '/index.html') path = prod ? '/index.html' : '/src/index.html';
    if (!prod) {
      if (path.startsWith('/vendor/pdfjs/')) path = path.replace('/vendor/pdfjs/', '/node_modules/pdfjs-dist/');
      else if (path === '/vendor/pdf-lib.min.js') path = '/node_modules/pdf-lib/dist/pdf-lib.min.js';
      else if (path.startsWith('/samples/')) path = `/public${path}`;
    }
    const target = resolve(root, `.${path}`);
    if (!target.startsWith(root + sep) || path.split('/').some(p => p.startsWith('.')) || (!prod && !/^\/(index\.html|styles\.css|src\/|public\/samples\/|node_modules\/(pdfjs-dist|pdf-lib)\/)/.test(path))) {
      res.writeHead(403); return res.end('Forbidden');
    }
    if (!(await stat(target)).isFile()) throw new Error('Not a file');
    const data = await readFile(target);
    res.writeHead(200, { 'Content-Type': types[extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch { res.writeHead(404); res.end('Not found'); }
});
server.listen(port, host, () => console.log(`Margin running at http://${host}:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
