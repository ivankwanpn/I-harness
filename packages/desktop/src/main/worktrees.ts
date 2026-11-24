import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, mkdir, readFile, realpath } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"
import type { GitWorktree, GitWorktreeList, WorktreeSelection } from "../shared/worktrees.ts"
import type { ProjectCatalog } from "./projects.ts"
import type { WorkspaceCatalog, WorkspaceEntry } from "./workspaces.ts"

const exec = promisify(execFile)
const envOverrides = new Set([
  "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_SHALLOW_FILE", "GIT_PREFIX",
  "GIT_CONFIG", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS",
])
const key = (path: string) => process.platform === "win32" ? path.toLowerCase().replaceAll("/", "\\") : path
const samePath = (left: string, right: string) => key(left) === key(right)

async function git(cwd: string, ...args: string[]): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => {
    const key = name.toUpperCase()
    return !envOverrides.has(key) && !key.startsWith("GIT_CONFIG_KEY_") && !key.startsWith("GIT_CONFIG_VALUE_")
  }))
  const { stdout } = await exec("git", [
    "-c", "core.fsmonitor=false",
    "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
    ...args,
  ], { cwd, env: { ...env, GIT_TERMINAL_PROMPT: "0" }, encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 60000, windowsHide: true })
  return stdout
}

