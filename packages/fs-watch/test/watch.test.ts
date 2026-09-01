// R-B9: createFsWatcher — chokidar-backed file change event stream.
// Covers the three event kinds (add/change/unlink), the default + custom
// ignore lists, and close() stopping the stream (and the iterator ending).
//
// Timing note: watchers report DELTAS after readiness — the initial chokidar
// scan (baseline) is the "now" snapshot. Tests therefore let the watcher
// settle (readinessMargin) before mutating, which is exactly the contract a
// real subscriber observes: files created before readiness are baseline.
import { describe, expect, it } from "vitest"
import { mkdtemp, rm, writeFile, unlink, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFsWatcher } from "../src/index.ts"

async function makeTmp(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "ih-fs-watch-"))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/** Allows the chokidar initial scan (ready) to complete before the test
 * mutates the watched tree. */
const readinessMargin = 300
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** next() with a watchdog — a hung subscription fails the test instead of
 * hanging the suite (the plan's CI-stability requirement). */
function withTimeout<T>(p: Promise<T>, ms = 8000, label = "event"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms)
    p.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

describe("createFsWatcher", () => {
  it("emits add/change/unlink events for one file", async () => {
    const { dir, cleanup } = await makeTmp()
    const w = createFsWatcher({ roots: [dir] })
    try {
      const it = w.events[Symbol.asyncIterator]()
      await sleep(readinessMargin)
      await writeFile(join(dir, "a.txt"), "x")
      const e1 = await withTimeout(it.next(), 8000, "add")
      expect(e1.done).toBe(false)
      expect(e1.value.kind).toBe("add")
      expect(e1.value.path).toBe(join(dir, "a.txt"))

      await sleep(200) // let awaitWriteFinish's stability window settle
      await writeFile(join(dir, "a.txt"), "xy")
      const e2 = await withTimeout(it.next(), 8000, "change")
      expect(e2.value.kind).toBe("change")
      expect(e2.value.path).toBe(join(dir, "a.txt"))

      await sleep(200)
      await unlink(join(dir, "a.txt"))
      const e3 = await withTimeout(it.next(), 8000, "unlink")
      expect(e3.value.kind).toBe("unlink")
    } finally {
      await w.close()
      await cleanup()
    }
  })

  it("does not emit for default-ignored dirs (node_modules/.git/.i-harness/dist)", async () => {
    const { dir, cleanup } = await makeTmp()
    const w = createFsWatcher({ roots: [dir] })
    try {
      const it = w.events[Symbol.asyncIterator]()
      await mkdir(join(dir, "node_modules"))
      await mkdir(join(dir, ".git"))
      await mkdir(join(dir, ".i-harness"))
      await mkdir(join(dir, "dist"))
      await sleep(readinessMargin)
      await writeFile(join(dir, "node_modules", "x.txt"), "x")
      await writeFile(join(dir, ".git", "y.txt"), "y")
      await writeFile(join(dir, ".i-harness", "z.txt"), "z")
      await writeFile(join(dir, "dist", "w.txt"), "w")
      await sleep(700)
      // the iterator must still be pending — no event arrived for ignored writes
      await writeFile(join(dir, "seen.txt"), "s")
      const e = await withTimeout(it.next(), 8000, "add (post-ignore)")
      expect(e.value.kind).toBe("add")
      expect(e.value.path).toBe(join(dir, "seen.txt"))
    } finally {
      await w.close()
      await cleanup()
    }
  })

  it("respects custom ignore entries", async () => {
    const { dir, cleanup } = await makeTmp()
    const w = createFsWatcher({ roots: [dir], ignore: ["artifact-zone"] })
    try {
      const it = w.events[Symbol.asyncIterator]()
      await mkdir(join(dir, "artifact-zone"))
      await sleep(readinessMargin)
      await writeFile(join(dir, "artifact-zone", "dump.bin"), "z")
      await sleep(700)
      await writeFile(join(dir, "keep.md"), "k")
      const e = await withTimeout(it.next(), 8000, "add (post-custom-ignore)")
      expect(e.value.kind).toBe("add")
      expect(e.value.path).toBe(join(dir, "keep.md"))
    } finally {
      await w.close()
      await cleanup()
    }
  })

  it("close() stops the stream and ends the iterable", async () => {
    const { dir, cleanup } = await makeTmp()
    const w = createFsWatcher({ roots: [dir] })
    const it = w.events[Symbol.asyncIterator]()
    await sleep(readinessMargin)
    try {
      await writeFile(join(dir, "b.txt"), "b")
      const e1 = await withTimeout(it.next(), 8000, "add")
      expect(e1.value.kind).toBe("add")
    } finally {
      await w.close()
    }
    await writeFile(join(dir, "c.txt"), "c") // no watcher left to report it
    const e2 = await withTimeout(it.next(), 5000, "close-stop")
    expect(e2.done).toBe(true)
    await cleanup()
  })

  it("roots are watched independently", async () => {
    const a = await makeTmp()
    const b = await makeTmp()
    const w = createFsWatcher({ roots: [a.dir, b.dir] })
    try {
      const it = w.events[Symbol.asyncIterator]()
      await sleep(readinessMargin)
      await writeFile(join(a.dir, "one.txt"), "1")
      const e1 = await withTimeout(it.next(), 8000, "add (root a)")
      expect(e1.value.path).toBe(join(a.dir, "one.txt"))
      await writeFile(join(b.dir, "two.txt"), "2")
      const e2 = await withTimeout(it.next(), 8000, "add (root b)")
      expect(e2.value.path).toBe(join(b.dir, "two.txt"))
    } finally {
      await w.close()
      await a.cleanup()
      await b.cleanup()
    }
  })
})
