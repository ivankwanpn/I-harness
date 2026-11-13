import { expect, it, vi } from 'vitest'
import { io, observeOpen, contentOpens, contentReads } from './integrity-io.ts'
vi.mock('node:fs/promises', async original => { const fs = await original<typeof import('node:fs/promises')>(); return { ...fs, open: observeOpen(fs.open) } })
import { readFile, writeFile, rename, symlink, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fixture, commit, hash, inventory, contained, record, vectorBody } from './integrity-fixture.ts'

it('actual model tool refuses original manifest corruption before body/index opens and permits equivalent JSON spelling', async () => {
  const f = await fixture('manifest-controls')
  try {
    const saved = await commit(f.service, 'manifest', vectorBody(131073)); await f.reopen()
    const { createContextOutputTools } = await import('../src/index.ts'), tool = createContextOutputTools(f.service).find(tool => tool.name === 'context_output_read')!
    const path = resolve(f.directory(saved.ref), 'manifest.json'), original = await readFile(path), m = JSON.parse(original.toString())
    io.reset(); expect(await tool.execute({ ref: saved.ref, maxBytes: 900 }, { sessionId: 'owner' })).toMatchObject({ data: { kind: 'text', text: expect.stringMatching(/^A+$/) } })
    expect(contentReads().filter(event => event.path.endsWith('body')).reduce((sum, event) => sum + event.actual, 0)).toBe(65536); io.stop()
    for (const spelling of [JSON.stringify(m, null, 2), original.toString().replace('text-utf8-v1', 'text-utf8-v\\u0031')]) {
      await writeFile(path, spelling); expect(await tool.execute({ ref: saved.ref, maxBytes: 900 }, { sessionId: 'owner' })).toMatchObject({ data: { kind: 'text' } })
    }
    const reordered = { codec: m.codec, version: 1, ...Object.fromEntries(Object.entries(m).slice(2)) }
    const cases: [string, string | undefined][] = [
      ...Object.entries({ version: 2, codec: 'json-utf8-v1', completeness: 'source-limited', encodedBytes: 131074, contentDigest: '0'.repeat(64), chunkBytes: 1, leaves: 4, paddedLeaves: 8, treeRoot: '0'.repeat(64) }).map(([field, value]): [string, string] => [field, JSON.stringify({ ...m, [field]: value })]),
      ['unsafe-count', JSON.stringify({ ...m, encodedBytes: Number.MAX_SAFE_INTEGER + 1 })], ['wrong-type', JSON.stringify({ ...m, encodedBytes: String(m.encodedBytes) })],
      ['extra-key', JSON.stringify({ ...m, extra: true })], ['renamed-key', original.toString().replace('treeRoot', 'treeROOT')], ['field-order', JSON.stringify(reordered)],
      ['invalid-json', '{'], ['truncated', original.subarray(0, -5).toString()], ['oversize', ' '.repeat(4097)], ['missing', undefined],
    ]
    const observed: unknown[] = []
    for (const [name, value] of cases) {
      if (value === undefined) await rm(path); else await writeFile(path, value)
      const before = await inventory(f.root); io.reset()
      const actual = await tool.execute({ ref: saved.ref, maxBytes: 900 }, { sessionId: 'owner' })
      observed.push({ name, actual, opens: [...io.opens], reads: [...io.reads] })
      expect.soft(actual, name).toMatchObject({ kind: 'unavailable' }); expect.soft(contentOpens(), name).toHaveLength(0); io.stop()
      expect.soft(await inventory(f.root), `${name}: no repair`).toEqual(before)
    }
    await writeFile(path, original)
    await record(`manifest-${f.root.split(/[\\/]/).at(-1)}`, observed)
  } finally { io.stop(); await f.close() }
})

