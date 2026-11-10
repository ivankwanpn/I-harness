#!/usr/bin/env node
// Build the shipped tree, then execute it outside the repository and its loaders.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateGatewayRuntime } from './package-inputs.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')
mkdirSync(join(repo, '.tmp'), { recursive: true })
const candidate = mkdtempSync(join(repo, '.tmp/compiled-gateway-smoke-'))
// build-gateway requires a previously nonexistent explicit output directory.
const build = join(candidate, 'gateway')
const isolated = mkdtempSync(join(tmpdir(), 'ih-compiled-gateway-'))
function removeOwned(parent, target) {
  const tail = relative(parent, target)
  assert(tail && tail !== '..' && !tail.startsWith(`..${sep}`) && !isAbsolute(tail))
  rmSync(target, { recursive: true, force: true })
}
const environment = { ...process.env }
for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'I_HARNESS_DIST']) delete environment[key]
function run(argv, cwd) {
  const child = spawnSync(process.execPath, argv, { cwd, env: environment, windowsHide: true, encoding: 'utf8', timeout: 240_000, maxBuffer: 8 * 1024 * 1024 })
  if (child.error || child.status !== 0) throw new Error(`Compiled smoke failed: ${child.error ?? child.status}\n${child.stdout}\n${child.stderr}`)
  return child.stdout
}
try {
  console.log('Building compiled gateway candidate...')
  run([join(here, 'build-gateway.mjs'), '--out', build], repo)
  const version = JSON.parse(readFileSync(join(repo, 'packages/desktop/package.json'), 'utf8')).version
  validateGatewayRuntime(build, version)
  const runtime = join(isolated, 'runtime')
  cpSync(build, runtime, { recursive: true, dereference: true })
  console.log('Running isolated compiled gateway and ACL smoke...')
  const harness = join(isolated, 'check.mjs')
  copyFileSync(join(here, "fixtures/compiled-gateway-smoke.mjs"), harness)
  const output = run([harness], isolated)
  assert(output.includes('IH_COMPILED_GATEWAY_OK'))
  console.log(output.trim())
  console.log('Compiled gateway validated outside the repository without NODE_OPTIONS, NODE_PATH, or tsx.')
} finally {
  removeOwned(join(repo, '.tmp'), candidate)
  removeOwned(tmpdir(), isolated)
}
