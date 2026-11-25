import { execFileSync } from "node:child_process"
import { resolve } from "node:path"
import { expect, it } from "vitest"

it.skipIf(process.platform !== 'win32' || process.env.IH_WSL_INJECTED_EXIT_EVENTS !== '1')('proves selected Directory locations without sibling metadata and preserves object exclusions', () => {
  const distribution = process.env.IH_WSL_TEST_DISTRIBUTION ?? 'Ubuntu'
  // Map fixture paths inside the already running guest instead of starting a
  // separate Windows launcher for each path before running the tests.
  const runFixture = `import runpy,subprocess,sys
paths=[subprocess.check_output(['/usr/bin/wslpath','-u',p],text=True,timeout=3).strip() for p in sys.argv[1:]]
sys.argv=paths
runpy.run_path(paths[0],run_name='__main__')`
  const result = execFileSync('wsl.exe', [
    '-d', distribution, '--exec', 'python3', '-I', '-B', '-c', runFixture,
    resolve('test/canonical_directory_test.py'), resolve('worker/runner.py'), process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,
  ], { encoding: 'utf8', timeout: 15000 })
  expect(result).toContain('INJECTED_SELECTED_LOCATION_CASES=31')
}, 20_000)
