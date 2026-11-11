import { expect, it, vi } from 'vitest'
const checked = vi.hoisted(() => ({ batches: 0, proofs: 0 }))
vi.mock('../../fs-lock/src/win32-artifact-path.ts', async load => {
  const original = await load<typeof import('../../fs-lock/src/win32-artifact-path.ts')>()
  return { ...original, checkWin32ArtifactPaths: function(this: unknown, ...args: Parameters<typeof original.checkWin32ArtifactPaths>) {
    checked.batches++; checked.proofs += args[0].length
    return Reflect.apply(original.checkWin32ArtifactPaths, this, args)
  } }
})
import { mkdir } from 'node:fs/promises'
import { createSession, legacyPrefixDigest } from '@i-harness/core-session'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createOwnership } from '../../session-persistence/src/coordinator/ownership.ts'
import { createManagedDocument, captureOriginalManagedReadyGuard } from '../../session-persistence/src/coordinator/managed-document.ts'
import { renameSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createArtifactPathOwner } from '../../fs-lock/src/artifact-path.ts'
import { assertArtifactCurrent, createArtifactCurrentGuard } from '../../session-persistence/src/coordinator/artifact-path-association.ts'
import { composeOriginalCurrentnessGuards } from '../../core-session/src/managed/currentness-guards.ts'
import { createManagedSessionState, isManagedFactOwner } from '@i-harness/core-session'
import { createForkSourceWitness } from '../../session-persistence/src/fork-inline-host.ts'
import { bindOriginalCurrentnessMethod, originalCurrentnessFactoryMatches, runOriginalCurrentnessRead, runOpaqueCurrentnessRead } from '@i-harness/core-session/internal/execution'
import { createGatewayForkFixture } from './helpers/fork-fixture.ts'

it('coalesces the actual original project getter with its held metadata observation', async () => {
  const f = await createGatewayForkFixture()
  try {
    await f.coordinator.withExistingSessionBindingObservation!({ sessionIds: ['source'] }, async read => {
      await f.projects.withBindingObservation(['source'], read, async () => {
        const get = (await f.projects.resultReadScopeFor('source'))!
        expect(originalCurrentnessFactoryMatches(get, read, 'metadata')).toBe(true)
        checked.batches = checked.proofs = 0
        runOriginalCurrentnessRead(read.assertCurrent, () => {
          read.assertCurrent()
          expect(get()).toMatchObject({ projectId: 'p', scope: { roots: [f.workspace] } })
          read.assertCurrent()
        })
        expect(checked.batches).toBe(1)
        expect(checked.proofs).toBeGreaterThan(0)
      })
    })
  } finally { await f.close() }
}, 15000)

it('does not promote a copied observation merely because it borrowed all original functions', async () => {
  const f = await createGatewayForkFixture()
  try {
    await f.coordinator.withExistingSessionBindingObservation!({ sessionIds: ['source'] }, async read => {
      const copied = { ...read }
      await f.projects.withBindingObservation(['source'], copied, async () => {
        const get = (await f.projects.resultReadScopeFor('source'))!
        expect(originalCurrentnessFactoryMatches(get, read, 'metadata')).toBe(false)
        expect(originalCurrentnessFactoryMatches(get, copied, 'metadata')).toBe(false)
        expect(get()).toMatchObject({ projectId: 'p' })
      })
    })
  } finally { await f.close() }
}, 15000)

it('keeps foreign and Proxy getter wrappers opaque and rejects namespace replacement after the callback', async () => {
  const f = await createGatewayForkFixture(), directory = join(f.root, 'getter-namespace')
  await mkdir(join(directory, 'child'), { recursive: true })
  const paths = createArtifactPathOwner(directory), proof = paths.capture(join(directory, 'child', 'value'))
  const namespace = createArtifactCurrentGuard(() => assertArtifactCurrent(proof))
  let calls = 0
  try {
    await f.coordinator.withExistingSessionBindingObservation!({ sessionIds: ['source'] }, async read => {
      await f.projects.withBindingObservation(['source'], read, async () => {
        const get = (await f.projects.resultReadScopeFor('source'))!
        const foreign = () => {
          calls++; expect(checked.proofs).toBeGreaterThan(0)
          renameSync(directory, directory + '-original'); mkdirSync(join(directory, 'child'), { recursive: true })
          return get()
        }
        expect(originalCurrentnessFactoryMatches(foreign, read, 'metadata')).toBe(false)
        expect(originalCurrentnessFactoryMatches(new Proxy(get, {}), read, 'metadata')).toBe(false)
        const guard = composeOriginalCurrentnessGuards(read.assertCurrent, namespace)!
        checked.batches = checked.proofs = 0
        expect(() => runOriginalCurrentnessRead(guard, () => {
          guard()
          runOpaqueCurrentnessRead(guard, foreign)
          guard()
        })).toThrow()
        expect(calls).toBe(1)
      })
    })
  } finally { paths.settleResources(); await f.close() }
}, 15000)

it('reads private project revisions again after an await and refuses a retired binding scope', async () => {
  const f = await createGatewayForkFixture()
  let get: Awaited<ReturnType<typeof f.projects.resultReadScopeFor>>, changedWasChecked = false
  try {
    await f.coordinator.withExistingSessionBindingObservation!({ sessionIds: ['source'] }, async read => {
      await expect(f.projects.withBindingObservation(['source'], read, async () => {
        get = (await f.projects.resultReadScopeFor('source'))!
        expect(originalCurrentnessFactoryMatches(get, read, 'metadata')).toBe(true)
        expect(get()).toMatchObject({ projectId: 'p' })
        await f.projects.configure({ ...f.project, name: 'Changed project' })
        expect(() => get!()).toThrow('Project binding observation changed')
        changedWasChecked = true
      })).rejects.toThrow('Project binding observation changed')
      expect(changedWasChecked).toBe(true)
    })
    expect(() => get!()).toThrow()
  } finally { await f.close() }
}, 15000)

