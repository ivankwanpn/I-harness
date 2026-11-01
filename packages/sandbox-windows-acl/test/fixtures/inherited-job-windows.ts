import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { AclSandbox } from '../../src/index.ts'
import { verifyWaitAssets } from '../../src/native-wait-bridge.ts'

assert.equal(process.env.IH_ACL_INHERITED_QUALIFICATION, '1')
assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64')
const cwd = process.env.IH_ACL_INHERITED_CWD, trace = process.env.IH_ACL_JOB_TRACE
assert.ok(cwd && trace)
const log = (event: string, detail: unknown = {}) => appendFileSync(trace, JSON.stringify({ event, detail, at: Date.now() }) + '\n')
log('verified-default-assets', verifyWaitAssets(fileURLToPath(new URL('../../native/runtime/', import.meta.url))))
const descendant = `const deadline=setTimeout(()=>process.exit(99),4000);process.stderr.write('READY');setTimeout(()=>{clearTimeout(deadline);process.stdout.write('LATE');process.exitCode=33},1000)`
const source = `const deadline=setTimeout(()=>process.exit(99),4000);const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','pipe'],windowsHide:true});child.on('error',()=>process.exit(98));let seen='';child.stderr.on('data',chunk=>{seen+=chunk.toString();if(seen.includes('READY')){child.stderr.destroy();child.unref();process.stdout.write('ROOT_READY');clearTimeout(deadline);process.exitCode=23}})`
const sandbox = new AclSandbox({ mode: 'read-only', writableDirs: [], manageDacls: false })
try {
  await sandbox.init()
  log('child-command', { executable: process.execPath, args: ['-e', source], cwd, stdio: 'inherit' })
  const child = await sandbox.spawn({ command: process.execPath, args: ['-e', source], cwd, stdio: 'inherit' })
  const result = await child.wait()
  assert.equal(result.exitCode, 23)
  log('root-wait-complete', { pid: child.pid, exitCode: result.exitCode })
} catch (error) { log('fixture-failure', { message: String(error), stack: error instanceof Error ? error.stack : undefined }); throw error }
finally { await sandbox.disposeAsync(); log('sandbox-disposed') }
