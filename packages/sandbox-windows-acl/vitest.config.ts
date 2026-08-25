import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // vitest 3.x defaults only pick up *.test.ts / *.spec.ts; the win32 e2e
    // file is named *.e2e.ts so it must be added explicitly (M16 core Task 6
    // lesson — without this include the win32 e2e silently never runs).
    include: ["test/**/*.test.ts", "test/**/*.e2e.ts"],
  },
})
