import { rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });

const outputs = [
  { format: 'esm', outdir: 'dist/esm', naming: 'index.js' },
  { format: 'cjs', outdir: 'dist/cjs', naming: 'index.cjs' },
] as const;

for (const output of outputs) {
  const result = await Bun.build({
    entrypoints: ['src/index.ts'],
    target: 'node',
    minify: true,
    sourcemap: 'linked',
    ...output,
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
}
