// Stage the complete static app using only Node's built-in modules.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (pkg.name !== 'show-your-work' || !/^\d+\.\d+\.\d+(?:-[\da-z.-]+)?(?:\+[\da-z.-]+)?$/i.test(pkg.version)) {
  throw new Error('Expected the show-your-work package with a valid release version.');
}
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
if (!/^[\da-f]{40}$/.test(sourceCommit)) throw new Error('Could not determine the source commit.');
const output = join(root, 'dist', `show-your-work-${pkg.version}`);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const entry of ['index.html', 'styles.css', 'src', 'vendor', 'samples/sample.pdf', 'scripts/serve.mjs', 'LICENSE']) {
  const destination = join(output, entry);
  await mkdir(dirname(destination), { recursive: true });
  await cp(join(root, entry), destination, { recursive: true });
}
const manifest = {
  name: pkg.name,
  version: pkg.version,
  private: true,
  type: 'module',
  description: pkg.description,
  engines: { node: '>=22.3.0' },
  license: 'MIT',
  scripts: { start: 'node scripts/serve.mjs' },
};
await writeFile(join(output, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(join(output, 'version.json'), `${JSON.stringify({ name: pkg.name, version: pkg.version, sourceCommit }, null, 2)}\n`);
await writeFile(join(output, 'README.md'), `# Show Your Work ${pkg.version}

Turn highlighted textbook problems into a printable exam with room for working.

## Run locally

1. Extract the ZIP and keep the complete folder together.
2. Install Node.js 22.3.0 or later.
3. Open a terminal in this folder and run:

\`\`\`bash
npm start
\`\`\`

Open http://localhost:4173 in a modern browser. No package installation or API key is needed. Stop the server with Ctrl+C.

Serve the app over HTTP or HTTPS; opening index.html by double-click does not support its JavaScript modules. The folder can also be uploaded intact to a static web host.

## Included features

- Select problems by highlighter color, number/range, or a drawn box.
- Preserve printed math and figures while removing highlighter from the output.
- Choose page count, columns, paper size and writing space, then download or print a PDF.
- Use the bundled sample PDF to try the app.
- Use Read page visually above a source page to recover missing number labels or retry a failed text-reader download, then enter the requested numbers again.

PDF libraries, fonts, character maps and their license files are bundled. Textbook files are processed locally in the browser. OCR for scans, photos, or incomplete PDF text layers and the optional local AI require external downloads. Local AI additionally requires WebGPU; the rule-based request reader works without it. This is not a fully offline package.

Source and development instructions: https://github.com/sodium-qed/show-your-work

Release provenance is recorded in version.json. MIT licensed; dependency licenses are retained under vendor/.
`);
console.log(`Built ${output}`);
