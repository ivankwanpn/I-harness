// Workspace-relative file resolution for the LSP tools: absolute paths pass
// through unchanged; relative paths resolve against the workspace root.
import { isAbsolute, resolve } from "node:path"

export function resolveFileInWorkspace(workspaceRoot: string, filePath: string): string {
  if (isAbsolute(filePath)) return filePath
  return resolve(workspaceRoot, filePath)
}
