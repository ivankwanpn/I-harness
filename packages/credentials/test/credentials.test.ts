import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createCredentialStore,
  CredentialRefError,
  CredentialShadowedError,
} from "../src/index.ts"

// Unique refs so tests never collide with real process.env entries.
const REF_FILE = "IH_TST_CRED_FILE"
const REF_ENV = "IH_TST_CRED_ENV"

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ih-credentials-"))
  delete process.env[REF_ENV]
})

afterEach(async () => {
  delete process.env[REF_ENV]
  await rm(dir, { recursive: true, force: true })
})

function docPath(): string {
  return join(dir, "credentials.json")
}

describe("createCredentialStore", () => {
  it("describe: unset ref → configured false, writable true, source file", async () => {
    const store = createCredentialStore(docPath())
    expect(store.describe([REF_FILE])).toEqual({
      [REF_FILE]: { configured: false, source: "file", writable: true },
    })
  })

  it("describe: file-resident ref → configured true, source file, writable true", async () => {
    const store = createCredentialStore(docPath())
    await store.set(REF_FILE, "sk-file-value")
    expect(store.describe([REF_FILE])).toEqual({
      [REF_FILE]: { configured: true, source: "file", writable: true },
    })
  })

  it("describe: process.env wins over the file → source env, writable false", async () => {
    const store = createCredentialStore(docPath())
    await store.set(REF_FILE, "sk-file-value")
    process.env[REF_FILE] = "sk-env-value"
    expect(store.describe([REF_FILE])).toEqual({
      [REF_FILE]: { configured: true, source: "env", writable: false },
    })
    delete process.env[REF_FILE]
    // env removed → the file value shows again
    expect(store.describe([REF_FILE])[REF_FILE]).toEqual({
      configured: true, source: "file", writable: true,
    })
  })

  it("describe never returns values (no value/secret key material)", async () => {
    const store = createCredentialStore(docPath())
    await store.set(REF_FILE, "sk-ultra-secret-x7")
    const d = store.describe([REF_FILE, REF_ENV])
    // result keys are exactly the requested refs
    expect(Object.keys(d).sort()).toEqual([REF_ENV, REF_FILE].sort())
    // each info carries exactly the three metadata fields
    expect(Object.keys(d[REF_FILE]).sort()).toEqual(["configured", "source", "writable"])
    // no value material anywhere in the describe surface
    expect(JSON.stringify(d)).not.toContain("sk-ultra-secret-x7")
    expect("value" in d[REF_FILE]).toBe(false)
    expect("secret" in d[REF_FILE]).toBe(false)
  })

  it("set/unset round-trip", async () => {
    const store = createCredentialStore(docPath())
    await store.set(REF_FILE, "sk-roundtrip")
    expect(store.describe([REF_FILE])[REF_FILE].configured).toBe(true)
    await store.unset(REF_FILE)
    expect(store.describe([REF_FILE])[REF_FILE]).toEqual({
      configured: false, source: "file", writable: true,
    })
    // on-disk doc no longer carries the ref
    const raw = JSON.parse(await (await import("node:fs/promises")).readFile(docPath(), "utf8"))
    expect(raw.refs).not.toHaveProperty(REF_FILE)
  })

  it("unset is idempotent (no error when the ref is absent)", async () => {
    const store = createCredentialStore(docPath())
    await store.unset(REF_FILE)
    await store.set(REF_FILE, "sk-x")
    await store.unset(REF_FILE)
    await store.unset(REF_FILE) // second unset: no-op, no throw
    expect(store.describe([REF_FILE])[REF_FILE].configured).toBe(false)
  })

  it("env-shadowed set → CredentialShadowedError (code credential-rejected)", async () => {
    process.env[REF_ENV] = "sk-from-env"
    const store = createCredentialStore(docPath())
    let err: unknown
    try {
      await store.set(REF_ENV, "sk-try")
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(CredentialShadowedError)
    expect((err as CredentialShadowedError).code).toBe("credential-rejected")
  })

  it("env-shadowed unset → CredentialShadowedError (code credential-rejected)", async () => {
    process.env[REF_ENV] = "sk-from-env"
    const store = createCredentialStore(docPath())
    await expect(store.unset(REF_ENV)).rejects.toMatchObject({
      name: "CredentialShadowedError",
      code: "credential-rejected",
    })
  })

  it("invalid ref grammar → CredentialRefError for describe/set/unset", async () => {
    const store = createCredentialStore(docPath())
    for (const bad of ["1abc", "a-b", "a b", "", "ref:value", "a.b"]) {
      expect(() => store.describe([bad])).toThrow(CredentialRefError)
      await expect(store.set(bad, "sk-x")).rejects.toBeInstanceOf(CredentialRefError)
      await expect(store.unset(bad)).rejects.toBeInstanceOf(CredentialRefError)
    }
  })

  it("invalid set value (empty / whitespace-only) → CredentialRefError", async () => {
    const store = createCredentialStore(docPath())
    await expect(store.set(REF_FILE, "")).rejects.toBeInstanceOf(CredentialRefError)
    await expect(store.set(REF_FILE, "   ")).rejects.toBeInstanceOf(CredentialRefError)
  })

  it("corrupt file → treated as empty + warn (degrade, never throw)", async () => {
    await writeFile(docPath(), "{not json", "utf8")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const store = createCredentialStore(docPath())
      expect(store.describe([REF_FILE])[REF_FILE].configured).toBe(false)
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it("non-object doc / non-string entries are dropped (normalize spirit + warn)", async () => {
    await writeFile(
      docPath(),
      JSON.stringify({ refs: { [REF_FILE]: 42, OK: "sk-ok", bad: [] } }),
      "utf8",
    )
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const store = createCredentialStore(docPath())
      expect(store.describe(["OK"])["OK"].configured).toBe(true)
      expect(store.describe([REF_FILE])[REF_FILE].configured).toBe(false)
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it("empty / whitespace-only file entries → configured false (dropped + warn)", async () => {
    await writeFile(
      docPath(),
      JSON.stringify({ refs: { [REF_FILE]: "", WS: "   " } }),
      "utf8",
    )
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const store = createCredentialStore(docPath())
      expect(store.describe([REF_FILE])[REF_FILE].configured).toBe(false)
      expect(store.describe(["WS"])["WS"].configured).toBe(false)
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  // ── resolve: the internal read chain (env > file) the APP BUILD path uses ──
  // describe stays one-way (metadata only); resolve is the non-echoing reader
  // for model builders — the value may leave the process into a ModelClient,
  // never into a UI-facing surface (review r1: web.ts model builds consult the
  // store instead of raw process.env, so a file-set key really builds).
  it("resolve: file entry → the file value (non-echoing read chain)", async () => {
    const store = createCredentialStore(docPath())
    await store.set(REF_FILE, "sk-file-value")
    expect(store.resolve(REF_FILE)).toBe("sk-file-value")
  })

  it("resolve: non-empty env beats the file value; env removed → file again", async () => {
    const store = createCredentialStore(docPath())
    await store.set(REF_FILE, "sk-file-value")
    process.env[REF_FILE] = "sk-env-value"
    expect(store.resolve(REF_FILE)).toBe("sk-env-value")
    delete process.env[REF_FILE]
    expect(store.resolve(REF_FILE)).toBe("sk-file-value")
  })

  it("resolve: empty/whitespace env does NOT shadow the file value", async () => {
    const store = createCredentialStore(docPath())
    await store.set(REF_FILE, "sk-file-value")
    process.env[REF_FILE] = "  "
    expect(store.resolve(REF_FILE)).toBe("sk-file-value")
    delete process.env[REF_FILE]
  })

  it("resolve: absent ref → undefined; invalid ref grammar → CredentialRefError", async () => {
    const store = createCredentialStore(docPath())
    expect(store.resolve(REF_ENV)).toBeUndefined()
    expect(() => store.resolve("1bad")).toThrow(CredentialRefError)
  })

  it("empty / whitespace-only env var means 'not configured here' (no shadow)", async () => {
    const store = createCredentialStore(docPath())
    await store.set(REF_FILE, "sk-file")
    process.env[REF_FILE] = "   "
    // whitespace env does NOT shadow the file value
    expect(store.describe([REF_FILE])[REF_FILE]).toEqual({
      configured: true, source: "file", writable: true,
    })
    delete process.env[REF_FILE]
    process.env[REF_ENV] = ""
    // empty env → unconfigured, still writable
    expect(store.describe([REF_ENV])[REF_ENV]).toEqual({
      configured: false, source: "file", writable: true,
    })
    // and an empty env does not reject writes either
    await store.set(REF_ENV, "sk-envfile")
    expect(store.describe([REF_ENV])[REF_ENV]).toEqual({
      configured: true, source: "file", writable: true,
    })
    delete process.env[REF_ENV]
  })

  it("missing file → configured false with zero warns (ENOENT is silent)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const store = createCredentialStore(docPath())
      expect(store.describe([REF_FILE])[REF_FILE]).toEqual({
        configured: false, source: "file", writable: true,
      })
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it("unset of an absent ref is a true no-op (content + mtime unchanged)", async () => {
    const store = createCredentialStore(docPath())
    await store.set(REF_FILE, "sk-x")
    const contentBefore = await readFile(docPath(), "utf8")
    const mtimeBefore = (await stat(docPath())).mtimeMs
    await store.unset(REF_ENV) // absent → no write
    expect(await readFile(docPath(), "utf8")).toBe(contentBefore)
    expect((await stat(docPath())).mtimeMs).toBe(mtimeBefore)
  })

  // PLATFORM NOTE: mode 0600 is asserted only on POSIX. On win32 chmod is
  // best-effort — Node ignores POSIX mode bits (Windows ACLs apply instead),
  // so the assertion would be meaningless (same stance as the plugin
  // state/audit tests: skip the bit assertion, keep the write).
  it.skipIf(process.platform === "win32")("persisted file gets mode 0600", async () => {
    const store = createCredentialStore(docPath())
    await store.set(REF_FILE, "sk-mode")
    const mode = (await stat(docPath())).mode & 0o777
    expect(mode).toBe(0o600)
  })
})
