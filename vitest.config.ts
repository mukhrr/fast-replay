import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Recording + replaying drives a real browser against a real dev server.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Integration tests share ports and .repros/ scratch dirs.
    fileParallelism: false,
  },
});
