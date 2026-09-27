import { basename, isAbsolute, relative, sep } from "node:path"
import { createSkillRegistry } from "@i-harness/skills"
import { parseCommandLine } from "@i-harness/interaction"
import type { RuntimeInputs } from "@i-harness/plugin-registry"
export type ResourceKind = "skills" | "commands"
export interface ResourceSummary { name: string; description?: string; source: "workspace" | "global" | "plugin"; path?: string; pluginId?: string; argumentHints?: string; unsupported?: string[] }
export interface ResourceDetail extends ResourceSummary { body: string; truncated: boolean }
export interface ResourceList { items: ResourceSummary[]; total: number; diagnostics: string[] }
const validCommand = (name: string) => parseCommandLine(`/${name}`)?.name === name
const bodyPreview = (body: string) => ({ body: body.slice(0, 131072), truncated: body.length > 131072 })

/** Adapts the same effective registries the engine consumes. Does not execute
 * resources or read arbitrary renderer-provided paths. */
export function createDesktopResources(workspace: string, inputs: () => Promise<RuntimeInputs>) {
  async function catalogue() {
    const input = await inputs()
    const diagnostics: string[] = []
    const skills = createSkillRegistry({ workspace, extraDirs: input.skillDirs, onWarn: (message) => { if (diagnostics.length < 100) diagnostics.push(message) } })
    const sourceFor = (path: string) => input.skillDirs.find((root) => { const child = relative(root, path); return child && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child) })
    const skillRows = (): ResourceSummary[] => skills.list().map((row) => {
      const plugin = row.source === "plugin" ? sourceFor(row.path) : undefined
      return { ...row, ...(plugin ? { pluginId: basename(plugin) } : {}) }
    })
    const commands = input.commandDescriptors.filter((row) => {
      if (validCommand(row.name)) return true
      if (diagnostics.length < 100) diagnostics.push(`Unsupported command name: ${row.name}`)
      return false
    })
    return { skills, skillRows, commands, diagnostics, sourceFor }
  }
  return {
    async list(kind: ResourceKind, query: string, offset: number): Promise<ResourceList> {
      const data = await catalogue()
      const all: ResourceSummary[] = kind === "skills" ? data.skillRows() : data.commands.map(({ body: _body, ...row }) => ({ ...row, source: "plugin" }))
      const term = query.trim().toLocaleLowerCase()
      const matches = all.filter((row) => `${row.name} ${row.description ?? ""} ${row.pluginId ?? ""}`.toLocaleLowerCase().includes(term))
      return { items: matches.slice(offset, offset + 50), total: matches.length, diagnostics: data.diagnostics }
    },
    async read(kind: ResourceKind, name: string): Promise<ResourceDetail | undefined> {
      const data = await catalogue()
      if (kind === "commands") {
        const row = data.commands.find((row) => row.name === name)
        return row ? { ...row, source: "plugin", ...bodyPreview(row.body) } : undefined
      }
      const summary = data.skillRows().find((row) => row.name === name)
      if (!summary) return undefined
      const skill = await data.skills.getSkill(name)
      if (!skill) return undefined
      const plugin = skill.source === "plugin" ? data.sourceFor(skill.path) : undefined
      return { ...skill, ...bodyPreview(skill.body), ...(plugin ? { pluginId: basename(plugin) } : {}) }
    },
  }
}