it('does not add metadata or assertion getter reads while declining a foreign accessor observation', async () => {
  const f = await createGatewayForkFixture()
  try {
    await f.coordinator.withExistingSessionBindingObservation!({ sessionIds: ['source'] }, async read => {
      let assertions = 0, metadata = 0, bindings = 0
      const foreign = {
        get assertCurrent() { assertions++; return function(this: unknown) { expect(this).toBe(foreign); read.assertCurrent() } },
        get metadata() { metadata++; return function(this: unknown, id: string) { expect(this).toBe(foreign); return read.metadata(id) } },
        get binding() { bindings++; return function(this: unknown, id: string) { expect(this).toBe(foreign); return read.binding(id) } },
      }
      await f.projects.withBindingObservation(['source'], foreign, async () => {
        const get = (await f.projects.resultReadScopeFor('source'))!
        expect(originalCurrentnessFactoryMatches(get, read, 'metadata')).toBe(false)
        assertions = metadata = bindings = 0
        expect(get()).toMatchObject({ projectId: 'p' })
        expect([assertions, metadata, bindings]).toEqual([1, 0, 0])
      })
    })
  } finally { await f.close() }
}, 15000)

it('does not infer a real document witness from a borrowed ready guard and factory-assigned foreign view', async () => {
  const f = await createGatewayForkFixture()
  try {
    const document = await f.coordinator.openManagedDocument('source')
    const state = createManagedSessionState({ formatVersion: 14, events: [] }, { sessionId: 'source' })
    const fake = { ...document, assertReady: document.assertReady, view: state.view }
    state.bindOwner(fake)
    expect(isManagedFactOwner(fake.view, fake)).toBe(true)
    expect(Object.isFrozen(fake.view)).toBe(true)
    // Deliberately model a forged document-shaped input, never a successful
    // writable coordinator or source admission. The old opaque path stays old.
    const witness = createForkSourceWitness(fake)
    expect(bindOriginalCurrentnessMethod(witness, 'assertUnchanged')).toBeUndefined()
  } finally { await f.close() }
}, 15000)

it('coalesces an original document witness with the original held observation', async () => {
  const f = await createGatewayForkFixture()
  try {
    const document = await f.coordinator.openManagedDocument('source')
    const witness = createForkSourceWitness(document)
    const guard = bindOriginalCurrentnessMethod(witness, 'assertUnchanged')
    expect(guard).toBeTypeOf('function')
    await f.coordinator.withExistingSessionBindingObservation!({ sessionIds: ['source'] }, async read => {
      checked.batches = checked.proofs = 0
      runOriginalCurrentnessRead(read.assertCurrent, () => {
        read.assertCurrent(); guard!(); read.assertCurrent()
      })
      expect(checked.batches).toBe(1)
      expect(checked.proofs).toBeGreaterThan(0)
    })
  } finally { await f.close() }
}, 15000)

it('refuses a genuine document whose public ready method changes after witness capture', async () => {
  const f = await createGatewayForkFixture()
  try {
    const document = await f.coordinator.openManagedDocument('source')
    const witness = createForkSourceWitness(document)
    const original = Object.getOwnPropertyDescriptor(document, 'assertReady')!
    let replacementCalls = 0
    try {
      Object.defineProperty(document, 'assertReady', { ...original, value() { replacementCalls++ } })
      expect(() => witness.assertUnchanged()).toThrow()
      expect(replacementCalls).toBe(0)
    } finally { Object.defineProperty(document, 'assertReady', original) }
  } finally { await f.close() }
}, 15000)

it('does not enroll a foreign document with a genuine borrowed ready method', async () => {
  const f = await createGatewayForkFixture()
  try {
    const document = await f.coordinator.openManagedDocument('source')
    const state = createManagedSessionState({ formatVersion: 14, events: [] }, { sessionId: 'source' })
    const foreign = { ...document, assertReady: document.assertReady, view: state.view }
    state.bindOwner(foreign)
    expect(isManagedFactOwner(state.view, foreign)).toBe(true)
    const witness = createForkSourceWitness(foreign)
    expect(bindOriginalCurrentnessMethod(witness, 'assertUnchanged')).toBeUndefined()
    witness.assertUnchanged()
  } finally { await f.close() }
}, 15000)

it('keeps custom ownership and its callbacks opaque despite the constructor-owned lifetime guard', async () => {
  const f = await createGatewayForkFixture()
  const root = join(f.root, 'custom-ownership')
  await mkdir(root, { recursive: true })
  const backend = createJsonlBackend(root)
  const original = createOwnership(backend, { lock: { enabled: true } })
  const claim = await original.pinOwnership('custom')
  let checks = 0
  const custom = { ...original, assertHeld(id: string) { checks++; original.assertHeld(id) } }
  const document = createManagedDocument('custom', createSession(), {
    eventCount: 0, bodyBytes: 0, prefixDigest: legacyPrefixDigest(0, new Uint8Array()),
  }, backend, custom, undefined, () => {})
  try {
    const before = checks
    expect(captureOriginalManagedReadyGuard(document)).toBeUndefined()
    expect(checks).toBe(before)
    const witness = createForkSourceWitness(document)
    expect(bindOriginalCurrentnessMethod(witness, 'assertUnchanged')).toBeUndefined()
    const after = checks
    witness.assertUnchanged()
    expect(checks).toBeGreaterThan(after)
  } finally {
    await document.close()
    await claim.release()
    await f.close()
  }
}, 15000)
