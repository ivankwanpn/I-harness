/**
 * `i-harness plugins` — the CLI face of the plugin runtime-state vocabulary
 * (owner ruling 2026-09-21, recorded in
 * docs/superpowers/research/2026-09-21-m6-precedent-synthesis.md row #8).
 *
 *   i-harness plugins [list] [--json]
 *
 * WHY THIS EXISTS. The registry has carried `state.json`, the catalog merge and
 * the readiness evaluator since the frontends were removed, with ZERO production
 * consumers: nothing could show what was installed, and the price of that
 * invisibility was the D-MCP-1 week — every plugin's MCP server silently failed
 * to mount and the only trace was one warn line inside a run. The owner's ruling
 * is this report face, and it exists for the CLI's own reason: the CLI is the
 * host that exists today (backend before frontend).
 *
 * The shape follows `sessions.ts` / `hooks.ts` — parse → gather → render → run,
 * each piece pure and separately testable — and it reads the SAME store the run
 * path reads: the registry root `run.ts` builds (`<harness home>/plugins`,
 * apps/cli/src/run.ts:451) and the same per-plugin paths `runtimeInputs()`
 * touches. The merge is `catalog()` (state × marketplace manifests) and the
 * verdicts are `evaluatePlugin`'s — this file adds no rule of its own beyond
 * deciding what may be printed (below).
 *
 * READ-ONLY, deliberately: no install/enable/disable verbs. The same owner
 * ruling names those a separate decision, and a list that grew a mutation verb
 * would be a different unit wearing this one's name.
 *
 * ── THE OBSERVATIONS DECISION (the crux) ────────────────────────────────────
 * `evaluatePlugin` is a pure function over (record × capabilities ×
 * observations), and its observations are what a LIVE host observed. A listing
 * process has no live session, and the observation set splits in two:
 *
 *   VERIFIABLE HERE — the input is an artifact on disk, read exactly the way the
 *   run path reads it (no session involved):
 *     · skills  — the `<root>/skills/<id>` overlay is the directory a live build
 *                 scans back by path (`runtimeInputs().skillDirs`), and this
 *                 process runs the SAME SCANNER over it: `createSkillRegistry`
 *                 with the overlay as an extraDir, which is the very call the
 *                 assembly's `skills.extraDirs` mount goes through. So "ready"
 *                 means the same thing on both sides — a stray `README.md`, a
 *                 `.gitkeep`-only directory, a bare overlay-root `SKILL.md` or a
 *                 broken file all read NOT-ready here exactly as they yield
 *                 nothing in a session. Counting directory entries instead would
 *                 be a second implementation of "is this a skill?" — measured
 *                 false-readies are why it is not.
 *     · agents / hooks — `evaluate.ts` states these need NO observation:
 *                 advertising the dimension IS the claim, because the registry
 *                 reads the installed copy synchronously itself.
 *     · executable — a package-level fact (D2): always "unsupported".
 *   NOT VERIFIABLE HERE — the fact exists only inside a live session:
 *     · commands — `ready` means the name was actually REGISTERED into the
 *                 interaction catalog by an agent build. Nothing on disk records
 *                 whether that happened.
 *     · mcp — `ready` means a session CONNECTED. A listing has no sessions and
 *                 dials nothing.
 *
 * So this command fills the halves it can prove, calls `evaluatePlugin` ONCE
 * with `initialized: true`, and replaces the two live-session verdicts with
 * `not-evaluated`. Why replace rather than print what the evaluator returns:
 * handed empty `commandNames` / `connectedMcpServers` it reads `failed` for
 * both — a failure THIS process invented because it mounts nothing, which is
 * the D-MCP-1 false-signal class pointed the other way. `not-evaluated` is
 * deliberately NOT the evaluator's `pending`: `pending` means "the host's first
 * probe has not completed", i.e. a probe is coming — this process never probes.
 * The replacement never adds a claim; it withdraws two the inputs cannot
 * support, and it touches ONLY dimensions the package advertises (an
 * unadvertised dimension reads `unsupported`, which is a disk-provable fact
 * about the package, and stays the evaluator's word).
 *
 * The overall readiness is printed only when a static input PROVES it, and the
 * proof is the evaluator's own precedence, never a parallel re-implementation:
 *   · `disabled`            — state.json says so (the evaluator's early return).
 *   · the evaluator's word  — verbatim, when NO live-session dimension is
 *                             advertised: every input that verdict consumed was
 *                             static, so nothing in it can change in a session.
 *   · `failed`              — when the skills dimension failed: the evaluator's
 *                             chain makes that failure dominate whatever a live
 *                             session would add.
 *   · `not-evaluated`       — otherwise (a live dimension is advertised).
 * `degraded` is unreachable here ON PURPOSE: the only arm that produces it
 * consumes a live input (the commands dimension's registered-name set), so this
 * listing has no member for it — the refusal is about the INPUT, not about the
 * arm being undecidable in principle.
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import { resolveHarnessHome } from "@i-harness/harness-home"
import { createSkillRegistry } from "@i-harness/skills"
import {
  PluginRegistry,
  describeCommands,
  evaluatePlugin,
  inspectCapabilities,
  readMcpServersSync,
  type Capabilities,
  type CatalogPlugin,
  type CommandConflict,
  type EvaluateResult,
  type Observations,
  type PluginRecord,
} from "@i-harness/plugin-registry"

/** The six dimensions the evaluator reports. */
export type PluginDimension = "skills" | "commands" | "mcp" | "agents" | "hooks" | "executable"

