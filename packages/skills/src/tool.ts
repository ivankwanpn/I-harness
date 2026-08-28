// Model-facing skill tools: skill_search (deferred-retrieval entry, mounted
// beside tool_search) and skill_get (explicit body load). Both are read-only
// and always exposed (direct) — the model must be able to DISCOVER skills
// without knowing they exist, then load only what it needs.
import { readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import type { Plugin, PluginContext } from "@i-harness/core-plugin"
import type { Tool, ToolRegistry } from "@i-harness/core-tools"
import {
  createSkillRegistry,
  isValidSkillName,
  SkillToolError,
  SKILL_FILE,
  SKILL_NAME_MAX_LENGTH,
  type Skill,
  type SkillRegistry,
  type SkillSource,
} from "./registry.ts"

export const skillSearchName = "skill_search"
export const skillGetName = "skill_get"
export const skillsServiceName = "skills"
export const skillsPluginName = "skills"

// opencode's deferred file-list discipline: sample the skill directory rather
// than dumping it, note the truncation to the model.
const MODEL_FILE_LIMIT = 10

const SKILL_SEARCH_USAGE =
  "Skills are deferred knowledge packs (SKILL.md directories). Call skill_get with a matching name to load the full instructions before acting on a skill; load only the skills you need."

export interface SkillToolDeps {
  registry: SkillRegistry
}

export interface SkillSearchArgs {
  query: string
  limit?: number
}

export interface SkillSearchMatch {
  name: string
  description: string
  path: string
  source: SkillSource
}

export interface SkillSearchOutput {
  query: string
  matches: SkillSearchMatch[]
  totalSkills: number
  usage: string
}

export interface SkillGetArgs {
  name: string
}

export interface SkillGetOutput {
  name: string
  description: string
  path: string
  baseDir: string
  files: string[]
  totalFiles: number
  body: string
  content: string
}

export function createSkillSearchTool(deps: SkillToolDeps): Tool<SkillSearchArgs, SkillSearchOutput> {
  return {
    name: skillSearchName,
    description:
      "Search available skills (deferred SKILL.md knowledge packs) by keyword. Returns name/description/path/source matches; load the full skill content with skill_get.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query for skills. An exact skill name, select:<name>, or natural language keywords.",
        },
        limit: { type: "number", description: "Maximum number of matches to return (default: 8)." },
      },
      required: ["query"],
    },
    exposure: "direct",
    isReadOnly: true,
    execute: async (args: SkillSearchArgs) => {
      const matches = deps.registry.searchSkills(args.query, { limit: args.limit })
      return {
        query: args.query,
        matches: matches.map((summary) => ({
          name: summary.name,
          description: summary.description,
          path: summary.path,
          source: summary.source,
        })),
        totalSkills: deps.registry.list().length,
        usage: SKILL_SEARCH_USAGE,
      }
    },
  }
}

export function createSkillGetTool(deps: SkillToolDeps): Tool<SkillGetArgs, SkillGetOutput> {
  return {
    name: skillGetName,
    description:
      "Load a skill's full content by name. Returns the rendered <skill_content> (instructions + base directory + sampled file list); follow the loaded instructions. Discover names with skill_search first.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Exact skill name (lowercase kebab-case), as returned by skill_search.",
        },
      },
      required: ["name"],
    },
    exposure: "direct",
    isReadOnly: true,
    execute: async (args: SkillGetArgs) => {
      const name = typeof args?.name === "string" ? args.name : ""
      if (name.trim().length === 0) {
        throw new SkillToolError(
          "SKILL_INVALID_NAME",
          "skill_get requires a skill name. Remedy: call skill_search first, then pass an exact skill name.",
        )
      }
      if (!isValidSkillName(name)) {
        throw new SkillToolError(
          "SKILL_INVALID_NAME",
          `skill name '${name}' is not lowercase kebab-case /^[a-z0-9]+(?:-[a-z0-9]+)*$/ with at most ${SKILL_NAME_MAX_LENGTH} chars. Remedy: pass an exact name from skill_search.`,
        )
      }
      const skill = await deps.registry.getSkill(name)
      if (!skill) {
        throw new SkillToolError(
          "SKILL_NOT_FOUND",
          `unknown skill '${name}'. Remedy: run skill_search to discover available skills.`,
        )
      }
      const baseDir = dirname(skill.path)
      const { files, total } = listSkillFiles(baseDir)
      return {
        name: skill.name,
        description: skill.description,
        path: skill.path,
        baseDir,
        files,
        totalFiles: total,
        body: skill.body,
        content: renderSkillContent(skill, baseDir, files, total),
      }
    },
  }
}

