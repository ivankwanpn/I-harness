/**
 * `i-harness models` — the model tree of the provider lifecycle
 * (docs/superpowers/specs/2026-09-19-provider-lifecycle-design.md §4).
 *
 * `probe` is the ONLY verb here that touches the network, and it WRITES
 * NOTHING — that split is the whole reason `probeModels` exists beside
 * `discoverModels`. What the user's flow called "multi-select" is `add` with
 * several ids.
 *
 * Shape follows `sessions.ts` and `hooks.ts`.
 */

import { listModelCatalogFamily, resolveModelCard, type ModelCard } from "@i-harness/provider"
import type { ProviderRuntime, ProviderRuntimeEntry } from "@i-harness/provider-runtime"
import type { SettingsModel } from "@i-harness/settings"
import { PROVIDER_PROTOCOLS, type CliProtocol } from "./provider.ts"
import { loadProviderRuntime } from "./provider-runtime.ts"

/** A parsed `--context-window` / `--max-tokens` argument. `auto` CLEARS the
 * override and falls back to the card — without it, a number once written
 * could never be taken back. */
export type TokenValue = { kind: "value"; value: number } | { kind: "clear" } | { kind: "error"; message: string }

/** The two arms a PARSED flag can actually hold. `parseModelsArgs` returns
 * before it assigns anything when a value is malformed, so `error` never lands
 * in `values` — and saying so in the type is what keeps every reader of
 * `values` from having to re-prove it. */
export type SettableTokenValue = Exclude<TokenValue, { kind: "error" }>

export function parseTokenValue(raw: string): TokenValue {
  const normalized = raw.trim().toLowerCase()
  if (normalized === "auto") return { kind: "clear" }
  // `_` may separate digits exactly where a JS numeric literal allows it, so
  // `1_000_000` is the same number as `1000000` — not a separate spelling.
  const match = /^(\d(?:_?\d)*)([km]?)$/.exec(normalized)
  if (match === null) return { kind: "error", message: `expected a positive integer, k/m suffix, or "auto"; got "${raw}"` }
  // `k` is the BINARY kilo: every 128K context window is 131,072 tokens, and
  // the design's own walkthrough writes `--context-window 128k` and reports
  // `contextWindow 131,072` (design §6). `m` is the decimal million.
  const scale = match[2] === "k" ? 1_024 : match[2] === "m" ? 1_000_000 : 1
  const value = Number(match[1]!.replaceAll("_", "")) * scale
  if (!Number.isSafeInteger(value) || value <= 0) return { kind: "error", message: `not a positive token count: "${raw}"` }
  return { kind: "value", value }
}

export interface ModelValues {
  contextWindow?: SettableTokenValue
  maxTokens?: SettableTokenValue
  /** A settings protocol name, or `null` for `auto` (clear the row's override
   * and fall back to the route's default — NOT to the hard-coded one). */
  protocol?: CliProtocol | null
  /** `use`'s reasoning effort. Not validated here: the settings schema holds the
   * closed set and a session resolving the model is where it is checked — the
   * CLI's job is to pass the user's word through without inventing one. */
  reasoningEffort?: string
}

/** What a parsed flag becomes on the way to the runtime: a number, `null` to
 * CLEAR (`setModel`'s own rule), or absent (leave alone). */
interface ModelFieldValues {
  contextWindow?: number | null
  maxTokens?: number | null
  protocol?: CliProtocol | null
}

/** One row for `addModels`. A SETTINGS row has no `null` — a field is present
 * or absent — so the nulls `setModel` uses to delete are dropped here: on a
 * NEW row, `auto` means "no override", which is exactly absence. */
function rowFor(modelId: string, fields: ModelFieldValues): SettingsModel {
  return {
    id: modelId,
    ...(fields.contextWindow !== undefined && fields.contextWindow !== null ? { contextWindow: fields.contextWindow } : {}),
    ...(fields.maxTokens !== undefined && fields.maxTokens !== null ? { maxTokens: fields.maxTokens } : {}),
    ...(fields.protocol !== undefined && fields.protocol !== null ? { protocol: fields.protocol } : {}),
  }
}