/**
 * A dimension's status as this listing may print it: the evaluator's own words
 * (see evaluate.ts) plus `not-evaluated`, which is NOT the evaluator's
 * vocabulary — it is this listing's marker for a live-session dimension whose
 * verdict no process without a session can produce. `pending` stays in the union
 * because it is part of the shape this listing consumes; it is never produced
 * here (`initialized` is always true).
 */
export type DimensionStatus = "ready" | "pending" | "failed" | "unsupported" | "disabled" | "not-evaluated"

/** The overall readiness this listing may print (module doc: why no `degraded`). */
export type PluginStatus = "disabled" | "failed" | "ready" | "not-evaluated"

/** One installed plugin, as this listing can honestly report it. */
export interface PluginListRow {
  id: string
  marketplace: string
  name: string
  installed: boolean
  enabled: boolean
  status: PluginStatus
  dimensions: Record<PluginDimension, DimensionStatus>
  /** Command names the plugin declares, from the MATERIALIZED copy
   * (`<root>/commands/<id>`, laid down by enable) ∪ its recorded conflicts.
   * SOURCING NOTE — the two declared lists are NOT symmetric, and deliberately
   * so: materialization is enable-time state, so a DISABLED plugin reports `[]`
   * here (the overlay is removed on disable), while `declaredMcpServers` below
   * survives — see its own note. */
  declaredCommands: string[]
  /** The plugin's MCP server keys, read from the INSTALLED copy
   * (`<root>/<id>/.mcp.json`), which survives disable — this is why a disabled
   * plugin still declares its servers. The install step re-keyed them to
   * `plugin:<id>:<server>`, the same keys `runtimeInputs()` hands the host. */
  declaredMcpServers: string[]
  /** Commands blocked at enable time (D5), as recorded on the registry record. */
  conflicts: CommandConflict[]
  /** Declarations this host does not honour, in the run path's own words. */
  diagnostics: string[]
}

/** The listing: the root it read (the run path's own root) and the rows. */
export interface PluginListing {
  /** `<harness home>/plugins` — named like `sessions`' `storeRoot` so the two
   * listings read alike on the wire and on stdout. */
  pluginsRoot: string
  plugins: PluginListRow[]
}

export interface ParsedPluginsArgs {
  subcommand: "list" | "help"
  json?: boolean
  error?: string
}

/** The registry's lifecycle verbs. They exist (on the class) and are NOT this
 * command's: a report face that accepted one would be a mutation verb wearing a
 * listing's name. Refused BY NAME so the refusal teaches where the ruling is. */
const LIFECYCLE_VERBS = new Set(["install", "uninstall", "enable", "disable", "add", "remove", "refresh"])

