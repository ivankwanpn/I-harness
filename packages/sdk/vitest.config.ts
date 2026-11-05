import { defineConfig } from 'vitest/config'

// The cancel/stop cases wait for real receipts and CLI subprocesses; the slowest
// exceed the 5 s default on a loaded machine, so use the same 30 s ceiling as the
// persistence and core-agent suites.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
