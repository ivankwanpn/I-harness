import { mkdtemp, readFile, rm, writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createJsonlBackend } from '../src/backend-factory.ts'
import { createJsonlTaskTransitionCoordinator } from '../src/task-document-factory.ts'

it('refuses a missing task document when complete local history names a task', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-existing-'))
  const backend = createJsonlBackend(root)
  await backend.create('p', { sessionId: 'p', formatVersion: 13, createdAt: '2026-01-01' })
  await backend.append('p', [{ type: 'subagent/start', version: 1, taskId: 'task-1', agentPath: 'a', role: 'worker', description: 'd' }])
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await expect(coordinator.loadOwned('p')).rejects.toThrow()
    await expect(readFile(join(root, 'task-p.doc.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('initializes a missing task document only for an empty complete local history', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-existing-empty-'))
  const backend = createJsonlBackend(root); await backend.create('p', { sessionId: 'p', formatVersion: 13, createdAt: 'x' })
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.loadOwned('p')
    expect(JSON.parse(await readFile(join(root, 'task-p.doc.jsonl'), 'utf8'))).toEqual({ formatVersion: 2, tasks: [], notifications: [] })
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it.each([1, 2])('confirms literal v%s task bytes without rewriting them', async formatVersion => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-existing-present-'))
  const backend = createJsonlBackend(root); await backend.create('p', { sessionId: 'p', formatVersion: 13, createdAt: 'x' })
  const literal = `{ "notifications": [], "tasks": [], "formatVersion": ${formatVersion} }\n`
  await writeFile(join(root, 'task-p.doc.jsonl'), literal)
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try { await coordinator.loadOwned('p'); expect(await readFile(join(root, 'task-p.doc.jsonl'), 'utf8')).toBe(literal) }
  finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('refuses a present task document that omits an original local task', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-inconsistent-'))
  const backend = createJsonlBackend(root); await backend.create('p', { sessionId: 'p', formatVersion: 13, createdAt: 'x' })
  await backend.append('p', [{ type: 'subagent/start', version: 1, taskId: 'task-1', agentPath: 'a', role: 'worker', description: 'd' }])
  const literal = '{"formatVersion":2,"tasks":[],"notifications":[]}\n'; await writeFile(join(root, 'task-p.doc.jsonl'), literal)
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try { await expect(coordinator.loadOwned('p')).rejects.toThrow(); expect(await readFile(join(root, 'task-p.doc.jsonl'), 'utf8')).toBe(literal) }
  finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('repairs a torn framed tail before proving local task history', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-torn-'))
  const backend = createJsonlBackend(root); await backend.create('p', { sessionId: 'p', formatVersion: 13, createdAt: 'x' })
  await backend.append('p', [{ type: 'subagent/start', version: 1, taskId: 'task-1', agentPath: 'a', role: 'worker', description: 'd' }])
  await appendFile(join(root, 'p.jsonl'), '{"incomplete":')
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await expect(coordinator.loadOwned('p')).rejects.toThrow()
    const raw = await readFile(join(root, 'p.jsonl'), 'utf8'); expect(raw).not.toContain('{"incomplete":')
    await expect(readFile(join(root, 'task-p.doc.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('refuses direct writable admission when prior local task history lacks its document', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-direct-'))
  const backend = createJsonlBackend(root); await backend.create('p', { sessionId: 'p', formatVersion: 13, createdAt: 'x' })
  await backend.append('p', [{ type: 'subagent/start', version: 1, taskId: 'task-1', agentPath: 'a', role: 'worker', description: 'd' }])
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await expect(coordinator.append('p', [{ type: 'user/message', text: 'blocked' }])).rejects.toThrow()
    expect((await backend.read('p')).events).toHaveLength(1)
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('appends and updates metadata only after the original existing task transition', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-direct-positive-'))
  const backend = createJsonlBackend(root); await backend.create('p', { sessionId: 'p', formatVersion: 13, createdAt: 'x' })
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.append('p', [{ type: 'user/message', text: 'kept' }])
    await coordinator.updateMeta('p', { title: 'new title' })
    expect((await backend.read('p')).events).toHaveLength(1)
    expect((await backend.read('p')).meta?.title).toBe('new title')
    expect(JSON.parse(await readFile(join(root, 'task-p.doc.jsonl'), 'utf8')).formatVersion).toBe(2)
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('initializes task storage before upgrading an actual framed predecessor', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-predecessor-'))
  const backend = createJsonlBackend(root); await backend.create('p', { sessionId: 'p', formatVersion: 13, createdAt: 'x' })
  const path = join(root, 'p.jsonl'), raw = await readFile(path, 'utf8'), lines = raw.split('\n'), header = JSON.parse(lines[0]!)
  header.formatVersion = 12; lines[0] = JSON.stringify(header); await writeFile(path, lines.join('\n'))
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.loadOwned('p')
    expect((await backend.read('p')).version).toBe(13)
    expect(JSON.parse(await readFile(join(root, 'task-p.doc.jsonl'), 'utf8')).formatVersion).toBe(2)
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('preserves a complete legacy body without a final newline when upgrading', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-legacy-'))
  const path = join(root, 'p.jsonl'), body = JSON.stringify({ type: 'user/message', text: 'legacy', seq: 0 })
  await writeFile(path, JSON.stringify({ sessionId: 'p', formatVersion: 5, createdAt: 'x' }) + '\n' + body)
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    const loaded = await coordinator.loadOwned('p'); expect(loaded.session.events).toHaveLength(1)
    const raw = await readFile(path, 'utf8'); expect(raw.endsWith(body + '\n')).toBe(true)
    const header = JSON.parse(raw.slice(0, raw.indexOf('\n'))); expect(header.formatVersion).toBe(13); expect(header.journal.legacyEventCount).toBe(1)
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('persists required legacy recovery before rereading and upgrading', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-legacy-recovery-'))
  const path = join(root, 'p.jsonl')
  await writeFile(path, JSON.stringify({ sessionId: 'p', formatVersion: 5, createdAt: 'x' }) + '\n' + JSON.stringify({ type: 'user/message', text: 'legacy' }) + '\n')
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    const loaded = await coordinator.loadOwned('p'); expect(loaded.session.events[0]?.seq).toBe(0)
    expect(JSON.parse(await readFile(join(root, 'task-p.doc.jsonl'), 'utf8')).formatVersion).toBe(2)
    expect((await createJsonlBackend(root).read('p')).events[0]?.seq).toBe(0)
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('drains the original queued write through the task transition', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-enqueue-'))
  const backend = createJsonlBackend(root); await backend.create('p', { sessionId: 'p', formatVersion: 13, createdAt: 'x' })
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true }, maxDelayMs: 60000 }, taskDocumentStorageContract)
  try {
    coordinator.enqueue('p', [{ type: 'user/message', text: 'queued' }]); await coordinator.flush('p')
    expect((await backend.read('p')).events).toHaveLength(1)
    expect(JSON.parse(await readFile(join(root, 'task-p.doc.jsonl'), 'utf8')).formatVersion).toBe(2)
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('drains previously queued parent work inside its original transition admission', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-drain-'))
  const backend = createJsonlBackend(root); await backend.create('p', { sessionId: 'p', formatVersion: 13, createdAt: 'x' })
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true }, maxDelayMs: 60000 }, taskDocumentStorageContract)
  try {
    coordinator.enqueue('p', [{ type: 'user/message', text: 'queued before load' }])
    const loaded = await coordinator.loadOwned('p')
    expect(loaded.session.events).toHaveLength(1); expect((await backend.read('p')).events).toHaveLength(1)
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('does not initialize task storage after a queued local start becomes committed', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-queued-start-'))
  const backend = createJsonlBackend(root); await backend.create('p', { sessionId: 'p', formatVersion: 13, createdAt: 'x' })
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true }, maxDelayMs: 60000 }, taskDocumentStorageContract)
  try {
    coordinator.enqueue('p', [{ type: 'subagent/start', version: 1, taskId: 'task-1', agentPath: 'a', role: 'worker', description: 'd' }])
    await expect(coordinator.loadOwned('p')).rejects.toThrow()
    expect((await backend.read('p')).events).toHaveLength(1)
    await expect(readFile(join(root, 'task-p.doc.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('refuses a new task fact missing from the acknowledged task file without poisoning admission', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-new-start-'))
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: 'p' })
    await expect(coordinator.append('p', [{ type: 'subagent/start', version: 1, taskId: 'missing', agentPath: 'a', role: 'worker', description: 'd' }])).rejects.toThrow()
    await coordinator.append('p', [{ type: 'user/message', text: 'still usable' }])
    expect((await createJsonlBackend(root).read('p')).events).toHaveLength(1)
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('admits a new local task fact already represented by its original task document', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-known-start-'))
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: 'p' })
    await coordinator.putDocumentStrict!('task-p', { formatVersion: 1, tasks: [{ id: 'task-1', parentSessionId: 'p', agentPath: 'a', description: 'd', prompt: 'p', agent: 'a', delivery: 'tool', status: 'accepted', timeCreated: 1 }], notifications: [] })
    await coordinator.append('p', [{ type: 'subagent/start', version: 1, taskId: 'task-1', parentSessionId: 'p', agentPath: 'a', role: 'worker', description: 'd' }])
    expect((await createJsonlBackend(root).read('p')).events).toHaveLength(1)
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
