import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCommitLog, openCommitLog } from '../src/index.ts'

const roots: string[] = []
const children: ReturnType<typeof spawn>[] = []
async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'ih-mp-lock-'))
  roots.push(value)
  return value
}
afterEach(async () => {
  for (const child of children.splice(0)) { child.kill(); child.stdin?.destroy() }
  for (const value of roots.splice(0)) await rm(value, { recursive: true, force: true })
})
const options = (base: string) => ({ root: base, sessionId: 's1', now: () => new Date('2026-01-01T00:00:00.000Z'), lockRoot: base, lease: { retryMs: 20, deadlineMs: 400 } })

describe('commit log multiprocess lease', () => {
  it('refuses a second writer while another process holds the lease and recovers after it dies', async () => {
    const base = await root()
    const created = await createCommitLog(options(base), { header: { formatVersion: 15, sessionId: 's1', createdAt: '2026-01-01T00:00:00.000Z' }, entries: [] })
    await created.close()
    const script = join(base, 'holder.mjs')
    await writeFile(script, 'import { openCommitLog } from ' + JSON.stringify(new URL('../src/index.ts', import.meta.url).href) + '\n' +
      'const base = process.argv[2]\n' +
      'const log = await openCommitLog({ root: base, sessionId: "s1", lockRoot: base, lease: { retryMs: 20, deadlineMs: 400 } }, "write")\n' +
      'process.stdout.write("HELD\\n")\n' +
      'setInterval(() => {}, 1000)\n', 'utf8')
    const child = spawn(process.execPath, ['--experimental-transform-types', script, base], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr!.setEncoding('utf8')
    child.stderr!.on('data', (chunk: string) => { stderr += chunk })
    children.push(child)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('holder did not start')), 15000)
      child.stdout!.setEncoding('utf8')
      child.stdout!.on('data', (chunk: string) => { if (chunk.includes('HELD')) { clearTimeout(timer); resolve() } })
      child.on('exit', code => { clearTimeout(timer); reject(new Error('holder exited early: ' + String(code) + ' ' + stderr.slice(0, 2000))) })
    })
    await expect(openCommitLog(options(base), 'write')).rejects.toBeTruthy()
    child.kill()
    await new Promise<void>(resolve => child.on('exit', () => resolve()))
    const reopened = await openCommitLog(options(base), 'write')
    try { await reopened.append({ entries: [{ type: 'user/message', text: 'after death' }] }) } finally { await reopened.close() }
    const read = await openCommitLog(options(base), 'read')
    try { expect(read.view().entries).toHaveLength(1) } finally { await read.close() }
  }, 30000)
})