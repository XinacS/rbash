import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  dts: true,
  target: 'node18',
  // Don't add shebang to ESM output — handle it via package.json bin
});
