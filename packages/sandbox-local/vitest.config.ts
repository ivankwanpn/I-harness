import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // vitest 3.x defaults only pick up *.test.ts / *.spec.ts; the bwrap e2e
    // file is named *.e2e.ts so it must be added explicitly.
    include: ["test/**/*.test.ts", "test/**/*.e2e.ts"],
  },
})
