import { defineConfig } from 'vitest/config'

// The capacity-boundary cases exercise real aggregate assembly and legitimately
// take longer than the 5 s default on a loaded machine; 30 s keeps a real hang
// visible without flaking on throughput.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
