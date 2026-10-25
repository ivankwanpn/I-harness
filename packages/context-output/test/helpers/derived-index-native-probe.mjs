import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

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

const deleteRevision = 'DELETE-IF10-13-20261025'
const scratch = opcodes => opcodes.filter(row => /OpenEphemeral|SorterOpen|^Sort$|RowSet(Add|Read|Test)/.test(row.opcode))
const nativePlan = (db, name, sql, bindings = []) => {
  receipt.observations.currentPlan = { name, sql, bindings }
  const args = /\?1\b/.test(sql) ? [Object.fromEntries(bindings.map((value, i) => [String(i + 1), value]))] : bindings
  return { name, sql, bindings, plan: db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args),
    opcodes: db.prepare(`EXPLAIN ${sql}`).all(...args) }
}
const schemaStatements = schema.flatMap(sql => sql.split(';').map(value => value.trim()).filter(value => value.startsWith('CREATE ')))

function deleteAudit() {
  const db = new DatabaseSync(path)
  try {
    receipt.policyRevision = deleteRevision
    receipt.observations.before = state(db)
    db.exec('PRAGMA max_page_count=64; BEGIN IMMEDIATE')
    loadSchema(db)
    receipt.observations.schemaPageCount = scalar(db, 'PRAGMA page_count')
    receipt.observations.sameTransactionRaise = db.prepare('PRAGMA max_page_count=768').get()
    receipt.observations.stillInTransaction = db.isTransaction
    receipt.observations.schema = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all()
    const shadowNames = ['chunks_fts_data', 'chunks_fts_idx', 'chunks_fts_content', 'chunks_fts_docsize', 'chunks_fts_config']
    receipt.observations.shadowShape = shadowNames.map(name => ({ name,
      columns: db.prepare(`PRAGMA table_info(${name})`).all(), indexes: db.prepare(`PRAGMA index_list(${name})`).all(), foreignKeys: db.prepare(`PRAGMA foreign_key_list(${name})`).all() }))
    receipt.observations.directShadowPreparation = attempt(() => nativePlan(db, 'actual-shadow-direct-control', "REPLACE INTO 'main'.'chunks_fts_data'(id, block) VALUES(?,?)", [100, Buffer.from('block')]))
    const generated = receipt.observations.schema.filter(row => shadowNames.includes(row.name))
    // IF14: compiler-only ordinary clones, never part of a resource candidate.
    for (const row of generated) db.exec(row.sql.replaceAll('chunks_fts_', 'audit_fts_'))
    receipt.observations.cloneSchema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name LIKE 'audit_fts_%' ORDER BY type,name").all()
    receipt.observations.cloneShape = shadowNames.map(name => ({ name: name.replace('chunks_fts_', 'audit_fts_'),
      columns: db.prepare(`PRAGMA table_info(${name.replace('chunks_fts_', 'audit_fts_')})`).all(),
      indexes: db.prepare(`PRAGMA index_list(${name.replace('chunks_fts_', 'audit_fts_')})`).all(),
      foreignKeys: db.prepare(`PRAGMA foreign_key_list(${name.replace('chunks_fts_', 'audit_fts_')})`).all() }))
    const normal = [
      ['native-data-replace', "REPLACE INTO 'main'.'chunks_fts_data'(id, block) VALUES(?,?)", [100, Buffer.from('block')]],
      ['native-data-range-delete', "DELETE FROM 'main'.'chunks_fts_data' WHERE id>=? AND id<=?", [100, 200]],
      ['native-idx-insert', "INSERT INTO 'main'.'chunks_fts_idx'(segid,term,pgno) VALUES(?,?,?)", [1, Buffer.from('term'), 2]],
      ['native-idx-segment-delete', "DELETE FROM 'main'.'chunks_fts_idx' WHERE segid=?", [1]],
      ['native-idx-desc-seek', "SELECT pgno FROM 'main'.'chunks_fts_idx' WHERE segid=? AND term<=? ORDER BY term DESC LIMIT 1", [1, Buffer.from('term')]],
      ['native-idx-asc-seek', "SELECT pgno FROM 'main'.'chunks_fts_idx' WHERE segid=? AND term>? ORDER BY term ASC LIMIT 1", [1, Buffer.from('term')]],
      ['native-content-insert', "INSERT INTO 'main'.'chunks_fts_content' VALUES(?1,?2,?3,?4)", [100, 'r', 0, 'needle']],
      ['native-content-replace', "REPLACE INTO 'main'.'chunks_fts_content' VALUES(?1,?2,?3,?4)", [100, 'r', 0, 'needle']],
      ['native-content-delete', "DELETE FROM 'main'.'chunks_fts_content' WHERE id=?", [100]],
      ['native-docsize-replace', "REPLACE INTO 'main'.'chunks_fts_docsize' VALUES(?,?)", [100, Buffer.from([1])]],
      ['native-docsize-delete', "DELETE FROM 'main'.'chunks_fts_docsize' WHERE id=?", [100]],
      ['native-config-replace', "REPLACE INTO 'main'.'chunks_fts_config' VALUES(?,?)", ['version', 4]],
      ['native-docsize-lookup', "SELECT sz FROM 'main'.'chunks_fts_docsize' WHERE id=?", [100]],
      ['native-config-read', "SELECT k, v FROM 'main'.'chunks_fts_config'", []],
      ['native-content-lookup', "SELECT T.'rowid', T.c0, T.c1, T.c2 FROM 'main'.'chunks_fts_content' T WHERE T.'rowid'=?", [100]],
      ['native-content-ascending', "SELECT T.'rowid', T.c0, T.c1, T.c2 FROM 'main'.'chunks_fts_content' T WHERE T.'rowid' >= ? AND T.'rowid' <= ? ORDER BY T.'rowid' ASC", [0, 200]],
      ['native-content-descending', "SELECT T.'rowid', T.c0, T.c1, T.c2 FROM 'main'.'chunks_fts_content' T WHERE T.'rowid' <= ? AND T.'rowid' >= ? ORDER BY T.'rowid' DESC", [200, 0]],
      ['native-content-scan', "SELECT T.'rowid', T.c0, T.c1, T.c2 FROM 'main'.'chunks_fts_content' AS T", []],
      ['fts-insert', 'INSERT INTO chunks_fts(ref_id,offset,text) VALUES (?,?,?)', ['r', 0, 'actual trigram needle 中文字符']],
      ['ref-insert', 'INSERT INTO refs VALUES (?,?,?)', ['r', 1900000000000, 1]],
      ['owner-insert', 'INSERT INTO owners VALUES (?,?)', ['r', 'session']],
      ['owner-ignore', 'INSERT OR IGNORE INTO owners VALUES (?,?)', ['r', 'session']],
      ['chunk-row-insert', 'INSERT INTO chunk_rows VALUES (?,?)', [100, 'r']],
      ['owner-bulk-rejected', 'DELETE FROM owners WHERE ref_id=?', ['r']],
      ['owner-rowid-page', 'SELECT rowid FROM owners WHERE ref_id=? LIMIT 64', ['r']],
      ['owner-scalar-delete', 'DELETE FROM owners WHERE rowid=? AND ref_id=?', [100, 'r']],
      ...['legacy_rows', 'legacy_pages', 'legacy_plans'].map(table => [`reset-${table}`, `DELETE FROM ${table} WHERE binding=?`, ['binding']]),
      ['legacy-row-insert', 'INSERT INTO legacy_rows VALUES (?,?,?,?,?)', ['binding', 0, 'r', '{}', '{}']],
      ['legacy-page-insert', 'INSERT INTO legacy_pages VALUES (?,?,?)', ['binding', 'page', 'digest']],
      ['legacy-plan-ignore', 'INSERT OR IGNORE INTO legacy_plans(binding,ready) VALUES (?,0)', ['binding']],
      ['legacy-plan-replace', 'INSERT OR REPLACE INTO legacy_plans VALUES (?,?,?,?,1)', ['binding', 'plan', 1, 1]],
      ['streaming-count', proposedCounts, ['binding']],
      ['keyset-hints', 'SELECT ordinal,row_json FROM legacy_rows WHERE binding=? AND ref_id=? AND ordinal>? ORDER BY ordinal LIMIT 64', ['binding', 'r', -1]],
      ['fts-match', 'SELECT rowid,ref_id FROM chunks_fts WHERE chunks_fts MATCH ? AND rowid>? LIMIT ?', ['"needle" OR "中文字符"', 0, 64]],
    ]
    receipt.observations.plans = normal.map(([name, sql, bindings]) => ({ ...nativePlan(db, name, name.startsWith('native-') ? sql.replaceAll('chunks_fts_', 'audit_fts_') : sql, bindings), generatedSQL: sql,
      nativeScopeArgument: name.startsWith('native-') ? 'Plain generated shadow VDBE; classify usesStmtJournal from exact pinned compiler source, not Transaction.p5' : 'Top-level retained shape' }))
    receipt.observations.nullablePlans = normal.filter(([name]) => ['native-idx-insert', 'native-config-replace', 'owner-scalar-delete', 'owner-insert'].includes(name))
      .map(([name, sql, bindings]) => nativePlan(db, `${name}-null`, name.startsWith('native-') ? sql.replaceAll('chunks_fts_', 'audit_fts_') : sql, bindings.map(() => null)))
    receipt.observations.generatedSchemaPlans = generated.map(row => nativePlan(db, `${row.name}-plain-create`, row.sql.replace(row.name, `${row.name}_explain_only`)))
    db.prepare('INSERT INTO refs VALUES (?,?,?)').run('r', 1900000000000, 1)
    db.prepare('INSERT INTO refs VALUES (?,?,?)').run('other', 1900000000000, 1)
    const owner = db.prepare('INSERT INTO owners VALUES (?,?)')
    for (let i = 0; i < 70; i++) owner.run('r', `owner-${i}`)
    owner.run('r', null); owner.run('r', null); owner.run('other', 'keep'); owner.run(null, 'null-ref')
    const pages = [], countsBefore = db.prepare('SELECT COUNT(*) AS count FROM owners WHERE ref_id=?').get('r')
    for (;;) {
      const rows = db.prepare('SELECT rowid FROM owners WHERE ref_id=? LIMIT 64').all('r')
      if (!rows.length) break
      pages.push(rows.length)
      for (const row of rows) db.prepare('DELETE FROM owners WHERE rowid=? AND ref_id=?').run(row.rowid, 'r')
    }
    receipt.observations.ownerSemantics = { countsBefore, pages,
      remaining: db.prepare('SELECT ref_id,session_id FROM owners').all(), nullBound: db.prepare('SELECT rowid FROM owners WHERE ref_id=? LIMIT 64').all(null),
      foreignKeys: scalar(db, 'PRAGMA foreign_keys') }
    receipt.observations.retainedScratch = receipt.observations.plans.filter(row => row.name !== 'owner-bulk-rejected')
      .map(row => ({ name: row.name, scratch: scratch(row.opcodes) }))
    receipt.observations.after = state(db)
    receipt.observations.memoryEnabled = false
    receipt.observations.filesBeforeCommit = files()
    db.exec('COMMIT')
  } finally { db.close() }
}

