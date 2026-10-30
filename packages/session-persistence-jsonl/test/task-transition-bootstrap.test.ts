import { expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { EMPTY_SEMANTIC_SEED_DIGEST, EMPTY_SEMANTIC_DEPENDENCY_DIGEST } from '@i-harness/core-session'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createJsonlTaskTransitionCoordinator } from '../src/task-document-factory.ts'

it('initializes the actual fresh bootstrap target task file before readiness', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-bootstrap-'))
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  const request = { invocation: { version: 1 as const, operationId: 'op', targetSessionId: 'target', createdAt: '2026-10-23T00:00:00.000Z', requestDigest: 'a'.repeat(64) }, target: { kind: 'new' as const }, metadata: {}, lineage: { origin: 'fork' as const, parentSession: 'parent' }, seed: { digest: EMPTY_SEMANTIC_SEED_DIGEST, dependencyDigest: EMPTY_SEMANTIC_DEPENDENCY_DIGEST, sourceObservation: { kind: 'none' as const }, records: [] } }
  const guards = { assertCurrent() {}, dependencies: { async confirm() { throw Error('unused') }, async reconcile() { throw Error('unused') } } }
  try {
    const first = await coordinator.bootstrapSemanticTarget(request, guards); expect(first.kind).toBe('ready')
    const repeated = await coordinator.bootstrapSemanticTarget(request, guards); expect(repeated.kind).toBe('already-ready')
    if (first.kind === 'ready' && repeated.kind === 'already-ready') expect(repeated.document).toBe(first.document)
    expect(JSON.parse(await readFile(join(root, 'task-target.doc.jsonl'), 'utf8'))).toEqual({ formatVersion: 2, tasks: [], notifications: [] })
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('refuses a preexisting orphan task file for a fresh bootstrap target', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-bootstrap-orphan-'))
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  const request = { invocation: { version: 1 as const, operationId: 'op', targetSessionId: 'target', createdAt: '2026-10-23T00:00:00.000Z', requestDigest: 'a'.repeat(64) }, target: { kind: 'new' as const }, metadata: {}, lineage: { origin: 'fork' as const, parentSession: 'parent' }, seed: { digest: EMPTY_SEMANTIC_SEED_DIGEST, dependencyDigest: EMPTY_SEMANTIC_DEPENDENCY_DIGEST, sourceObservation: { kind: 'none' as const }, records: [] } }
  const guards = { assertCurrent() {}, dependencies: { async confirm() { throw Error('unused') }, async reconcile() { throw Error('unused') } } }
  const path = join(root, 'task-target.doc.jsonl'), original = '{"formatVersion":1,"tasks":[],"notifications":[]}\n'
  try {
    await writeFile(path, original)
    expect(await coordinator.bootstrapSemanticTarget(request, guards)).toMatchObject({ kind: 'refused', reason: 'conflict' })
    expect(await readFile(path, 'utf8')).toBe(original); await expect(readFile(join(root, 'target.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('initializes the original child capture target task before publishing its header', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-child-'))
  const { pair, guards } = await import('../../session-persistence/test/child-bootstrap-fixture.ts')
  const { request, payload } = pair(), coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  let captures = 0
  try {
    const outcome = await coordinator.bootstrapChildTargetWithCapture!(request, guards, async () => { captures++; return payload })
    expect(outcome.kind).toBe('ready'); expect(captures).toBe(1)
    expect(JSON.parse(await readFile(join(root, 'task-target.doc.jsonl'), 'utf8'))).toEqual({ formatVersion: 2, tasks: [], notifications: [] })
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('initializes the original public capture target under its reservation', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-capture-'))
  const p = await import('@i-harness/session-persistence'), coreSession = await import('@i-harness/core-session')
  const core = p.readForkRequestCore({ version: 1, kind: 'session-fork-core', sourceSessionId: 'source', selection: { kind: 'completed' }, sourceCapture: 'first-authorized-capture', metadata: { title: 'original' } })
  const intent = p.createBootstrapRequestIntent(core, { kind: 'unmanaged' })
  const request = { invocation: { version: 1 as const, operationId: 'capture', targetSessionId: 'target', createdAt: '2026-10-26T00:00:00.000Z', requestDigest: intent.requestDigest }, core, requestIntent: intent.intent }
  const source = coreSession.createSession(); coreSession.append(source, { type: 'turn/start' }); coreSession.append(source, { type: 'user/message', text: 'original' }); coreSession.append(source, { type: 'turn/end' })
  const exported = coreSession.exportConversationSeed(source, { kind: 'session', sessionId: 'source' }, { kind: 'completed' }); if (exported.kind !== 'seed') throw Error('seed refused')
  const payload = { invocation: request.invocation, target: { kind: 'new' as const }, metadata: core.metadata, lineage: { origin: 'fork' as const, parentSession: 'source' }, seed: p.compileSemanticSeed(exported) }
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  const guards = { assertCurrent() {}, dependencies: { async confirm() { throw Error('unused') }, async reconcile() { throw Error('unused') } } }
  try {
    expect((await coordinator.bootstrapSemanticTargetWithCapture!(request, guards, async () => payload)).kind).toBe('ready')
    expect(JSON.parse(await readFile(join(root, 'task-target.doc.jsonl'), 'utf8')).formatVersion).toBe(2)
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('confirms an existing-empty target task file before replacing its bootstrap header', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-existing-empty-'))
  const { createHash } = await import('node:crypto'), { legacyPrefixDigest } = await import('@i-harness/core-session'), { createJsonlBackend } = await import('../src/backend-factory.ts')
  const backend = createJsonlBackend(root), createdAt = '2026-10-23T00:00:00.000Z'
  await backend.create('target', { sessionId: 'target', formatVersion: 13, createdAt })
  const before = await readFile(join(root, 'target.jsonl')), task = '{ "formatVersion": 1, "tasks": [], "notifications": [] }\n'
  await writeFile(join(root, 'task-target.doc.jsonl'), task)
  const request = { invocation: { version: 1 as const, operationId: 'op', targetSessionId: 'target', createdAt, requestDigest: 'a'.repeat(64) }, target: { kind: 'existing-empty' as const, expectedHeaderDigest: createHash('sha256').update(before).digest('hex'), expectedPrefix: { eventCount: 0, bodyBytes: 0, prefixDigest: legacyPrefixDigest(0,new Uint8Array()) } }, metadata: {}, lineage: { origin: 'fork' as const, parentSession: 'parent' }, seed: { digest: EMPTY_SEMANTIC_SEED_DIGEST, dependencyDigest: EMPTY_SEMANTIC_DEPENDENCY_DIGEST, sourceObservation: { kind: 'none' as const }, records: [] } }
  const guards = { assertCurrent() {}, dependencies: { async confirm() { throw Error('unused') }, async reconcile() { throw Error('unused') } } }
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    expect((await coordinator.bootstrapSemanticTarget(request, guards)).kind).toBe('ready')
    expect(await readFile(join(root, 'task-target.doc.jsonl'), 'utf8')).toBe(task)
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('confirms a completed original13 birth before initializing its missing task file on cold resume', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-cold-birth-'))
  const { createJsonlSessionCoordinator } = await import('../src/backend-factory.ts')
  const request = { invocation: { version: 1 as const, operationId: 'op', targetSessionId: 'target', createdAt: '2026-10-23T00:00:00.000Z', requestDigest: 'a'.repeat(64) }, target: { kind: 'new' as const }, metadata: {}, lineage: { origin: 'fork' as const, parentSession: 'parent' }, seed: { digest: EMPTY_SEMANTIC_SEED_DIGEST, dependencyDigest: EMPTY_SEMANTIC_DEPENDENCY_DIGEST, sourceObservation: { kind: 'none' as const }, records: [] } }
  const guards = { assertCurrent() {}, dependencies: { async confirm() { throw Error('unused') }, async reconcile() { throw Error('unused') } } }
  const original = createJsonlSessionCoordinator(root, { lock: { enabled: true } })
  try { expect((await original.bootstrapSemanticTarget(request, guards)).kind).toBe('ready') } finally { await original.close() }
  const parent = await readFile(join(root, 'target.jsonl')), coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    expect((await coordinator.resumeSemanticTarget(request.invocation, guards)).kind).toBe('already-ready')
    expect(await readFile(join(root, 'target.jsonl'))).toEqual(parent)
    expect(JSON.parse(await readFile(join(root, 'task-target.doc.jsonl'), 'utf8')).formatVersion).toBe(2)
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('preserves a constructed original12 birth while confirming task storage and upgrading its live header', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-bootstrap12-'))
  const p = await import('@i-harness/session-persistence'), core = await import('@i-harness/core-session')
  const { pair, guards } = await import('../../session-persistence/test/child-bootstrap-fixture.ts')
  const { buildBootstrapHeader, bootstrapManifest } = await import('../../session-persistence/src/coordinator/bootstrap-header.ts')
  const { bootstrapPaths } = await import('../src/backend/bootstrap-stage.ts'), { createJsonlBackend } = await import('../src/backend-factory.ts')
  const { payload } = pair(), current = buildBootstrapHeader(payload).stage, headerBase = { ...current.headerBase, formatVersion: 12 }, draft = { ...current, headerBase }, header = JSON.parse(current.headerBytes)
  header.formatVersion = 12; header.semanticSeed.manifestDigest = bootstrapManifest(draft, payload.seed.records)
  const stage = { ...draft, headerBytes: core.canonicalJsonData(header) + '\n' }, built = buildBootstrapHeader(payload, stage), path = join(root, 'target.jsonl'), paths = bootstrapPaths(path, payload.invocation)
  await writeFile(paths.stage, built.operation.stageBytes); await writeFile(path, built.operation.headerBytes)
  const backend = createJsonlBackend(root), originalUpgrade = backend.upgradeSessionFormat!
  backend.upgradeSessionFormat = async () => { throw Error('hold original12 birth') }
  const old = p.createSessionCoordinator(backend, { lock: { enabled: true } })
  try { expect((await old.resumeSemanticTarget(payload.invocation, guards, payload)).kind).toBe('blocked') } finally { await old.close(); backend.upgradeSessionFormat = originalUpgrade }
  const before = await readFile(path), stageBefore = await readFile(paths.stage), originalBody = before.subarray(before.indexOf(10) + 1)
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    expect((await coordinator.resumeSemanticTarget(payload.invocation, guards, payload)).kind).toBe('already-ready')
    const after = await readFile(path); expect(after.subarray(after.indexOf(10) + 1)).toEqual(originalBody); expect(await readFile(paths.stage)).toEqual(stageBefore)
    expect(JSON.parse(after.subarray(0, after.indexOf(10)).toString()).formatVersion).toBe(13)
    expect(JSON.parse(await readFile(join(root, 'task-target.doc.jsonl'), 'utf8')).formatVersion).toBe(2)
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('finishes the original incomplete13 birth before the task barrier without rewriting birth bytes', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-incomplete-birth-'))
  const { pair, guards } = await import('../../session-persistence/test/child-bootstrap-fixture.ts')
  const { buildBootstrapHeader } = await import('../../session-persistence/src/coordinator/bootstrap-header.ts'), { bootstrapPaths } = await import('../src/backend/bootstrap-stage.ts')
  const { payload } = pair(), built = buildBootstrapHeader(payload), path = join(root, 'target.jsonl'), paths = bootstrapPaths(path, payload.invocation)
  await writeFile(paths.stage, built.operation.stageBytes); await writeFile(path, built.operation.headerBytes)
  const stageBefore = await readFile(paths.stage), headerBefore = await readFile(path)
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    const result = await coordinator.resumeSemanticTarget(payload.invocation, guards, payload); if (result.kind !== 'ready') throw new Error(JSON.stringify({ result, parent: (await readFile(path,'utf8')).split('\n').length, stage: (await readFile(paths.stage)).length })); expect(result.kind).toBe('ready')
    const after = await readFile(path); expect(after.subarray(0, headerBefore.length)).toEqual(headerBefore); expect(await readFile(paths.stage)).toEqual(stageBefore)
    expect(JSON.parse(await readFile(join(root, 'task-target.doc.jsonl'), 'utf8')).formatVersion).toBe(2)
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('opens a completed original13 semantic birth through the actual managed cold-open path', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-managed-birth-'))
  const { createJsonlSessionCoordinator } = await import('../src/backend-factory.ts')
  const request = { invocation: { version: 1 as const, operationId: 'op', targetSessionId: 'target', createdAt: '2026-10-23T00:00:00.000Z', requestDigest: 'a'.repeat(64) }, target: { kind: 'new' as const }, metadata: {}, lineage: { origin: 'fork' as const, parentSession: 'parent' }, seed: { digest: EMPTY_SEMANTIC_SEED_DIGEST, dependencyDigest: EMPTY_SEMANTIC_DEPENDENCY_DIGEST, sourceObservation: { kind: 'none' as const }, records: [] } }
  const guards = { assertCurrent() {}, dependencies: { async confirm() { throw Error('unused') }, async reconcile() { throw Error('unused') } } }
  const original = createJsonlSessionCoordinator(root, { lock: { enabled: true } })
  try { expect((await original.bootstrapSemanticTarget(request, guards)).kind).toBe('ready') } finally { await original.close() }
  const before = await readFile(join(root, 'target.jsonl')), coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    const document = await coordinator.openManagedDocument('target'); expect(document.view.events).toHaveLength(1)
    expect(await readFile(join(root, 'target.jsonl'))).toEqual(before)
    expect(JSON.parse(await readFile(join(root, 'task-target.doc.jsonl'), 'utf8')).formatVersion).toBe(2)
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('resumes the same cached original semantic document through its retained task boundary', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-cached-birth-'))
  const { createJsonlSessionCoordinator } = await import('../src/backend-factory.ts')
  const request = { invocation: { version: 1 as const, operationId: 'op', targetSessionId: 'target', createdAt: '2026-10-23T00:00:00.000Z', requestDigest: 'a'.repeat(64) }, target: { kind: 'new' as const }, metadata: {}, lineage: { origin: 'fork' as const, parentSession: 'parent' }, seed: { digest: EMPTY_SEMANTIC_SEED_DIGEST, dependencyDigest: EMPTY_SEMANTIC_DEPENDENCY_DIGEST, sourceObservation: { kind: 'none' as const }, records: [] } }
  const guards = { assertCurrent() {}, dependencies: { async confirm() { throw Error('unused') }, async reconcile() { throw Error('unused') } } }
  const original = createJsonlSessionCoordinator(root, { lock: { enabled: true } })
  try { expect((await original.bootstrapSemanticTarget(request, guards)).kind).toBe('ready') } finally { await original.close() }
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    const document = await coordinator.openManagedDocument('target')
    const resumed = await coordinator.resumeSemanticTarget(request.invocation, guards); expect(resumed.kind).toBe('already-ready')
    if (resumed.kind === 'already-ready') expect(resumed.document).toBe(document)
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('uses the original selected binding admission for a fresh target bootstrap', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-selected-bootstrap-'))
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  const request = { invocation: { version: 1 as const, operationId: 'op', targetSessionId: 'target', createdAt: '2026-10-23T00:00:00.000Z', requestDigest: 'a'.repeat(64) }, target: { kind: 'new' as const }, metadata: {}, lineage: { origin: 'fork' as const, parentSession: 'source' }, seed: { digest: EMPTY_SEMANTIC_SEED_DIGEST, dependencyDigest: EMPTY_SEMANTIC_DEPENDENCY_DIGEST, sourceObservation: { kind: 'none' as const }, records: [] } }
  const guards = { assertCurrent() {}, dependencies: { async confirm() { throw Error('unused') }, async reconcile() { throw Error('unused') } } }
  try {
    await coordinator.create({ sessionId: 'source' })
    const outcome = await coordinator.withSessionBindingObservation!({ existingSessionIds: ['source'], target: request.invocation }, async observation => { observation.assertCurrent(); return coordinator.bootstrapSemanticTarget(request, guards) })
    expect(outcome.kind).toBe('ready'); expect(JSON.parse(await readFile(join(root,'task-target.doc.jsonl'),'utf8')).formatVersion).toBe(2)
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('uses the actual selected source and original binding admission for a capture target', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-selected-capture-'))
  const p = await import('@i-harness/session-persistence'), coreSession = await import('@i-harness/core-session')
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  const guards = { assertCurrent() {}, dependencies: { async confirm() { throw Error('unused') }, async reconcile() { throw Error('unused') } } }
  try {
    await coordinator.create({ sessionId: 'source' }); await coordinator.append('source', [{ type: 'turn/start' }, { type: 'user/message', text: 'selected source' }, { type: 'turn/end' }])
    const core = p.readForkRequestCore({ version: 1, kind: 'session-fork-core', sourceSessionId: 'source', selection: { kind: 'completed' }, sourceCapture: 'first-authorized-capture', metadata: { title: 'selected' } })
    const intent = p.createBootstrapRequestIntent(core, { kind: 'unmanaged' }), request = { invocation: { version: 1 as const, operationId: 'capture', targetSessionId: 'target', createdAt: '2026-10-26T00:00:00.000Z', requestDigest: intent.requestDigest }, core, requestIntent: intent.intent }
    let captures = 0
    const result = await coordinator.withSessionBindingObservation!({ existingSessionIds: ['source'], target: request.invocation }, async observation => {
      observation.assertCurrent()
      return coordinator.bootstrapSemanticTargetWithCapture!(request, guards, async () => {
        captures++; const { session } = await coordinator.snapshot!('source'), exported = coreSession.exportConversationSeed(session, { kind: 'session', sessionId: 'source' }, { kind: 'completed' })
        if (exported.kind !== 'seed') throw Error('selected source refused')
        return { invocation: request.invocation, target: { kind: 'new' as const }, metadata: core.metadata, lineage: { origin: 'fork' as const, parentSession: 'source' }, seed: p.compileSemanticSeed(exported) }
      })
    })
    expect(result.kind).toBe('ready'); expect(captures).toBe(1); expect(JSON.parse(await readFile(join(root, 'task-target.doc.jsonl'), 'utf8')).formatVersion).toBe(2)
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
