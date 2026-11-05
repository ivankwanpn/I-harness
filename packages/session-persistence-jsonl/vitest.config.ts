import { defineConfig } from 'vitest/config'

// These suites exercise real filesystem/journal/fsync paths and native locks.
// A 5 s default timeout turns a slow disk or a loaded machine into a fake
// failure (dozens of tests here legitimately take 3-8 s); 30 s keeps a real
// hang visible without flaking on throughput.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
