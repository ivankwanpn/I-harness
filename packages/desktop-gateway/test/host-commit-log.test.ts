import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRpcSuccess, type RpcMessage } from '@i-harness/sdk'
import { createDesktopHost } from '../src/host.ts'

for (const sessionStore of ['jsonl', 'commit-log'] as const) {
  it('creates and closes a session on the ' + sessionStore + ' store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ih-gateway-store-')), workspace = join(root, 'workspace'), sessionDir = join(root, 'sessions')
    await mkdir(workspace)
    const settingsPath = join(root, 'settings.json'), credentialsPath = join(root, 'credentials.json')
    await writeFile(settingsPath, JSON.stringify({ autoTitle: false, sandboxMode: 'read-only', compaction: { auto: false }, codeMode: { mode: 'off' } }))
    await writeFile(credentialsPath, JSON.stringify({ refs: {} }))
    const frames: RpcMessage[] = []
    const host = await createDesktopHost({ workspace, sessionDir, settingsPath, credentialsPath, sessionStore, onWrite: frame => frames.push(frame) })
    try {
      const request = (id: number, method: string, params: unknown) => host.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      await request(1, 'initialize', {})
      await request(2, 'session/create', {})
      const created = frames.find(frame => 'id' in frame && frame.id === 2)
      if (!isRpcSuccess(created)) throw new Error(sessionStore + ' session creation failed')
      const sessionId = (created.result as { sessionId: string }).sessionId
      expect(sessionId).toBeTruthy()
      if (sessionStore === 'commit-log') {
        await request(3, 'desktop/schedule/list', { sessionId })
        const schedules = frames.find(frame => 'id' in frame && frame.id === 3)
        expect(isRpcSuccess(schedules)).toBe(true)
        if (isRpcSuccess(schedules)) expect(schedules.result).toEqual({ schedules: [] })
        await request(4, 'desktop/approval-rules/state', {})
        const rules = frames.find(frame => 'id' in frame && frame.id === 4)
        expect(isRpcSuccess(rules)).toBe(true)

      }
    } finally {
      await host.close()
    }
  }, 60000)
}