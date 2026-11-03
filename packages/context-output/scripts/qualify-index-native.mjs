import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const fixtureRoot = resolve(packageRoot, 'test/qualification/fixtures')
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const json = path => JSON.parse(readFileSync(path, 'utf8'))
function fixture(item) {
  const path = resolve(fixtureRoot, item.path)
  const child = relative(fixtureRoot, path)
  if (isAbsolute(item.path) || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error('Fixture path must stay relative to its manifest')
  if (digest(path) !== item.sha256) throw new Error(`Raw fixture checksum mismatch: ${item.path}`)
  return { ...item, path }
}
function inputs() {
  const values = new Map(), args = process.argv.slice(2)
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1]
    if (!['--active-node', '--floor-node', '--out'].includes(key) || !value || value.startsWith('--') || values.has(key)) throw new Error('Expected --active-node PATH --floor-node PATH --out FRESH_DIRECTORY')
    values.set(key, value)
  }
  if (values.size !== 3) throw new Error('--active-node, --floor-node and --out are required; environment variables do not supply them')
  for (const value of values.values()) if (!isAbsolute(value)) throw new Error('Runtime and output paths must be absolute')
  if (process.platform !== 'win32') throw new Error('This reviewed policy qualifies only the pinned Windows x64 builds')
  const output = resolve(values.get('--out'))
  if (existsSync(output)) throw new Error('--out must not exist; choose a fresh output directory')
  if (!statSync(dirname(output)).isDirectory()) throw new Error('Output parent directory must exist')
  return { active: resolve(values.get('--active-node')), floor: resolve(values.get('--floor-node')), output }
}

try {
  const input = inputs(), manifestPath = resolve(fixtureRoot, 'manifest.json'), manifest = json(manifestPath)
  if (manifest.policyRevision !== 'DELETE-IF10-13-20261025' || manifest.approvedToEnableMemory !== true) throw new Error('Unrecognized reviewed policy fixture')
  const proof = fixture(manifest.proof), runtimes = manifest.runtimes.map(runtime => ({ ...runtime,
    nodeSource: fixture(runtime.nodeSource), sqliteSource: fixture(runtime.sqliteSource), auditReceipt: fixture(runtime.auditReceipt), checksum: fixture(runtime.checksum) }))
  const additionalArguments = manifest.additionalArguments.map(fixture)
  const usage = fixture(manifest.usage)
  if (runtimes.length !== 2 || runtimes[0].role !== 'active' || runtimes[1].role !== 'floor') throw new Error('Both fixed runtime roles are required')
  for (const runtime of runtimes) {
    const executable = input[runtime.role]
    if (!statSync(executable).isFile()) throw new Error(`Missing ${runtime.role} executable`)
    const official = readFileSync(runtime.checksum.path, 'utf8').split(/\r?\n/).find(line => line.endsWith('  win-x64/node.exe'))
    if (!official || digest(executable) !== official.split(' ')[0]) throw new Error(`${runtime.role} executable does not match original official ${runtime.node} Windows x64 checksum`)
  }
  // Resolve existing dependencies before creating output or launching a child.
  const vitest = fileURLToPath(import.meta.resolve('vitest/vitest.mjs'))
  const config = resolve(packageRoot, 'test/qualification/vitest.config.mts')
  mkdirSync(input.output)
  const qualificationPath = resolve(input.output, 'source-qualification.json')
  writeFileSync(qualificationPath, `${JSON.stringify({ ...manifest, proof, runtimes, additionalArguments, usage }, null, 2)}\n`)
  const env = { ...process.env }
  for (const name of Object.keys(env)) if (name.startsWith('IH_DERIVED_INDEX_')) delete env[name]
  Object.assign(env, { IH_DERIVED_INDEX_POLICY_REVISION: manifest.policyRevision, IH_DERIVED_INDEX_EVIDENCE_ROOT: input.output,
    IH_DERIVED_INDEX_DELETE_QUALIFICATION: qualificationPath, IH_DERIVED_INDEX_ACTIVE_NODE: input.active,
    IH_DERIVED_INDEX_FLOOR_NODE: input.floor, IH_DERIVED_INDEX_ACTIVE_SHASUMS: runtimes[0].checksum.path,
    IH_DERIVED_INDEX_FLOOR_SHASUMS: runtimes[1].checksum.path })
  for (const name of ['IH_CONFIG_DIR', 'IH_STRUCTURE_EVIDENCE_ROOT', 'IH_RESULT_INTEGRITY_EVIDENCE_ROOT', 'IH_LEGACY_FORK_EVIDENCE_ROOT', 'IH_MIXED_RETENTION_EVIDENCE_ROOT', 'IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT']) env[name] = resolve(input.output, 'isolated', name)
  const argv = [vitest, 'run', '--config', config, '--exclude', 'test/legacy-fork-scale.test.ts', '-t', '^(?!.*10001)', '--maxWorkers=2', '--minWorkers=1']
  const receiptPath = resolve(input.output, 'launcher.json')
  const receipt = { policyRevision: manifest.policyRevision, input, launcher: fileURLToPath(import.meta.url),
    launcherSHA256: digest(fileURLToPath(import.meta.url)), manifestPath, manifestSHA256: digest(manifestPath),
    executable: process.execPath, argv, cwd: packageRoot, environment: Object.fromEntries(Object.entries(env).filter(([name]) => name.startsWith('IH_'))),
    preparedAt: new Date().toISOString() }
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
  const child = spawnSync(process.execPath, argv, { cwd: packageRoot, env, stdio: 'inherit', windowsHide: true })
  Object.assign(receipt, { status: child.status, signal: child.signal, error: child.error?.message, finishedAt: new Date().toISOString() })
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
  process.exitCode = child.status ?? 1
} catch (error) {
  console.error(`Native qualification refused: ${error.message}`)
  process.exitCode = 2
}
