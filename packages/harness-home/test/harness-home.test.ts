import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { homedir } from "node:os"
import { join } from "node:path"
import { resolveHarnessHome } from "../src/index.ts"

// The harness home is the ONE place `$IH_CONFIG_DIR` is resolved. It used to be
// four places — a private copy in session-persistence, inline copies in settings
// and hooks, and a variant in skills that ignored the variable entirely — which
// is how a test pinning IH_CONFIG_DIR came to read the developer's real home.

describe("resolveHarnessHome", () => {
  let previous: string | undefined

  beforeEach(() => {
    previous = process.env.IH_CONFIG_DIR
    delete process.env.IH_CONFIG_DIR
  })

  afterEach(() => {
    if (previous === undefined) delete process.env.IH_CONFIG_DIR
    else process.env.IH_CONFIG_DIR = previous
  })

  it("an explicit configDir wins over everything", () => {
    process.env.IH_CONFIG_DIR = "/from-env"
    expect(resolveHarnessHome("/explicit")).toBe("/explicit")
  })

  it("falls back to $IH_CONFIG_DIR when no explicit dir is given", () => {
    process.env.IH_CONFIG_DIR = "/from-env"
    expect(resolveHarnessHome()).toBe("/from-env")
  })

  it("falls back to ~/.i-harness when neither is set", () => {
    expect(resolveHarnessHome()).toBe(join(homedir(), ".i-harness"))
  })

  // Resolved PER CALL. A module-level const would capture the environment once,
  // at import, and a process that sets the variable later — or a test that
  // isolates by setting it — would be silently ignored.
  it("resolves the environment per call, not once at import", () => {
    process.env.IH_CONFIG_DIR = "/first"
    expect(resolveHarnessHome()).toBe("/first")
    process.env.IH_CONFIG_DIR = "/second"
    expect(resolveHarnessHome()).toBe("/second")
  })

  it("an empty configDir is not the same as an absent one", () => {
    // The chain is `??`, not `||`: an explicitly empty string is a caller error
    // to surface, not a silent fall-through to the environment.
    process.env.IH_CONFIG_DIR = "/from-env"
    expect(resolveHarnessHome("")).toBe("")
  })
})
