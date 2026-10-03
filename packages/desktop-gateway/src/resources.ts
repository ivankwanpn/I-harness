import { basename, isAbsolute, join, dirname, relative, sep } from "node:path"
import { createSkillRegistry, parseFrontmatter } from "@i-harness/skills"
import { resolveHooksConfigPath } from "@i-harness/hooks"
import { parseCommandLine } from "@i-harness/interaction"
import type { RuntimeInputs } from "@i-harness/plugin-registry"
import { createEffectiveLocalInputs, type LocalResourceSource } from "./effective-local-inputs.ts"
import { readResourceFile, mutateResourceFile, validateResourceName } from "./resource-files.ts"
export type ResourceKind = "skills" | "commands"
export interface ResourceSummary { name: string; description?: string; source: "workspace" | "global" | "plugin"; path?: string; pluginId?: string; argumentHints?: string; unsupported?: string[]; effective?: boolean }
export interface ResourceDetail extends ResourceSummary { body: string; truncated: boolean; rawBody?: string; revision?: string }
export interface ResourceWrite { resourceKind: ResourceKind; source: LocalResourceSource; name: string; body: string; expectedRevision: string | null }
export interface ResourceRemove { resourceKind: ResourceKind; source: LocalResourceSource; name: string; expectedRevision: string }
export type ResourceAuthoringRequest =
  | ({ kind: "desktop/resources/write"; workspaceId: string } & ResourceWrite)
  | ({ kind: "desktop/resources/remove"; workspaceId: string; confirmed: true } & ResourceRemove)
  | { kind: "desktop/resources/import"; workspaceId: string; source: LocalResourceSource }
export type ResourceAuthoringRequestHandler = (request: ResourceAuthoringRequest) => Promise<unknown>
export interface ResourceList { items: ResourceSummary[]; total: number; diagnostics: string[] }
const validCommand = (name: string) => parseCommandLine(`/${name}`)?.name === name
const bodyPreview = (body: string) => ({ body: body.slice(0, 131072), truncated: body.length > 131072 })

/** Adapts the same effective registries the engine consumes. Does not execute
 * resources or read arbitrary renderer-provided paths. */
