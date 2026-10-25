import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Native observations only. This child never imports a Store or lifecycle double.
const [scenario, directory, storePath] = process.argv.slice(2)
if (!scenario || !directory || !storePath) throw new Error('scenario, evidence directory and unchanged store source are required')
mkdirSync(directory, { recursive: true })
const path = resolve(directory, 'index.sqlite')
const receipt = { scenario, argv: process.argv, execPath: process.execPath, node: process.version,
  platform: process.platform, arch: process.arch, sqlite: process.versions.sqlite, observations: {} }
const describe = error => ({ name: error?.name, message: error?.message, code: error?.code, errcode: error?.errcode, errstr: error?.errstr })
const attempt = work => { try { return { ok: true, value: work() } } catch (error) { return { ok: false, error: describe(error) } } }
const files = () => readdirSync(directory).map(name => ({ name, bytes: statSync(resolve(directory, name)).size }))
const scalar = (db, sql) => Object.values(db.prepare(sql).get())[0]
const state = db => Object.fromEntries(['page_size', 'page_count', 'max_page_count', 'journal_mode', 'synchronous', 'temp_store', 'cache_size', 'cache_spill', 'foreign_keys'].map(name => [name, scalar(db, `PRAGMA ${name}`)]))
const source = readFileSync(storePath, 'utf8')
const schema = [...source.matchAll(/this\.db\.exec\(`(PRAGMA journal_mode=DELETE;[\s\S]*?|CREATE TABLE legacy_plans[\s\S]*?)`\)/g)].map(match => match[1])
if (schema.length !== 2) throw new Error('Cannot extract the exact unchanged two-part schema')
const loadSchema = db => { for (const sql of schema) db.exec(sql) }
const originalCounts = 'SELECT COUNT(*) AS observations,COUNT(DISTINCT ref_id) AS refs FROM legacy_rows WHERE binding=?'
// IF09 proposal only: COUNT(ref_id) excludes the NULL group, while SUM(n) counts its rows.
const proposedCounts = 'SELECT COALESCE(SUM(n),0) AS observations,COUNT(ref_id) AS refs FROM (SELECT ref_id,COUNT(*) AS n FROM legacy_rows WHERE binding=? GROUP BY ref_id)'

