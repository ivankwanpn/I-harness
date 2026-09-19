/**
 * `i-harness provider` — the CLI face of the provider lifecycle
 * (docs/superpowers/specs/2026-09-19-provider-lifecycle-design.md §4).
 *
 * WHY IT EXISTS: M65 deleted the TUI, and with it the only caller of SEVEN
 * ProviderRuntime methods — directory, upsert, remove, setApiKey, clearApiKey,
 * discoverModels, setDefaultModel. Nothing noticed, because nothing could
 * exercise them. This is the same reason `i-harness hooks approve` exists: a
 * rule that cannot be invoked is a rule that is already broken.
 *
 * Shape follows `sessions.ts` and `hooks.ts` — parse → gather → render → run,
 * each piece pure and separately testable.
 */

import { createInterface } from "node:readline"
import {
  listModelCatalogFamily,
  resolveModelCard,
  resolveModelCatalogProvenance,
  type ModelCatalogFamilySource,
  type ModelCatalogProvenance,
  type ModelCatalogRow,
} from "@i-harness/provider"
import type { ProviderRuntimeEntry } from "@i-harness/provider-runtime"
import { loadProviderRuntime } from "./provider-runtime.ts"

/** The five wire protocols a route may declare. Exported because `models.ts`
 * validates `--protocol` against the SAME list — two copies would drift. */
export const PROVIDER_PROTOCOLS = ["openai-completions", "openai-responses", "anthropic-messages", "gemini", "bedrock"] as const
export type CliProtocol = (typeof PROVIDER_PROTOCOLS)[number]

/** The route fields the CLI can write. `models` is not among them — that is
 * `i-harness models`' job, and keeping them apart is what stops a protocol
 * change from emptying a route's catalog. */
export interface ProviderFields {
  baseURL?: string
  protocol?: CliProtocol
  catalog?: string
  displayName?: string
  modelsURL?: string
}

export interface ParsedProviderArgs {
  subcommand: "list" | "add" | "set" | "key" | "rm" | "help"
  id?: string
  fields: ProviderFields
  error?: string
}

const PROVIDER_USAGE =
  "usage: i-harness provider <list|add|set|key|rm>\n" +
  "  list                                        routes, the card family each resolves, and the table's provenance\n" +
  "  add <id> --base-url URL --protocol P [--catalog F] [--display-name N] [--models-url URL]\n" +
  "  set <id> [--base-url URL] [--protocol P] [--catalog F] [--display-name N] [--models-url URL]\n" +
  "  key <id>                                    read the API key from stdin (never from argv)\n" +
  "  rm <id>\n" +
  `  protocols: ${PROVIDER_PROTOCOLS.join(" | ")}`

export function parseProviderArgs(args: string[]): ParsedProviderArgs {
  const sub = args[1]
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    return { subcommand: "help", fields: {} }
  }
  const rest = args.slice(2)
  if (sub !== "list" && sub !== "add" && sub !== "set" && sub !== "key" && sub !== "rm") {
    return { subcommand: "help", fields: {}, error: `unknown provider subcommand: ${sub}` }
  }

  let id: string | undefined
  const fields: ProviderFields = {}
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]!
    if (!token.startsWith("-")) {
      if (id !== undefined) return { subcommand: "help", fields: {}, error: `unexpected extra argument: ${token}` }
      id = token
      continue
    }
    const value = rest[i + 1]
    if (value === undefined || value.startsWith("--")) {
      return { subcommand: "help", fields: {}, error: `${token} needs a value` }
    }
    i += 1
    if (token === "--base-url") { fields.baseURL = value; continue }
    if (token === "--models-url") { fields.modelsURL = value; continue }
    if (token === "--catalog") { fields.catalog = value; continue }
    if (token === "--display-name") { fields.displayName = value; continue }
    if (token === "--protocol") {
      if (!(PROVIDER_PROTOCOLS as readonly string[]).includes(value)) {
        // Never default a protocol: the schema's fill-in is `openai-completions`
        // (settings/src/sections.ts:116), and applying it silently is a wrong
        // answer stated as a right one.
        return { subcommand: "help", fields: {}, error: `unknown protocol "${value}"; expected one of: ${PROVIDER_PROTOCOLS.join(" | ")}` }
      }
      fields.protocol = value as CliProtocol
      continue
    }
    return { subcommand: "help", fields: {}, error: `unknown flag: ${token}` }
  }

  if (sub !== "list" && id === undefined) {
    return { subcommand: "help", fields: {}, error: `${sub} requires a provider id` }
  }
  if (sub === "add") {
    if (fields.baseURL === undefined) return { subcommand: "help", fields: {}, error: "add requires --base-url" }
    if (fields.protocol === undefined) return { subcommand: "help", fields: {}, error: "add requires --protocol" }
  }
  if (sub !== "list" && sub !== "add" && sub !== "set" && Object.keys(fields).length > 0) {
    return { subcommand: "help", fields: {}, error: `${sub} takes no flags` }
  }
  return { subcommand: sub, ...(id !== undefined ? { id } : {}), fields }
}

/** The table ROW a route's model id names: the row holding the numbers and the
 * retired names that resolve to them. Undefined for an id the table does not
 * know (fail-closed, like `resolveModelCard`) — and for an id that IS a retired
 * name, because an alias is not a row of its own. */
function catalogRowFor(family: string, modelId: string): ModelCatalogRow | undefined {
  return listModelCatalogFamily(family).find((row) => row.modelId === modelId)
}

