import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Build dist/ once, before any test file is collected, when build
    // artifacts are absent (fresh checkout or worktree). The dist-reading
    // test files assume a complete dist; see test/global-setup.ts.
    globalSetup: ['./test/global-setup.ts'],
  },
});
