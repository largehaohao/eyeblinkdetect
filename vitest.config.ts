import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup/idb.ts'],
    include: ['tests/**/*.test.ts']
  },
  resolve: { alias: { '@': '/src' } }
});