it('native proof/header/body controls reject touched corruption while an untouched corrupted chunk remains readable', async () => {
  const f = await fixture('proof-controls')
  try {
    const saved = await commit(f.service, 'proof', vectorBody(131073)); await f.reopen()
    const { readManagedResultPage } = await import('../src/result-page.ts')
    const read = () => readManagedResultPage(f.service, { sessionId: 'owner' }, { ref: saved.ref, maxBytes: 900 })
    const indexPath = resolve(f.directory(saved.ref), 'index'), bodyPath = resolve(f.directory(saved.ref), 'body')
    const index = await readFile(indexPath), body = await readFile(bodyPath), observed: unknown[] = []
    io.reset(); expect(await read()).toMatchObject({ data: { kind: 'text' } }); expect(contentReads().length).toBe(6); io.stop()
    const cases: [string, 'body' | 'index', Buffer | undefined][] = []
    for (const offset of [0, 8, 12, 16, 20, 24, 32, 40, 48, 56, 63, 64, 160, 192, 128]) {
      const bytes = Buffer.from(index); bytes[offset] = bytes[offset]! ^ 1; cases.push([`index-byte-${offset}`, 'index', bytes])
    }
    const touched = Buffer.from(body); touched[0] = 90
    const swapped = Buffer.concat([body.subarray(65536, 131072), body.subarray(0, 65536), body.subarray(131072)])
    cases.push(['touched-byte', 'body', touched], ['swapped-chunks', 'body', swapped], ['truncated-body', 'body', body.subarray(0, -1)], ['truncated-index', 'index', index.subarray(0, -1)], ['missing-body', 'body', undefined], ['missing-index', 'index', undefined])
    for (const [name, file, bytes] of cases) {
      const path = file === 'body' ? bodyPath : indexPath
      if (bytes === undefined) await rm(path); else await writeFile(path, bytes)
      const before = await inventory(f.root); io.reset(); const actual = await read()
      observed.push({ name, actual, reads: [...io.reads], opens: [...io.opens] }); io.stop()
      expect.soft(actual, name).toMatchObject({ kind: 'unavailable' }); expect.soft(await inventory(f.root), `${name}: no repair`).toEqual(before)
      await writeFile(path, file === 'body' ? body : index)
    }
    const untouched = Buffer.from(body); untouched[65536] = 90; await writeFile(bodyPath, untouched)
    expect(await read()).toMatchObject({ data: { text: expect.stringMatching(/^A+$/) } })
    expect(await readManagedResultPage(f.service, { sessionId: 'owner' }, { ref: saved.ref, offset: 65536, maxBytes: 900 })).toMatchObject({ kind: 'unavailable', reason: 'corrupt' })
    await record(`proof-${f.root.split(/[\\/]/).at(-1)}`, observed)
  } finally { io.stop(); await f.close() }
})

it('original access/pin/operation metadata mismatches deny with calibrated zero content I/O', async () => {
  const f = await fixture('pin-controls')
  try {
    const saved = await commit(f.service, 'pin-original', Buffer.from('real original pinned bytes')); await f.reopen()
    const { readManagedResultPage } = await import('../src/result-page.ts')
    const read = (sessionId = 'owner') => readManagedResultPage(f.service, { sessionId }, { ref: saved.ref, maxBytes: 900 })
    const directory = f.directory(saved.ref), access = resolve(directory, 'access', hash('owner') + '.json'), pin = resolve(directory, 'pins', hash('owner') + '.json'), operation = resolve(directory, 'operation.json')
    const originals = new Map(await Promise.all([access, pin, operation].map(async path => [path, await readFile(path)] as const)))
    const a = JSON.parse(originals.get(access)!.toString()), p = JSON.parse(originals.get(pin)!.toString())
    io.reset(); expect(await read()).toMatchObject({ data: { kind: 'text' } }); expect(contentReads().length).toBeGreaterThan(0); io.stop()
    const cases: [string, string, string | undefined][] = [
      ['access-missing', access, undefined], ['access-truncated', access, '{'], ['access-oversize', access, ' '.repeat(65537)],
      ...Object.entries({ version: 2, sessionId: 'foreign', revision: '0'.repeat(64), pinId: '0'.repeat(64) }).map(([key, value]): [string, string, string] => [`access-${key}`, access, JSON.stringify({ ...a, [key]: value })]),
      ['pin-missing', pin, undefined], ['pin-truncated', pin, '{'], ['pin-oversize', pin, ' '.repeat(65537)],
      ...Object.entries({ version: 2, documentId: 'foreign', sessionId: 'foreign', revision: '0'.repeat(64), operationId: 'foreign' }).map(([key, value]): [string, string, string] => [`pin-${key}`, pin, JSON.stringify({ ...p, [key]: value })]),
      ['operation-truncated', operation, '{'], ['operation-oversize', operation, ' '.repeat(65537)],
    ]
    const observed: unknown[] = []
    for (const [name, path, bytes] of cases) {
      if (bytes === undefined) await rm(path); else await writeFile(path, bytes)
      const before = await inventory(f.root); io.reset(); const actual = await read()
      observed.push({ name, actual, reads: [...io.reads], opens: [...io.opens] })
      expect.soft(actual, name).toMatchObject({ kind: 'unavailable' }); expect.soft(contentOpens(), name).toHaveLength(0); io.stop()
      expect.soft(await inventory(f.root), `${name}: no repair`).toEqual(before); await writeFile(path, originals.get(path)!)
    }
    io.reset(); expect(await read('foreign')).toMatchObject({ kind: 'unavailable' }); expect(contentOpens()).toHaveLength(0); io.stop()
    await record(`pin-${f.root.split(/[\\/]/).at(-1)}`, observed)
  } finally { io.stop(); await f.close() }
})

