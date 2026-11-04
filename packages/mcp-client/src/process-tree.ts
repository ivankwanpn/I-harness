import { spawn, type SpawnOptions } from 'node:child_process'

/** A-11: on Windows the SDK kills only the direct MCP child; its descendants
 * survive and keep pipes/ports. taskkill /T terminates the whole tree. */
export function killWindowsProcessTree(pid: number, spawnFn: typeof spawn = spawn): Promise<void> {
  return new Promise(resolve => {
    let settled = false
    const done = () => { if (!settled) { settled = true; resolve() } }
    try {
      const child = spawnFn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' } as SpawnOptions)
      child.once('error', done)
      child.once('exit', done)
    } catch {
      done()
    }
  })
}
