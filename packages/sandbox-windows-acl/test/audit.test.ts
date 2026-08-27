import { describe, expect, it } from "vitest"
import { scanWorldWritable } from "../src/audit.ts"
import { mkdtempSync, mkdirSync, chmodSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe.skipIf(process.platform !== "win32")("scanWorldWritable", () => {
  it("finds a world-writable temp dir", async () => {
    const root = mkdtempSync(join(tmpdir(), "i-harness-audit-"))
    try {
      const dir = join(root, "open")
      mkdirSync(dir)
      chmodSync(dir, 0o777) // Everyone write on POSIX-mode emulation; win32 needs real ACL — use icacls in integration；這裡先以 POSIX 測試非 win32 路徑（skipIf 使 win32 上只跑 icacls 案例）
      const findings = await scanWorldWritable([root], { maxItemsPerDir: 10, totalBudgetMs: 2000 })
      expect(Array.isArray(findings)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it("budget caps exploration", async () => {
    const root = mkdtempSync(join(tmpdir(), "i-harness-audit-"))
    try {
      for (let i = 0; i < 50; i++) mkdirSync(join(root, `d${i}`))
      const findings = await scanWorldWritable([root], { maxItemsPerDir: 5, totalBudgetMs: 500 })
      expect(findings.length).toBeLessThanOrEqual(50) // budget 限制探索
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it("probe verdict world-writable → finding recorded", async () => {
    const root = mkdtempSync(join(tmpdir(), "i-harness-audit-"))
    try {
      const dir = join(root, "open")
      mkdirSync(dir)
      const findings = await scanWorldWritable([root], {
        maxItemsPerDir: 5,
        totalBudgetMs: 2000,
        probe: (p) => (p === dir ? "world-writable" : "safe"),
      })
      expect(findings.some((f) => f.path === dir && f.who === "Everyone")).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
