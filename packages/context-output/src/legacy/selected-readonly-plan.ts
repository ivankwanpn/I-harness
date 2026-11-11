import { resolve, basename } from 'node:path'
import { open, opendir, lstat } from 'node:fs/promises'
import { freezeJsonData } from '@i-harness/core-session'
import { ownedPath, pendingPath, readExact } from '../artifact/io.ts'
import { failuresTogether } from '../workspace-mutation.ts'
import { appliedFor, canonicalRecord, checkPage, checkRoot, recordHash, same, sourceHash } from './fork-codec.ts'
import { expiryBase, expiredTuple, readSlots, revokedTuple } from './fork-disposition.ts'
import { pageName } from './fork-pages.ts'
import { transferDirectory, rowCommitment } from './observed-read.ts'
import type { ContextStore } from '../store.ts'
import type { LegacyReadObservation, LegacyRoot, LegacyRow, LegacyPageRef } from './fork-types.ts'
import { legacyResultMetadata } from '../../../core-session/src/conversation/history/result-metadata.ts'
import { captureSelectedPlanView } from './selected-plan-view.ts'
import { SELECTED_RESULT_METADATA_LIMITS } from '../../../core-session/src/conversation/selected-results.ts'

export interface OriginalSelectedPlan {
  readonly directory: string; readonly root: LegacyRoot; readonly planDigest: string
  readonly bindingBytes: Buffer; readonly planBytes: Buffer; readonly appliedBytes: Buffer
  readonly selected?:ReturnType<typeof captureSelectedPlanView>
}

/** Selected-only bounded reads; every original descriptor belongs to the same
 * store ledger. Generic immutable confirmation and writers are unchanged. */
async function bytes(store: ContextStore, root: string, path: string, budget: number, guard: () => void, expected?: Buffer): Promise<Buffer> {
  guard(); await ownedPath(root, path); guard()
  const handle = await open(path, 'r'), failures: unknown[] = []
  let result!: Buffer
  try {
    guard(); const info = await handle.stat(); guard()
    if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size > budget) throw Error('Original metadata exceeds limit')
    result = await readExact(handle, info.size, 0); guard()
    if (expected && !result.equals(expected)) throw Error('Original metadata changed')
  } catch (failure) { failures.push(failure) }
  try { await store.retireLegacyFile(handle) } catch (failure) { failures.push(failure) }
  failuresTogether(failures, 'Original metadata read and close failed'); guard(); return result
}
/** A confirmed final may retain its original transaction's exact prefix. This
 * read never finishes or removes that transaction, and grants no authority. */