export interface ParsedModelsArgs {
  subcommand: "list" | "probe" | "add" | "set" | "rm" | "use" | "refresh" | "help"
  route?: string
  ids: string[]
  values: ModelValues
  error?: string
}

const MODELS_USAGE =
  "usage: i-harness models <list|probe|add|set|rm|use|refresh> [args]\n" +
  "  [<route>]                                 what each model resolves, and whether the route can be probed\n" +
  "  probe <route> [--protocol P]              ask the endpoint what it offers — WRITES NOTHING; P shapes this request only\n" +
  "  add <route> <id...> [--protocol P] [--context-window V] [--max-tokens V]\n" +
  "  set <route> <id>    [--protocol P] [--context-window V] [--max-tokens V]\n" +
  "  rm <route> <id>\n" +
  "  use <route>:<model> [--reasoning-effort E]   replaces the whole default selection: omitted E clears it\n" +
  "  refresh <route>                           probe and merge everything it returns\n" +
  "  V = 131072 | 128k | 1m | auto    (auto clears the override, falling back to the card)\n" +
  "  P = one of the five protocols | auto  (auto clears the row's override — the route's own protocol then applies, and a route that declares none refuses at send)"

/** Which flags each verb READS. The design's §4 table is the source: `--protocol`
 * belongs to probe/add/set, `--context-window`/`--max-tokens` to add/set (a row's
 * numbers), `--reasoning-effort` to use (the default model's). */
const MODELS_FLAGS: Record<ParsedModelsArgs["subcommand"], readonly (keyof ModelValues)[]> = {
  list: [],
  probe: ["protocol"],
  add: ["protocol", "contextWindow", "maxTokens"],
  set: ["protocol", "contextWindow", "maxTokens"],
  rm: [],
  use: ["reasoningEffort"],
  refresh: [],
  help: [],
}

const FLAG_NAMES: Record<keyof ModelValues, string> = {
  contextWindow: "--context-window",
  maxTokens: "--max-tokens",
  protocol: "--protocol",
  reasoningEffort: "--reasoning-effort",
}

