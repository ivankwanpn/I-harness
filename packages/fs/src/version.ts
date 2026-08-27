import { FsToolError } from "./error.ts"

// M21 §4.2：read→write 之間的 TOCTOU 防護——比對 {mtimeMs,size} 快照（mtime 以 Math.floor 比較，size 精確比較）。
export interface FileSnapshot {
  mtimeMs: number
  size: number
}

export function assertSnapshotFresh(before: FileSnapshot, after: FileSnapshot): void {
  if (Math.floor(before.mtimeMs) !== Math.floor(after.mtimeMs) || before.size !== after.size) {
    throw new FsToolError(
      "FS_STALE_VERSION",
      `file changed between read and write (mtime ${Math.floor(before.mtimeMs)} → ${Math.floor(after.mtimeMs)}, size ${before.size} → ${after.size}) — re-read then retry`,
    )
  }
}
