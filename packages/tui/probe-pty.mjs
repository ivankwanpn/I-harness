import { spawn } from 'node-pty'
import { mkdirSync } from 'node:fs'
const dir = 'C:/Users/inkik/AppData/Local/Temp/tui-probe-marker'
mkdirSync(dir, { recursive: true })
const cwd = 'D:/I-harness-main'
const child = spawn(process.execPath, ['--import','tsx','packages/tui/test/harness/host-011.ts','porbe',dir,'46','24'], { cols:46, rows:24, cwd })
let count = 0
const chunks = []
child.onData(d => { chunks.push(d); count += Buffer.byteLength(d) })
child.onExit(({exitCode}) => {
  console.log('exit', exitCode, 'total', count)
  const joined = chunks.join('')
  console.log('first 200 bytes:', JSON.stringify(joined.slice(0,200)))
  console.log('bytes 1532..1700:', JSON.stringify(joined.slice(1532,1700)))
})