export function parseModelsArgs(args: string[]): ParsedModelsArgs {
  const rest = args.slice(1)
  const values: ModelValues = {}
  const positional: string[] = []
  let subcommand: ParsedModelsArgs["subcommand"] = "list"

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]!
    if (token === "--context-window" || token === "--max-tokens") {
      const raw = rest[i + 1]
      if (raw === undefined) return { subcommand: "help", ids: [], values: {}, error: `${token} needs a value` }
      i += 1
      const parsed = parseTokenValue(raw)
      if (parsed.kind === "error") return { subcommand: "help", ids: [], values: {}, error: parsed.message }
      if (token === "--context-window") values.contextWindow = parsed
      else values.maxTokens = parsed
      continue
    }
    if (token === "--protocol") {
      const raw = rest[i + 1]
      if (raw === undefined) return { subcommand: "help", ids: [], values: {}, error: "--protocol needs a value" }
      i += 1
      // `auto` clears the row's override, falling back to the ROUTE's default.
      // The hard-coded `openai-completions` arm is never a destination the CLI
      // can name — it is the failure mode, not a choice.
      if (raw === "auto") { values.protocol = null; continue }
      if (!(PROVIDER_PROTOCOLS as readonly string[]).includes(raw)) {
        return { subcommand: "help", ids: [], values: {}, error: `unknown protocol "${raw}"; expected one of: ${PROVIDER_PROTOCOLS.join(" | ")} | auto` }
      }
      values.protocol = raw as CliProtocol
      continue
    }
    if (token === "--reasoning-effort") {
      const raw = rest[i + 1]
      if (raw === undefined) return { subcommand: "help", ids: [], values: {}, error: "--reasoning-effort needs a value" }
      i += 1
      values.reasoningEffort = raw
      continue
    }
    if (token.startsWith("-")) return { subcommand: "help", ids: [], values: {}, error: `unknown flag: ${token}` }
    if (positional.length === 0 && ["list", "probe", "add", "set", "rm", "use", "refresh"].includes(token)) {
      subcommand = token as ParsedModelsArgs["subcommand"]
      continue
    }
    positional.push(token)
  }

  // A flag a verb cannot READ is refused rather than dropped — `rm gw x
  // --protocol gemini` used to delete the row and say nothing about the flag it
  // ignored, which is the same "exit 0 having done something other than what was
  // asked" the probe override had. The design's §4 table is the source of the
  // rule below. Checked AFTER the scan: a flag may still precede the verb
  // (`models --protocol P set gw a`), and by here the verb is known.
  const misplaced = (Object.keys(values) as Array<keyof ModelValues>)
    .find((key) => !MODELS_FLAGS[subcommand].includes(key))
  if (misplaced !== undefined) {
    const takers = (Object.keys(MODELS_FLAGS) as ParsedModelsArgs["subcommand"][])
      .filter((verb) => MODELS_FLAGS[verb].includes(misplaced))
    return {
      subcommand: "help", ids: [], values: {},
      error: `${FLAG_NAMES[misplaced]} is not a flag of "${subcommand}"; it belongs to: ${takers.join(", ")}`,
    }
  }

  if (subcommand === "list") {
    if (positional.length > 1) return { subcommand: "help", ids: [], values: {}, error: "unexpected extra argument" }
    if (positional.length > 0) return { subcommand, route: positional[0], ids: [], values }
    return { subcommand, ids: [], values }
  }
  if (subcommand === "use") {
    if (positional.length !== 1) return { subcommand: "help", ids: [], values: {}, error: "use takes <route>:<model>" }
    const token = positional[0]!
    const separator = token.indexOf(":")
    if (separator === -1) return { subcommand: "help", ids: [], values: {}, error: `use needs provider:model; got "${token}"` }
    // BOTH halves must name something AFTER TRIMMING. `use gw:` used to be
    // accepted and wrote { provider: "gw", model: "" } with a success message —
    // a typo (or a script's unset $MODEL) destroyed a working default, and the
    // next run reported "No model configured". `use "gw: "` then walked past
    // that guard and wrote a one-space model id. The TRIMMED halves are what
    // this returns, so surrounding whitespace never becomes part of an id.
    const providerId = token.slice(0, separator).trim()
    const modelId = token.slice(separator + 1).trim()
    if (providerId === "" || modelId === "") {
      return { subcommand: "help", ids: [], values: {}, error: `use needs BOTH a provider and a model; got "${token}"` }
    }
    return { subcommand, route: `${providerId}:${modelId}`, ids: [], values }
  }
  if (subcommand === "probe" || subcommand === "refresh") {
    if (positional.length !== 1) return { subcommand: "help", ids: [], values: {}, error: `${subcommand} takes exactly one route` }
    return { subcommand, route: positional[0], ids: [], values }
  }
  if (subcommand === "rm") {
    if (positional.length !== 2) return { subcommand: "help", ids: [], values: {}, error: "rm takes exactly one model id" }
    return { subcommand, route: positional[0], ids: [positional[1]!], values }
  }
  // add / set
  if (positional.length < 2) return { subcommand: "help", ids: [], values: {}, error: `${subcommand} takes a route and at least one model id` }
  if (subcommand === "set" && positional.length !== 2) return { subcommand: "help", ids: [], values: {}, error: "set takes exactly one model id" }
  return { subcommand, route: positional[0], ids: positional.slice(1), values }
}

/** What `probe` sends as its one-request protocol override (design §4): it
 * shapes THIS request's auth headers and lands nowhere. `auto` (`null`) means
 * "the route's protocol decides", which is also what a probe does with no flag
 * at all — so on a request that writes nothing it passes no override rather
 * than being refused. */
