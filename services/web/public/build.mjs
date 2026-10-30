// Build script: bundles src/main.ts and src/styles.css into dist/ and copies index.html and static/ (icon, manifest) there.
// dist/ is the only folder the web service serves (web.public_dir); sources never are.
// Output has no external references (no CDN, no webfonts).
import { build, context } from 'esbuild';
import { rmSync, mkdirSync, copyFileSync, cpSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');
const dist = resolve(root, 'dist');

const options = {
  absWorkingDir: root,
  entryPoints: {
    app: 'src/main.ts',
    styles: 'src/styles.css',
  },
  outdir: 'dist',
  bundle: true,
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  target: ['safari15', 'chrome100', 'firefox100'],
  format: 'iife',
  legalComments: 'none',
  logLevel: 'info',
};

if (watch) {
  mkdirSync(dist, { recursive: true });
  copyFileSync(resolve(root, 'index.html'), resolve(dist, 'index.html'));
  cpSync(resolve(root, 'static'), dist, { recursive: true });
  const ctx = await context(options);
  await ctx.watch();
  console.log('watching src/ …');
} else {
  rmSync(dist, { recursive: true, force: true });
  await build(options);
  copyFileSync(resolve(root, 'index.html'), resolve(dist, 'index.html'));
  cpSync(resolve(root, 'static'), dist, { recursive: true });
}
