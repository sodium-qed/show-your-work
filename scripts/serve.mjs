// Minimal static server for local development and tests: npm start → http://localhost:4173
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.wasm': 'application/wasm', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.ttf': 'font/ttf', '.svg': 'image/svg+xml' };
export function createStaticServer(root = resolve(new URL('..', import.meta.url).pathname)) {
  return createServer(async (req, res) => {
    try {
      let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (path.endsWith('/')) path += 'index.html';
      const file = resolve(root, `.${path}`);
      if (!file.startsWith(root + sep) || /[\\/]\.|node_modules/.test(path)) { res.writeHead(403); return res.end(); }
      if (!(await stat(file)).isFile()) throw new Error();
      res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(await readFile(file));
    } catch { res.writeHead(404); res.end('Not found'); }
  });
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 4173);
  createStaticServer().listen(port, 'localhost', () => console.log(`Show Your Work: http://localhost:${port}`));
}
