import { execFileSync } from "node:child_process"
import { resolve } from "node:path"
import { expect, it } from "vitest"

it.skipIf(process.platform !== 'win32' || process.env.IH_WSL_INJECTED_EXIT_EVENTS !== '1')('proves selected Directory locations without sibling metadata and preserves object exclusions', () => {
  const toWsl = (p: string) => execFileSync('wsl.exe', ['-d', 'Ubuntu', '--exec', 'wslpath', '-u', p], { encoding: 'utf8' }).trim()
  const fixture = toWsl(resolve('test/canonical_directory_test.py'))
  const source = toWsl(resolve('worker/runner.py'))
  const root = toWsl(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!)
  const result = execFileSync('wsl.exe', ['-d', 'Ubuntu', '--exec', 'python3', '-I', '-B', fixture, source, root], { encoding: 'utf8', timeout: 15000 })
  expect(result).toContain('INJECTED_SELECTED_LOCATION_CASES=26')
})