export function parsePluginsArgs(args: string[]): ParsedPluginsArgs {
  const rest = args.slice(1) // drop the `plugins` token
  let json = false
  for (const token of rest) {
    if (token === "list") continue
    if (token === "--json") { json = true; continue }
    if (token === "help" || token === "--help" || token === "-h") return { subcommand: "help" }
    if (LIFECYCLE_VERBS.has(token)) {
      return {
        subcommand: "help",
        error: `\`${token}\` is a plugin lifecycle verb and this listing is read-only (install/enable/disable are a separate decision)`,
      }
    }
    return { subcommand: "help", error: `unknown plugins argument: ${token}` }
  }
  return { subcommand: "list", ...(json ? { json: true } : {}) }
}

const NOT_EVALUATED: DimensionStatus = "not-evaluated"
const NOT_EVALUATED_TEXT = "not evaluated here (needs a live session)"

/** The evaluator's record shape, from a merged catalog row. `installPath` is
 * the registry's own layout (`<root>/<id>` — what install() records and what
 * `runtimeInputs()` reads back); the evaluator itself consumes only
 * id/enabled/conflicts, so nothing here is a second source of truth. */
function recordFor(root: string, entry: CatalogPlugin): PluginRecord {
  return {
    id: entry.id,
    marketplace: entry.marketplace,
    name: entry.name,
    installPath: join(root, entry.id),
    installed: entry.installed,
    enabled: entry.enabled,
    ...(entry.conflicts !== undefined ? { conflicts: entry.conflicts } : {}),
  }
}

/** Per-dimension statuses this listing may print (module doc). */
function dimensionsFor(verdict: EvaluateResult, caps: Capabilities, enabled: boolean): Record<PluginDimension, DimensionStatus> {
  const reported = verdict.capabilities
  if (!enabled) {
    // Every verdict the evaluator reached for a disabled plugin came from
    // state.json and the package — nothing live was involved, so all of its
    // words stand as-is.
    return {
      skills: reported.skills,
      commands: reported.commands,
      mcp: reported.mcp,
      agents: reported.agents,
      hooks: reported.hooks,
      executable: reported.executable,
    }
  }
  return {
    skills: reported.skills,
    commands: caps.commands ? NOT_EVALUATED : reported.commands,
    mcp: caps.mcp ? NOT_EVALUATED : reported.mcp,
    agents: reported.agents,
    hooks: reported.hooks,
    executable: reported.executable,
  }
}

/** The overall readiness this listing may print (module doc, the four arms). */
function overallStatus(verdict: EvaluateResult, caps: Capabilities, enabled: boolean): PluginStatus {
  if (!enabled || verdict.overall === "disabled") return "disabled"
  if (!caps.commands && !caps.mcp) {
    // No live-session dimension is advertised: every input this verdict
    // consumed was static, so the evaluator's own word is provable.
    if (verdict.overall === "ready") return "ready"
    if (verdict.overall === "failed") return "failed"
    return "not-evaluated" // unreachable today; named rather than assumed
  }
  // A live dimension IS advertised. The evaluator's `failed` here cannot be
  // trusted (this process fed it empty live sets) — except when a static
  // dimension failed, which its precedence makes dominate.
  return verdict.capabilities.skills === "failed" ? "failed" : "not-evaluated"
}

