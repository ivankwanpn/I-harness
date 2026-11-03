import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parent } from './publication-fixture.mts'
import type { Cut } from './publication-native.mts'

export const repository = fileURLToPath(new URL('../../../../', import.meta.url))
export const evidence = resolve(repository, '.tmp/context-r4a-publication-pins-20261021-implementation')
export interface Receipt { nonce: string; parent: string; mode: string; selected: Cut; kind: string; [key: string]: unknown }
export async function launch(mode: string, selected: Cut = 'body-sync') {
  assert(process.env.IH_CONFIG_DIR, 'isolated gate-level config required before tests')
  await mkdir(evidence, { recursive: true })
  const root = await mkdtemp(join(evidence, `${mode}-${selected}-`)), config = join(root, 'config'), nonce = randomUUID()
  await mkdir(config); await writeFile(join(config, 'settings.json'), '{}\n')
  const child = spawn(process.execPath, ['--experimental-test-module-mocks', '--import', 'tsx', fileURLToPath(new URL('./publication-producer.mts', import.meta.url)), root, mode, selected, nonce], {
    cwd: repository, windowsHide: true, env: { ...process.env, IH_CONFIG_DIR: config }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let stdout = '', stderr = '', closed = false, hardKilled = false
  const messages: Receipt[] = [], foreign: unknown[] = [], listeners = new Set<() => void>()
  assert(child.stdout && child.stderr)
  child.stdout.on('data', chunk => { stdout += String(chunk) }); child.stderr.on('data', chunk => { stderr += String(chunk) })
  child.on('message', value => {
    const message = value as Receipt
    if (message.nonce !== nonce || message.parent !== parent || message.mode !== mode || message.selected !== selected) foreign.push(value)
    else messages.push(message)
    for (const listener of listeners) listener()
  })
  const close = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((accept, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => { closed = true; accept({ code, signal }); for (const listener of listeners) listener() })
  })
  async function message(kind: string) {
    const deadline = Date.now() + 25000
    for (;;) {
      const found = messages.find(row => row.kind === kind)
      if (found) { assert.deepEqual(foreign, []); return found }
      if (closed || Date.now() >= deadline) throw new Error(`SETUP/child failure before ${kind}; closed=${closed}\n${stdout}\n${stderr}`)
      await new Promise<void>(accept => {
        const timer = setTimeout(done, 100)
        function done() { clearTimeout(timer); listeners.delete(done); accept() }
        listeners.add(done)
      })
    }
  }
  return { root, config, messages, close, message,
    async kill() { assert(!closed, 'original process remains parked'); hardKilled = true; assert(child.kill('SIGKILL')); return close },
    async cleanup() {
      if (!closed) { hardKilled = true; assert(child.kill('SIGKILL')); await close }
      await writeFile(join(root, 'process.json'), JSON.stringify({ nonce, parent, mode, selected, pid: child.pid, messages, foreign, stdout, stderr, hardKilled, disposition: await close }, null, 2))
    },
  }
}