export function createDesktopResources(workspace: string, inputs: () => Promise<RuntimeInputs>, options?: { configDir?: string; pluginRoot?: string; refresh?(): Promise<void> }) {
  const configDir = options?.configDir ?? dirname(resolveHooksConfigPath())
  const rootFor = (source: LocalResourceSource) => source === "workspace" ? workspace : configDir
  const effectiveInputs = async () => createEffectiveLocalInputs(workspace, configDir, await inputs())
  async function localPath(kind: ResourceKind, source: LocalResourceSource, name: string) {
    if (source !== "workspace" && source !== "global") throw new Error("Resource source must be workspace or global; copy plugin content locally")
    validateResourceName(name)
    const root = rootFor(source)
    if (kind === "skills") {
      const rows = createSkillRegistry({ ...(source === "workspace" ? { workspace } : {}), globalDir: source === "global" ? join(configDir, "skills") : join(workspace, ".i-harness", ".no-global-skills") }).list()
      return rows.find(row => row.name === name && row.source === source)?.path ?? join(root, "skills", name, "SKILL.md")
    }
    if (kind !== "commands") throw new Error("Invalid resource kind")
    return join(root, "commands", `${name}.md`)
  }
  async function catalogue() {
    const input = await effectiveInputs()
    const diagnostics: string[] = [...input.diagnostics]
    const skills = createSkillRegistry({ workspace, globalDir: join(configDir, "skills"), extraDirs: input.skillDirs, onWarn: (message) => { if (diagnostics.length < 100) diagnostics.push(message) } })
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
    const skillLayers = () => {
      const global = createSkillRegistry({ globalDir: join(configDir, "skills"), onWarn: () => {} }).list()
      const plugins = input.skillDirs.flatMap(root => createSkillRegistry({ globalDir: join(configDir, "skills"), extraDirs: [root], onWarn: () => {} }).list().filter(row => row.source === "plugin").map(row => ({ ...row, pluginId: basename(root) })))
      const local = createSkillRegistry({ workspace, globalDir: join(configDir, "skills"), onWarn: () => {} }).list().filter(row => row.source === "workspace")
      const effective = new Map(skillRows().map(row => [row.name, row.path]))
      return [...global, ...plugins, ...local].map(row => ({ ...row, effective: effective.get(row.name) === row.path }))
    }
    return { skills, skillRows, skillLayers, commands, commandLayers: input.commandLayers, diagnostics, sourceFor }
  }
  return {
    effectiveInputs,
    async list(kind: ResourceKind, query: string, offset: number, includeShadowed = false): Promise<ResourceList> {
      const data = await catalogue()
      if (kind !== "skills" && kind !== "commands") throw new Error("Invalid resource kind")
      if (typeof includeShadowed !== "boolean") throw new Error("Invalid source visibility")
      if (typeof query !== "string" || query.length > 512 || !Number.isInteger(offset) || offset < 0) throw new Error("Invalid resource search")
      const all: ResourceSummary[] = kind === "skills" ? includeShadowed ? data.skillLayers() : data.skillRows() : (includeShadowed ? data.commandLayers : data.commands).map(({ body: _body, ...row }) => ({ ...row, source: row.source ?? "plugin", ...(includeShadowed ? { effective: data.commands.some(effective => effective.name === row.name && effective.source === row.source && effective.path === row.path && effective.pluginId === row.pluginId) } : {}) }))
      all.sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source) || (a.pluginId ?? "").localeCompare(b.pluginId ?? ""))
      const term = query.trim().toLocaleLowerCase()
      const matches = all.filter((row) => `${row.name} ${row.description ?? ""} ${row.pluginId ?? ""}`.toLocaleLowerCase().includes(term))
      return { items: matches.slice(offset, offset + 50), total: matches.length, diagnostics: data.diagnostics }
    },
    async read(kind: ResourceKind, name: string, source?: ResourceSummary["source"], pluginId?: string): Promise<ResourceDetail | undefined> {
      validateResourceName(name)
      if (source !== undefined && !["global", "workspace", "plugin"].includes(source)) throw new Error("Invalid resource source")
      const data = await catalogue()
      if (kind === "commands") {
        const rows = source === "plugin" ? (await inputs()).commandDescriptors : data.commands
        const row = rows.find((row) => row.name === name && (!source || source === "plugin" || (row as { source?: string }).source === source) && (!pluginId || row.pluginId === pluginId)) as typeof data.commands[number] | undefined
        if (source === "workspace" || source === "global") {
          const path = await localPath(kind, source, name), raw = readResourceFile(rootFor(source), path)
          if (!raw) return undefined
          const { parseCommandMarkdown } = await import("@i-harness/plugin-registry")
          const descriptor = parseCommandMarkdown(`${name}.md`, raw.body)
          return { ...descriptor, source, path, effective: data.commands.some(row => row.name === name && row.source === source), ...bodyPreview(descriptor.body), rawBody: raw.body, revision: raw.revision }
        }
        if (!row) return undefined
        if (row.source === "workspace" || row.source === "global") {
          const raw = readResourceFile(rootFor(row.source), row.path!)!
          return { ...row, source: row.source, effective: true, ...bodyPreview(row.body), rawBody: raw.body, revision: raw.revision }
        }
        const pluginRoot = options?.pluginRoot ?? join(configDir, "plugins")
        if (row.pluginId && /^[a-z0-9][a-z0-9_-]{0,127}$/.test(row.pluginId)) {
          const path = join(pluginRoot, "commands", row.pluginId, `${name}.md`), raw = readResourceFile(pluginRoot, path)
          if (raw) return { ...row, source: "plugin", path, effective: data.commands.some(effective => effective.name === name && effective.source === "plugin" && effective.pluginId === row.pluginId), ...bodyPreview(row.body), rawBody: raw.body, revision: raw.revision }
        }
        const frontmatter = [row.description ? `description: ${JSON.stringify(row.description)}` : undefined, row.argumentHints ? `argument-hints: ${JSON.stringify(row.argumentHints)}` : undefined].filter(Boolean).join("\n")
        return { ...row, source: "plugin", effective: data.commands.some(effective => effective.name === name && effective.source === "plugin" && effective.pluginId === row.pluginId), ...bodyPreview(row.body), rawBody: frontmatter ? `---\n${frontmatter}\n---\n${row.body}` : row.body }
      }
      if (kind !== "skills") throw new Error("Invalid resource kind")
      const input = await inputs()
      const registry = source ? createSkillRegistry({ ...(source === "workspace" ? { workspace } : {}), globalDir: source === "global" ? join(configDir, "skills") : join(workspace, ".i-harness", ".no-global-skills"), extraDirs: source === "plugin" ? input.skillDirs.filter(root => !pluginId || basename(root) === pluginId) : [] }) : data.skills
      const summary = registry.list().find((row) => row.name === name)
      if (!summary) return undefined
      const skill = await registry.getSkill(name)
      if (!skill) return undefined
      const plugin = skill.source === "plugin" ? data.sourceFor(skill.path) : undefined
      const root = skill.source === "plugin" ? input.skillDirs.find(root => { const child = relative(root, skill.path); return child && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child) }) : rootFor(skill.source)
      if (!root) throw new Error("Resource source is no longer available")
      const raw = readResourceFile(root, skill.path)!
      return { ...skill, effective: data.skillRows().some(row => row.path === skill.path), ...bodyPreview(skill.body), rawBody: raw.body, revision: raw.revision, ...(plugin ? { pluginId: basename(plugin) } : {}) }
    },
    async write(command: ResourceWrite) {
      const path = await localPath(command.resourceKind, command.source, command.name)
      const result = await mutateResourceFile(rootFor(command.source), path, command.expectedRevision, command.body, body => {
        if (command.resourceKind === "skills") {
          const parsed = parseFrontmatter(body)
          if (!parsed?.meta.description || (parsed.meta.name ?? command.name) !== command.name) throw new Error("SKILL.md requires valid scalar frontmatter with matching name and description")
        } else if (!body.trim()) throw new Error("Command body cannot be empty")
      })
      if (result.kind === "saved") try { await options?.refresh?.() } catch { throw new Error("Resource saved, but live refresh failed. Reload the saved revision and retry refresh.") }
      return result
    },
    async remove(command: ResourceRemove) {
      const path = await localPath(command.resourceKind, command.source, command.name)
      const result = await mutateResourceFile(rootFor(command.source), path, command.expectedRevision)
      if (result.kind === "removed") try { await options?.refresh?.() } catch { throw new Error("Resource removed, but live refresh failed. Retry refresh.") }
      return result
    },
    /** Native main-process dialog supplies this path; never forward a renderer path here. */
    async importSkill(source: LocalResourceSource, selectedPath: string) {
      if (basename(selectedPath).toLowerCase() !== "skill.md") throw new Error("Choose a local SKILL.md")
      const raw = readResourceFile(dirname(selectedPath), selectedPath)
      if (!raw) throw new Error("Selected SKILL.md no longer exists")
      const parsed = parseFrontmatter(raw.body), name = parsed?.meta.name ?? basename(dirname(selectedPath))
      if (!parsed?.meta.description) throw new Error("SKILL.md requires valid frontmatter with a description")
      validateResourceName(name)
      return { name, body: raw.body, source }
    },
  }
}
