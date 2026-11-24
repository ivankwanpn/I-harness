export type WorktreeSelection =
  | { mode: "create" }
  | { mode: "existing"; path: string }

export interface GitWorktree {
  path: string
  branch?: string
  head: string
  locked: boolean
  missing: boolean
  dirty?: boolean
  workspaceId?: string
  offered?: boolean
}

export interface GitWorktreeList {
  source: GitWorktree
  worktrees: GitWorktree[]
}
