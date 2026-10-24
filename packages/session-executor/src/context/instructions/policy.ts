import { dirname, resolve } from 'node:path'
import { lstat, stat } from 'node:fs/promises'
import { SettingsStore, resolveInstructionPolicy, watchSettings, type SettingsWatchHandle, type SettingsSourceStamp } from '@i-harness/settings'
import type { FsWatchService } from '@i-harness/fs-watch'
import type { SavedInstructionPolicyPort, SavedInstructionState } from './contracts.ts'

// Windows may report ENOENT for a child beneath a regular file. Missing native
// homes are valid; a non-directory ancestor is never a first-run profile.
async function missingProfileIsViable(path: string): Promise<void> {
  const assertMissing = async () => {
    try { await lstat(path) }
    catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return; throw error }
    throw new Error('Missing policy observation was superseded')
  }
  await assertMissing()
  let current = dirname(path)
  while (true) {
    let entry: Awaited<ReturnType<typeof lstat>> | undefined
    try { entry = await lstat(current) }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error }
    if (entry) {
      // A broken link is an existing invalid ancestor; never skip to its parent.
      const mapped = entry.isSymbolicLink() ? await stat(current) : entry
      if (!mapped.isDirectory()) throw new Error('Invalid native config home')
      await assertMissing()
      return
    }
    const parent = dirname(current)
    if (parent === current) throw new Error('Native config home unavailable')
    current = parent
  }
}

/** Strict reads and W2 coverage are both required for saved policy authority. */
export function createSavedInstructionPolicy(settingsPath: string, watch: FsWatchService): SavedInstructionPolicyPort & { dispose(): void; close(): Promise<void> } {
  const path = resolve(settingsPath), store = new SettingsStore({ path }), listeners = new Set<() => void>()
  let revision = 0, disposed = false, present = false
  let state: SavedInstructionState = { kind: 'unavailable', generation: '0', reason: 'Instruction policy loading' }
  let jobs: Promise<void> = Promise.resolve()
  let watcher: SettingsWatchHandle | undefined, unsubscribe: (() => void) | undefined
  const readSaved = async () => {
    try {
      const observed = await store.loadObserved()
      if (observed.kind === 'loaded') present = true
      return observed
    } catch {
      // A rejected present/unreadable observation is never a first-run proof.
      // A later deletion must not turn that failure into default authority.
      present = true
      throw new Error('Saved instruction policy unavailable')
    }
  }
  const fence = (reason: string) => {
    state = { kind: 'unavailable', generation: String(++revision), reason }
    for (const listener of [...listeners]) listener()
  }
  const reload = () => {
    const generation = revision
    const job = jobs.catch(() => {}).then(async () => {
      if (disposed) return
      try {
        const result = await readSaved()
        if (result.kind === 'missing') await missingProfileIsViable(path)
        if (disposed || generation !== revision || watcher?.getState().kind !== 'covered') return
        if (result.kind === 'missing' && present) throw new Error('Saved instruction policy missing')
        state = { kind: 'ready', generation: String(generation), policy: resolveInstructionPolicy(result.kind === 'loaded' ? result.settings.instructions : { enabled: true, maxBytes: 24000 }, dirname(path)) }
      } catch {
        if (!disposed && generation === revision) state = { kind: 'unavailable', generation: String(generation), reason: 'Saved instruction policy unavailable' }
      }
    })
    jobs = job; return job
  }
  const initialized = (async () => {
    let baseline: SettingsSourceStamp = { kind: 'unreadable', code: 'INITIAL_UNAVAILABLE' }
    try { const result = await readSaved(); baseline = result.stamp } catch { /* Unavailable until a successful strict reload. */ }
    if (disposed) return
    watcher = watchSettings(path, () => reload(), { service: watch, baseline: new Map([[path, baseline]]) })
    // W2 synchronously calls state subscribers before its asynchronous stamp read.
    unsubscribe = watcher.subscribeState(value => {
      fence(value.kind === 'covered' ? 'Instruction policy changed' : 'Instruction policy coverage unavailable')
      if (value.kind === 'covered') void reload()
    })
    await watcher.ready.catch(() => {})
  })
  const initialJob = initialized()
  return { current: () => state, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async ready() {
      await initialJob
      await jobs
      if (state.kind !== 'ready') throw new Error(state.reason)
    },
    dispose() { if (disposed) return; disposed = true; fence('Instruction policy closed'); unsubscribe?.(); watcher?.dispose() },
    async close() { this.dispose(); await initialJob; await jobs; await watcher?.close() },
  }
}
