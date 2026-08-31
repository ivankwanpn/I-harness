/**
 * Runtime capability evaluator — a pure function over (PluginRecord ×
 * Capabilities × Observations) → per-dimension status labels plus an overall
 * status (spec §2.2, plan Task 5).
 *
 * Conventions:
 *   - Never performs I/O and never executes plugin code: everything the
 *     evaluator needs is either on the PluginRecord (enabled, conflicts) /
 *     Capabilities (what the package advertises) or injected as Observations —
 *     the web host scans the materialized overlays and the mcp-client session
 *     set once and passes the results in.
 *   - D2: a server-executable plugin is always "unsupported" on the
 *     `executable` dimension (the host never executes plugin code). The
 *     dimension does not affect the overall status itself, but a plugin
 *     advertising NO other dimension (the only advert being executable) is
 *     "failed": its runtime surface is empty and can never become ready.
 *   - A not-enabled plugin is reported as overall "disabled"; every runtime
 *     dimension turns "disabled" too (executable stays "unsupported" — D2 is a
 *     property of the package, not of its runtime state).
 *   - While observations are still incomplete (initialized=false, the web
 *     first-scan has not completed) every applicable dimension reads "pending"
 *     and the overall status is "initializing".
 *   - Dimensions the plugin does not advertise (capabilities.X=false) read
 *     "unsupported" — the host knows what the package is, but it contributes
 *     nothing to the agent build.
 *
 * Command semantics (controller amendment, bound from the Task 4 review):
 *   - expectedCommandNames is the plugin's FULL expected set — every command
 *     the plugin advertises, INCLUDING names recorded as conflicts (blocked at
 *     enable time, so at runtime they are not registered under the plugin).
 *     Callers derive it from the plugin's command descriptors (the
 *     runtimeInputs.commandDescriptors attributable to this plugin) UNION
 *     record.conflicts[].name; omitting the conflicts would hide the blocked
 *     commands and misreport "ready".
 *   - Per expected name: conflicted → "failed" (reason already recorded in
 *     record.conflicts) even when another owner registered the same name;
 *     otherwise "ready" iff the name is in observations.commandNames, else
 *     "failed" (unregistered) — a name the catalog holds that the plugin does
 *     not expect is a host/other-plugin command and is ignored.
 *   - Overall: the ONLY configured-to-be-degraded case is "the only failures
 *     are command conflicts" (degraded); any skills/mcp failure or a
 *     non-conflicted but unregistered command is "failed".
 */

import type { Capabilities } from "./capability.ts"
import type { PluginRecord } from "./types.ts"

/** Per-dimension runtime status of one plugin. */
export type CapabilityStatus = "ready" | "pending" | "failed" | "unsupported" | "disabled"

/** Overall runtime status of one plugin. */
export type OverallStatus = "disabled" | "initializing" | "ready" | "degraded" | "failed"

/**
 * Runtime observations injected by the host (web.ts scans its overlays and the
 * mcp-client session set once per probe; the evaluator stays pure).
 */
export interface Observations {
  /** Observed skills per materialized overlay, keyed by plugin id (the
   * `<root>/skills/<id>` overlay is one-per-id; the host scans each and records
   * the names under the owning plugin's id). Values are the skill file/dir
   * names; ready requires at least one. */
  skillNamesByDir: Map<string, string[]>
  /** Actually registered command names (the interaction catalog). */
  commandNames: Set<string>
  /** The plugin's FULL expected command set, including names recorded as
   * conflicts (see module docstring — callers union the plugin's descriptors
   * with record.conflicts[].name). */
  expectedCommandNames: string[]
  /** The plugin's declared MCP servers, RE-KEYED as `plugin:<id>:<server>`
   * (mirrors mcpServerConfigs keys); ready requires every one connected. */
  expectedMcpServerNames: string[]
  /** Connected mcp-client session names (also re-keyed). */
  connectedMcpServers: Set<string>
  /** false until the host's first probe completed → pending/initializing. */
  initialized: boolean
}

/** Per-command verdict label for the plugin's expected command set. */
export type CommandStatus = "ready" | "failed"

/** The evaluator's per-plugin verdict. */
export interface EvaluateResult {
  overall: OverallStatus
  capabilities: Record<"skills" | "commands" | "mcp" | "executable", CapabilityStatus>
  /** One entry per expected command name ([]/{} once the commands dimension is
   * unsupported, pending or the plugin is disabled). */
  commandStatuses: Record<string, CommandStatus>
}

