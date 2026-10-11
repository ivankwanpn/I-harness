import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { Store, hash } from '../src/store.ts'

it('looks up cached file chunks and cascading term deletions without scanning the entire committed generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'code-store-plan-'))
  const store = new Store(root, 'fixture')
  let db: DatabaseSync | undefined
  try {
    await store.open(8 * 1024 * 1024)
    db = new DatabaseSync(join(root, 'code-retrieval', hash('fixture'), 'index.sqlite'))
    const lookup = db.prepare('EXPLAIN QUERY PLAN SELECT text,startOffset FROM chunks WHERE source=? AND path=? ORDER BY startOffset')
      .all('workspace', 'a.ts') as Array<{ detail: string }>
    const cascade = db.prepare('EXPLAIN QUERY PLAN SELECT rowid FROM terms WHERE chunk=?').all(1) as Array<{ detail: string }>
    expect(lookup.map(row => row.detail).join('\n')).not.toMatch(/SCAN chunks|TEMP B-TREE/)
    expect(cascade.map(row => row.detail).join('\n')).not.toMatch(/SCAN terms/)
    // Simulate an already committed schema-v1 store from an earlier version.
    // Reopening must repair its lookup plans without clearing its generation.
    db.exec("INSERT INTO files VALUES('workspace','a.ts','r1','fixture'); INSERT INTO chunks VALUES(1,'workspace','a.ts','r1','retained content',1,1,0,16); INSERT INTO terms VALUES('retained',1); UPDATE meta SET generation=7 WHERE id=1; DROP INDEX chunks_by_file; DROP INDEX terms_by_chunk")
    db.close(); db=undefined; store.close()
    await store.open(8 * 1024 * 1024)
    expect(store.status()).toMatchObject({generation:7,files:1,chunks:1})
    expect(store.file('workspace','a.ts')?.chunks[0].text).toBe('retained content')
    db = new DatabaseSync(join(root, 'code-retrieval', hash('fixture'), 'index.sqlite'))
    const repaired = db.prepare('EXPLAIN QUERY PLAN SELECT text,startOffset FROM chunks WHERE source=? AND path=? ORDER BY startOffset').all('workspace','a.ts') as Array<{detail:string}>
    expect(repaired.map(row=>row.detail).join('\n')).not.toMatch(/SCAN chunks|TEMP B-TREE/)
  } finally { db?.close(); store.close(); await rm(root, { recursive: true, force: true }) }
})
