import { open, readlink } from "node:fs/promises"

export interface PinnedProjectDirectory { finalPath: string; scanPath: string; close(): Promise<void> }
/** Linux enumerates through the pinned fd. Windows holds directory handles
 * without FILE_SHARE_DELETE while their canonical paths are enumerated. */
export async function openPinnedProjectDirectory(path: string): Promise<PinnedProjectDirectory> {
  if (process.platform === "win32") {
    const { openWindowsProjectDirectory } = await import("./project-directory-win32.ts")
    return openWindowsProjectDirectory(path)
  }
  if (process.platform !== "linux") throw new Error("Secure project directory scan unavailable on this platform")
  const handle = await open(path, "r")
  try {
    if (!(await handle.stat()).isDirectory()) throw new Error("Project scan target is not a directory")
    const finalPath = await readlink(`/proc/self/fd/${handle.fd}`)
    return { finalPath, scanPath: `/proc/self/fd/${handle.fd}`, close: () => handle.close() }
  } catch (error) { await handle.close(); throw error }
}
