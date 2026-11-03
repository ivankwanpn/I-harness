import { expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const probe = fileURLToPath(new URL('../helpers/derived-index-native-probe.mjs', import.meta.url))
const store = fileURLToPath(new URL('../../src/legacy/index-lifecycle.ts', import.meta.url))
const policyRevision = 'DELETE-IF10-13-20261025'
type NativeRow = Record<string, any>
type Receipt = { scenario: string; node: string; sqlite: string; platform: string; execPath: string; error?: unknown;
  policyRevision: string; observations: NativeRow }
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
function required(name: string): string {
  const value = process.env[name]
  if (!value || !isAbsolute(value) || !existsSync(value)) throw new Error(`Required explicit native proof path missing: ${name}`)
  return value
}

// Historical rejected-policy receipts are provenance, not execution inputs.
// Run only through qualify:index-native; no runtime selects a fallback.
// Gate and native close/callback characterizations are deliberately not rerun.
it.each(['active', 'floor'] as const)('qualifies the fixed DELETE native resource conditions on %s', runtime => {
  expect(process.env.IH_DERIVED_INDEX_POLICY_REVISION).toBe(policyRevision)
  const evidence = required('IH_DERIVED_INDEX_EVIDENCE_ROOT')
  const executable = required(runtime === 'active' ? 'IH_DERIVED_INDEX_ACTIVE_NODE' : 'IH_DERIVED_INDEX_FLOOR_NODE')
  const sums = required(runtime === 'active' ? 'IH_DERIVED_INDEX_ACTIVE_SHASUMS' : 'IH_DERIVED_INDEX_FLOOR_SHASUMS')
  const official = readFileSync(sums, 'utf8').split(/\r?\n/).find(line => line.endsWith('  win-x64/node.exe'))
  expect(official?.split(' ')[0], 'match official executable SHA256 before execution').toBe(digest(executable))
  const qualificationPath = required('IH_DERIVED_INDEX_DELETE_QUALIFICATION')
  const qualification = JSON.parse(readFileSync(qualificationPath, 'utf8')) as NativeRow
  expect(qualification.policyRevision).toBe(policyRevision)
  expect(qualification.approvedToEnableMemory).toBe(true)
  expect(digest(qualification.proof.path)).toBe(qualification.proof.sha256)
  const run = resolve(evidence, 'native', `${runtime}-${Date.now()}-${process.pid}`)
  mkdirSync(run, { recursive: true })
  const scenarios = ['delete-audit', 'delete-build-normal', 'delete-build-merge', 'delete-build-full', 'delete-build-constraint', 'delete-build-exit', 'delete-existing']
  const receipts = new Map<string, Receipt>()
  for (const scenario of scenarios) {
    const directory = resolve(run, scenario), argv = [probe, scenario, directory, store]
    const child = spawnSync(executable, argv, { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true })
    writeFileSync(resolve(run, `${scenario}-process.json`), JSON.stringify({ policyRevision, executable, executableSHA256: digest(executable), argv,
      helperSHA256: digest(probe), storeSHA256: digest(store), qualificationPath, qualificationSHA256: digest(qualificationPath),
      environment: Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('IH_'))),
      status: child.status, signal: child.signal, error: child.error && { name: child.error.name, message: child.error.message },
      stdout: child.stdout, stderr: child.stderr }, null, 2))
    expect(child.error, `${runtime}/${scenario} launch`).toBeUndefined()
    expect(child.status, `${runtime}/${scenario}; preserve original receipt in ${run}`).toBe(scenario === 'delete-build-exit' ? 29 : 0)
    const receipt = JSON.parse(child.stdout.trim()) as Receipt
    writeFileSync(resolve(run, `${scenario}.json`), JSON.stringify(receipt, null, 2))
    receipts.set(scenario, receipt)
    expect(receipt.error).toBeUndefined()
    expect(receipt.policyRevision).toBe(policyRevision)
    expect(resolve(receipt.execPath).toLowerCase()).toBe(resolve(executable).toLowerCase())
    expect(receipt.platform).toBe('win32')
    expect(receipt.node).toBe(runtime === 'floor' ? 'v22.18.0' : 'v24.15.0')
    if (scenario === 'delete-build-exit') {
      // Inspect only after child exit; do not recover or unlink this candidate.
      writeFileSync(resolve(run, 'after-child-exit-files.json'), JSON.stringify(readdirSync(directory)
        .filter(name => name.startsWith('index.sqlite')).map(name => ({ name, bytes: statSync(resolve(directory, name)).size })), null, 2))
    }
  }
  const audit = receipts.get('delete-audit')!.observations
  expect(audit.before.page_count).toBe(0)
  expect(audit.schemaPageCount).toBeLessThanOrEqual(64)
  expect(audit.sameTransactionRaise.max_page_count).toBe(768)
  expect(audit.stillInTransaction).toBe(true)
  expect(audit.retainedScratch.every((row: NativeRow) => row.scratch.length === 0)).toBe(true)
  const bulk = audit.plans.find((row: NativeRow) => row.name === 'owner-bulk-rejected')
  expect(bulk.opcodes.some((row: NativeRow) => row.opcode === 'RowSetAdd')).toBe(true)
  expect(audit.ownerSemantics).toEqual({ countsBefore: { count: 72 }, pages: [64, 8],
    remaining: [{ ref_id: 'other', session_id: 'keep' }, { ref_id: null, session_id: 'null-ref' }], nullBound: [], foreignKeys: 1 })
  for (const [i, actual] of (audit.shadowShape as NativeRow[]).entries()) {
    const clone = audit.cloneShape[i]
    expect(clone.columns).toEqual(actual.columns)
    expect(clone.foreignKeys).toEqual(actual.foreignKeys)
    expect(clone.indexes.map((row: NativeRow) => ({ ...row, name: row.name.replace('audit_fts_', 'chunks_fts_') }))).toEqual(actual.indexes)
  }
  if (runtime === 'active') {
    expect(audit.directShadowPreparation.ok).toBe(false)
    expect(audit.directShadowPreparation.error.message).toContain('may not be modified')
  }

  for (const scenario of scenarios.filter(name => name.startsWith('delete-build-'))) {
    const value = receipts.get(scenario)!.observations, ceiling = scenario === 'delete-build-full' ? 96 : 768
    expect(value.before.page_count).toBe(0)
    expect(value.mode.journal_mode).toBe('delete')
    expect(value.configured.journal_mode).toBe('delete')
    expect(value.configured.temp_store).toBe(2)
    for (const setting of ['synchronous', 'cache_size', 'cache_spill', 'foreign_keys']) expect(value.configured[setting]).toBe(value.before[setting])
    expect(value.sameTransactionRaise.max_page_count).toBe(ceiling)
    expect(value.raiseInTransaction).toBe(true)
    const snapshots = value.snapshots as NativeRow[]
    expect(snapshots[0]!.phase).toBe('schema-complete')
    expect(snapshots[0]!.state.max_page_count).toBe(64)
    for (const snapshot of snapshots) {
      expect(snapshot.inTransaction).toBe(true)
      expect(snapshot.state.page_count).toBeLessThanOrEqual(snapshot.state.max_page_count)
      for (const file of snapshot.files.managed) {
        if (file.name === 'index.sqlite') expect(file.bytes).toBeLessThanOrEqual(ceiling * 4096)
        else if (file.name === 'index.sqlite-journal') expect(file.bytes).toBeLessThanOrEqual(8192)
        else throw new Error(`Unexpected managed SQLite side file: ${file.name}`)
      }
      for (const header of snapshot.files.headers.filter((row: NativeRow) => row.magic === 'd9d505f920a163d7')) {
        expect(header.originalPages).toBe(0)
        expect(header.sectorSize).toBeLessThanOrEqual(4096)
      }
    }
    for (const observation of [value.filesAtFailure, value.filesAfterCommit].filter(Boolean)) {
      for (const file of observation.managed) {
        if (file.name === 'index.sqlite') expect(file.bytes).toBeLessThanOrEqual(ceiling * 4096)
        else if (file.name === 'index.sqlite-journal') expect(file.bytes).toBeLessThanOrEqual(8192)
        else throw new Error(`Unexpected managed SQLite side file: ${file.name}`)
      }
    }
    if (value.afterCommit) {
      expect(value.afterCommit.page_count).toBeLessThanOrEqual(ceiling)
      expect(value.afterCommit.max_page_count).toBe(ceiling)
    }
    if (scenario === 'delete-build-full') expect(value.failure.errcode & 0xff).toBe(13)
    else if (scenario === 'delete-build-constraint') expect(value.failure.errcode & 0xff).toBe(19)
    else {
      expect(value.failure).toBeUndefined()
      expect(value.workload.firstSpill).toBeDefined()
      expect(value.workload.rows).toBeLessThanOrEqual(512)
      expect(value.counts).toEqual({ observations: 12, refs: 3 })
      expect(snapshots.some(snapshot => snapshot.phase === 'before-commit' && snapshot.files.managed
        .some((file: NativeRow) => file.name === 'index.sqlite-journal' && file.bytes > 0))).toBe(true)
    }
    if (scenario === 'delete-build-merge') expect(value.workload.mergeDrops).toBeGreaterThan(0)
    if (scenario === 'delete-build-exit') {
      expect(value.openTransactionExit).toEqual({ status: 29, nativeCloseAttempted: false })
      expect(value.close).toBeUndefined()
    } else {
      expect(value.close.ok).toBe(true)
      expect(value.discard.ok).toBe(true)
    }
  }
  const existing = receipts.get('delete-existing')!.observations
  expect(existing.before.journal_mode).toBe('delete')
  expect(existing.before.temp_store).toBe(2)
  expect(existing.ownerBatches).toEqual([64, 64, 2])
  expect(existing.countsBeforeCommit).toEqual({ owners: { count: 1 }, legacy: { observations: 0, refs: 0 } })
  expect(existing.existingEnvelope.n0).toBeGreaterThan(0)
  expect(existing.beforeCommit.files.managed.find((file: NativeRow) => file.name === 'index.sqlite-journal').bytes)
    .toBeLessThanOrEqual(existing.existingEnvelope.journalBound)
  expect(existing.close.ok).toBe(true)
  expect(existing.discard.ok).toBe(true)
}, 60_000)
