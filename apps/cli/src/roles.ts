/**
 * `i-harness roles` — which model each sub-agent role runs on
 * (docs/superpowers/specs/2026-09-19-agent-roles-design.md §8).
 *
 * WHY IT EXISTS: Tasks 1–4 landed `agents.roles`, the chain, the resolver and
 * the gate — and Task 4's refusal message already ends with `or clear the
 * role's model: i-harness roles unset <role>`, a repair the user was told to
 * run and could not. Same reason `i-harness hooks approve` exists: a rule that
 * cannot be invoked is a rule that is already broken.
 *
 * Shape follows `provider.ts` and `models.ts` — parse → render → run, each
 * piece pure and separately testable.
 */

import { builtinRoles } from "@i-harness/subagent"
import type { Settings } from "@i-harness/settings"
import { PROVIDER_PROTOCOLS, type CliProtocol } from "./provider.ts"
import { loadProviderRuntime } from "./provider-runtime.ts"
import { diagnosticsFor } from "@i-harness/diagnostics"

// W6 T5: one module-scope handle — every site here reports the `roles`
// command's own refusals and failures (phase `cli`).
const d = diagnosticsFor("cli")

/** The four built-in names, read from the ONE place that declares them
 * (`packages/subagent/src/roles.ts` via the package's own export). A literal
 * list here would be a second place to edit for one fact — and §2 rule 3's
 * refusal is exactly the message that must not go stale. */
const ROLE_NAMES = builtinRoles().map((role) => role.name)

/** One `agents.roles.<name>` entry. DERIVED from the settings document type
 * rather than restated: `SettingsRoleModel` is deliberately not exported
 * (packages/settings/src/index.ts:168 — nothing outside that file names it),
 * and an indexed access borrows the shape without naming a copy that could
 * drift from it. The import is type-only, so nothing is loaded for it. */
type RoleSelection = Settings["agents"]["roles"][string]

interface RoleValues {
  provider?: string
  model?: string
  protocol?: CliProtocol
  /** Carried through unvalidated, like `models use --reasoning-effort`: the
   * settings schema holds the closed set and resolves it where the model is
   * built. The CLI's job is to pass the user's word on, not to invent one. */
  reasoningEffort?: string
}

interface ParsedRolesArgs {
  subcommand: "list" | "set" | "unset" | "help"
  role?: string
  values: RoleValues
  error?: string
}

const ROLES_USAGE =
  "usage: i-harness roles <list|set|unset>\n" +
  "  list                                        each role's model: declared in settings, or inherited from the parent's client\n" +
  "  set <role> --provider P --model M [--protocol X] [--reasoning-effort E]\n" +
  "  unset <role>                                the role goes back to inheriting the parent's client\n" +
  "  --provider and --model are required TOGETHER: half a selection is a guess, not a setting\n" +
  "  set REPLACES the whole entry — an omitted --protocol/--reasoning-effort CLEARS it\n" +
  `  roles: ${ROLE_NAMES.join(", ")}       (the built-in set; any other name is refused)\n` +
  `  protocols: ${PROVIDER_PROTOCOLS.join(" | ")}   (no "auto": an omitted flag already clears the protocol)`

