import { defineConfig } from 'tsup';
// Bundle the workspace core package so production never loads its TypeScript sources at runtime.
export default defineConfig({ entry: ['src/main.ts'], format: ['esm'], outDir: 'dist', target: 'node24', external: ['better-sqlite3'], noExternal: ['@filtarr/core'], clean: true });