function journalObservation() {
  const managed = files().filter(file => file.name.startsWith('index.sqlite'))
  const journal = managed.find(file => file.name === 'index.sqlite-journal')
  const headers = []
  if (journal?.bytes) {
    const bytes = readFileSync(`${path}-journal`)
    for (const offset of [0, 512, 4096]) {
      if (offset + 28 > bytes.length) continue
      headers.push({ offset, magic: bytes.subarray(offset, offset + 8).toString('hex'),
        records: bytes.readUInt32BE(offset + 8), originalPages: bytes.readUInt32BE(offset + 16),
        sectorSize: bytes.readUInt32BE(offset + 20), pageSize: bytes.readUInt32BE(offset + 24) })
    }
  }
  const temp = attempt(() => readdirSync(tmpdir()).filter(name => name.startsWith('etilqs_')).map(name => {
    const observed = attempt(() => statSync(resolve(tmpdir(), name)).size)
    return { name, observed }
  }))
  return { managed, headers, tempDirectory: tmpdir(), temp,
    limitation: 'Between-statement metadata only; absence does not establish zero transient I/O or memory high-water' }
}

function verifyMemoryQualification() {
  const qualificationPath = process.env.IH_DERIVED_INDEX_DELETE_QUALIFICATION
  if (!qualificationPath) throw new Error('MEMORY candidate requires prior exact source/compiler/retained-plan qualification')
  const qualification = JSON.parse(readFileSync(qualificationPath, 'utf8'))
  if (qualification.policyRevision !== deleteRevision || qualification.approvedToEnableMemory !== true) throw new Error('Missing matching DELETE source qualification')
  const runtime = qualification.runtimes.find(value => value.node === process.version)
  if (!runtime || runtime.sqlite !== process.versions.sqlite) throw new Error('Unqualified native runtime')
  for (const item of [qualification.proof, runtime.nodeSource, runtime.sqliteSource, runtime.auditReceipt]) {
    if (createHash('sha256').update(readFileSync(item.path)).digest('hex') !== item.sha256) throw new Error('DELETE qualification source/receipt changed')
  }
  receipt.observations.priorQualification = { path: qualificationPath,
    sha256: createHash('sha256').update(readFileSync(qualificationPath)).digest('hex'), runtime }
}

