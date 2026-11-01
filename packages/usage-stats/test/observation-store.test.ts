import { it, expect } from 'vitest'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
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
