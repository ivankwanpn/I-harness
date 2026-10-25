import { expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const probe = fileURLToPath(new URL('./helpers/derived-index-native-probe.mjs', import.meta.url))
const store = fileURLToPath(new URL('../src/store.ts', import.meta.url))
const scenarios = ['audit', 'mode', 'close-prepared', 'close-return', 'close-exhaust', 'close-paused', 'close-callback'] as const
type Receipt = {
  scenario: string; node: string; sqlite: string; platform: string; execPath: string; error?: unknown;
  observations: Record<string, any>;
}
const receipts = new Map<string, Receipt[]>()

function required(name: string): string {
  const value = process.env[name]
  if (!value || !isAbsolute(value) || !existsSync(value)) throw new Error(`Required explicit native proof path missing: ${name}`)
  return value
}
function verifyExecutable(executable: string, checksumPath: string): string {
  const sha256 = createHash('sha256').update(readFileSync(executable)).digest('hex')
  const official = readFileSync(checksumPath, 'utf8').split(/\r?\n/).find(line => line.endsWith('  win-x64/node.exe'))
  expect(official?.split(' ')[0], 'actual executable must match official Windows x64 release SHA256 before execution').toBe(sha256)
  return sha256
}

// Every case uses a distinct directory under the supplied task evidence root.
// Missing runtimes are hard failures, never silent skips or process.execPath fallbacks.
it.each(['active', 'floor'] as const)('captures bounded real native plans, refusals and close behavior on %s', runtime => {
  const evidence = required('IH_DERIVED_INDEX_EVIDENCE_ROOT')
  const executable = required(runtime === 'active' ? 'IH_DERIVED_INDEX_ACTIVE_NODE' : 'IH_DERIVED_INDEX_FLOOR_NODE')
  const sums = required(runtime === 'active' ? 'IH_DERIVED_INDEX_ACTIVE_SHASUMS' : 'IH_DERIVED_INDEX_FLOOR_SHASUMS')
  const sha256 = verifyExecutable(executable, sums)
  const run = resolve(evidence, 'native', `${runtime}-${Date.now()}-${process.pid}`)
  mkdirSync(run, { recursive: true })
  const observations: Receipt[] = []
  receipts.set(runtime, observations)
  for (const scenario of scenarios) {
    const argv = [probe, scenario, resolve(run, scenario), store]
    const child = spawnSync(executable, argv, { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true })
    writeFileSync(resolve(run, `${scenario}-process.json`), JSON.stringify({ executable, sha256, argv, status: child.status, signal: child.signal,
      error: child.error && { name: child.error.name, message: child.error.message }, stdout: child.stdout, stderr: child.stderr }, null, 2))
    expect(child.error, `${runtime}/${scenario} child launch`).toBeUndefined()
    if (scenario === 'close-callback' && child.status === 3221225477) {
      // Descriptive unsafe native failure; never a successful close proof.
      const checkpoint = resolve(run, scenario, 'before-callback.json')
      expect(existsSync(checkpoint), 'native crash must retain its pre-callback receipt').toBe(true)
      const receipt = JSON.parse(readFileSync(checkpoint, 'utf8')) as Receipt
      receipt.observations.nativeProcessFailure = { status: child.status, signal: child.signal, stderr: child.stderr }
      writeFileSync(resolve(run, `${scenario}.json`), JSON.stringify(receipt, null, 2))
      observations.push(receipt)
      continue
    }
    expect(child.status, `${runtime}/${scenario} original native process failure retained in ${run}`).toBe(0)
    const receipt = JSON.parse(child.stdout.trim()) as Receipt
    writeFileSync(resolve(run, `${scenario}.json`), JSON.stringify(receipt, null, 2))
    observations.push(receipt)
    expect(receipt.error).toBeUndefined()
    expect(resolve(receipt.execPath).toLowerCase()).toBe(resolve(executable).toLowerCase())
    expect(receipt.platform).toBe('win32')
    if (runtime === 'floor') expect(receipt.node).toBe('v22.18.0')
  }
  const audit = observations.find(item => item.scenario === 'audit')!.observations
  expect(audit.identity.version).toBe(observations[0]!.sqlite)
  const expected = [{ observations: 0, refs: 0 }, { observations: 2, refs: 1 }, { observations: 2, refs: 2 },
    { observations: 4, refs: 1 }, { observations: 24, refs: 7 }, { observations: 0, refs: 0 }]
  expect(audit.countComparisons.map((item: any) => item.original)).toEqual(expected)
  expect(audit.countComparisons.map((item: any) => item.proposed)).toEqual(expected)
  const original = audit.plans.find((item: any) => item.name === 'original-counts-blocked')
  expect(original.opcodes.some((item: any) => item.opcode === 'OpenEphemeral')).toBe(true)
  const proposed = audit.plans.find((item: any) => item.name === 'proposed-counts-IF09')
  expect(proposed.plan.some((item: any) => item.detail.includes('COVERING INDEX legacy_rows_ref'))).toBe(true)
  expect(proposed.opcodes.filter((item: any) => /Ephemeral|SorterOpen|Sort$/.test(item.opcode))).toEqual([])
  for (const scenario of ['close-return', 'close-exhaust']) {
    const safe = observations.find(item => item.scenario === scenario)!.observations
    expect(safe.endCursor.ok).toBe(true)
    expect(safe.close.ok).toBe(true)
    expect(safe.unlink.ok).toBe(true)
    expect(safe.reopen.ok).toBe(true)
    expect(safe.staleStatement.ok).toBe(false)
  }
}, 60_000)

it('requires OFF on both runtimes and the remaining native resource proof before qualification', () => {
  for (const runtime of ['active', 'floor']) {
    const mode = receipts.get(runtime)?.find(item => item.scenario === 'mode')?.observations
    expect(mode, `missing ${runtime} mode proof`).toBeDefined()
    if (!mode) throw new Error(`Missing ${runtime} native mode proof`)
    expect(mode.after.synchronous).toBe(mode.before.synchronous)
    expect(mode.accepted, `${runtime} refused journal_mode=OFF; selected resource policy is NOT qualified`).toBe(true)
  }
  for (const runtime of ['active', 'floor']) {
    const mode = receipts.get(runtime)?.find(item => item.scenario === 'mode')?.observations
    expect(mode?.resourceQualified, `${runtime} missing source/temp/MEMORY/full/spill/constraint/transaction-exit resource proof`).toBe(true)
  }
})