async function matchingPending(store: ContextStore, root: string, path: string, expected: Buffer, guard: () => void): Promise<string | undefined> {
  const pending = pendingPath(path, expected)
  guard()
  try { await lstat(pending) }
  catch (failure) { if ((failure as NodeJS.ErrnoException).code === 'ENOENT') { guard(); return }; throw failure }
  guard()
  const prefix = await bytes(store, root, pending, expected.length, guard)
  if (!prefix.equals(expected.subarray(0, prefix.length))) throw Error('Original pending metadata conflict')
  guard(); return basename(pending)
}
async function exact(store: ContextStore, root: string, path: string, expected: Buffer, guard: () => void): Promise<void> {
  await bytes(store, root, path, expected.length, guard, expected)
  await matchingPending(store, root, path, expected, guard); guard()
}
async function inventory(store: ContextStore, folder: string, limit: number, guard: () => void): Promise<Set<string>> {
  guard(); await ownedPath(store.directory, folder); guard()
  const directory = await opendir(folder), names = new Set<string>(), failures: unknown[] = []
  try {
    guard()
    for (;;) {
      const entry = await directory.read(); guard(); if (!entry) break
      if (names.size >= limit || names.has(entry.name)) throw Error('Original metadata inventory exceeds limit')
      names.add(entry.name)
    }
  } catch (failure) { failures.push(failure) }
  try { await store.retireLegacyDirectory(directory) } catch (failure) { failures.push(failure) }
  failuresTogether(failures, 'Original inventory and close failed'); guard(); return names
}
async function controlInventory(store: ContextStore, plan: OriginalSelectedPlan, guard: () => void): Promise<void> {
  const names = await inventory(store, plan.directory, 9, guard)
  for (const expected of ['binding.json', 'plan.json', 'applied.json', 'pages', 'revoke.0', 'revoke.1']) if (!names.delete(expected)) throw Error('Original control inventory conflict')
  for (const [name, expected] of [['binding.json', plan.bindingBytes], ['plan.json', plan.planBytes], ['applied.json', plan.appliedBytes]] as const) {
    const pending = await matchingPending(store, store.directory, resolve(plan.directory, name), expected, guard)
    if (pending && !names.delete(pending)) throw Error('Original pending control inventory changed')
  }
  if (names.size) throw Error('Original control inventory conflict')
}
export async function assertSelectedGrant(store: ContextStore, plan: OriginalSelectedPlan, guard: () => void): Promise<void> {
  guard(); const grant = await readSlots(store.directory, resolve(plan.directory, 'revoke'), revokedTuple(plan.root), store.retireLegacyFile); guard()
  if (grant !== 'live') throw Error('Original selected grant unavailable')
}
export async function assertSelectedPlan(store: ContextStore, plan: OriginalSelectedPlan, observation: LegacyReadObservation, guard: () => void): Promise<void> {
  guard(); const root = plan.root
  if (!observation.bootstrap || root.binding.workspaceId !== store.workspaceId || !same(root.binding.invocation, observation.bootstrap.invocation) || root.binding.manifestDigest !== observation.bootstrap.manifestDigest || root.binding.semanticSeedDigest !== observation.bootstrap.seedDigest || root.binding.targetSessionId !== observation.sessionId || root.binding.targetSourceDigest !== sourceHash(observation.sourceId)) throw Error('Original selected plan conflict')
  await exact(store, store.directory, resolve(plan.directory, 'binding.json'), plan.bindingBytes, guard)
  await exact(store, store.directory, resolve(plan.directory, 'plan.json'), plan.planBytes, guard)
  await exact(store, store.directory, resolve(plan.directory, 'applied.json'), plan.appliedBytes, guard)
  await assertSelectedGrant(store, plan, guard)
}
/** Capture A once; later checks compare original bytes, never adopt a new root. */
export async function readSelectedPlan(store: ContextStore, observation: LegacyReadObservation, guard: () => void): Promise<OriginalSelectedPlan> {
  if (!observation.bootstrap) throw Error('Original bootstrap required')
  const directory = transferDirectory(store, observation.bootstrap.invocation), path = resolve(directory, 'plan.json')
  const root = freezeJsonData(checkRoot(JSON.parse((await bytes(store, store.directory, path, 65536, guard)).toString('utf8'))))
  if(root.version===2&&!observation.selectedView||root.version===1&&observation.selectedView)throw Error('Legacy plan and seed version conflict')
  if (root.pages && root.pages.level > 53 || root.observationCount > SELECTED_RESULT_METADATA_LIMITS.rows) throw Error('Original graph exceeds limit')
  const selected=root.version===2?captureSelectedPlanView(observation.selectedView!,root,{sessionId:observation.bootstrap!.invocation.targetSessionId,createdAt:observation.bootstrap!.invocation.createdAt}):undefined
  const plan = Object.freeze({ directory, root,...(selected?{selected}:{}), planDigest: recordHash('plan', root,root.version), bindingBytes: Buffer.from(JSON.stringify(canonicalRecord({ version: root.version, kind: 'legacy-fork-binding', binding: root.binding }))), planBytes: Buffer.from(JSON.stringify(root)), appliedBytes: Buffer.from(JSON.stringify(appliedFor(root))) })
  await assertSelectedPlan(store, plan, observation, guard); return plan
}
/** One complete streaming pass: bounded inventories, one decoded page per ref,
 * one resident leaf and the existing bounded directory frontier. */
