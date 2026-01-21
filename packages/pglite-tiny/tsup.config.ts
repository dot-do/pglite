import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  sourcemap: true,
  // DTS generation disabled until main @dotdo/pglite types are fixed
  // The main pglite package has a type error in src/fs/base.ts
  // that prevents DTS generation. Types are available from source.
  dts: false,
  clean: true,
  minify: true,
  shims: true,
  format: ['esm', 'cjs'],
})
