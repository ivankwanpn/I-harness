// Skill registry: scans <workspace>/skills/**/SKILL.md and the global root
// (~/.i-harness/skills/**/SKILL.md; `globalDir` override for tests), merges
// workspace-over-global by name, and keeps bodies DEFERRED: list() and
// searchSkills() touch summaries only; getSkill() reads the SKILL.md fresh.
// v0 has no watcher — rescan-per-access (scanning a handful of SKILL.md files
// is cheap); one bad skill warns and skips, never breaking the registry.
import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs"
import { basename, dirname, join } from "node:path"
import { homedir } from "node:os"
import { parseFrontmatter } from "./frontmatter.ts"
import { searchSkillSummaries } from "./search.ts"

export type SkillSource = "workspace" | "global"

export interface Skill {
  name: string
  description: string
  body: string
  path: string
  source: SkillSource
}

export interface SkillSummary {
  name: string
  description: string
  path: string
  source: SkillSource
}

export interface SkillRegistry {
  // Merged index (workspace overrides global same-name), sorted by name.
  // Rescans on every access.
  list(): SkillSummary[]
  // Explicit body load. Unknown name or non-kebab request → undefined.
  // A skill present on disk but INVALID fails loud with a coded SkillToolError
  // (SKILL_INVALID_FRONTMATTER / SKILL_INVALID_NAME) so skill_get can tell the
  // model to repair the file instead of claiming not-found.
  getSkill(name: string): Promise<Skill | undefined>
  // BM25 via @i-harness/tool-search (exact name, select:, +term semantics).
  searchSkills(query: string, opts?: { limit?: number }): SkillSummary[]
}

export interface SkillRegistryDeps {
  workspace?: string
  globalDir?: string
  // Observability seam for the scan's warn+skip path (defaults to console.warn).
  onWarn?: (message: string) => void
}

// dsh name grammar, ≤64 (codex cap). Exported for the tool layer's validation.
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const SKILL_NAME_MAX_LENGTH = 64
export const SKILL_FILE = "SKILL.md"
// Simplified codex scan parameters: ≤4 directory levels below the skills root.
export const MAX_SKILL_DEPTH = 4
// Safety cap (codex entry-cap discipline, simplified): a root never yields more
// than this many skills; hitting it warns once and stops scanning deeper.
export const MAX_SKILL_ENTRIES = 256

export function isValidSkillName(name: string): boolean {
  return name.length > 0 && name.length <= SKILL_NAME_MAX_LENGTH && SKILL_NAME_PATTERN.test(name)
}

export type SkillToolErrorCode = "SKILL_INVALID_NAME" | "SKILL_INVALID_FRONTMATTER" | "SKILL_NOT_FOUND"

// Coded skill error (messages carry a remedy). Lives next to the registry so
// both the scan (warn+skip) and the tool layer (explicit fail) share codes.
export class SkillToolError extends Error {
  readonly code: SkillToolErrorCode

  constructor(code: SkillToolErrorCode, message: string) {
    super(`[${code}] ${message}`)
    this.name = "SkillToolError"
    this.code = code
  }
}

const GLOBAL_SKILLS_DIR = join(homedir(), ".i-harness", "skills")

