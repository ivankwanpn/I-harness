import { it, expect } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUsageStore } from '../src/store.js'
import type { UsageObservationV1 } from '../src/observation-types.js'

it('publishes canonical immutable observations separately and reads without writes', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'usage-observation-'))
 const store = createUsageStore(dir)
 const legacy = { id:'legacy', startedAt:1, durationMs:1, workspace:'w', providerId:'p', modelId:'m', billing:'api' as const, status:'failed' as const }
 await store.record(legacy)
 const legacyPath = join(dir, 'records', (await readdir(join(dir, 'records')))[0]!)
 const before = await readFile(legacyPath, 'utf8')
 const obs: UsageObservationV1 = { kind:'usage-observation', version:1, observationId:'id', observedAt:1, source:'journal-fact', observation:{ type:'action-close', ownerSessionId:'s', actionId:'a', factSeq:1, disposition:'failed' } }
 await store.recordObservation(obs)
 await store.recordObservation({ ...obs, observation: { disposition:'failed', factSeq:1, actionId:'a', ownerSessionId:'s', type:'action-close' } })
 await expect(store.recordObservation({ ...obs, observedAt:2 })).rejects.toThrow(/collision/i)
 const folder = join(dir, 'observations-v1')
 const names = await readdir(folder)
 expect(names).toHaveLength(1)
 expect((await store.loadObservations()).observations).toEqual([obs])
 expect(await readdir(folder)).toEqual(names)
 expect(await readFile(legacyPath, 'utf8')).toBe(before)
 await writeFile(join(folder, 'bad.json'), '{')
 await writeFile(join(folder, 'future.json'), JSON.stringify({ ...obs, version:2 }))
 const loaded = await store.loadObservations()
 expect(loaded.observations).toEqual([obs])
 expect(loaded.warnings.length).toBeGreaterThan(0)
 expect(await readFile(legacyPath, 'utf8')).toBe(before)
})

const fixture: UsageObservationV1 = { kind:'usage-observation', version:1, observationId:'shared', observedAt:1, source:'journal-fact', observation:{ type:'action-close', ownerSessionId:'s', actionId:'a', factSeq:1, disposition:'failed' } }
const fileFor = (id: string) => `${createHash('sha256').update(id).digest('hex')}.json`

it('warns without creating absent storage and rejects a valid file with the wrong identity while preserving pricing', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'usage-observation-'))
 const store = createUsageStore(dir)
 await store.setPricing({ providerId:'p', modelId:'m', inputPerMillion:1, outputPerMillion:2, source:'user', updatedAt:1 })
 const price = join(dir, 'prices', (await readdir(join(dir, 'prices')))[0]!)
 const bytes = await readFile(price, 'utf8')
 const absent = await store.loadObservations()
 expect(absent.observations).toEqual([])
 expect(absent.warnings).toHaveLength(1)
 expect(await readdir(dir)).toEqual(['prices'])
 const folder = join(dir, 'observations-v1')
 await mkdir(folder)
 await writeFile(join(folder, fileFor('another-id')), JSON.stringify(fixture))
 const loaded = await store.loadObservations()
 expect(loaded.observations).toEqual([])
 expect(loaded.warnings).toHaveLength(1)
 expect(await readFile(price, 'utf8')).toBe(bytes)
 expect(await readdir(folder)).toEqual([fileFor('another-id')])
})

it('serializes concurrent independent store replay and rejects conflicts without changing bytes or leaking temporaries', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'usage-observation-'))
 const first = createUsageStore(dir), second = createUsageStore(dir)
 await Promise.all([first.recordObservation(fixture), second.recordObservation(fixture)])
 const folder = join(dir, 'observations-v1'), name = fileFor(fixture.observationId)
 const bytes = await readFile(join(folder, name), 'utf8')
 const results = await Promise.allSettled([first.recordObservation(fixture), second.recordObservation({ ...fixture, observedAt:2 })])
 expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
 expect(await readFile(join(folder, name), 'utf8')).toBe(bytes)
 expect(await readdir(folder)).toEqual([name])
})

it('propagates a real publication obstruction and removes the temporary file', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'usage-observation-'))
 const folder = join(dir, 'observations-v1'), name = fileFor(fixture.observationId)
 await mkdir(join(folder, name), { recursive:true })
 await expect(createUsageStore(dir).recordObservation(fixture)).rejects.toThrow()
 expect(await readdir(folder)).toEqual([name])
 expect(await readdir(join(folder, name))).toEqual([])
})
