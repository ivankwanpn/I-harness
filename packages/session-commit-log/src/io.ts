import { mkdir, open, readdir, readFile, rm, unlink, link } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'

export type OpenFlags = 'r' | 'r+' | 'wx'

/** Injectable filesystem port: the store never imports node:fs directly, so crash
 *  cuts are injected by wrapping this port instead of monkey-patching modules. */
export type CommitLogIo = {
  open(path: string, flags: OpenFlags): Promise<FileHandle>
  readFile(path: string): Promise<Buffer>
  link(existing: string, next: string): Promise<void>
  unlink(path: string): Promise<void>
  mkdir(path: string): Promise<void>
  readdir(path: string): Promise<string[]>
  rm(path: string): Promise<void>
}

export const nodeIo: CommitLogIo = {
  open: (path, flags) => open(path, flags),
  readFile: path => readFile(path),
  link: (existing, next) => link(existing, next),
  unlink: path => unlink(path),
  mkdir: async path => { await mkdir(path, { recursive: true }) },
  readdir: path => readdir(path),
  rm: async path => { await rm(path, { recursive: true, force: true }) },
}

export function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null | undefined)?.code === 'ENOENT'
}

export function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null | undefined)?.code === 'EEXIST'
}
