import { createHash } from 'node:crypto'
import { realpath, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { normalizeContextSubsystems, resolveSettingsPath } from '@i-harness/settings'
import type { ContextOutputConfig } from './types.ts'

export const contextPathKey = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
/** Preserve the established Desktop workspace identity and nested layout. */
export async function contextWorkspaceIdentity(workspace: string) {
  const canonical = await realpath(workspace), workspaceKey = hash(contextPathKey(canonical))
  return { canonical, workspaceKey }
}
export const contextOutputServiceRoot = (nativeContextRoot: string): string => join(nativeContextRoot, 'context-output')
export async function contextWorkspaceLocation(workspace: string, storageRoot: string) {
  const identity = await contextWorkspaceIdentity(workspace), canonicalStore = await realpath(storageRoot)
  return { ...identity, serviceRoot: contextOutputServiceRoot(join(canonicalStore, 'native-context')) }
}
export function contextSourceIdentity(workspaceKey: string, canonical: string, scope?: { id: string; roots: readonly string[] }): string {
  return 'session-scope:' + hash(JSON.stringify([scope?.id ?? workspaceKey, (scope?.roots ?? [canonical]).map(contextPathKey).sort()]))
}
export async function loadContextOutputConfiguration(workspaceKey: string, path?: string): Promise<ContextOutputConfig> {
  let raw: unknown
  try { raw = JSON.parse(await readFile(resolveSettingsPath(path === undefined ? {} : { path }), 'utf8')) }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Result storage configuration unavailable') }
  const document = raw && typeof raw === 'object' ? raw as { contextSubsystems?: unknown } : {}
  const saved = normalizeContextSubsystems(document.contextSubsystems)
  return { ...saved.contextOutput, ...saved.workspaceOverrides[workspaceKey]?.contextOutput }
}