/**
 * Evaluate one plugin's runtime status. Pure: the record holds what enable()
 * persisted, the caps what inspectCapabilities() advertised and the
 * observations what the host actually observed (rendered overlays, registered
 * command names, connected MCP sessions).
 */
export function evaluatePlugin(
  record: PluginRecord,
  caps: Capabilities,
  observations: Observations,
): EvaluateResult {
  // Not enabled → the plugin contributes nothing to the runtime surface.
  if (!record.enabled) {
    return {
      overall: "disabled",
      capabilities: {
        skills: "disabled",
        commands: "disabled",
        mcp: "disabled",
        executable: "unsupported", // D2: package-level fact, not runtime state
      },
      commandStatuses: {},
    }
  }

  // First probe not complete yet → every applicable dimension is unknown.
  if (!observations.initialized) {
    return {
      overall: "initializing",
      capabilities: {
        skills: apply(caps.skills, "pending"),
        commands: apply(caps.commands, "pending"),
        mcp: apply(caps.mcp, "pending"),
        executable: "unsupported",
      },
      commandStatuses: {},
    }
  }

  // Evaluate each advertised dimension; a dimension the package does not
  // advertise is "unsupported" (contributes nothing to the runtime surface).
  const skills = caps.skills ? evaluateSkills(record, observations) : "unsupported"
  const evaluated = caps.commands ? evaluateCommands(record, observations) : undefined
  const commands = evaluated !== undefined ? evaluated.status : "unsupported"
  const commandStatuses = evaluated !== undefined ? evaluated.commandStatuses : {}
  const mcp = caps.mcp ? evaluateMcp(observations) : "unsupported"

  const statuses = { skills, commands, mcp }

  let overall: OverallStatus
  if (skills === "unsupported" && commands === "unsupported" && mcp === "unsupported") {
    // Nothing advertised → the runtime surface is empty and can never become
    // ready (reached when a refreshed package drops all its dimensions, e.g.
    // an executable-only payload). D2 phase rule → failed.
    overall = "failed"
  } else if (skills === "failed" || mcp === "failed") {
    // Hard failures on the materialized/connected surfaces.
    overall = "failed"
  } else if (commands === "failed") {
    // Per the controller decision: conflicts may degrade (the plugin enabled
    // with its blocked commands recorded), but an unregistered NON-conflicted
    // command is a genuine failure — the surface silently misses a command.
    const conflictNames = new Set((record.conflicts ?? []).map((c) => c.name))
    const failedUnregistered = Object.keys(commandStatuses).some(
      (name) => commandStatuses[name] === "failed" && !conflictNames.has(name),
    )
    overall = failedUnregistered ? "failed" : "degraded"
  } else {
    overall = "ready"
  }

  return {
    overall,
    capabilities: { ...statuses, executable: "unsupported" },
    commandStatuses,
  }
}

/** A dimension's status when it is advertised ("pending") or absent ("unsupported"). */
function apply(advertised: boolean, whenAdvertised: CapabilityStatus): CapabilityStatus {
  return advertised ? whenAdvertised : "unsupported"
}

/** skills ready = the host observed at least one skill file/dir for the plugin. */
function evaluateSkills(record: PluginRecord, o: Observations): CapabilityStatus {
  return (o.skillNamesByDir.get(record.id) ?? []).length >= 1 ? "ready" : "failed"
}

/**
 * Per-command verdict: conflicted names are failed no matter who registered
 * them; every other expected name is ready iff the catalog actually holds it.
 */
function evaluateCommands(
  record: PluginRecord,
  o: Observations,
): { status: CapabilityStatus; commandStatuses: Record<string, CommandStatus> } {
  const conflicts = new Set((record.conflicts ?? []).map((c) => c.name))
  const commandStatuses: Record<string, CommandStatus> = {}
  let anyFailed = false
  for (const name of o.expectedCommandNames) {
    if (conflicts.has(name) || !o.commandNames.has(name)) {
      commandStatuses[name] = "failed"
      anyFailed = true
    } else {
      commandStatuses[name] = "ready"
    }
  }
  return { status: anyFailed ? "failed" : "ready", commandStatuses }
}

/** mcp ready = every declared server (re-keyed) has a connected session. */
function evaluateMcp(o: Observations): CapabilityStatus {
  const missing = o.expectedMcpServerNames.some((name) => !o.connectedMcpServers.has(name))
  return missing ? "failed" : "ready"
}
