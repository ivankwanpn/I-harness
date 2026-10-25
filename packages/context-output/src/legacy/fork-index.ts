import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ContextStore } from '../store.ts'
import type { WorkspaceMutationTurn } from '../workspace-mutation.ts'
import { recordHash } from './fork-codec.ts'
import { pageName, walkPages } from './fork-pages.ts'
import type { LegacyRoot } from './fork-types.ts'

export type LegacyIndexMutation = <T>(work: (turn: WorkspaceMutationTurn) => Promise<T>) => Promise<T>
export async function verifyPageInventory(store: ContextStore, directory: string, root: LegacyRoot, guard: () => void): Promise<void> {
  const binding = recordHash('binding', root.binding), names = await readdir(resolve(directory, 'pages')); guard()
  let finals = 0
  for (const name of names) if (name.endsWith('.json')) { finals++; if (!store.legacyPageHint(binding, name)) throw Error('Legacy page EOF mismatch') }
  if (finals !== store.legacyPageCount(binding)) throw Error('Legacy page EOF mismatch')
}
/** Explicit owner phase, called before private lookup. Only the original
 * disposable main index changes; source and canonical grant records do not. */
export async function prepareLegacyIndex(store: ContextStore, directory: string, root: LegacyRoot, guard: () => void, mutate: LegacyIndexMutation, quota: number, groupCount?: number, force = false): Promise<void> {
  if (!force && store.legacyReady(root)) { await verifyPageInventory(store, directory, root, guard); return }
  await mutate(async turn => { guard(); await store.resetLegacyIndex(turn, recordHash('binding', root.binding), quota); guard() }); guard()
  for await (const _ of walkPages(directory, root, guard, groupCount, store.retireLegacyFile, async (ref, page) => {
    await mutate(async turn => { guard(); await store.stageLegacyPage(turn, recordHash('binding', root.binding), pageName(ref), page, quota); guard() }); guard()
  })) { guard() }
  await mutate(async turn => { guard(); await store.confirmLegacyIndex(turn, root, quota); guard() }); guard()
}