function deleteConstruction(kind) {
  const memory = kind !== 'default' && kind !== 'merge-default', ceiling = kind === 'full' ? 96 : 768
  const merge = kind.startsWith('merge')
  receipt.policyRevision = deleteRevision
  if (memory) verifyMemoryQualification()
  const db = new DatabaseSync(path)
  let failure, failed = false, closed = false
  const snapshots = []
  function snap(phase, rows) {
    const observation = { phase, rows, state: state(db), inTransaction: db.isTransaction,
      indexRows: db.prepare('SELECT COUNT(*) AS count FROM chunks_fts_idx').get(),
      dataRows: db.prepare('SELECT COUNT(*) AS count FROM chunks_fts_data').get(), files: journalObservation() }
    snapshots.push(observation)
    return observation
  }
  try {
    receipt.observations.before = state(db)
    receipt.observations.identity = db.prepare('SELECT sqlite_version() AS version,sqlite_source_id() AS sourceId').get()
    receipt.observations.compileOptions = db.prepare('PRAGMA compile_options').all()
    receipt.observations.mode = db.prepare('PRAGMA journal_mode=DELETE').get()
    if (memory) db.exec('PRAGMA temp_store=MEMORY')
    receipt.observations.configured = state(db)
    db.exec(`PRAGMA max_page_count=${Math.min(ceiling, 64)}; BEGIN IMMEDIATE`)
    receipt.observations.transactionStartPages = receipt.observations.before.page_count
    for (const [i, sql] of schemaStatements.entries()) {
      receipt.observations.currentWork = { phase: 'schema', statement: i, sql }
      db.exec(sql)
    }
    snap('schema-complete', 0)
    receipt.observations.sameTransactionRaise = db.prepare(`PRAGMA max_page_count=${ceiling}`).get()
    receipt.observations.raiseInTransaction = db.isTransaction
    const ref = db.prepare('INSERT INTO refs VALUES (?,?,?)'), owner = db.prepare('INSERT INTO owners VALUES (?,?)')
    const chunk = db.prepare('INSERT INTO chunks_fts(ref_id,offset,text) VALUES (?,?,?)'), row = db.prepare('INSERT INTO chunk_rows VALUES (?,?)')
    ref.run('r', 1900000000000, 1); owner.run('r', 'original-owner'); owner.run('r', 'second-owner')
    let firstSpill, previousIdxRows = 0, mergeDrops = 0, rows = 0
    const repeatedText = `${'中'.repeat(1360)} needle `
    receipt.observations.input = { bytesPerRow: Buffer.byteLength(repeatedText), maxRows: 512, mainCeiling: ceiling, schemaCeiling: Math.min(ceiling, 64),
      corpus: merge ? '12-cycle contiguous CJK codepoints: 1360 characters per row plus needle' : 'Repeated CJK trigram plus needle' }
    for (; rows < 512; rows++) {
      receipt.observations.currentWork = { phase: 'data', row: rows, sql: 'INSERT INTO chunks_fts(ref_id,offset,text) VALUES (?,?,?)' }
      const text = merge ? Array.from({ length: 1360 }, (_, i) => String.fromCodePoint(0x4e00 + rows % 12 * 1360 + i)).join('') + ' needle ' : repeatedText
      const inserted = chunk.run('r', rows * 3064, text)
      row.run(inserted.lastInsertRowid, 'r')
      const idxRows = Number(db.prepare('SELECT COUNT(*) AS count FROM chunks_fts_idx').get().count)
      if (idxRows < previousIdxRows) mergeDrops++
      previousIdxRows = idxRows
      if (rows % 16 === 0 || firstSpill !== undefined && rows <= firstSpill + 2) {
        const at = snap('streaming', rows + 1)
        const mainBytes = at.files.managed.find(file => file.name === 'index.sqlite')?.bytes ?? 0
        if (firstSpill === undefined && mainBytes > 0) firstSpill = rows
      }
      if (kind === 'constraint' && rows === 63) break
      if (merge && mergeDrops > 0 && firstSpill !== undefined && rows >= firstSpill + 8) break
      if ((kind === 'normal' || kind === 'default' || kind === 'exit') && firstSpill !== undefined && rows >= firstSpill + 8) break
    }
    receipt.observations.workload = { rows: rows + 1, firstSpill, mergeDrops }
    const stage = db.prepare('INSERT INTO legacy_rows VALUES (?,?,?,?,?)')
    receipt.observations.currentWork = { phase: 'legacy-stage', sql: 'INSERT INTO legacy_rows VALUES (?,?,?,?,?)' }
    for (let i = 0; i < 12; i++) stage.run('binding', i * 3, `ref-${i % 3}`, '{}', '{}')
    db.prepare('INSERT INTO legacy_pages VALUES (?,?,?)').run('binding', 'page', 'digest')
    db.prepare('INSERT INTO legacy_plans VALUES (?,?,?,?,1)').run('binding', 'plan', 12, 3)
    receipt.observations.counts = db.prepare(proposedCounts).get('binding')
    receipt.observations.search = db.prepare('SELECT rowid,ref_id FROM chunks_fts WHERE chunks_fts MATCH ? AND rowid>? LIMIT ?').all('"needle"', 0, 64)
    snap('before-commit', rows + 1)
    if (kind === 'constraint') {
      receipt.observations.currentWork = { phase: 'constraint', sql: 'INSERT INTO legacy_rows VALUES (?,?,?,?,?)', bindings: ['binding', 0, 'conflict', '{}', '{}'] }
      stage.run('binding', 0, 'conflict', '{}', '{}')
      throw new Error('Expected native constraint refusal did not occur')
    }
    if (kind === 'exit') {
      receipt.observations.openTransactionExit = { status: 29, nativeCloseAttempted: false }
      receipt.observations.snapshots = snapshots
      writeFileSync(resolve(directory, 'open-transaction-receipt.json'), JSON.stringify(receipt, null, 2))
      writeSync(1, `${JSON.stringify(receipt)}\n`)
      process.exit(29)
    }
    receipt.observations.currentWork = { phase: 'commit', sql: 'COMMIT' }
    db.exec('COMMIT')
    receipt.observations.afterCommit = state(db)
    receipt.observations.filesAfterCommit = journalObservation()
  } catch (error) {
    failed = true; failure = describe(error)
    receipt.observations.failure = failure
    // No SQL, ROLLBACK TO or reuse of the failed generation after this cut.
    receipt.observations.filesAtFailure = journalObservation()
  } finally {
    receipt.observations.snapshots = snapshots
    if (kind !== 'exit' || failed) {
      receipt.observations.close = attempt(() => { db.close(); closed = true })
      receipt.observations.filesAfterClose = journalObservation()
      if (closed) receipt.observations.discard = attempt(() => unlinkSync(path))
    }
  }
  receipt.observations.failed = failed
  receipt.observations.closed = closed
  if (kind === 'full' && !failure) throw new Error('Bounded main-ceiling scenario did not reach SQLITE_FULL')
  if (kind !== 'full' && kind !== 'constraint' && failure) throw Object.assign(new Error(failure.message), failure)
}

