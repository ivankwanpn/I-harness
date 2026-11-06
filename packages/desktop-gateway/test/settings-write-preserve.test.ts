import { expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModelRetrySettings } from '../src/model-retry-settings.ts'

// A user's store selection must survive another settings write: the store
// patch merges, it does not rewrite a normalized full document.
it('preserves the store selection through another settings write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-settings-preserve-'))
  const path = join(root, 'settings.json')
  await writeFile(path, JSON.stringify({ sessionStore: 'commit-log', modelRetryLimit: 3 }), 'utf8')
  const settings = createModelRetrySettings(path)
  await settings.configure(7)
  const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  expect(raw.modelRetryLimit).toBe(7)
  expect(raw.sessionStore).toBe('commit-log')
})