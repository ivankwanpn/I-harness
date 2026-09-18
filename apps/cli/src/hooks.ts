/**
 * `i-harness hooks` — the CLI face of the D1 grant
 * (docs/handoff/2026-09-18-prior-art-survey.md §4).
 *
 * The RULE lives in `@i-harness/hooks`: a declaration counts only when the
 * config is the harness home's own, and anything else needs its script hash
 * approved by the user. That rule was complete and unusable — a plugin's hook
 * could never be granted, because nothing existed that could grant one. This is
 * the surface that can, and it exists for the CLI's own reason: the CLI is the
 * development/test harness, so the grant has to be exercisable here.
 *
 * Shape follows `sessions.ts` — parse → gather → render → run, each piece pure
 * and separately testable — and it shares the store with the run path
 * (`resolveHookTrustPath`) so the two cannot disagree about where grants live.
 */

import { existsSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { resolveHarnessHome } from "@i-harness/harness-home"
import {
  createHookTrustStore,
  loadHooksConfig,
  resolveHookTrustPath,
  resolveHooksConfigPath,
  trustScriptPath,
  type LoadedHandler,
} from "@i-harness/hooks"
import { PluginRegistry } from "@i-harness/plugin-registry"

export interface HooksCommandOptions {
  configDir?: string
}

/**
 * `granted` — may run. `ungranted` — declared, never approved: neither enforced
 * nor blocking, reported once. `tampered` — approved, then the artifact changed:
 * a gate closes on it. The three are distinct because the responses are.
 */
export type HooksStatus = "granted" | "ungranted" | "tampered"

export interface ParsedHooksArgs {
  subcommand: "list" | "approve" | "revoke" | "help"
  target?: string
  error?: string
}

export interface DeclaredHookRow {
  /** Where the declaration came from: `home`, or the plugin id. */
  source: string
  id: string
  event: string
  script: string
  sha256: string
  status: HooksStatus
}

const HOOKS_USAGE =
  "usage: i-harness hooks <list|approve|revoke> [sha256]\n" +
  "  list              every declared handler, from the harness home and each enabled plugin\n" +
  "  approve <sha256>  grant one (a unique prefix is enough); the grant is of the SCRIPT's hash\n" +
  "  revoke <sha256>   take a grant back"

export function parseHooksArgs(args: string[]): ParsedHooksArgs {
  const sub = args[1]
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") return { subcommand: "help" }
  if (sub === "list") return { subcommand: "list" }
  if (sub === "approve" || sub === "revoke") {
    const target = args[2]
    if (target === undefined || target.trim() === "") {
      return { subcommand: "help", error: `${sub} requires a handler hash` }
    }
    return { subcommand: sub, target }
  }
  // An unknown token is NOT treated as a target: `hooks aproove <hash>` must not
  // silently do nothing, and it must not be read as an approval.
  return { subcommand: "help", error: `unknown hooks subcommand: ${sub}` }
}

function toRow(handler: LoadedHandler, source: string, configDir: string): DeclaredHookRow {
  return {
    source,
    id: handler.spec.id,
    event: handler.spec.event,
    script: trustScriptPath(handler.spec, configDir),
    sha256: handler.spec.trust.sha256,
    status: handler.valid ? "granted" : handler.unapproved === true ? "ungranted" : "tampered",
  }
}

/**
 * Every DECLARED handler, from both sources, with the verdict the loader reaches.
 *
 * The verdicts come from `loadHooksConfig` rather than being recomputed here —
 * a second implementation of "may this run?" is how the display and the gate
 * drift apart, and the display is what a human approves from.
 */
export async function listDeclaredHooks(opts: HooksCommandOptions = {}): Promise<DeclaredHookRow[]> {
  const store = createHookTrustStore(resolveHookTrustPath(opts.configDir))
  const rows: DeclaredHookRow[] = []

  const homeConfig = resolveHooksConfigPath(opts.configDir)
  if (existsSync(homeConfig)) {
    for (const handler of await loadHooksConfig(homeConfig, dirname(homeConfig), store)) {
      rows.push(toRow(handler, "home", dirname(homeConfig)))
    }
  }

  const root = join(resolveHarnessHome(opts.configDir), "plugins")
  // No state file ⇒ no enabled plugins ⇒ nothing to list, and the registry must
  // not be CONSTRUCTED to discover that: `loadStateSync` warns "state file is
  // missing or unreadable … rebuilding defaults" for an absent file, so on a
  // fresh machine every read-only `hooks list` announced rebuilding something
  // that was never there. Observed on the real machine before this guard.
  if (existsSync(join(root, "state.json"))) {
    for (const configPath of new PluginRegistry({ root }).runtimeInputs().hookConfigs) {
      // The id is the first path segment by construction — the registry builds
      // these as `<root>/<id>/hooks/hooks.json`. The label is cosmetic; the hash
      // is what a grant names.
      const id = relative(root, configPath).split(/[\\/]/)[0] ?? configPath
      for (const handler of await loadHooksConfig(configPath, dirname(configPath), store)) {
        rows.push(toRow(handler, id, dirname(configPath)))
      }
    }
  }
  return rows
}

export function renderHookTable(rows: DeclaredHookRow[]): string {
  if (rows.length === 0) {
    return "no hooks declared (nothing in <harness home>/hooks.json, and no enabled plugin ships hooks/)"
  }
  const lines = [`${rows.length} hook handler(s) declared:`, ""]
  for (const row of rows) {
    lines.push(`  ${row.status.padEnd(9)} ${row.id}  [${row.event}]`)
    lines.push(`            source: ${row.source}`)
    lines.push(`            script: ${row.script}`)
    // Printed in full: this is the string `approve` takes.
    lines.push(`            sha256: ${row.sha256}`)
    lines.push("")
  }
  lines.push("grant a plugin's handler with:  i-harness hooks approve <sha256>")
  return lines.join("\n")
}

export async function runHooksCommand(args: string[]): Promise<number> {
  const parsed = parseHooksArgs(args)
  if (parsed.error !== undefined) {
    console.error(`hooks: ${parsed.error}`)
    console.error(HOOKS_USAGE)
    return 1
  }
  if (parsed.subcommand === "help") {
    console.error(HOOKS_USAGE)
    return 0
  }
  if (parsed.subcommand === "list") {
    console.log(renderHookTable(await listDeclaredHooks()))
    return 0
  }

  // approve / revoke name a handler by hash, or by a prefix unique among what is
  // DECLARED. Prefixes are resolved here rather than by the store because the
  // store is keyed by the full hash and must stay that way — an ambiguous prefix
  // fails loudly instead of granting one of several.
  const target = parsed.target!
  const matches = (await listDeclaredHooks()).filter((row) => row.sha256.startsWith(target))
  const distinct = [...new Set(matches.map((row) => row.sha256))]
  if (distinct.length === 0) {
    console.error(`hooks: no declared handler matches ${target}`)
    return 1
  }
  if (distinct.length > 1) {
    console.error(`hooks: ${target} is ambiguous — it matches ${distinct.length} declared handlers`)
    return 1
  }

  const hash = distinct[0]!
  const store = createHookTrustStore(resolveHookTrustPath())
  if (parsed.subcommand === "approve") {
    const row = matches[0]!
    store.approve({ sha256: hash, script: row.script, handlerId: row.id })
    console.log(`approved ${row.id} (${row.source})\n  sha256: ${hash}`)
    return 0
  }
  store.revoke(hash)
  console.log(`revoked ${hash}`)
  return 0
}
