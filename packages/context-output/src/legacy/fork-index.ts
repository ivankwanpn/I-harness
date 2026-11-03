import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { IndexedLegacyContext } from './index-lifecycle.ts'
import type { WorkspaceMutationTurn } from '../workspace-mutation.ts'
import { recordHash } from './fork-codec.ts'
import { pageName, walkPages } from './fork-pages.ts'
import type { LegacyRoot } from './fork-types.ts'

export type LegacyIndexMutation = <T>(context: IndexedLegacyContext, work: (turn: WorkspaceMutationTurn) => Promise<T>) => Promise<T>
export async function verifyPageInventory(context: IndexedLegacyContext, directory: string, root: LegacyRoot, guard: () => void): Promise<void> {
  const { store, index } = context
  index.assertCurrent()
  const binding = recordHash('binding', root.binding,root.version), names = await readdir(resolve(directory, 'pages')); index.assertCurrent(); guard()
  let finals = 0
  for (const name of names) if (name.endsWith('.json')) { finals++; if (!store.legacyPageHint(index, binding, name)) throw Error('Legacy page EOF mismatch') }
  if (finals !== store.legacyPageCount(index, binding)) throw Error('Legacy page EOF mismatch')
}
/** Explicit owner phase, called before private lookup. Only the original
 * disposable main index changes; source and canonical grant records do not. */
export async function prepareLegacyIndex(context: IndexedLegacyContext, directory: string, root: LegacyRoot, guard: () => void, mutate: LegacyIndexMutation, quota: number, groupCount?: number, force = false): Promise<void> {
  const { store, lease, index } = context
  index.assertCurrent()
  const checked = () => { index.assertCurrent(); guard() }
  if (!force && store.legacyReady(index, root)) { await verifyPageInventory(context, directory, root, guard); return }
  await mutate(context, async turn => { checked(); await store.resetLegacyIndex(turn, lease, index, recordHash('binding', root.binding,root.version), quota); checked() }); checked()
  for await (const _ of walkPages(directory, root, checked, groupCount, store.retireLegacyFile, async (ref, page) => {
    await mutate(context, async turn => { checked(); await store.stageLegacyPage(turn, lease, index, recordHash('binding', root.binding,root.version), pageName(ref), page, quota,root.version); checked() }); checked()
  })) { checked() }
  await mutate(context, async turn => { checked(); await store.confirmLegacyIndex(turn, lease, index, root, quota); checked() }); checked()
}