for (const file of ['body', 'index', 'manifest.json', 'operation.json', 'access', 'pins'] as const) {
it(`preexisting fixture link at ${file} denies before opening content`, async context => {
  const f = await fixture(`linked-${file}`)
  try {
    const saved = await commit(f.service, 'linked', Buffer.from('native linked control')); await f.reopen()
    const { readManagedResultPage } = await import('../src/result-page.ts')
    io.reset(); expect(await readManagedResultPage(f.service, { sessionId: 'owner' }, { ref: saved.ref })).toMatchObject({ data: { kind: 'text' } }); expect(contentOpens()).toHaveLength(2); io.stop()
    const path = resolve(f.directory(saved.ref), file), sibling = resolve(f.root, `outside-${file}`)
    await contained(f.root, path); await contained(f.root, sibling); await rename(path, sibling)
    try { await symlink(sibling, path, file === 'access' || file === 'pins' ? 'junction' : 'file') }
    catch (cause) {
      if (process.platform === 'win32' && file !== 'access' && file !== 'pins' && (cause as NodeJS.ErrnoException).code === 'EPERM')
        context.skip('Windows file symlink privilege is unavailable, confirmed by the actual fixture link creation')
      throw cause
    }
    const before = await inventory(f.root); io.reset()
    const actual = await readManagedResultPage(f.service, { sessionId: 'owner' }, { ref: saved.ref })
    expect(actual).toMatchObject({ kind: 'unavailable' }); expect(contentOpens()).toHaveLength(0); io.stop()
    expect(await inventory(f.root)).toEqual(before)
  } finally { io.stop(); await f.close() }
})
}

it.each(['body', 'index'] as const)('discards actual held read after same-length fixture %s identity replacement', async file => {
  const f = await fixture(`held-${file}`), entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>()
  let pending: Promise<unknown> | undefined
  try {
    const saved = await commit(f.service, 'held', vectorBody(131073)); await f.reopen()
    const { readManagedResultPage } = await import('../src/result-page.ts')
    io.reset(); expect(await readManagedResultPage(f.service, { sessionId: 'owner' }, { ref: saved.ref })).toMatchObject({ data: { kind: 'text' } }); expect(contentReads().length).toBeGreaterThan(0)
    io.reset(); let held = false
    io.beforeRead = async path => { if (!held && path === resolve(f.directory(saved.ref), file)) { held = true; entered.resolve(); await released.promise } return undefined }
    pending = readManagedResultPage(f.service, { sessionId: 'owner' }, { ref: saved.ref })
    await entered.promise
    const path = resolve(f.directory(saved.ref), file), bytes = await readFile(path)
    await contained(f.root, path); await rename(path, path + '.original-held'); await writeFile(path, bytes)
    released.resolve(); const actual = await pending
    expect(actual).toMatchObject({ kind: 'unavailable' }); expect(contentReads().some(event => event.actual > 0)).toBe(true)
    await record(`held-${f.root.split(/[\\/]/).at(-1)}`, { actual, reads: [...io.reads], opens: [...io.opens], replacementBytes: bytes.length })
  } finally { released.resolve(); await pending; io.stop(); await f.close() }
})
