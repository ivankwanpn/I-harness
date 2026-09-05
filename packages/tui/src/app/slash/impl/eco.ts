// @i-harness/tui — G2 (M46a): ecosystem slash commands — /skills /mcps /hooks
// /plugins /marketplace /personas /config-agents /workflow.
// DATA FROM THE REAL BACKENDS (read-only listings — the editing surfaces are
// v2 per spec): skills = @i-harness/skills registry (workspace + global scan);
// hooks = @i-harness/hooks config (9-event map + sha256 per handler);
// plugins/marketplace = @i-harness/plugin-registry catalog (installed/enabled
// + market shelf); config-agents = @i-harness/subagent builtin roles;
// workflow = @i-harness/workflow registry + job store. mcps = plugin runtime
// inputs mcpServerConfigs (the per-server config keys — there is NO aggregated
// status registry in @i-harness/mcp-client; live supervisor states are the
// session assembly's mount outcomes — see light-mcps.ts).

import { dirname, join } from "node:path"
import { resolveHooksConfigPath, loadHooksConfig, HOOK_EVENTS } from "@i-harness/hooks"
import { PluginRegistry } from "@i-harness/plugin-registry"
import { createSkillRegistry } from "@i-harness/skills"
import { builtinRoles } from "@i-harness/subagent"
import { createWorkflowJobStore, createWorkflowRegistry } from "@i-harness/workflow"
import type { SlashCommand } from "../types.ts"
import { skillsRows, SKILLS_EMPTY } from "../../../views/light-skills.ts"
import { mcpsRows, MCPS_EMPTY } from "../../../views/light-mcps.ts"
import { hooksRows, HOOKS_EMPTY } from "../../../views/light-hooks.ts"
import { pluginRows, marketplaceRows, PLUGINS_EMPTY, MARKETPLACE_EMPTY } from "../../../views/light-plugins.ts"
import { PERSONAS_EMPTY } from "../../../views/light-personas.ts"
import { configAgentRows, CONFIG_AGENTS_EMPTY } from "../../../views/light-config-agents.ts"
import { workflowDefRows, workflowJobRows, WORKFLOW_DEFS_EMPTY, WORKFLOW_JOBS_EMPTY } from "../../../views/light-workflow.ts"
import type { LightPanelRow } from "../../../views/light-panel.ts"

function workspaceOf(ctx: Parameters<SlashCommand["run"]>[0]): string {
  return ctx.workspace ?? process.cwd()
}

function emptyOr(rows: LightPanelRow[], empty: string): LightPanelRow[] {
  return rows.length > 0 ? rows : [{ label: empty.trim() }]
}

export const ecoCommands: SlashCommand[] = [
  {
    name: "skills",
    description: "Skills registry (workspace + global)",
    run: async (ctx) => {
      try {
        const registry = createSkillRegistry({ workspace: workspaceOf(ctx) })
        ctx.openPanel({ kind: "skills", title: "Skills", rows: emptyOr(skillsRows(registry.list()), SKILLS_EMPTY) })
      } catch (error) {
        ctx.openPanel({ kind: "skills", title: "Skills", rows: [{ label: `skills scan failed: ${String(error)}` }] })
      }
    },
  },
  {
    name: "mcps",
    description: "MCP servers configured for this session",
    run: async (ctx) => {
      try {
        const registry = new PluginRegistry({ root: join(workspaceOf(ctx), ".i-harness", "plugins") })
        const configs = registry.runtimeInputs().mcpServerConfigs
        const names = Object.keys(configs ?? {})
        const servers = names.map((name) => {
          const cfg = configs?.[name] as { url?: string; command?: string } | undefined
          return { name, transport: cfg?.url !== undefined ? "streamable-http" : cfg?.command !== undefined ? "stdio" : "unknown" }
        })
        ctx.openPanel({ kind: "mcps", title: "MCP servers", rows: emptyOr(mcpsRows(servers), MCPS_EMPTY) })
      } catch {
        ctx.openPanel({ kind: "mcps", title: "MCP servers", rows: [{ label: MCPS_EMPTY.trim() }] })
      }
    },
  },
  {
    name: "hooks",
    description: "Hooks config (9 events, per-handler sha256)",
    run: async (ctx) => {
      try {
        const configPath = resolveHooksConfigPath()
        const handlers = await loadHooksConfig(configPath, dirname(configPath))
        ctx.openPanel({ kind: "hooks", title: "Hooks", rows: emptyOr(hooksRows(handlers, HOOK_EVENTS), HOOKS_EMPTY) })
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        ctx.openPanel({ kind: "hooks", title: "Hooks", rows: [{ label: `hooks config: ${msg}` }] })
      }
    },
  },
  {
    name: "plugins",
    description: "Plugin catalog (installed/enabled)",
    run: async (ctx) => {
      try {
        const registry = new PluginRegistry({ root: join(workspaceOf(ctx), ".i-harness", "plugins") })
        const { plugins } = await registry.catalog()
        ctx.openPanel({ kind: "plugins", title: "Plugins", rows: emptyOr(pluginRows(plugins), PLUGINS_EMPTY) })
      } catch (error) {
        ctx.openPanel({ kind: "plugins", title: "Plugins", rows: [{ label: `plugin catalog: ${String(error)}` }] })
      }
    },
  },
  {
    name: "marketplace",
    description: "Plugin market shelf (not yet installed)",
    run: async (ctx) => {
      try {
        const registry = new PluginRegistry({ root: join(workspaceOf(ctx), ".i-harness", "plugins") })
        const { plugins } = await registry.catalog()
        ctx.openPanel({ kind: "marketplace", title: "Marketplace", rows: emptyOr(marketplaceRows(plugins), MARKETPLACE_EMPTY) })
      } catch (error) {
        ctx.openPanel({ kind: "marketplace", title: "Marketplace", rows: [{ label: `market: ${String(error)}` }] })
      }
    },
  },
  {
    name: "personas",
    description: "Persona list (presets are config-time — see note)",
    run: (ctx) => {
      // Honest: @i-harness/preset has NO list/catalog (presets are JSON text
      // mounted per session). The REAL in-session persona set is the subagent
      // role table (/config-agents). The panel says so instead of faking rows.
      ctx.openPanel({ kind: "personas", title: "Personas", rows: [{ label: PERSONAS_EMPTY.trim() }] })
    },
  },
  {
    name: "config-agents",
    description: "Subagent role table (builtin + registered)",
    run: (ctx) => {
      const roles = builtinRoles()
      ctx.openPanel({ kind: "config-agents", title: "Config agents", rows: emptyOr(configAgentRows(roles), CONFIG_AGENTS_EMPTY) })
    },
  },
  {
    name: "workflow",
    description: "Workflow registry + job list",
    run: (ctx) => {
      const defs = createWorkflowRegistry({ workspace: workspaceOf(ctx) }).list()
      const jobs = createWorkflowJobStore().list()
      const rows = [
        ...emptyOr(workflowDefRows(defs), WORKFLOW_DEFS_EMPTY),
        { label: "jobs", detail: String(jobs.length), header: true } as LightPanelRow,
        ...emptyOr(workflowJobRows(jobs), WORKFLOW_JOBS_EMPTY),
      ]
      ctx.openPanel({ kind: "workflow", title: "Workflows", rows })
    },
  },
]
