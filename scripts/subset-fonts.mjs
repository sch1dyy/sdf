// Builds the tiny font subsets in src/assets/fonts from the glyphs the page actually uses.
// Re-run with `npm run fonts` after changing any on-screen text.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import subsetFont from 'subset-font';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const outDir = join(root, 'src/assets/fonts');

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])),
  );
  return files.flat().filter((f) => /\.(ts|html)$/.test(f));
}

const sources = [join(root, 'index.html'), ...(await walk(join(root, 'src')))];
const text = (await Promise.all(sources.map((f) => readFile(f, 'utf8')))).join('');
const wide = [...new Set([...text].filter((ch) => ch.codePointAt(0) > 0x2000))].sort().join('');
const ascii = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('');

const fontFile = (pkg, file) => join(dirname(require.resolve(`${pkg}/package.json`)), 'files', file);

const jobs = [
  [fontFile('@fontsource/shippori-mincho', 'shippori-mincho-japanese-500-normal.woff2'), 'shippori-mincho-500.woff2', wide],
  [fontFile('@fontsource/dotgothic16', 'dotgothic16-japanese-400-normal.woff2'), 'dotgothic16-jp.woff2', wide],
  [fontFile('@fontsource/dotgothic16', 'dotgothic16-latin-400-normal.woff2'), 'dotgothic16-latin.woff2', ascii],
];

await mkdir(outDir, { recursive: true });
for (const [source, name, glyphs] of jobs) {
  const output = await subsetFont(await readFile(source), glyphs, { targetFormat: 'woff2' });
  await writeFile(join(outDir, name), output);
  console.log(`${name}: ${[...glyphs].length} glyphs, ${output.length} bytes`);
}