function audit() {
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA max_page_count=512')
    receipt.observations.initial = state(db)
    receipt.observations.identity = db.prepare('SELECT sqlite_version() AS version,sqlite_source_id() AS sourceId').get()
    receipt.observations.compileOptions = db.prepare('PRAGMA compile_options').all()
    loadSchema(db)
    db.exec('BEGIN IMMEDIATE')
    const addRef = db.prepare('INSERT INTO refs VALUES (?,?,?)'), addOwner = db.prepare('INSERT INTO owners VALUES (?,?)')
    const addChunk = db.prepare('INSERT INTO chunks_fts(ref_id,offset,text) VALUES (?,?,?)'), addRow = db.prepare('INSERT INTO chunk_rows VALUES (?,?)')
    const addLegacy = db.prepare('INSERT INTO legacy_rows VALUES (?,?,?,?,?)')
    for (let i = 0; i < 24; i++) {
      const id = `ref-${i}`
      addRef.run(id, 1900000000000 + i, i % 2); addOwner.run(id, 'owner-a'); addOwner.run(id, 'owner-b')
      const chunk = addChunk.run(id, 0, `actual trigram searchable needle 中文字符 repeated ${i}`)
      addRow.run(chunk.lastInsertRowid, id)
      addLegacy.run('source-domain', i * 3, `ref-${i % 7}`, '{}', '{}')
    }
    for (const [binding, ordinal, id] of [['duplicate', 0, 'same'], ['duplicate', 9, 'same'], ['distinct', 2, 'a'], ['distinct', 20, 'b'], ['nullable', 0, null], ['nullable', 8, null], ['nullable', 30, 'x'], ['nullable', 60, 'x'], [null, 0, 'null-binding']]) addLegacy.run(binding, ordinal, id, '{}', '{}')
    db.prepare('INSERT INTO legacy_plans VALUES (?,?,?,?,1)').run('source-domain', 'plan', 24, 7)
    db.prepare('INSERT INTO legacy_pages VALUES (?,?,?)').run('source-domain', 'page.json', 'digest')
    db.exec('COMMIT')
    receipt.observations.schema = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all()
    receipt.observations.nullability = db.prepare('PRAGMA table_info(legacy_rows)').all()
    receipt.observations.countComparisons = ['empty', 'duplicate', 'distinct', 'nullable', 'source-domain', null].map(binding => ({ binding,
      original: db.prepare(originalCounts).get(binding), proposed: db.prepare(proposedCounts).get(binding) }))
    const queries = [
      ['original-counts-blocked', originalCounts, ['source-domain']],
      ['proposed-counts-IF09', proposedCounts, ['source-domain']],
      ['legacy-prior-page', 'SELECT digest FROM legacy_pages WHERE binding=? AND name=?', ['source-domain', 'page.json']],
      ['legacy-prior-ref', 'SELECT tuple FROM legacy_rows WHERE binding=? AND ref_id=? LIMIT 1', ['source-domain', 'ref-1']],
      ['legacy-prior-ordinal', 'SELECT row_json FROM legacy_rows WHERE binding=? AND ordinal=?', ['source-domain', 3]],
      ['legacy-first', 'SELECT MIN(ordinal) AS ordinal FROM legacy_rows WHERE binding=? AND ref_id=?', ['source-domain', 'ref-1']],
      ['legacy-header', 'SELECT * FROM legacy_plans WHERE binding=?', ['source-domain']],
      ['legacy-hint', 'SELECT ref_id,tuple,row_json FROM legacy_rows WHERE binding=? AND ordinal=?', ['source-domain', 3]],
      ['legacy-hints-future-no-cross-await-iterate', 'SELECT ordinal,row_json FROM legacy_rows WHERE binding=? AND ref_id=? ORDER BY ordinal', ['source-domain', 'ref-1']],
      ['proposed-keyset-64', 'SELECT ordinal,row_json FROM legacy_rows WHERE binding=? AND ref_id=? AND ordinal>? ORDER BY ordinal LIMIT 64', ['source-domain', 'ref-1', -1]],
      ['legacy-page-exists', 'SELECT 1 FROM legacy_pages WHERE binding=? AND name=?', ['source-domain', 'page.json']],
      ['legacy-page-count', 'SELECT COUNT(*) AS count FROM legacy_pages WHERE binding=?', ['source-domain']],
      ['fts-match-page', 'SELECT rowid,ref_id FROM chunks_fts WHERE chunks_fts MATCH ? AND rowid>? LIMIT ?', ['"needle" OR "中文字符"', 0, 64]],
      ['short-query', 'SELECT id FROM refs WHERE expires_at>? LIMIT ?', [0, 129]],
      ['incomplete', 'SELECT id FROM refs WHERE complete=0 AND expires_at>? LIMIT ?', [0, 129]],
      ['chunk-delete-membership', 'SELECT rowid FROM chunk_rows WHERE ref_id=?', ['ref-1']],
    ]
    receipt.observations.plans = queries.map(([name, sql, bindings]) => ({ name, sql, bindings,
      plan: db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings),
      opcodes: db.prepare(`EXPLAIN ${sql}`).all(...bindings), rows: db.prepare(sql).all(...bindings) }))
    receipt.observations.mutationPlans = [
      ['remove-fts', 'DELETE FROM chunks_fts WHERE rowid IN (SELECT rowid FROM chunk_rows WHERE ref_id=?)', ['ref-1']],
      ['remove-ref-cascade', 'DELETE FROM refs WHERE id=?', ['ref-1']],
      ...['legacy_rows', 'legacy_pages', 'legacy_plans'].map(table => [`reset-${table}`, `DELETE FROM ${table} WHERE binding=?`, ['source-domain']]),
    ].map(([name, sql, bindings]) => ({ name, sql, bindings, plan: db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings), opcodes: db.prepare(`EXPLAIN ${sql}`).all(...bindings) }))
    receipt.observations.final = state(db)
    receipt.observations.files = files()
    receipt.observations.memoryEnabled = false
    receipt.observations.proofLimit = 'No transient I/O trace; plans alone do not audit native FTS or mutation scratch. MEMORY remains disabled pending full source proof.'
  } finally { db.close() }
}