interface SkillFiles {
  files: string[]
  total: number
}

// Sample the skill directory for the model: relative (slash-joined) paths,
// hidden entries and SKILL.md itself excluded, capped at MODEL_FILE_LIMIT.
function listSkillFiles(baseDir: string): SkillFiles {
  const files: string[] = []
  const walk = (dir: string, rel: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue
      if (entry.isFile() && entry.name === SKILL_FILE) continue
      const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) walk(join(dir, entry.name), relPath)
      else if (entry.isFile()) files.push(relPath)
    }
  }
  walk(baseDir, "")
  files.sort((a, b) => a.localeCompare(b))
  return { files: files.slice(0, MODEL_FILE_LIMIT), total: files.length }
}

function escapeXmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

// Model-side render (dsh <skill_content> + opencode base-directory hint): the
// body is XML-escaped inside the block, the base-directory hint tells the model
// where the skill's files live, and a truncated list is marked as sampled.
function renderSkillContent(skill: Skill, baseDir: string, files: string[], totalFiles: number): string {
  const lines: string[] = []
  lines.push(`<skill_content name="${escapeXmlText(skill.name)}">`)
  lines.push(`base-directory: ${baseDir}`)
  if (totalFiles === 0) {
    lines.push("files: none (SKILL.md is the only file)")
  } else {
    lines.push(files.length < totalFiles ? `files (sampled ${files.length} of ${totalFiles}):` : "files:")
    for (const file of files) lines.push(`- ${file}`)
  }
  lines.push("")
  lines.push(escapeXmlText(skill.body))
  lines.push("</skill_content>")
  return lines.join("\n")
}

export interface SkillsMountHandle {
  registry: SkillRegistry
  unmount(): Promise<void>
}

// run.ts wiring (mounts beside registerToolSearch — the deferred-retrieval
// family): registers the "skills" service and the skill_search/skill_get tools.
// The returned handle unregisters the tools so a host (or the plugin below)
// can reclaim them; unregister is idempotent (unknown names are no-ops).
export function registerSkills(
  ctx: PluginContext,
  tools: ToolRegistry,
  config?: { workspace?: string },
): SkillsMountHandle {
  const registry = createSkillRegistry({ workspace: config?.workspace })
  ctx.services.register(skillsServiceName, registry)
  const skillSearch = createSkillSearchTool({ registry })
  const skillGet = createSkillGetTool({ registry })
  tools.register(skillSearch)
  tools.register(skillGet)
  return {
    registry,
    unmount: async () => {
      tools.unregister(skillSearchName)
      tools.unregister(skillGetName)
    },
  }
}

// Plugin form (spec §3.1): name "skills"; mount wires registerSkills, unmount
// reclaims the tools via the handle (core-plugin reclaim owns the rest). The
// service itself stays registered — core-plugin's service store has no
// unregister seam, and the run-level ctx outlives every mount in v0.
export function createSkillsPlugin(
  ctx: PluginContext,
  tools: ToolRegistry,
  config?: { workspace?: string },
): Plugin {
  let handle: SkillsMountHandle | undefined
  return {
    name: skillsPluginName,
    mount() {
      handle = registerSkills(ctx, tools, config)
    },
    async unmount() {
      await handle?.unmount()
      handle = undefined
    },
  }
}