export function parseRolesArgs(args: string[]): ParsedRolesArgs {
  const sub = args[1]
  if (sub === "help" || sub === "--help" || sub === "-h") {
    return { subcommand: "help", values: {} }
  }
  // A bare `i-harness roles` is the READ verb, like a bare `i-harness models`:
  // the read is the thing a user wants nine times out of ten, and it writes
  // nothing, so defaulting to it cannot surprise anyone's config.
  const verb = sub ?? "list"
  const rest = args.slice(2)
  if (verb !== "list" && verb !== "set" && verb !== "unset") {
    // The verb is checked FIRST: `roles general` is a typo'd subcommand, not a
    // verb-less role — the second token is a role only after set/unset says so.
    return { subcommand: "help", values: {}, error: `unknown roles subcommand: ${verb}` }
  }

  let role: string | undefined
  const values: RoleValues = {}
  /** The flag tokens seen, in order — for the diagnostic that has to NAME the
   * flag a verb cannot read (fields alone can no longer spell it back). */
  const flagTokens: string[] = []
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]!
    if (!token.startsWith("-")) {
      if (role !== undefined) return { subcommand: "help", values: {}, error: `unexpected extra argument: ${token}` }
      role = token
      continue
    }
    const raw = rest[i + 1]
    if (raw === undefined || raw.startsWith("--")) {
      return { subcommand: "help", values: {}, error: `${token} needs a value` }
    }
    i += 1
    flagTokens.push(token)
    // A BLANK value is refused here, and the trimmed value is what lands: the
    // store's normalizer returns null for a blank provider/model
    // (packages/settings/src/index.ts:497), so `--model ""` would persist
    // nothing while this verb printed success — the provider tree's
    // `--base-url ""` defect, one plane over. Trimming means surrounding
    // whitespace never becomes part of an id, the rule `models use` set.
    const value = raw.trim()
    if (value === "") return { subcommand: "help", values: {}, error: `${token} needs a non-empty value` }
    if (token === "--provider") { values.provider = value; continue }
    if (token === "--model") { values.model = value; continue }
    if (token === "--reasoning-effort") { values.reasoningEffort = value; continue }
    if (token === "--protocol") {
      if (!(PROVIDER_PROTOCOLS as readonly string[]).includes(value)) {
        // `auto` is NOT accepted here, unlike `models --protocol auto`: there
        // it names a fall-back a ROW could otherwise not express. An omitted
        // flag already clears the protocol on a role — `set` replaces the
        // whole entry — so `auto` would be a second spelling of one thing.
        return { subcommand: "help", values: {}, error: `unknown protocol "${value}"; expected one of: ${PROVIDER_PROTOCOLS.join(" | ")}` }
      }
      values.protocol = value as CliProtocol
      continue
    }
    return { subcommand: "help", values: {}, error: `unknown flag: ${token}` }
  }

  if (verb === "list") {
    // `list` READS every role and takes nothing. `provider list deepseek` used
    // to print the full list with exit 0 — silently ignoring an argument is the
    // same "exit 0 having done something other than what was asked" this tree
    // refuses.
    if (role !== undefined) {
      return { subcommand: "help", values: {}, error: `list takes no arguments (got "${role}"); it lists every role` }
    }
    if (flagTokens.length > 0) {
      return { subcommand: "help", values: {}, error: `${flagTokens[0]} is not a flag of "list"; it lists every role` }
    }
    return { subcommand: "list", values: {} }
  }

  if (role === undefined) return { subcommand: "help", values: {}, error: `${verb} takes a role name` }
  // §2 rule 3, checked BEFORE the flags: a typo'd role is the more useful of
  // the two complaints, and it names the four the user can actually type.
  if (!ROLE_NAMES.includes(role)) {
    return { subcommand: "help", values: {}, error: `unknown role "${role}"; known roles: ${ROLE_NAMES.join(", ")}` }
  }
  if (verb === "unset") {
    if (flagTokens.length > 0) {
      return { subcommand: "help", values: {}, error: `${flagTokens[0]} is not a flag of "unset"; it takes only a role name` }
    }
    return { subcommand: "unset", role, values: {} }
  }
  // §2 rule 1: `provider` and `model` come TOGETHER, and the refusal names the
  // MISSING one — "invalid flags" would leave the user guessing which half.
  if (values.provider === undefined || values.model === undefined) {
    const missing = values.provider === undefined ? "--provider" : "--model"
    return { subcommand: "help", values: {}, error: `set needs BOTH --provider and --model; ${missing} is missing` }
  }
  return { subcommand: "set", role, values }
}

/** One `roles list` row: the role, and WHO chose its model. */
interface RoleRow {
  name: string
  /** Whether one of the four BUILT-IN names carries this name. It does NOT say
   * whether the role can spawn, and this marker must not claim it: the name is
   * only what the CLI's own `set`/`unset` can type. Plugin-contributed agents
   * and the guardian's `reviewer` register into the SAME registry the spawn
   * tools read (apps/cli/src/run.ts:517;
   * packages/guard-approval/src/guardian/reviewer.ts:56), and every
   * role-carrying spawn resolves `agents.roles[<any name>]` through
   * `declaredRoleModel` (packages/subagent/src/child.ts:122) — so a
   * hand-declared entry decides that role's model at every spawn: refused
   * while `plugins.subagentModel` is off, the declared selection when it is
   * on. */
  builtin: boolean
  /** Absent = the role inherits the parent's client. A DECLARED row always
   * carries both halves, because the store DROPS a half entry when it
   * normalizes (packages/settings/src/index.ts:495-502) — the type says what
   * the data can actually be. */
  selection?: RoleSelection
}

/** How a declared selection is spelled — in the read verb AND in `set`'s echo.
 * One spelling, so the two can never disagree about what "unset" means. Both
 * optional fields are printed even when absent: `set` REPLACES the whole
 * entry, so an omitted flag CLEARS them, and a line that showed only what is
 * present could not show that the verb had just done it. */
function describeSelection(selection: RoleSelection): string {
  return `${selection.provider}:${selection.model}` +
    ` (protocol: ${selection.protocol ?? "unset"}, reasoning effort: ${selection.reasoningEffort ?? "unset"})`
}