function mode() {
  const db = new DatabaseSync(path)
  try {
    receipt.observations.before = state(db)
    receipt.observations.identity = db.prepare('SELECT sqlite_version() AS version,sqlite_source_id() AS sourceId').get()
    receipt.observations.compileOptions = db.prepare('PRAGMA compile_options').all()
    // Refusal probe only; no fallback or weakening of native safety settings.
    receipt.observations.request = attempt(() => db.prepare('PRAGMA journal_mode=OFF').get())
    receipt.observations.after = state(db)
    receipt.observations.accepted = receipt.observations.after.journal_mode === 'off'
    receipt.observations.memoryEnabled = false
    receipt.observations.resourceQualified = false
    receipt.observations.resourceScenarios = 'Not attempted: two-runtime policy and full source/temp proof must qualify first'
  } finally { receipt.observations.close = attempt(() => db.close()) }
  receipt.observations.files = files()
}

function closeMatrix(kind) {
  const db = new DatabaseSync(path)
  loadSchema(db)
  db.prepare('INSERT INTO refs VALUES (?,?,?)').run('a', 1900000000000, 1)
  db.prepare('INSERT INTO refs VALUES (?,?,?)').run('b', 1900000000000, 1)
  const statement = db.prepare('SELECT id FROM refs ORDER BY id')
  let iterator
  receipt.observations.statementCloseAvailable = typeof statement.close === 'function'
  if (kind !== 'prepared' && kind !== 'callback') {
    iterator = statement.iterate(); receipt.observations.first = attempt(() => iterator.next())
    if (kind === 'return') receipt.observations.endCursor = attempt(() => iterator.return())
    if (kind === 'exhaust') receipt.observations.endCursor = attempt(() => Array.from(iterator))
  }
  if (kind === 'callback') {
    // Preserve facts even when the unsafe native callback access-violates.
    writeFileSync(resolve(directory, 'before-callback.json'), JSON.stringify(receipt, null, 2))
    db.function('attempt_close', () => {
      receipt.observations.closeDuringSQL = attempt(() => db.close())
      writeFileSync(resolve(directory, 'during-callback.json'), JSON.stringify(receipt, null, 2))
      return 1
    })
    receipt.observations.issuedSQL = attempt(() => db.prepare('SELECT attempt_close() AS result').get())
  }
  receipt.observations.close = attempt(() => db.close())
  receipt.observations.isOpen = db.isOpen
  receipt.observations.staleStatement = attempt(() => statement.all())
  if (iterator) {
    receipt.observations.staleIteratorNext = attempt(() => iterator.next())
    receipt.observations.staleIteratorReturn = attempt(() => iterator.return())
  }
  receipt.observations.afterCloseSQL = attempt(() => db.prepare('SELECT 1').get())
  receipt.observations.unlink = attempt(() => unlinkSync(path))
  if (receipt.observations.unlink.ok) receipt.observations.reopen = attempt(() => {
    const reopened = new DatabaseSync(path)
    try { reopened.exec('CREATE TABLE receipt(value TEXT)'); return reopened.prepare('SELECT COUNT(*) AS count FROM receipt').get() }
    finally { reopened.close() }
  })
  receipt.observations.discipline = kind === 'return' || kind === 'exhaust' ? 'Cursor ended before original close; no GC requested' : 'Descriptive unsafe/retained-handle case; not a safe retirement receipt'
  receipt.observations.files = files()
}

try {
  if (scenario === 'audit') audit()
  else if (scenario === 'mode') mode()
  else if (scenario.startsWith('close-')) closeMatrix(scenario.slice(6))
  else throw new Error(`Unknown native scenario: ${scenario}`)
} catch (error) { receipt.error = describe(error); process.exitCode = 1 }
process.stdout.write(`${JSON.stringify(receipt, (_, value) => typeof value === 'bigint' ? String(value) : value)}\n`)