export function probeRequestFor(values: ModelValues): { protocol?: CliProtocol } {
  return values.protocol === null || values.protocol === undefined ? {} : { protocol: values.protocol }
}

export interface ModelsRouteView {
  id: string
  cardFamily: string
  declared: boolean
  /** Absent = the route declares no protocol OF ITS OWN. NOT "it refuses to
   * resolve": resolution falls through to the model row and the selection
   * before it refuses (`renderModels` below says so on the line it prints), so
   * this field's absence is a fact about the route, not a verdict on the route.
   * Optional here because the value rides straight off `directory()`. */
  protocol?: string
  /** Whether the route's endpoint can be probed at all — `directory()`'s own
   * answer (bedrock is manual-only). Spec §4's read shows 能不能 discovery. */
  discovery: "available" | "manual-only"
  models: Array<{ id: string; card: ModelCard | undefined; aliases: string[]; protocol?: string }>
}

export function renderModels(routes: readonly ModelsRouteView[]): string {
  if (routes.length === 0) return "no provider routes configured"
  const lines: string[] = []
  const cardless: string[] = []
  for (const route of routes) {
    // A route with no declared protocol of its own is not a route with a
    // default one, and not a verdict on usability either: resolution tries the
    // selection, then the model row, then the route
    // (provider-runtime/src/index.ts:632 feeds :741), so this route still
    // resolves when a row or a selection names a wire — the row's own protocol
    // prints on its own line below. Same sentence as `provider list`'s, and the
    // same metavariable — naming ONE protocol would pick a wire for a user who
    // never chose one. `[undefined]` is the rendering accident this line
    // printed the moment Task 1 made the field optional.
    const wire = route.protocol === undefined
      ? `no protocol of its own — set one with: i-harness provider set ${route.id} --protocol <one of: ${PROVIDER_PROTOCOLS.join(" | ")}>`
      : route.protocol
    lines.push(`${route.id}  [${wire}]  discovery: ${route.discovery}  card family: ${route.cardFamily} (${route.declared ? "declared" : "the route name"})`)
    // Same rule as `provider list`'s hint, and the same two refusing states:
    // `models probe` refuses on a route that declares no protocol (nothing to
    // shape the request with) and on one whose discovery is manual-only
    // (bedrock has no discovery endpoint — provider-runtime/src/index.ts:246
    // throws it). Each state names the verb that can actually run; a declared
    // protocol with discovery available keeps the probe hint it always had.
    if (route.models.length === 0) {
      lines.push(route.protocol === undefined
        ? `  (no models — declare a protocol first: i-harness provider set ${route.id} --protocol <one of: ${PROVIDER_PROTOCOLS.join(" | ")}>)`
        : route.discovery === "manual-only"
          ? `  (no models — discovery is unavailable for this route; add one: i-harness models add ${route.id} <id...>)`
          : `  (no models — try: i-harness models probe ${route.id})`)
    }
    for (const model of route.models) {
      const numbers = model.card?.contextWindow !== undefined
        ? `${model.card.contextWindow}${model.card.maxOutputTokens !== undefined ? ` / ${model.card.maxOutputTokens}` : ""}`
        : "no card"
      // The ROW's protocol matters only where it DIVERGES from the route's: the
      // route line above already printed the inherited answer, and a row that
      // overrode nothing is not making a statement. This is the read half of
      // `models set --protocol`, which was invisible before it.
      const ownProtocol = model.protocol !== undefined && model.protocol !== route.protocol
        ? `  protocol: ${model.protocol}`
        : ""
      lines.push(`  ${model.id}  (${numbers})${ownProtocol}${model.aliases.length > 0 ? `  +retired: ${model.aliases.join(", ")}` : ""}`)
    }
    // The D1/D2 symptom, said out loud: a route whose family resolves nothing
    // is exactly the state that used to fail silently.
    if (route.models.length > 0 && route.models.every((model) => model.card === undefined)) cardless.push(route.id)
    lines.push("")
  }
  if (cardless.length > 0) {
    lines.push(`no card resolves for: ${cardless.join(", ")} — declare \`catalog\` on the route, or add the family to model-catalog.json`)
  }
  return lines.join("\n")
}