/** One installed catalog row → the row this listing prints. */
function evaluateInstalled(root: string, entry: CatalogPlugin): PluginListRow {
  const caps = entry.capabilities ?? inspectCapabilities(join(root, entry.id))
  // The run path's own per-plugin paths (run.ts:474-493): the materialized
  // command descriptors, the materialized skills overlay, and the installed
  // copy's MCP config. No second layout.
  const commandDescriptors = describeCommands(join(root, "commands", entry.id))
  // The evaluator's contract for this input: the FULL expected set, blocked
  // names included (the copy already holds them; the union keeps a recorded
  // conflict visible even if the copy lost its file).
  const declaredCommands = [...new Set([
    ...commandDescriptors.map((d) => d.name),
    ...(entry.conflicts ?? []).map((c) => c.name),
  ])].sort()

  const diagnostics: string[] = []
  for (const d of commandDescriptors) {
    if (d.unsupported !== undefined) {
      // The run path's own sentence (run.ts:471), so the listing and the run
      // path cannot disagree about what "unsupported" means.
      diagnostics.push(`command ${d.name} declares unsupported frontmatter: ${d.unsupported.join(", ")}`)
    }
  }

  let declaredMcpServers: string[] = []
  try {
    declaredMcpServers = Object.keys(readMcpServersSync(join(root, entry.id))).sort()
  } catch (error) {
    // A malformed .mcp.json in the installed copy: the run path warns and
    // carries on (runtimeInputs catches the same error). A listing must not
    // fail whole over one broken config — it must SHOW it.
    diagnostics.push(`MCP config unreadable: ${error instanceof Error ? error.message : String(error)}`)
  }

  // Skills: the SAME SCANNER the live build runs over this overlay, not a
  // second implementation of "is this entry a skill?". The live mount hands the
  // overlay to the skill registry as an extraDir (assembly's `skills.extraDirs`,
  // fed by `runtimeInputs().skillDirs`); this is that call. Counting directory
  // entries instead printed `ready` for a stray README.md, a `.gitkeep`-only
  // directory or a broken SKILL.md — a false signal in the exact class this
  // whole command exists to stop sending.
  const skillNamesByDir = new Map<string, string[]>()
  const skillsDir = join(root, "skills", entry.id)
  if (existsSync(skillsDir)) {
    const scanner = createSkillRegistry({
      // Only this overlay is passed. The registry also walks the machine-level
      // global root (dropped below by `source`) and, when given one, a
      // workspace — deliberately absent here: the overlay is a machine-level
      // root and the live mount adds it as an extraDir, nothing more.
      extraDirs: [skillsDir],
      // The scanner's warn+skip channel IS this listing's diagnostic channel: a
      // skill it had to skip is a real defect to SHOW, never a reason to fail
      // the whole listing. Messages about other roots are not this row's.
      onWarn: (message) => { if (message.includes(skillsDir)) diagnostics.push(message) },
    })
    const names = scanner.list().filter((skill) => skill.source === "plugin").map((skill) => skill.name)
    if (names.length > 0) skillNamesByDir.set(entry.id, names)
  }

  const observations: Observations = {
    skillNamesByDir,
    // Both live halves are empty because THIS PROCESS OBSERVED NOTHING. The
    // verdicts they feed are replaced before printing (module doc) — they are
    // passed so the evaluator's inputs are exactly what a host could feed.
    commandNames: new Set<string>(),
    expectedCommandNames: declaredCommands,
    connectedMcpServers: new Set<string>(),
    expectedMcpServerNames: declaredMcpServers,
    initialized: true,
  }
  const verdict = evaluatePlugin(recordFor(root, entry), caps, observations)

  return {
    id: entry.id,
    marketplace: entry.marketplace,
    name: entry.name,
    installed: entry.installed,
    enabled: entry.enabled,
    status: overallStatus(verdict, caps, entry.enabled),
    dimensions: dimensionsFor(verdict, caps, entry.enabled),
    declaredCommands,
    declaredMcpServers,
    conflicts: entry.conflicts ?? [],
    diagnostics,
  }
}

/**
 * Every INSTALLED plugin under the run path's registry root (a never-installed
 * marketplace entry has no readiness to report, so `catalog()`'s entries are
 * filtered to the ones state.json records as installed — which is also what
 * keeps this a listing of the store, not a browse of the marketplace).
 *
 * NOT exported on purpose: the command entry below is its only caller, and an
 * export nothing consumes is the orphan this unit's own gate keeps reporting.
 */
async function listInstalledPlugins(): Promise<PluginListing> {
  const root = join(resolveHarnessHome(), "plugins")
  // No state file ⇒ nothing was ever installed, and the registry must not be
  // CONSTRUCTED to discover that: the state loader warns "state file is missing
  // or unreadable … rebuilding defaults" for an absent file, so on a fresh
  // machine every read-only listing announced rebuilding a file that was never
  // there. `hooks list` hit this on the real machine first; same guard.
  if (!existsSync(join(root, "state.json"))) return { pluginsRoot: root, plugins: [] }
  const { plugins } = await new PluginRegistry({ root }).catalog()
  return {
    pluginsRoot: root,
    plugins: plugins.filter((entry) => entry.installed).map((entry) => evaluateInstalled(root, entry)),
  }
}

/** The dimensions in evaluator order, skipping `executable` — it is always
 * "unsupported" by D2 and would be noise on every row. */
const RENDER_DIMENSIONS = ["skills", "commands", "mcp", "agents", "hooks"] as const