/** One provenance line: the family, and where its numbers came from. */
function familySourceLine(entry: ModelCatalogFamilySource): string {
  return `  ${entry.family}  ${entry.source}`
}

export function renderProviderList(
  rows: readonly ProviderRuntimeEntry[],
  provenance: ModelCatalogProvenance,
): string {
  if (rows.length === 0) return "no provider routes configured"
  const lines = [`${rows.length} provider route(s):`, ""]
  for (const row of rows) {
    // Declared vs defaulted is the distinction the whole `catalog` field exists
    // for, so the listing states which one it is.
    lines.push(`  ${row.id}  [${row.protocol}]${row.configured ? "" : "  (not configured)"}`)
    lines.push(`    card family: ${row.cardFamily} (${row.catalog !== undefined ? "declared" : "the route name"})`)
    lines.push(`    discovery: ${row.discovery}`)
    if (row.defaultModel !== undefined) lines.push(`    default model: ${row.defaultModel}`)
    const cards = row.models.map((model) => {
      const card = resolveModelCard(row.cardFamily, model.id)
      const aliases = catalogRowFor(row.cardFamily, model.id)?.aliases ?? []
      const numbers = card?.contextWindow !== undefined
        ? `${card.contextWindow}${card.maxOutputTokens !== undefined ? ` / ${card.maxOutputTokens}` : ""}`
        : "no card"
      return `      ${model.id}  (${numbers})${aliases.length > 0 ? `  +${aliases.length} retired name(s): ${aliases.join(", ")}` : ""}`
    })
    lines.push("    models:", ...(cards.length > 0 ? cards : ["      (none — try: i-harness models probe " + row.id + ")"]))
    lines.push("")
  }
  lines.push(`model table: last revised ${provenance.generatedAt}`)
  for (const family of provenance.families) lines.push(familySourceLine(family))
  return lines.join("\n")
}

/** One line from stdin. A TTY would echo it, so say that rather than pretend. */
async function readStdinLine(): Promise<string> {
  if (process.stdin.isTTY === true) {
    console.error("provider: reading the key from a terminal — it WILL be echoed. Prefer: printf %s \"$KEY\" | i-harness provider key <id>")
  }
  const rl = createInterface({ input: process.stdin, terminal: false })
  for await (const line of rl) {
    rl.close()
    return line.trim()
  }
  return ""
}

/** Injection point for the credential read. Tests MUST use it: writing to the
 * real `process.stdin` from a test is a test that hangs on CI. */
export interface ProviderCommandOptions {
  readKey?: () => Promise<string>
}

export async function runProviderCommand(args: string[], options: ProviderCommandOptions = {}): Promise<number> {
  const parsed = parseProviderArgs(args)
  if (parsed.error !== undefined) {
    console.error(`provider: ${parsed.error}`)
    console.error(PROVIDER_USAGE)
    return 1
  }
  if (parsed.subcommand === "help") {
    console.error(PROVIDER_USAGE)
    return 0
  }

  const { runtime } = await loadProviderRuntime()
  try {
    if (parsed.subcommand === "list") {
      console.log(renderProviderList(await runtime.directory(), resolveModelCatalogProvenance()))
      return 0
    }
    const id = parsed.id!
    if (parsed.subcommand === "add") {
      try {
        await runtime.createProvider(id, { ...parsed.fields })
      } catch (error) {
        // The runtime's message deliberately names no sibling method; this is
        // where the CLI verb the user can actually type belongs.
        console.error(`provider: ${error instanceof Error ? error.message : String(error)}`)
        console.error(`  to change an existing route: i-harness provider set ${id} [flags]`)
        return 1
      }
      // The credential REF is decided by the runtime; print it so the next
      // step is a copy-paste rather than a guess.
      console.log(`created provider "${id}"\n  next: i-harness provider key ${id}`)
      return 0
    }
    if (parsed.subcommand === "set") {
      try {
        await runtime.patchProvider(id, { ...parsed.fields })
      } catch (error) {
        console.error(`provider: ${error instanceof Error ? error.message : String(error)}`)
        console.error(`  to create a route: i-harness provider add ${id} --base-url URL --protocol P`)
        return 1
      }
      console.log(`updated provider "${id}"`)
      return 0
    }
    if (parsed.subcommand === "key") {
      // The route must exist BEFORE anything is read or written, or the write
      // below invents one: `setApiKey` persists `...(current ?? {})`, so a
      // typo'd id stored a credential and grew a settings row that the next
      // `provider list` showed. `set` already refuses an absent route; `key`
      // is symmetric with it now.
      const known = (await runtime.directory()).some((row) => row.id === id)
      if (!known) {
        console.error(`provider: no route "${id}" — create it first: i-harness provider add ${id} --base-url URL --protocol P`)
        return 1
      }
      const value = (await (options.readKey ?? readStdinLine)()).trim()
      if (value === "") {
        console.error("provider: no key on stdin")
        return 1
      }
      await runtime.setApiKey(id, value)
      // A SHORT key must not be revealed by its own mask: with `value.length <= 8`
      // the "last four" tail IS the value. The invariant is never, not usually.
      const masked = value.length > 8 ? `x…${value.slice(-4)}` : "x…"
      console.log(`stored a credential for "${id}" (${masked})`)
      return 0
    }
    await runtime.removeProvider(id)
    console.log(`removed provider "${id}"`)
    return 0
  } catch (error) {
    console.error(`provider: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}