function defaultWarn(message: string): void {
  console.warn(`[skills] ${message}`)
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Read + validate ONE SKILL.md. Throws a coded SkillToolError on a bad file so
// the scan can warn+skip and skill_get can fail explicitly with a code.
function readSkillFile(path: string, dirName: string, source: SkillSource): Skill {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (err) {
    throw new SkillToolError("SKILL_INVALID_FRONTMATTER", `cannot read skill file ${path} (${errorText(err)}). Remedy: restore or remove the file.`)
  }
  const parsed = parseFrontmatter(text)
  if (!parsed) {
    throw new SkillToolError(
      "SKILL_INVALID_FRONTMATTER",
      `${path} must start with a closed --- front-matter fence holding scalar name/description keys (nested or non-scalar values are invalid). Remedy: repair the SKILL.md front-matter.`,
    )
  }
  const name = parsed.meta.name ?? dirName // 缺 name → 目錄名
  if (!isValidSkillName(name)) {
    throw new SkillToolError(
      "SKILL_INVALID_NAME",
      `skill name '${name}' (${path}) is not lowercase kebab-case /^[a-z0-9]+(?:-[a-z0-9]+)*$/ with at most ${SKILL_NAME_MAX_LENGTH} chars. Remedy: rename the skill (or its directory).`,
    )
  }
  const description = parsed.meta.description
  if (description === undefined) {
    throw new SkillToolError(
      "SKILL_INVALID_FRONTMATTER",
      `${path} is missing the required single-line front-matter description. Remedy: add "description: <one line>" to the front-matter.`,
    )
  }
  return { name, description, body: parsed.body, path, source }
}

function toSummary(skill: Skill): SkillSummary {
  return { name: skill.name, description: skill.description, path: skill.path, source: skill.source }
}

// Walk one skills root (`<workspace>/skills` or the global root). Depth is
// counted from the root: a skill directory directly under it is depth 1, and
// directories beyond MAX_SKILL_DEPTH are never descended into. Hidden entries
// (leading ".") are skipped entirely; per-skill errors warn and skip.
function scanSkillsDir(root: string, source: SkillSource, onWarn: (message: string) => void): SkillSummary[] {
  const summaries: SkillSummary[] = []
  let capped = false
  const visit = (dir: string, depth: number): void => {
    if (capped) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      // A missing root is normal (no skills dir yet) — silent; anything else warns.
      if (depth === 0 && (err as NodeJS.ErrnoException)?.code === "ENOENT") return
      onWarn(`cannot read skills directory ${dir}: ${errorText(err)}`)
      return
    }
    for (const entry of entries) {
      if (capped) return
      if (entry.name.startsWith(".")) continue // hidden dirs/files are skipped
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth + 1 > MAX_SKILL_DEPTH) continue // depth cap
        visit(full, depth + 1)
        continue
      }
      if (entry.isFile() && entry.name === SKILL_FILE && depth >= 1) {
        try {
          summaries.push(toSummary(readSkillFile(full, basename(dir), source)))
          if (summaries.length >= MAX_SKILL_ENTRIES) {
            capped = true
            onWarn(`entry cap reached (${MAX_SKILL_ENTRIES} skills under ${root}); deeper entries are ignored`)
          }
        } catch (err) {
          // Per-skill error: warn + skip — one bad skill never breaks the registry.
          onWarn(errorText(err))
        }
      }
    }
  }
  visit(root, 0)
  return summaries
}

export function createSkillRegistry(deps?: SkillRegistryDeps): SkillRegistry {
  const onWarn = deps?.onWarn ?? defaultWarn

  function scanGlobal(): SkillSummary[] {
    return scanSkillsDir(deps?.globalDir ?? GLOBAL_SKILLS_DIR, "global", onWarn)
  }

  function scanWorkspace(): SkillSummary[] {
    if (deps?.workspace === undefined) return []
    return scanSkillsDir(join(deps.workspace, "skills"), "workspace", onWarn)
  }

  function list(): SkillSummary[] {
    const merged = new Map<string, SkillSummary>()
    for (const summary of scanGlobal()) merged.set(summary.name, summary)
    for (const summary of scanWorkspace()) merged.set(summary.name, summary) // workspace 蓋 global
    return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  // Conventional <root>/<name>/SKILL.md probe locations, workspace first. Used
  // only when the valid index has no such name: a skill whose file is BROKEN is
  // skipped by the scan, but skill_get must fail explicitly on it instead of
  // reporting a misleading SKILL_NOT_FOUND.
  function probeRoots(): [root: string, source: SkillSource][] {
    const roots: [string, SkillSource][] = []
    if (deps?.workspace !== undefined) roots.push([join(deps.workspace, "skills"), "workspace"])
    roots.push([deps?.globalDir ?? GLOBAL_SKILLS_DIR, "global"])
    return roots
  }

  async function getSkill(name: string): Promise<Skill | undefined> {
    // Non-kebab / oversized names can never match a valid skill → undefined
    // (the skill_get tool surfaces the request as SKILL_INVALID_NAME itself).
    if (!isValidSkillName(name)) return undefined
    const summary = list().find((skill) => skill.name === name)
    if (summary) {
      const skill = readSkillFile(summary.path, basename(dirname(summary.path)), summary.source)
      if (skill.name === name) return skill
    }
    for (const [root, source] of probeRoots()) {
      const candidate = join(root, name, SKILL_FILE)
      if (!existsSync(candidate)) continue
      const skill = readSkillFile(candidate, name, source) // may throw SKILL_INVALID_*
      if (skill.name === name) return skill
    }
    return undefined
  }

  function searchSkills(query: string, opts?: { limit?: number }): SkillSummary[] {
    return searchSkillSummaries(query, list(), opts)
  }

  return { list, getSkill, searchSkills }
}
