import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // engine + UI tests each start real browsers and fixed ports
    fileParallelism: false,
  },
});