export function renderRoles(rows: readonly RoleRow[], subagentModelEnabled?: boolean): string {
  const declared = rows.filter((row) => row.selection !== undefined).length
  const lines = [`roles: ${rows.length} (${declared} declared, ${rows.length - declared} inheriting the parent's client)`]
  for (const row of rows) {
    const selection = row.selection
    // "inherited" is a STATEMENT, not a blank: the parent's client is the
    // answer, and who wins is the one thing this read exists to show.
    if (selection === undefined) {
      lines.push(`  ${row.name}  inherited`)
      continue
    }
    // The clause says only what this tool can know: the name is not one `set`
    // accepts. Whether the row is INERT is not knowable here — see RoleRow.
    lines.push(`  ${row.name}  declared: ${describeSelection(selection)}${row.builtin ? "" : "  (not one of the four built-ins)"}`)
  }
  // State, not decoration: with the switch off a declared row is a spawn
  // refusal, and the rows alone cannot show that. Printed only when the caller
  // STATES the switch is off — a caller that did not say must not be claimed
  // to know — and only when some row would actually be refused.
  if (subagentModelEnabled === false && declared > 0) {
    lines.push("note: plugins.subagentModel is false — a spawn of any role declared above is refused until it is enabled")
  }
  return lines.join("\n")
}

/** Every role the read verb prints: the four built-ins in their declared
 * order, then any OTHER name the file declares. The CLI refuses unknown names;
 * the file does not (design §8: the settings key is writable by hand) — and
 * such a name is often a plugin-contributed role or the guardian's, which a
 * hand-written entry really does gate. A read that hid those rows would hide
 * the very entries "who wins" is a question about. */
function rowsOf(roles: Readonly<Record<string, RoleSelection>>): RoleRow[] {
  const extra = Object.keys(roles).filter((name) => !ROLE_NAMES.includes(name)).sort()
  return [...ROLE_NAMES, ...extra].map((name) => {
    const selection = roles[name]
    return { name, builtin: ROLE_NAMES.includes(name), ...(selection !== undefined ? { selection } : {}) }
  })
}

export async function runRolesCommand(args: string[]): Promise<number> {
  const parsed = parseRolesArgs(args)
  if (parsed.error !== undefined) {
    d.error(`roles: ${parsed.error}`)
    d.error(ROLES_USAGE)
    return 1
  }
  if (parsed.subcommand === "help") {
    // Named exception (T5/R11): an exit-0 help print on the stderr channel.
    // This API cannot express a non-`error` level over that channel, and a
    // record calling a help request an error would be the sentence lying.
    console.error(ROLES_USAGE)
    return 0
  }

  const { settings } = await loadProviderRuntime()
  // The whole table is copied out and written back: `set` replaces one entry
  // and `unset` drops one, and each lands as the same single `agents` write —
  // a per-field merge is what design §2 rule 2 rejected, because the unit here
  // is "which model this role runs on", not a bag of independent fields.
  const roles = { ...settings.get().agents.roles }

  try {
    if (parsed.subcommand === "list") {
      // The switch travels with the read: without it the note above the rows
      // would be a guess, and with it the listing says which of these entries
      // can actually run.
      console.log(renderRoles(rowsOf(roles), settings.get().plugins.subagentModel))
      return 0
    }
    const name = parsed.role!
    if (parsed.subcommand === "unset") {
      // A no-op SAYS it is one instead of reporting a removal that did not
      // happen — and stays exit 0, because the role already has the state the
      // user asked for. This is `models set`'s "nothing to change", not
      // `models rm`'s absent row, which failed because the user named
      // something that was not there.
      if (roles[name] === undefined) {
        console.log(`role "${name}": nothing to unset — it already inherits the parent's client`)
        return 0
      }
      delete roles[name]
      await settings.set({ agents: { roles } })
      console.log(`role "${name}" now inherits the parent's client`)
      return 0
    }
    // §2 rule 1 was enforced at parse time, so both halves are present here.
    const entry: RoleSelection = {
      provider: parsed.values.provider!,
      model: parsed.values.model!,
      ...(parsed.values.protocol !== undefined ? { protocol: parsed.values.protocol } : {}),
      ...(parsed.values.reasoningEffort !== undefined ? { reasoningEffort: parsed.values.reasoningEffort } : {}),
    }
    roles[name] = entry
    await settings.set({ agents: { roles } })
    // The RESULTING entry is printed, not a bare "updated": this verb replaces
    // the whole entry, so re-running it to change the model clears a protocol
    // set earlier — the printed line is what makes that visible (the ruling
    // `models use` made for the default model's reasoning effort).
    console.log(`role "${name}": ${describeSelection(entry)}`)
    // Setting a model the gate will refuse is a stop, not a surprise — say it
    // HERE, where the user just asked for it, rather than at the next spawn
    // that fails somewhere else. A DIAGNOSTIC (stderr) and NOT an error: the
    // write succeeded and is exactly what was asked for, so the exit stays 0.
    if (!settings.get().plugins.subagentModel) {
      console.error("note: plugins.subagentModel is false — spawns of this role will be refused until it is enabled")
    }
    return 0
  } catch (error) {
    d.error(`roles: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}