function deleteExisting() {
  verifyMemoryQualification()
  receipt.policyRevision = deleteRevision
  const db = new DatabaseSync(path)
  let failed = false
  try {
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA temp_store=MEMORY; PRAGMA max_page_count=64; BEGIN IMMEDIATE')
    for (const sql of schemaStatements) db.exec(sql)
    db.exec('PRAGMA max_page_count=768')
    db.prepare('INSERT INTO refs VALUES (?,?,?)').run('r', 1900000000000, 1)
    const owner = db.prepare('INSERT INTO owners VALUES (?,?)'), legacy = db.prepare('INSERT INTO legacy_rows VALUES (?,?,?,?,?)')
    for (let i = 0; i < 128; i++) {
      owner.run('r', `owner-${i}`)
      legacy.run('binding', i * 2, `ref-${i % 7}`, '{}', '{}')
    }
    owner.run('r', null); owner.run('r', null)
    db.prepare('INSERT INTO legacy_pages VALUES (?,?,?)').run('binding', 'page', 'digest')
    db.prepare('INSERT INTO legacy_plans VALUES (?,?,?,?,1)').run('binding', 'plan', 128, 7)
    db.exec('COMMIT')
    const n0 = Number(scalar(db, 'PRAGMA page_count')), pageSize = Number(scalar(db, 'PRAGMA page_size'))
    receipt.observations.before = state(db)
    receipt.observations.existingEnvelope = { n0, D: n0, pageSize, sectorBound: 4096,
      journalBound: n0 * (pageSize + 8) + (2 * n0 + 3) * 4096,
      mainCeiling: 768, explanation: 'Existing-image original-page journal bound, separate from fresh2S; no index+32768 assumption' }
    db.exec('BEGIN IMMEDIATE')
    const pages = []
    for (;;) {
      const rows = db.prepare('SELECT rowid FROM owners WHERE ref_id=? LIMIT 64').all('r')
      if (!rows.length) break
      pages.push(rows.length)
      for (const row of rows) db.prepare('DELETE FROM owners WHERE rowid=? AND ref_id=?').run(row.rowid, 'r')
    }
    receipt.observations.ownerBatches = pages
    for (const table of ['legacy_rows', 'legacy_pages', 'legacy_plans']) db.prepare(`DELETE FROM ${table} WHERE binding=?`).run('binding')
    owner.run('r', 'restored-owner')
    receipt.observations.countsBeforeCommit = { owners: db.prepare('SELECT COUNT(*) AS count FROM owners WHERE ref_id=?').get('r'), legacy: db.prepare(proposedCounts).get('binding') }
    receipt.observations.beforeCommit = { state: state(db), files: journalObservation() }
    db.exec('COMMIT')
    receipt.observations.afterCommit = state(db)
  } catch (error) {
    failed = true; receipt.observations.failure = describe(error)
    receipt.observations.filesAtFailure = journalObservation()
  } finally {
    receipt.observations.close = attempt(() => db.close())
    if (receipt.observations.close.ok) receipt.observations.discard = attempt(() => unlinkSync(path))
  }
  if (failed) throw new Error('Retained existing-index mutation control failed; exact native error retained')
}

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
  if (scenario === 'delete-audit') deleteAudit()
  else if (scenario.startsWith('delete-build-')) deleteConstruction(scenario.slice(13))
  else if (scenario === 'delete-existing') deleteExisting()
  else if (scenario === 'audit') audit()
  else if (scenario === 'mode') mode()
  else if (scenario.startsWith('close-')) closeMatrix(scenario.slice(6))
  else throw new Error(`Unknown native scenario: ${scenario}`)
} catch (error) { receipt.error = describe(error); process.exitCode = 1 }
process.stdout.write(`${JSON.stringify(receipt, (_, value) => typeof value === 'bigint' ? String(value) : value)}\n`)
