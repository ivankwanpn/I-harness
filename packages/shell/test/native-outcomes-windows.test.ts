import { expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry, resultExecution } from '@i-harness/core-tools'
import { createShellTools } from '../src/index.ts'
import { createOwnedExec } from '../../sandbox-windows-psec/test/owned-exec.ts'

it.skipIf(process.platform !== 'win32')('real unrestricted Windows helper forwards native outcomes into registered pwsh without profile loading', async () => {
  const base = resolve(import.meta.dirname, '../../../build/native-outcome-windows'); mkdirSync(base, { recursive: true })
  const root = mkdtempSync(resolve(base, 'owned-')), exec = createOwnedExec(root), registry = createToolRegistry(createContext())
  for (const tool of createShellTools({ exec, cwd: root })) registry.register(tool)
  try {
    for (const [code, outcome] of [[0, 'succeeded'], [7, 'failed']] as const) {
      const call = await registry.prepare({ name: 'pwsh', args: { command: `Write-Output 'native-proof'; exit ${code}` } })
      const output = await registry.dispatch(call); await registry.finalize(call, output)
      expect(output).toEqual({ stdout: 'native-proof\n', stderr: '', exitCode: code })
      expect(resultExecution(call)).toEqual({ outcome, dispatch: 'dispatched' })
    }
  } finally { await exec.dispose(); rmSync(root, { recursive: true, force: true }) }
}, 30000)
