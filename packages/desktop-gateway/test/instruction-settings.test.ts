import { expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInstructionSettings } from '../src/instructions/settings.ts'
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
it('keeps saved instruction policy after the original durable rename fails', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'ih-i6-save-failure-')), path = join(root, 'settings.json')
  await fs.writeFile(path, JSON.stringify({ instructions: { enabled: true, maxBytes: 24000, globalSources: [] } }))
  const owner = createInstructionSettings(path), original = fs.rename
  const failing = vi.spyOn(fs, 'rename').mockImplementation(async (...args) => { if (String(args[1]) === path) throw Object.assign(new Error('controlled rename failure'), { code: 'EACCES' }); return original(...args) })
  try { await expect(owner.configure({ enabled: false, maxBytes: 0 })).rejects.toThrow(); expect((await owner.state()).saved).toMatchObject({ enabled: true, maxBytes: 24000, globalSources: [] }) }
  finally { failing.mockRestore(); await fs.rm(root, { recursive: true, force: true }) }
})
