// Folds the production build into one self-contained file, export/index.html, that can be
// opened directly from disk or sent to someone. Run with `npm run build:single`.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const asset = (ref) => join(dist, 'assets', basename(ref.replace(/["']/g, '')));

let html = await readFile(join(dist, 'index.html'), 'utf8');

const cssTag = html.match(/<link[^>]+rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/);
const jsTag = html.match(/<script[^>]+src="([^"]+)"[^>]*><\/script>/);
if (!cssTag || !jsTag) throw new Error('dist/index.html does not look like a fresh build; run `vite build` first.');

let css = await readFile(asset(cssTag[1]), 'utf8');
const fonts = [...new Set([...css.matchAll(/url\(([^)]+\.woff2)\)/g)].map((m) => m[1]))];
for (const ref of fonts) {
  const data = (await readFile(asset(ref))).toString('base64');
  css = css.split(`url(${ref})`).join(`url(data:font/woff2;base64,${data})`);
}

// A literal closing tag inside the script would end the inline element early.
const js = (await readFile(asset(jsTag[1]), 'utf8')).replace(/<\/script/gi, '<\\/script');

html = html.replace(cssTag[0], () => `<style>${css}</style>`);
html = html.replace(jsTag[0], () => `<script type="module">${js}</script>`);

const out = join(root, 'export', 'index.html');
await mkdir(dirname(out), { recursive: true });
await writeFile(out, html);
console.log(`${out}: ${(Buffer.byteLength(html) / 1024).toFixed(0)} kB`);