async function viewOf(runtime: ProviderRuntime): Promise<ModelsRouteView[]> {
  const rows = await runtime.directory()
  return rows
    .map((row) => {
      const family = listModelCatalogFamily(row.cardFamily)
      return {
        id: row.id,
        cardFamily: row.cardFamily,
        declared: row.catalog !== undefined,
        protocol: row.protocol,
        discovery: row.discovery,
        models: row.models.map((model) => {
          const own = family.find((entry) => entry.modelId === model.id)
          // BOTH directions matter. A row that IS the current name carries its
          // retired names; a row that is ITSELF retired says which name it is —
          // and that second direction is what tells a user holding
          // `deepseek-v4-flash` why it still resolves (design §1.2).
          const owner = own === undefined ? family.find((entry) => entry.aliases.includes(model.id)) : undefined
          return {
            id: model.id,
            card: own?.card ?? owner?.card,
            aliases: own?.aliases ?? (owner !== undefined ? [`alias of ${owner.modelId}`] : []),
            ...(model.protocol !== undefined ? { protocol: model.protocol } : {}),
          }
        }),
      }
    })
}

/** Spec §5: a `--max-tokens` ABOVE the card's `maxOutputTokens` WARNS and does
 * not block (exit stays 0). The card is a documented limit, not a wall — the
 * standing stance is no clamping, failing loud at the model end instead — so
 * this only says what the write did. `auto` (a clear) writes no number, and an
 * unknown route has no card to compare against (its own verb will refuse). */
function warnAboveCard(
  entry: ProviderRuntimeEntry | undefined,
  modelIds: readonly string[],
  maxTokens: SettableTokenValue | undefined,
): void {
  if (entry === undefined || maxTokens === undefined || maxTokens.kind === "clear") return
  for (const modelId of modelIds) {
    const cap = resolveModelCard(entry.cardFamily, modelId)?.maxOutputTokens
    if (cap !== undefined && maxTokens.value > cap) {
      console.error(`models: warning — "${modelId}" maxTokens ${maxTokens.value} is above its card's maxOutputTokens ${cap}; the card documents the limit, it does not enforce it`)
    }
  }
}

