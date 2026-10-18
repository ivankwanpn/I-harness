import { expect, it } from 'vitest'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'

it('the private SDK ownership bridge has only the concrete built-in Bedrock terminal as a production importer', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url)), importers: string[] = []
  async function scan(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await scan(path)
      else if (entry.isFile() && entry.name.endsWith('.ts')) {
        const text = await readFile(path, 'utf8')
        if (/from\s+['"]@i-harness\/llm-seam\/internal\/bedrock-terminal['"]/.test(text)) importers.push(relative(root, path).replaceAll('\\', '/'))
      }
    }
  }
  for (const group of ['packages', 'apps']) for (const entry of await readdir(join(root, group), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    try { await scan(join(root, group, entry.name, 'src')) } catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error }
  }
  expect(importers).toEqual(['packages/llm-bedrock/src/sdk-terminal.ts'])
  const facade = await readFile(join(root, 'packages/llm-seam/src/index.ts'), 'utf8')
  expect(facade).not.toMatch(/export\s*\{[^}]*\b(?:ownPreparedTerminal|createBedrockTerminalPayload)\b/)
  const mockFacade = await readFile(join(root, 'packages/llm-mock/src/index.ts'), 'utf8')
  expect(mockFacade).not.toMatch(/export\s*\{[^}]*\bownLocalMock\b/)
})
