import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ContextOutputOptions, ContextResultRef } from '../src/types.ts'
import { structureEvidence } from './structure-evidence.ts'
import { lockPathFor } from '@i-harness/fs-lock'

const evidence = structureEvidence('.tmp/legacy-workspace-timing')
const { createContextOutputService } = await import('../src/index.ts')
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const text = 'literal original producer body'
async function fresh(prefix: string) {
  await mkdir(evidence, { recursive: true })
  return mkdtemp(join(evidence, prefix))
}

it('captures each constructor identity once without opening the legacy store', async () => {
  const root = await fresh('constructor-'), reads: string[] = []
  let rootReads = 0
  const service = createContextOutputService({ get root() { rootReads++; return root }, get workspaceId() { reads.push('before'); return 'before' }, config: { enabled: true } })
  try {
    expect(reads).toEqual(['before'])
    expect(rootReads).toBe(1)
    expect(await readdir(root)).toEqual([])
  } finally {
    await service.close()
    await writeFile(join(root, 'observations.json'), JSON.stringify({ constructorReads: reads, activeJobsAfterClose: service.status().activeJobs }, null, 2))
  }
})

it.each([false, true])('preserves the captured workspace after the held original producer (mutate=%s)', async mutate => {
  const root = await fresh(mutate ? 'mutated-' : 'ordinary-')
  let workspace = 'before', phase = 'constructor', producerCalls = 0
  const reads: { value: string; phase: string; legacyDirectoryExists: boolean }[] = []
  const options: ContextOutputOptions = { root, config: { enabled: true },
    get workspaceId() { reads.push({ value: workspace, phase, legacyDirectoryExists: existsSync(join(root, 'context-output')) }); return workspace },
    set workspaceId(value: string) { workspace = value },
  }
  const service = createContextOutputService(options)
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const constructorReads = reads.splice(0)
  phase = 'before-producer-release'
  const capturing = service.capture({ sessionId: 'owner', callId: 'call', label: 'literal', text: 'unused caller body', complete: true }, undefined, async () => {
    producerCalls++; entered.resolve(); await release.promise
    return { text, complete: true }
  })
  let ref: ContextResultRef | undefined, liveText: string | undefined, coldText: string | undefined, coldError: string | undefined
  let beforeReleaseReads: typeof reads = [], directories: string[] = []
  try {
    await entered.promise
    beforeReleaseReads = [...reads]
    expect.soft(beforeReleaseReads).toEqual([])
    expect.soft(await readdir(root)).toEqual([]) // Do not warm the target store.
    if (mutate) { options.workspaceId = 'after'; options.root = join(root, 'relocated') }
    phase = 'after-producer-release'; release.resolve()
    ref = await capturing
    if (!ref) throw new Error('Expected actual legacy capture')
    const expectedWorkspace = 'before'
    const expectedId = 'ctx_' + sha(JSON.stringify([expectedWorkspace, 'owner', 'call', sha(text)]))
    expect.soft(reads).toEqual([])
    expect.soft(ref.workspaceId).toBe(expectedWorkspace); expect.soft(ref.id).toBe(expectedId)
    expect.soft(existsSync(lockPathFor(root, 'context-output:before'))).toBe(true)
    expect.soft(existsSync(lockPathFor(root, 'context-output-legacy:before'))).toBe(true)
    expect.soft(existsSync(join(root, 'relocated'))).toBe(false)
    liveText = (await service.read({ sessionId: 'owner' }, { refId: ref.id })).text
    expect.soft(liveText).toBe(text)
    await service.close()
    directories = await readdir(join(root, 'context-output'))
    expect.soft(directories).toEqual([sha(expectedWorkspace)])
    const persisted = JSON.parse(await readFile(join(root, 'context-output', sha(expectedWorkspace), 'artifacts', ref.id + '.json'), 'utf8'))
    expect.soft(persisted.ref).toEqual(ref)
    const cold = createContextOutputService({ root, workspaceId: expectedWorkspace, config: { enabled: true } })
    try { coldText = (await cold.read({ sessionId: 'owner' }, { refId: ref.id })).text }
    catch (error) { coldError = error instanceof Error ? error.message : String(error) }
    finally { await cold.close() }
    expect.soft(coldError).toBeUndefined(); expect.soft(coldText).toBe(text)
    if (mutate) {
      const distinct = createContextOutputService({ ...options, root })
      try {
        const after = await distinct.capture({ sessionId: 'owner', callId: 'new-workspace', label: 'distinct', text, complete: true })
        expect(after?.workspaceId).toBe('after')
        expect((await distinct.read({ sessionId: 'owner' }, { refId: after!.id })).text).toBe(text)
      } finally { await distinct.close() }
    }
  } finally {
    release.resolve(); await Promise.allSettled([capturing]); await service.close()
    expect(producerCalls).toBe(1); expect(service.status().activeJobs).toBe(0)
    await writeFile(join(root, 'observations.json'), JSON.stringify({ mutate, constructorReads, beforeReleaseReads, reads, producerCalls, ref, liveText, directories, coldText, coldError, activeJobsAfterClose: service.status().activeJobs }, null, 2))
  }
})
