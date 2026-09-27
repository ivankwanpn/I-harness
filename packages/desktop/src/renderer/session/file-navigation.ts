export interface FileNavigation { workspacePath: string; onOpenFile(path: string): void }

/** Presentation routing only; the existing review backend remains the authority
 * for filesystem access, symlinks and workspace confinement. Never parse shells. */
export function toolFilePath(name: string, args: unknown, workspacePath: string): string | undefined {
  if (!workspacePath || !["read", "read_file", "write", "write_file", "edit"].includes(name) || !args || typeof args !== "object" || Array.isArray(args)) return undefined
  const input = args as Record<string, unknown>
  const raw = input.path ?? input.file_path ?? input.filePath
  if (typeof raw !== "string" || !raw || raw.length > 4096 || /[\0\r\n]/.test(raw)) return undefined
  const root = workspacePath.replace(/\\/g, "/").replace(/\/+$/, "")
  let path = raw.replace(/\\/g, "/")
  const absolute = path.startsWith("/") || /^[a-zA-Z]:\//.test(path)
  if (absolute) {
    const windows = /^[a-zA-Z]:/.test(root) || root.startsWith("//")
    const candidate = windows ? path.toLowerCase() : path
    const prefix = `${windows ? root.toLowerCase() : root}/`
    if (!candidate.startsWith(prefix)) return undefined
    path = path.slice(root.length + 1)
  }
  while (path.startsWith("./")) path = path.slice(2)
  if (!path || path.includes(":") || path.split("/").some((part) => part === "..")) return undefined
  return path
}
