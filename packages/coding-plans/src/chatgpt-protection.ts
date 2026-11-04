import { chmod, lstat, mkdir } from "node:fs/promises"
import { protectWindowsPath } from "@i-harness/fs"

/** A dedicated credential directory: reject links and fail closed if protection fails. */
export async function protectChatGptDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Credential directory must be a real directory")
  if (process.platform !== "win32") { await chmod(directory, 0o700); return }
  await protectWindowsPath(directory)
}

/** Existing files may carry explicit ACL entries that a parent DACL cannot remove. */
export async function protectChatGptFile(path: string): Promise<void> {
  if (process.platform !== "win32") { await chmod(path, 0o600); return }
  await protectWindowsPath(path)
}
