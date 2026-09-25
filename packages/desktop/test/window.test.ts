import { describe, expect, it } from "vitest"
import { windowPreferences } from "../src/main/window-options.ts"

describe("Desktop window", () => {
  it("keeps renderer isolated from Node", () => {
    expect(windowPreferences("preload.js")).toMatchObject({
      preload: "preload.js",
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    })
  })
})