function dimensionText(status: DimensionStatus): string {
  return status === "not-evaluated" ? NOT_EVALUATED_TEXT : status
}

/** The two dimensions a live session owns, in evaluator order. */
const LIVE_DIMENSIONS = ["commands", "mcp"] as const

/** The readiness line's text. For `not-evaluated` it names the dimensions that
 * made it so — derived from the row itself, so the phrase cannot drift from
 * what the dimension lines below it say. */
function overallText(row: PluginListRow): string {
  switch (row.status) {
    case "disabled": return "disabled"
    case "failed": return "failed"
    case "ready": return "ready (every advertised dimension is verifiable without a live session)"
    case "not-evaluated": {
      const live = LIVE_DIMENSIONS.filter((dim) => row.dimensions[dim] === NOT_EVALUATED)
      return `not evaluated here (needs a live session: ${live.join(", ")})`
    }
  }
}

/** Aligned per-plugin blocks: flag + readiness, then the advertised dimensions,
 * what the plugin declares, and its diagnostics. Empty → an honest line, never
 * a bare header. */
export function renderPluginTable(listing: PluginListing): string {
  const rows = listing.plugins
  if (rows.length === 0) return `no plugins installed in ${listing.pluginsRoot}`
  const lines = [`${rows.length} plugin(s) installed in ${listing.pluginsRoot}:`, ""]
  for (const row of rows) {
    lines.push(`  [${row.enabled ? "enabled" : "disabled"}] ${row.id} — readiness: ${overallText(row)}`)
    if (row.enabled) {
      const dims = RENDER_DIMENSIONS
        .filter((dim) => row.dimensions[dim] !== "unsupported")
        .map((dim) => `${dim}: ${dimensionText(row.dimensions[dim])}`)
      lines.push(dims.length > 0 ? `      ${dims.join(" · ")}` : "      advertises no runtime capabilities")
      const declares: string[] = []
      if (row.declaredCommands.length > 0) {
        declares.push(`${row.declaredCommands.length} command(s) (${row.declaredCommands.join(", ")})`)
      }
      if (row.declaredMcpServers.length > 0) {
        declares.push(`${row.declaredMcpServers.length} MCP server(s) (${row.declaredMcpServers.join(", ")})`)
      }
      if (declares.length > 0) lines.push(`      declares: ${declares.join(" · ")}`)
    }
    for (const conflict of row.conflicts) lines.push(`      blocked: ${conflict.name} (${conflict.reason})`)
    for (const diagnostic of row.diagnostics) lines.push(`      diagnostic: ${diagnostic}`)
    lines.push("")
  }
  lines.push("this listing is read-only — install/enable/disable are a separate decision")
  return lines.join("\n")
}

const PLUGINS_USAGE =
  "usage: i-harness plugins [list] [--json]\n" +
  "  list  every installed plugin: its enabled flag, the readiness that is\n" +
  "        verifiable without a live session, and what it declares. Writes no\n" +
  "        registry state (no install/enable/disable — a separate decision; a\n" +
  "        cold network source's cache may be refreshed, as on the run path).\n" +
  "        Dimensions that need a LIVE session — commands (registered?) and mcp\n" +
  "        (connected?) — are reported as not evaluated here, never as failed."

/** The command. It writes no registry state: the only mutations reachable from
 * here are `catalog()`'s own — a registered source whose cache dir is cold is
 * re-pulled into `<root>/cache/` (the HTTP manifest is written at
 * marketplaces.ts:396; a git source is re-cloned, rm at :403 + clone at :406),
 * which is exactly what every other `catalog()` caller does. Returns the
 * process exit code. */
export async function runPluginsCommand(args: string[]): Promise<number> {
  const parsed = parsePluginsArgs(args)
  if (parsed.error !== undefined) {
    console.error(`plugins: ${parsed.error}`)
    console.error(PLUGINS_USAGE)
    return 1
  }
  if (parsed.subcommand === "help") {
    console.error(PLUGINS_USAGE)
    return 0
  }
  const listing = await listInstalledPlugins()
  if (parsed.json === true) {
    console.log(JSON.stringify(listing, null, 2))
    return 0
  }
  console.log(renderPluginTable(listing))
  return 0
}
