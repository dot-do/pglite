import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  sourcemap: true,
  dts: true,
  clean: true,
  minify: true,
  shims: true,
  format: ['esm', 'cjs'],
})
