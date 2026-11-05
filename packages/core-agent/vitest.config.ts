import { defineConfig } from 'vitest/config'

// Several cases drive real managed writers and provider flows that exceed the
// 5 s default on a loaded machine; 30 s keeps hang detection without flakes.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
