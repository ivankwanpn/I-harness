import { expect, it } from 'vitest'
import { readFile, readdir, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { legacyFixture } from './legacy-fork-fixture.ts'

it.each([101, 1001])('funds %i distinct actual refs under the selected B1 summary anchor', async count => {
  const start = performance.now(), f = await legacyFixture({ distinct: count, summary: true }), setup = performance.now() - start
  try {
    const begin = performance.now(); expect((await f.run()).kind).toBe('ready'); const owner = performance.now() - begin
    const directory = join(f.root, 'context-output', createHash('sha256').update('workspace').digest('hex')), plans = join(directory, 'legacy-fork-v1'), operation = (await readdir(plans))[0]!
    const root = JSON.parse(await readFile(join(plans, operation, 'plan.json'), 'utf8'))
    expect(root).toMatchObject({ observationCount: count, distinctRefCount: count })
    for (const ref of f.selectedRefs) {
      expect(JSON.parse(await readFile(join(directory, 'owners', ref.id + '.json'), 'utf8'))).toEqual(['creator', 'source', 'target'])
      expect((await lstat(join(directory, 'owners', ref.id + '.rewrite'))).size).toBeGreaterThan(0)
    }
    const page = JSON.parse(await readFile(join(plans, operation, 'pages', '0-0.json'), 'utf8'))
    expect(page.rows[0].anchor).toEqual({ kind: 'seed-group', manifestSeq: 0, ordinal: 0 })
    expect(f.request.seed.records[1]).toMatchObject({ type: 'conversation/seed-group', group: { items: [{ kind: 'summary' }] } })
    console.info('Actual distinct legacy scale milliseconds:', { refs: count, setup, owner })
  } finally { await f.close() }
}, 1800000)