async function identity(cwd: string) {
  const root = await realpath(cwd)
  if (!samePath(root, cwd)) throw new Error("Workspace path changed")
  const gitRoot = (await git(cwd, "rev-parse", "--path-format=absolute", "--show-toplevel")).trim()
  if (!samePath(await realpath(gitRoot), root)) throw new Error("Select the root of a Git working tree")
  const common = await realpath((await git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")).trim())
  const gitDir = await realpath((await git(cwd, "rev-parse", "--path-format=absolute", "--git-dir")).trim())
  return { root, common, gitDir }
}

async function worktreeList(cwd: string): Promise<GitWorktree[]> {
  const output = await git(cwd, "worktree", "list", "--porcelain", "-z")
  const rows: GitWorktree[] = []
  let row: GitWorktree | undefined
  for (const field of output.split("\0")) {
    if (field.startsWith("worktree ")) {
      row = { path: field.slice(9), head: "", locked: false, missing: false }
      rows.push(row)
    } else if (row) {
      if (field.startsWith("HEAD ")) row.head = field.slice(5)
      else if (field.startsWith("branch ")) row.branch = field.slice(7).replace(/^refs\/heads\//, "")
      else if (field === "locked" || field.startsWith("locked ")) row.locked = true
      else if (field === "prunable" || field.startsWith("prunable ")) row.missing = true
    }
  }
  return rows.filter(row => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(row.head) && !/^0+$/.test(row.head))
}

/** Profile-owned worktrees. The draft creation token maps to one Git path even
 * if Git finished before the workspace catalog or the response was written. */
export function createDesktopWorktrees(directory: string, catalog: WorkspaceCatalog, projects: ProjectCatalog) {
  type Created = { workspaceId: string; sessionId: string }
  const submissions = new Map<string, { choice: string; result: Promise<Created> }>()
  const readers = new Set<Promise<unknown>>()
  let tail: Promise<unknown> = Promise.resolve()
  let active = 0
  let closed = false

  async function source(workspaceId: string, projectId: string) {
    const workspace = catalog.get(workspaceId)
    const project = (await projects.list()).find(project => project.id === projectId)
    if (!workspace || workspace.worktree || !project?.workspaceIds.includes(workspaceId)) {
      throw new Error("The source folder is not a current project folder")
    }
    return workspace
  }

  async function assertWorktree(workspace: WorkspaceEntry) {
    if (!workspace.worktree) return
    const root = await realpath(workspace.path)
    const marker = join(root, ".git")
    const markerInfo = await lstat(marker)
    if (!samePath(root, workspace.path) || !markerInfo.isFile() || markerInfo.size > 32768) {
      throw new Error("The linked worktree path changed")
    }
    const pointer = /^gitdir: (.+)$/m.exec((await readFile(marker, "utf8")).trim())
    const gitDir = pointer && await realpath(resolve(root, pointer[1]!))
    if (!gitDir || !samePath(gitDir, workspace.worktree.gitDir)) {
      throw new Error("The linked worktree no longer belongs to this repository")
    }
    const commonPointer = (await readFile(join(gitDir, "commondir"), "utf8")).trim()
    if (!samePath(await realpath(resolve(gitDir, commonPointer)), workspace.worktree.gitCommonDir)) {
      throw new Error("The linked worktree repository changed")
    }
  }

  function run<T>(operation: () => Promise<T>): Promise<T> {
    if (closed) return Promise.reject(new Error("Worktree manager is closed"))
    active++
    const result = tail.then(operation, operation)
    tail = result.finally(() => { active-- }).catch(() => {})
    return result
  }

  function read<T>(operation: () => Promise<T>): Promise<T> {
    if (closed) return Promise.reject(new Error("Worktree manager is closed"))
    const result = operation().finally(() => readers.delete(result))
    readers.add(result)
    return result
  }

  return {
    assertWorktree,
    hasActiveWork: () => active > 0 || readers.size > 0,
    async close() {
      closed = true
      await Promise.allSettled([tail, ...readers, ...Array.from(submissions.values(), record => record.result)])
    },
    createSession(workspaceId: string, projectId: string, token: string, selection: WorktreeSelection, create: () => Promise<Created>) {
      if (closed) return Promise.reject(new Error("Worktree manager is closed"))
      const key = JSON.stringify([workspaceId, projectId, token])
      const choice = JSON.stringify(selection)
      const existing = submissions.get(key)
      if (existing) {
        return existing.choice === choice ? existing.result : Promise.reject(new Error("Worktree choice changed during conversation creation"))
      }
      active++
      const result = create().finally(() => {
        submissions.delete(key)
        active--
      })
      submissions.set(key, { choice, result })
      return result
    },
    describe(workspaceId: string): Promise<GitWorktree | undefined> {
      return read(async () => {
        const workspace = catalog.get(workspaceId)
        if (!workspace?.worktree) return undefined
        await assertWorktree(workspace)
        const row = (await worktreeList(workspace.path)).find(row => samePath(row.path, workspace.path))
        if (!row) return undefined
        return { ...row, dirty: !!(await git(workspace.path, "--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=normal")) }
      })
    },
    setOffered(workspaceId: string, projectId: string, offered: boolean) {
      return run(async () => {
        const workspace = catalog.get(workspaceId)
        if (!workspace?.worktree || workspace.worktree.projectId !== projectId || !catalog.setWorktreeOffered) {
          throw new Error("The worktree is not managed by this project")
        }
        await source(workspace.worktree.sourceWorkspaceId, projectId)
        await catalog.setWorktreeOffered(workspaceId, offered)
      })
    },
    relocate(workspaceId: string, closeOriginal: (id: string) => Promise<void>) {
      return run(async () => {
        const workspace = catalog.get(workspaceId)
        if (!workspace?.worktree || !catalog.relocateWorktree) throw new Error("Worktree is not registered")
        // The repository's original administrative entry points back to its
        // checkout. Relocation changes only a path, retaining the session host ID.
        const pointer = await readFile(join(workspace.worktree.gitDir, "gitdir"), "utf8")
        const marker = resolve(workspace.worktree.gitDir, pointer.trim())
        if (basename(marker) !== ".git") throw new Error("Git has not recorded a linked checkout")
        const path = await realpath(dirname(marker))
        await assertWorktree({ ...workspace, path })
        if (samePath(workspace.path, path)) return workspace
        await closeOriginal(workspaceId)
        return catalog.relocateWorktree(workspaceId, path)
      })
    },
    list(workspaceId: string, projectId: string): Promise<GitWorktreeList | undefined> {
      return read(async () => {
        const workspace = await source(workspaceId, projectId)
        let repo
        try { repo = await identity(workspace.path) }
        catch { return undefined }
        const rows = await worktreeList(repo.root)
        const current = rows.find(row => samePath(row.path, repo.root))
        if (!current) return undefined
        // A detached checkout can be a source. Other entries must still be
        // linked checkouts, and already assigned paths stay with their owner.
        const owners = await catalog.list()
        const worktrees = rows.filter(row => !row.missing && !samePath(row.path, repo.root)
          && !samePath(row.path, join(repo.common, ".."))
          && !owners.some(owner => samePath(owner.path, row.path)
            && (!owner.worktree || owner.worktree.projectId !== projectId)))
        const withStatus = async (row: GitWorktree): Promise<GitWorktree> => {
          try {
            const selected = await identity(await realpath(row.path))
            if (!samePath(selected.common, repo.common)) return { ...row, missing: true }
            const owner = owners.find(owner => samePath(owner.path, row.path))
            return { ...row, workspaceId: owner?.id, offered: owner?.worktree?.offered,
              dirty: !!(await git(selected.root, "--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=normal")) }
          } catch { return { ...row, missing: true } }
        }
        const result: GitWorktree[] = []
        for (const row of worktrees) result.push(await withStatus(row))
        return { source: await withStatus(current), worktrees: result }
      })
    },
    prepare(workspaceId: string, projectId: string, clientToken: string, selection: WorktreeSelection): Promise<WorkspaceEntry> {
      return run(async () => {
        if (!catalog.registerWorktree) throw new Error("Worktree catalog unavailable")
        const workspace = await source(workspaceId, projectId)
        const repo = await identity(workspace.path)
        const receipt = { sourceWorkspaceId: workspaceId, projectId, gitCommonDir: repo.common }
        const rows = await worktreeList(repo.root)
        if (!rows.some(row => samePath(row.path, repo.root))) throw new Error("The source checkout has no commit")
        if (selection.mode === "existing") {
          if (!isAbsolute(selection.path)) throw new Error("Choose an existing linked worktree")
          const selected = await identity(await realpath(selection.path))
          if (samePath(selected.root, repo.root) || !samePath(selected.common, repo.common)
            || samePath(selected.gitDir, selected.common) || !rows.some(row => !row.missing && !row.locked && samePath(row.path, selected.root))) {
            throw new Error("Choose a linked worktree from this repository")
          }
          if ((await catalog.list()).some(row => samePath(row.path, selected.root) && row.worktree?.offered === false)) {
            throw new Error("Enable the linked worktree before using it for a new conversation")
          }
          await source(workspaceId, projectId)
          return catalog.registerWorktree(selected.root, { ...receipt, gitDir: selected.gitDir, kind: "imported" })
        }

        const operationId = createHash("sha256").update(JSON.stringify([workspaceId, projectId, clientToken])).digest("hex")
        const remembered = (await catalog.list()).find(row => row.worktree?.operationId === operationId)
        if (remembered) {
          await assertWorktree(remembered)
          return remembered
        }
        await mkdir(directory, { recursive: true })
        const root = await realpath(directory)
        const repoRelation = relative(repo.root, root)
        if (!repoRelation || !isAbsolute(repoRelation) && repoRelation !== ".." && !repoRelation.startsWith(".." + sep)) {
          throw new Error("Choose a project outside IH's worktree storage")
        }
        const name = operationId.slice(0, 20)
        const path = join(root, name)
        const branch = `ih/task-${name}`
        const expected = rows.find(row => samePath(row.path, path))
        if (!expected) {
          try { await lstat(path); throw new Error("Worktree destination is already in use") }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
          // An interrupted Git add may have left the generated ref without a
          // checkout. Git can safely resume by attaching its own existing ref.
          let existingBranch = false
          try {
            await git(repo.root, "show-ref", "--verify", "--", "refs/heads/" + branch)
            existingBranch = true
          } catch (error) { if ((error as { code?: unknown }).code !== 128) throw error }
          await git(repo.root, "worktree", "add", ...(existingBranch ? ["--", path, branch] : ["-b", branch, "--", path, "HEAD"]))
        } else if (expected.branch !== branch || expected.missing || expected.locked) {
          throw new Error("The previous worktree creation has an unresolved Git checkout")
        }
        const created = await identity(path)
        if (!samePath(created.common, repo.common) || samePath(created.gitDir, repo.common)) {
          throw new Error("Linked worktree validation failed")
        }
        await source(workspaceId, projectId)
        return catalog.registerWorktree(path, { ...receipt, gitDir: created.gitDir, kind: "managed", operationId })
      })
    },
  }
}
