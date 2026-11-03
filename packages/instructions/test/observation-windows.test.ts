import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { createFsWatchService, type FsWatchService, type WatchNotification } from '@i-harness/fs-watch'
import { createObservedInstructionService, createInstructionObservationOwner, type InstructionScope } from '../src/index.ts'
import { temporary } from './helpers/observation-fixture.ts'
import { follow } from './helpers/follow-source.ts'

describe.skipIf(process.platform !== 'win32')('real Windows observation/factory backend', () => {
  it('reconciles startup, ignored-parent absent preferred creation, atomic replace and directory replacement', async () => {
    const temp = await temporary(), root = join(temp.root, '.i-harness', 'rules')
    await fs.mkdir(root, { recursive: true }); await fs.writeFile(join(root, 'CLAUDE.md'), 'fallback')
    const backend = createFsWatchService(), trace: WatchNotification[] = []
    const watch: FsWatchService = { acquire(options) {
      const lease = backend.acquire(options)
      return { ready: lease.ready, subscribe(listener) { return lease.subscribe(event => { trace.push(event); listener(event) }) }, close: () => lease.close() }
    }, close: () => backend.close() }, observation = createInstructionObservationOwner(watch)
    const scope: InstructionScope = { cwd: root, roots: [root], globalSources: [], enabled: true, maxBytes: 24000 }
    const view = createObservedInstructionService({ scope, observation }), tracker = follow(view)
    let stage = 'startup'
    try {
      const initial = view.prepare([])
      await fs.writeFile(join(root, 'CLAUDE.md'), 'startup write'); await initial
      await tracker.at(value => value.reliability === 'ready' && value.text.includes('startup write'))
      stage = 'preferred'
      const preferred = tracker.at(value => value.reliability === 'ready' && value.text.includes('preferred'))
      await fs.writeFile(join(root, 'AGENTS.md'), 'preferred'); await preferred
      stage = 'atomic'
      const atomic = tracker.at(value => value.reliability === 'ready' && value.text.includes('atomic'))
      await fs.writeFile(join(root, 'replacement'), 'atomic'); await fs.rename(join(root, 'replacement'), join(root, 'AGENTS.md')); await atomic
      stage = 'directory replacement'
      const replaced = tracker.at(value => value.reliability === 'ready' && value.text.includes('directory replacement'))
      await fs.rename(root, join(temp.root, '.i-harness', 'retired')); await fs.mkdir(root)
      await fs.writeFile(join(root, 'AGENTS.md'), 'directory replacement'); await replaced
      stage = 'ordinary write after directory recovery'
      const later = tracker.at(value => value.reliability === 'ready' && value.text.includes('later directory write'))
      await fs.writeFile(join(root, 'AGENTS.md'), 'later directory write'); await later
    } catch (error) {
      throw new Error(JSON.stringify({ stage, trace, snapshot: view.snapshot() }), { cause: error })
    } finally { await tracker.close(); await view.close(); await observation.close(); await watch.close(); await temp.remove() }
  }, 30000)

  it.each(['file', 'directory'] as const)('observes Git %s boundary creation/removal through explicit marker roots', async kind => {
    const temp = await temporary(), child = join(temp.root, 'child'), git = join(temp.root, 'git-data')
    await fs.mkdir(child); await fs.mkdir(git); await fs.writeFile(join(temp.root, 'AGENTS.md'), 'ancestor'); await fs.writeFile(join(child, 'AGENTS.md'), 'child')
    const watch = createFsWatchService(), observation = createInstructionObservationOwner(watch)
    const scope: InstructionScope = { cwd: child, roots: [temp.root], globalSources: [], enabled: true, maxBytes: 24000 }
    const view = createObservedInstructionService({ scope, observation }), tracker = follow(view)
    try {
      expect((await view.prepare([])).text).toContain('ancestor')
      const bounded = tracker.at(value => value.reliability === 'ready' && value.text.includes('child') && !value.text.includes('ancestor'))
      if (kind === 'file') await fs.writeFile(join(child, '.git'), `gitdir: ${git}\n`)
      else await fs.mkdir(join(child, '.git'))
      await bounded
      const restored = tracker.at(value => value.reliability === 'ready' && value.text.includes('ancestor'))
      if (kind === 'file') await fs.unlink(join(child, '.git'))
      else await fs.rmdir(join(child, '.git'))
      await restored
      const later = tracker.at(value => value.reliability === 'ready' && value.text.includes('later boundary write'))
      await fs.writeFile(join(child, 'AGENTS.md'), 'later boundary write'); await later
    } finally { await tracker.close(); await view.close(); await observation.close(); await watch.close(); await temp.remove() }
  })

  it('observes canonical candidate/marker changes and junction retargeting without promoting stale mapping', async () => {
    const temp = await temporary(), a = join(temp.root, 'actual-a'), b = join(temp.root, 'actual-b'), alias = join(temp.root, 'alias')
    await fs.mkdir(a); await fs.mkdir(b); await fs.symlink(a, alias, 'junction')
    await fs.writeFile(join(temp.root, 'AGENTS.md'), 'ancestor'); await fs.writeFile(join(a, 'AGENTS.md'), 'first'); await fs.writeFile(join(b, 'AGENTS.md'), 'second')
    const watch = createFsWatchService(), observation = createInstructionObservationOwner(watch)
    const scope: InstructionScope = { cwd: alias, roots: [temp.root], globalSources: [], enabled: true, maxBytes: 24000 }
    const view = createObservedInstructionService({ scope, observation }), tracker = follow(view)
    try {
      await view.prepare([])
      const content = tracker.at(value => value.reliability === 'ready' && value.text.includes('canonical edit'))
      await fs.writeFile(join(a, 'AGENTS.md'), 'canonical edit'); await content
      const bounded = tracker.at(value => value.reliability === 'ready' && !value.text.includes('ancestor'))
      await fs.mkdir(join(a, '.git')); await bounded
      const restored = tracker.at(value => value.reliability === 'ready' && value.text.includes('ancestor'))
      await fs.rmdir(join(a, '.git')); await restored
      const retargeted = tracker.at(value => value.reliability === 'ready' && value.text.includes('second') && !value.text.includes('canonical edit'))
      await fs.unlink(alias); await fs.symlink(b, alias, 'junction'); await retargeted
      const later = tracker.at(value => value.reliability === 'ready' && value.text.includes('later junction write'))
      await fs.writeFile(join(b, 'AGENTS.md'), 'later junction write'); await later
    } finally { await tracker.close(); await view.close(); await observation.close(); await watch.close(); await temp.remove() }
  }, 30000)
})