export async function runModelsCommand(args: string[]): Promise<number> {
  const parsed = parseModelsArgs(args)
  if (parsed.error !== undefined) {
    console.error(`models: ${parsed.error}`)
    console.error(MODELS_USAGE)
    return 1
  }
  if (parsed.subcommand === "help") {
    console.error(MODELS_USAGE)
    return 0
  }

  const { runtime } = await loadProviderRuntime()
  const fields: ModelFieldValues = {
    ...(parsed.values.contextWindow !== undefined
      ? { contextWindow: parsed.values.contextWindow.kind === "clear" ? null : parsed.values.contextWindow.value }
      : {}),
    ...(parsed.values.maxTokens !== undefined
      ? { maxTokens: parsed.values.maxTokens.kind === "clear" ? null : parsed.values.maxTokens.value }
      : {}),
    ...(parsed.values.protocol !== undefined ? { protocol: parsed.values.protocol } : {}),
  }

  try {
    if (parsed.subcommand === "list") {
      const routes = await viewOf(runtime)
      const selected = parsed.route === undefined ? routes : routes.filter((item) => item.id === parsed.route)
      // "no routes configured" and "no route by THAT name" are different
      // sentences for different problems — a typo'd route used to print the
      // first, which reads as "your configuration is empty" while it was not.
      if (selected.length === 0 && parsed.route !== undefined) {
        console.log(routes.length === 0
          ? "no provider routes configured"
          : `no route "${parsed.route}" — configured routes: ${routes.map((item) => item.id).join(", ")}`)
        return 0
      }
      console.log(renderModels(selected))
      return 0
    }
    const route = parsed.route!
    if (parsed.subcommand === "probe") {
      const models = await runtime.probeModels(route, probeRequestFor(parsed.values))
      console.log(`${models.length} model(s) found — NOTHING was written:`)
      // The card family is a property of the ROUTE, not of each model: ONE
      // directory() read, not one per row (this used to call directory() inside
      // the loop, N+1 reads of the same answer).
      const family = (await runtime.directory()).find((row) => row.id === route)?.cardFamily ?? route
      for (const model of models) {
        const card = resolveModelCard(family, model.id)
        console.log(`  ${model.id}  ${card?.contextWindow !== undefined ? `card ${card.contextWindow}` : "no card"}`)
      }
      if (models.length > 0) console.log(`next: i-harness models add ${route} <id> ...`)
      return 0
    }
    if (parsed.subcommand === "refresh") {
      const models = await runtime.discoverModels(route, { force: true })
      console.log(`refreshed "${route}": ${models.length} model(s) now in its list`)
      return 0
    }
    if (parsed.subcommand === "add") {
      // Which ids already existed is REPORTED, because `addModels` follows the
      // merge rule and a silently-ignored --context-window would be exactly the
      // kind of quiet wrong answer this repo keeps measuring. The wording says
      // what the merge ACTUALLY does: `{...addition, ...existing}` keeps the
      // fields the existing row HAS, so a bare row (one with no numbers of its
      // own) still absorbs the flags — "left alone" was false in that direction.
      const entry = (await runtime.directory()).find((row) => row.id === route)
      const before = new Set(entry?.models.map((model) => model.id) ?? [])
      const already = parsed.ids.filter((modelId) => before.has(modelId))
      const models = await runtime.addModels(route, parsed.ids.map((modelId) => rowFor(modelId, fields)))
      // AFTER the write: the warning is about a value that was written, so a
      // refused add must not warn about one that was not.
      warnAboveCard(entry, parsed.ids, parsed.values.maxTokens)
      console.log(`"${route}": ${models.length} model(s)`)
      if (already.length > 0) {
        console.log(`  already present: ${already.join(", ")} — their own values win where set; the flags fill only the gaps. Use \`models set\` to change one.`)
      }
      return 0
    }
    if (parsed.subcommand === "set") {
      const entry = (await runtime.directory()).find((row) => row.id === route)
      await runtime.setModel(route, parsed.ids[0]!, fields)
      // AFTER the write — see the add branch.
      warnAboveCard(entry, parsed.ids, parsed.values.maxTokens)
      // No flags = `setModel` writes the row back unchanged; it still proves
      // the row exists, which is why the call stays.
      console.log(Object.keys(fields).length === 0
        ? `"${route}"/"${parsed.ids[0]}": nothing to change (no flags given)`
        : `"${route}"/"${parsed.ids[0]}" updated`)
      return 0
    }
    if (parsed.subcommand === "rm") {
      await runtime.removeModel(route, parsed.ids[0]!)
      console.log(`"${route}"/"${parsed.ids[0]}" removed`)
      return 0
    }
    const separator = route.indexOf(":")
    await runtime.setDefaultModel({
      provider: route.slice(0, separator),
      model: route.slice(separator + 1),
      ...(parsed.values.reasoningEffort !== undefined ? { reasoningEffort: parsed.values.reasoningEffort } : {}),
    })
    // `use` REPLACES the whole selection, so the effort is printed even when
    // there is none: re-running the verb to change the model silently cleared
    // an effort set earlier, and the printed result is what makes that visible
    // (the alternative rejected in review was a getter on the runtime API).
    console.log(`default model: ${route} (reasoning effort: ${parsed.values.reasoningEffort ?? "none"})`)
    return 0
  } catch (error) {
    console.error(`models: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}
