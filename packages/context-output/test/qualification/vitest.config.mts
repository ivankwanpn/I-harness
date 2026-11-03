import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Only the explicit launcher selects this config. The qualification filename
// does not match ordinary Vitest test/spec discovery.
export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  test: {
    include: ['test/qualification/legacy-index-native.qualification.ts'],
    environment: 'node',
    maxWorkers: 2,
    minWorkers: 1,
  },
})
