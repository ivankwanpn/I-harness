import { describe, expect, it } from "vitest"
import { createProviderRegistry, type DirectoryEntry } from "@i-harness/provider"
import type { SectionView } from "@i-harness/settings"
import {
  buildModelsCatalog,
  catalogDefaultOf,
  mergeCatalogModels,
  mergeDirectoryRows,
  sectionUserProviders,
} from "../src/models.ts"

function redactedView(user: Record<string, unknown>, value: Record<string, unknown>): SectionView {
  // describeSection's shape: value = redacted merged view; user = the redacted
  // USER layer carrying the section's top-level keys (providers/defaultModel).
  return { value, user: { providers: user }, writable: true, revision: 1 }
}
const registry = createProviderRegistry()

/** Fixture: the amendment composition — the CLI registry is composed EMPTY, so
 * rows = user-section routes only. */
const EMPTY_DIRECTORY: DirectoryEntry[] = registry.describeDirectory()

describe("models folds (R-C5)", () => {
  it("merges declared ⊕ user rows; declared content wins an id collision", () => {
    const directory: DirectoryEntry[] = [
      { route: "deepseek", displayName: "DeepSeek", protocol: "openai-compatible", defaultModel: "deepseek-chat", models: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }] },
    ]
    const user = {
      deepseek: {
        displayName: "My DeepSeek",
        protocol: "openai-completions",
        models: [
          { id: "deepseek-chat", name: "chat-new" },
          "old-string-model",
        ],
      },
      custom1: { displayName: "Custom Route", protocol: "openai-responses", models: [{ id: "custom-one" }] },
    }
    const rows = mergeDirectoryRows(directory, user)
    const deepseek = rows.find((r) => r.route === "deepseek")!
    expect(deepseek.declared).toBe(true)
    expect(deepseek.user).toBe(true)
    expect(deepseek.protocol).toBe("openai-completions") // user section > seeded > default
    expect(deepseek.models!.map((m) => m.id)).toEqual(["deepseek-chat", "deepseek-reasoner", "old-string-model"])
    expect(deepseek.models![0]).toMatchObject({ id: "deepseek-chat" }) // declared row wins the collision
    const custom = rows.find((r) => r.route === "custom1")!
    expect(custom).toMatchObject({ declared: false, user: true })
    expect(custom.models).toEqual([{ id: "custom-one" }])
  })

  it("protocol resolution per row: user > SEEDED_PROTOCOLS > DEFAULT", () => {
    const rows = mergeDirectoryRows([], { myroute: { protocol: "anthropic-messages" } })
    expect(rows[0]!.protocol).toBe("anthropic-messages")
    // no validated protocol → the default
    const rows2 = mergeDirectoryRows([], { another: {} })
    expect(rows2[0]!.protocol).toBe("openai-completions")
  })

  it("mergeCatalogModels dedupes, declared wins", () => {
    const merged = mergeCatalogModels(
      [{ id: "a", name: "declared-a" }, { id: "b" }],
      [{ id: "a", name: "user-a" }, { id: "c" }],
    )
    expect(merged).toEqual([{ id: "a", name: "declared-a" }, { id: "b" }, { id: "c" }])
  })

  it("catalog: an unusable protocol becomes a failure, never a group; default falls back", () => {
    const section = redactedView(
      { badroute: { protocol: "not-a-wire-protocol" } },
      { defaultModel: {} },
    )
    const view = buildModelsCatalog({
      directory: EMPTY_DIRECTORY,
      section,
      fallbackDefault: { provider: "", model: "" },
    })
    expect(view.failures).toEqual([{ route: "badroute", reason: "unknown-protocol" }])
    expect(view.groups).toEqual([])
    expect(view.default).toEqual({ provider: "", model: "" }) // honest UNSET
  })

  it("catalogDefaultOf reads the section's defaultModel", () => {
    const section = redactedView({}, { defaultModel: { provider: "deepseek", model: "deepseek-chat" } })
    expect(catalogDefaultOf(section, { provider: "", model: "" })).toEqual({ provider: "deepseek", model: "deepseek-chat" })
  })

  it("sectionUserProviders reads the USER layer only (never the merged value)", () => {
    const section = redactedView({ p1: {} }, { p1: {}, other: {} })
    expect(sectionUserProviders(section)).toEqual({ p1: {} })
  })
})
