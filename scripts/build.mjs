import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await build({
  entryPoints: {
    background: 'src/background.ts',
    content: 'src/content.ts',
    popup: 'src/popup.ts',
  },
  outdir: 'dist',
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  minify: false,
});
await cp('public', 'dist', { recursive: true });
