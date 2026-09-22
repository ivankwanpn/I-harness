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
import { PROVIDER_PROTOCOLS, type SettingsProviderProtocol } from "@i-harness/settings"
import { loadProviderRuntime } from "./provider-runtime.ts"
import { diagnosticsFor } from "@i-harness/diagnostics"

// W6 T5: this file's call sites all report the `provider` command's own
// refusals and failures (phase `cli`), so one module-scope handle covers them.
const d = diagnosticsFor("cli")

/** The five wire protocols a route may declare. ONE list, and it lives in
 * settings — the CLI used to re-declare the same enum, which is two places to
 * edit for one fact (and `models.ts` reads it through here, so its validation
 * is against the SAME object). */
export { PROVIDER_PROTOCOLS }
export type CliProtocol = SettingsProviderProtocol

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

/** Flags whose settings field is a NON-EMPTY string. An empty (or blank) value
 * is refused at parse time, and the line above each flag is why: settings
 * DROPS an empty baseURL on normalize (packages/settings/src/index.ts:446-449),
 * so `add gw --base-url ""` used to persist `{baseURL: ""}`, report
 * `created provider "gw"`, and leave every adapter to fall back to its
 * hard-coded vendor endpoint (llm-openai-compatible/src/index.ts:93), taking
 * the user's prompt and stored credential to a host they never configured.
 * `set` clears a working endpoint the same way. */
const NON_EMPTY_VALUE_FLAGS = new Set(["--base-url", "--models-url", "--catalog", "--display-name"])

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
  /** The flag tokens seen, in order — for the diagnostic that has to NAME the
   * flag a verb cannot read (fields alone cannot spell `--base-url` back). */
  const flagTokens: string[] = []
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
    if (NON_EMPTY_VALUE_FLAGS.has(token) && value.trim() === "") {
      return { subcommand: "help", fields: {}, error: `${token} needs a non-empty value` }
    }
    i += 1
    flagTokens.push(token)
    if (token === "--base-url") { fields.baseURL = value; continue }
    if (token === "--models-url") { fields.modelsURL = value; continue }
    if (token === "--catalog") { fields.catalog = value; continue }
    if (token === "--display-name") { fields.displayName = value; continue }
    if (token === "--protocol") {
      if (!(PROVIDER_PROTOCOLS as readonly string[]).includes(value)) {
        // Never default a protocol: there is NO schema fill-in anymore (the
        // resolver stops at SEEDED_PROTOCOLS — see resolveProviderProtocol),
        // and inventing one silently is a wrong answer stated as a right one.
        return { subcommand: "help", fields: {}, error: `unknown protocol "${value}"; expected one of: ${PROVIDER_PROTOCOLS.join(" | ")}` }
      }
      fields.protocol = value as CliProtocol
      continue
    }
    return { subcommand: "help", fields: {}, error: `unknown flag: ${token}` }
  }

  // `list` READS every route and takes nothing. It used to accept an id and
  // flags and silently ignore both, so `provider list deepseek` printed the
  // full list with exit 0 — the same "exit 0 having done something other than
  // what was asked" the models tree refuses. What it takes is nothing, and the
  // refusal says so.
  if (sub === "list") {
    if (id !== undefined) {
      return { subcommand: "help", fields: {}, error: `list takes no arguments (got "${id}"); it lists every configured route` }
    }
    if (flagTokens.length > 0) {
      return { subcommand: "help", fields: {}, error: `${flagTokens[0]} is not a flag of "list"; it lists every configured route` }
    }
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
    //
    // A route with no declared protocol is NOT a route with a default one — but
    // it is not a verdict on usability either. `[undefined]` would be a
    // rendering accident and `[openai-completions]` a wire nobody declared;
    // "cannot be used" would be a claim about the CHAIN that this row cannot
    // see: resolution tries the selection, then the model row, then the route
    // (provider-runtime/src/index.ts:632 feeds :741), so a protocol-less route
    // still resolves whenever a row or a selection names a wire. The line
    // states what is true of the ROUTE and names the verb that declares one.
    // The repair names the SET, not a placeholder — `--protocol P` copied
    // verbatim fails with `unknown protocol "P"`, a second error before the fix
    // (this repo already ruled on that: 5d0f2d89, "P was the --provider
    // placeholder").
    lines.push(
      row.protocol === undefined
        ? `  ${row.id}  [no protocol of its own — set one with: i-harness provider set ${row.id} --protocol <one of: ${PROVIDER_PROTOCOLS.join(" | ")}>]`
        : `  ${row.id}  [${row.protocol}]${row.configured ? "" : "  (not configured)"}`,
    )
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
    // The next step depends on the route's OWN facts, because `models probe`
    // refuses in two states: no declared protocol (nothing to shape the
    // request with) and manual-only discovery (bedrock; there is no discovery
    // endpoint at all — provider-runtime/src/index.ts:246 throws it).
    // Recommending it in either state costs a round trip, so each state names
    // the verb that can actually run. A declared protocol with discovery
    // available keeps the probe hint it always had.
    lines.push("    models:", ...(cards.length > 0 ? cards : [
      row.protocol === undefined
        ? `      (none — declare a protocol first: i-harness provider set ${row.id} --protocol <one of: ${PROVIDER_PROTOCOLS.join(" | ")}>)`
        : row.discovery === "manual-only"
          ? `      (none — discovery is unavailable for this route; add one: i-harness models add ${row.id} <id...>)`
          : `      (none — try: i-harness models probe ${row.id})`,
    ]))
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
    d.error(`provider: ${parsed.error}`)
    d.error(PROVIDER_USAGE)
    return 1
  }
  if (parsed.subcommand === "help") {
    d.error(PROVIDER_USAGE)
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
        d.error(`provider: ${error instanceof Error ? error.message : String(error)}`)
        d.error(`  to change an existing route: i-harness provider set ${id} [flags]`)
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
        d.error(`provider: ${error instanceof Error ? error.message : String(error)}`)
        d.error(`  to create a route: i-harness provider add ${id} --base-url URL --protocol P`)
        return 1
      }
      // A no-flag `set` writes the row back unchanged (and still proves the
      // route exists). Reporting `updated` for that is a success message for
      // nothing — only flags change fields.
      console.log(Object.keys(parsed.fields).length === 0
        ? `provider "${id}": nothing to change (no flags given)`
        : `updated provider "${id}"`)
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
        d.error(`provider: no route "${id}" — create it first: i-harness provider add ${id} --base-url URL --protocol P`)
        return 1
      }
      const value = (await (options.readKey ?? readStdinLine)()).trim()
      if (value === "") {
        d.error("provider: no key on stdin")
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
    d.error(`provider: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}