export async function* walkSelectedPages(store: ContextStore, plan: OriginalSelectedPlan, guard: () => void): AsyncGenerator<LegacyRow> {
  const { root, directory } = plan, folder = resolve(directory, 'pages'), limit = root.pages ? 2 * (root.pages.level + 1) * root.observationCount : 0
  if (!Number.isSafeInteger(limit) || root.pages && root.pages.level > 53) throw Error('Original graph exceeds limit')
  await controlInventory(store, plan, guard)
  const names = await inventory(store, folder, limit, guard), remaining = new Set(names)
  let count = 0, metadataBytes = 0
  async function* walk(ref: LegacyPageRef): AsyncGenerator<LegacyRow> {
    guard(); const name = pageName(ref), path = resolve(folder, name)
    if (!remaining.delete(name)) throw Error('Original page inventory conflict')
    const raw = await bytes(store, directory, path, 65536, guard), page = checkPage(JSON.parse(raw.toString('utf8')), root.binding,undefined,root.version); guard()
    const expected = Buffer.from(JSON.stringify(page))
    if (!raw.equals(expected) || recordHash('page', page,root.version) !== ref.digest || ref.firstRow !== count) throw Error('Original page conflict')
    const pending = await matchingPending(store, directory, path, expected, guard)
    if (pending && !remaining.delete(pending)) throw Error('Original pending page inventory changed')
    if (page.kind === 'legacy-fork-leaf') {
      if (ref.level !== 0 || page.firstRow !== ref.firstRow || page.rows.length !== ref.rows) throw Error('Original leaf conflict')
      for (const row of page.rows) {
        count++; metadataBytes += row.metadataEncodedBytes
        if (count > SELECTED_RESULT_METADATA_LIMITS.rows || !Number.isSafeInteger(metadataBytes) || metadataBytes > SELECTED_RESULT_METADATA_LIMITS.bytes) throw Error('Selected metadata limit exceeded')
        guard(); yield row
      }
    } else {
      if (page.level !== ref.level || ref.level > 53 || page.children[0]!.firstRow !== ref.firstRow || page.children.reduce((n, child) => n + child.rows, 0) !== ref.rows) throw Error('Original directory conflict')
      for (const child of page.children) yield* walk(child)
    }
  }
  if (root.pages) yield* walk(root.pages)
  if (count !== root.observationCount || remaining.size) throw Error('Original row or page count conflict')
  const final = await inventory(store, folder, limit, guard)
  if (final.size !== names.size || [...names].some(name => !final.has(name))) throw Error('Original page inventory conflict')
  await controlInventory(store, plan, guard)
}
export async function selectedRow(store: ContextStore, plan:OriginalSelectedPlan, row: LegacyRow, observation:LegacyReadObservation, guard: () => void,requireVisible=true) {
  const root=plan.root;plan.selected?.row(row);const visible=()=>root.version!==2||plan.selected!.visible(row)
  if(requireVisible&&!visible())return undefined
  guard(); const c = rowCommitment(row), live = async () => { const state = await readSlots(store.directory, expiryBase(store.directory, c), expiredTuple(store.workspaceId, c), store.retireLegacyFile); guard(); if (state !== 'live' || c.expiresAt <= Date.now()) throw Error('Original reference expired') }
  await live()
  const ref = legacyResultMetadata(await store.canonicalRef(c, root.binding.targetSessionId, true)); guard()
  if (ref.source && ref.source.sourceId !== observation.sourceId) throw Error('Original source policy changed')
  await live(); guard();if(requireVisible&&!visible())return undefined
  return { ref, original: { kind: 'local' as const, sessionId: row.original.sessionId, seq: row.original.seq, event: 'context/result-ref' as const, slot: 'ref' as const }, extent: row.extent, anchor: row.anchor }
}
export async function qualifySelectedGraph(store: ContextStore, plan: OriginalSelectedPlan, observation: LegacyReadObservation, guard: () => void) {
  const distinct = new Map<string, string>(); let rows = 0, metadataBytes = 0, minimumExpiry: number | undefined
  const expected=plan.root.version===2?plan.selected!.expectedLegacyRows()[Symbol.iterator]():undefined
  for await (const row of walkSelectedPages(store, plan, guard)) {
    if(expected){const next=expected.next();if(next.done||!same(next.value,{anchor:row.anchor,...rowCommitment(row),extent:row.extent,original:row.original}))throw Error('Selected seed coverage conflict')}
    const commitment = JSON.stringify(rowCommitment(row)), prior = distinct.get(row.refId)
    if (prior !== undefined && prior !== commitment) throw Error('Inconsistent original reference commitment')
    distinct.set(row.refId, commitment); rows++; metadataBytes += row.metadataEncodedBytes
    plan.selected?.row(row)
    const visible=plan.root.version!==2||plan.selected!.visible(row)
    if(visible){minimumExpiry = Math.min(minimumExpiry ?? Infinity, row.expiresAt);await selectedRow(store, plan, row, observation, guard,false)}
  }
  if(expected&&!expected.next().done)throw Error('Selected seed coverage incomplete')
  if (distinct.size !== plan.root.distinctRefCount) throw Error('Original distinct reference count conflict')
  if(expected)await assertSelectedPlan(store,plan,observation,guard)
  guard(); return { rows, distinctRefs: distinct.size, metadataBytes, minimumExpiry }
}
