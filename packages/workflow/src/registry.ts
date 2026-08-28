// Workflow registry: scans <workspace>/workflow/*.yml into validated
// WorkflowDefinitions (spec §3.2). Definitions are static YAML, so the scan
// result is cached; `reload()` re-scans (rescan-per-access stays available by
// calling reload before reads — v0 has no watcher, mirroring the skills
// package). One invalid file warns and skips — it never breaks the registry.
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parseWorkflowYaml, type WorkflowDefinition } from "./definition.ts"

export interface WorkflowRegistry {
  // Cached index, sorted by name.
  list(): WorkflowDefinition[]
  // Unknown or non-kebab name → undefined (mirrors the skills registry).
  get(name: string): WorkflowDefinition | undefined
  // Force a re-scan of <workspace>/workflow/*.yml on the next access.
  reload(): void
}

export interface WorkflowRegistryDeps {
  workspace: string
  // Observability seam for the warn+skip path (defaults to console.warn).
  onWarn?: (message: string) => void
}

export function createWorkflowRegistry(deps: WorkflowRegistryDeps): WorkflowRegistry {
  const workflowDir = join(deps.workspace, "workflow")
  const onWarn = deps.onWarn ?? ((message: string) => console.warn(`[workflow] ${message}`))
  let cache: WorkflowDefinition[] | undefined

  function scan(): WorkflowDefinition[] {
    if (!existsSync(workflowDir)) return [] // no workflow/ dir = empty registry, not an error
    let entries: string[]
    try {
      entries = readdirSync(workflowDir)
    } catch (e) {
      onWarn(`cannot read ${workflowDir}: ${e instanceof Error ? e.message : String(e)}`)
      return []
    }
    const defs: WorkflowDefinition[] = []
    // Only *.yml (spec §3.2). Sorted by filename so the index is deterministic.
    for (const file of entries.filter((f) => f.endsWith(".yml")).sort()) {
      const stem = file.slice(0, -".yml".length)
      try {
        const text = readFileSync(join(workflowDir, file), "utf-8")
        // Name defaults to the file stem (spec: 缺省=檔名 stem).
        defs.push(parseWorkflowYaml(text, { fallbackName: stem }))
      } catch (e) {
        onWarn(`skipping ${file}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    return defs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }

  function ensure(): WorkflowDefinition[] {
    if (cache === undefined) cache = scan()
    return cache
  }

  return {
    list(): WorkflowDefinition[] {
      return [...ensure()]
    },
    get(name: string): WorkflowDefinition | undefined {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return undefined
      return ensure().find((d) => d.name === name)
    },
    reload(): void {
      cache = undefined
    },
  }
}
