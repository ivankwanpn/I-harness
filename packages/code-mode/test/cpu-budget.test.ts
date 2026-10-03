import { expect, it } from 'vitest'
import { Worker } from 'node:worker_threads'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const quickjsPackage = require.resolve('quickjs-emscripten/package.json')
const quickjsEntry = new URL(require('quickjs-emscripten/package.json').exports['.'].import, pathToFileURL(quickjsPackage)).href

async function probe(code: string, mode: 'pause' | 'fallback' | 'clock-failure' | 'initialization' | 'final-clock-failure' | 'after-success-clock-failure') {
  const root = await mkdtemp(join(tmpdir(), 'ih-code-cpu-')), preload = join(root, 'clock.mjs')
  const shared = new SharedArrayBuffer(Float64Array.BYTES_PER_ELEMENT * 5)
  let worker: Worker | undefined
  try {
  await writeFile(preload, `import { workerData } from 'node:worker_threads';
const native = process.threadCpuUsage?.bind(process), now = performance.now.bind(performance), telemetry = new Float64Array(workerData.cpuTelemetry);
let wallReads=0, cpuReads=0;
function pause(kind) {
  const wall=now(), before=native?.();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);
  const after=native?.(); telemetry[0]=now()-wall; telemetry[1]=before&&after?((after.user-before.user)+(after.system-before.system))/1000:-1; telemetry[2]=kind; telemetry[3]++;
}
if(workerData.cpuProbe==='fallback') { process.threadCpuUsage=undefined; process.cpuUsage=()=>{throw Error('Whole-process CPU must not be used')}; }
else if(native) process.threadCpuUsage=(...args)=>{telemetry[4]=++cpuReads;if(workerData.cpuProbe==='pause'&&cpuReads===3)pause(1);if(workerData.cpuProbe==='clock-failure'&&cpuReads>2||workerData.cpuProbe==='final-clock-failure'&&cpuReads===6||workerData.cpuProbe==='after-success-clock-failure'&&cpuReads>6)throw Error('Thread CPU clock failed');return native(...args)};
Object.defineProperty(performance,'now',{value:()=>{wallReads++;if(workerData.cpuProbe==='pause'&&wallReads===2)pause(0);return now()}});
if(workerData.cpuProbe==='initialization') {
  const {getQuickJS}=await import(${JSON.stringify(quickjsEntry)}), engine=await getQuickJS(), create=engine.newRuntime.bind(engine);
  engine.newRuntime=(...args)=>{const runtime=create(...args), context=runtime.newContext.bind(runtime);runtime.newContext=(...args)=>{const vm=context(...args), evaluate=vm.evalCode.bind(vm);let boot=false;vm.evalCode=(...args)=>{if(!boot&&args[1]===undefined){boot=true;const before=native(), start=now();let used=0;do{for(let i=0;i<1000;i++)Math.sqrt(i);const current=native();used=((current.user-before.user)+(current.system-before.system))/1000}while(used<45&&now()-start<1000);telemetry[0]=now()-start;telemetry[1]=used;telemetry[2]=2;telemetry[3]++};return evaluate(...args)};return vm};return runtime};
}
`)
  worker = new Worker(new URL('../src/worker.mjs', import.meta.url), { stderr: true, execArgv: ['--import', pathToFileURL(preload).href], workerData: {
    code, cellId: 'budget-probe', catalog: '[]', store: '[]', cpuProbe: mode, cpuTelemetry: shared,
    config: { cpuTimeMs: 30, memoryLimitMb: 64, maxResultBytes: 4 * 1024 * 1024, maxStoreBytes: 1024 * 1024, maxPendingCalls: 64 },
  } })
  const cell = worker
  cell.stderr?.resume() // Expected injected native-clock errors belong to this probe.
  const exited = new Promise<number>(resolve => cell.once('exit', resolve))
  const output: string[] = []
    const closed = await new Promise<{ status: string; error?: string; writes: string }>((resolve, reject) => {
      cell.on('message', event => { if (event.type === 'output') { const item = JSON.parse(event.json); if (item.type === 'text') output.push(item.text) }; if (event.type === 'closed') resolve(event) })
      cell.once('error', reject); cell.once('exit', code => { if (code !== 0) reject(new Error(`CPU probe worker exit ${code}`)) })
    })
    expect(await exited).toBe(0) // The VM reaches quiescence without a parent kill shortcut.
    return { ...closed, text: output.join('\n'), telemetry: [...new Float64Array(shared)] }
  } finally { await worker?.terminate(); await rm(root, { recursive: true, force: true }) }
}

it.runIf(typeof process.threadCpuUsage === 'function')('does not charge a deterministic scheduler pause as guest thread CPU in the actual worker', async () => {
  const result = await probe('text(7)', 'pause')
  expect(result.telemetry[0]).toBeGreaterThanOrEqual(90)
  expect(result.telemetry[1]).toBeLessThan(30)
  expect(result.telemetry[3]).toBe(1)
  expect(result.status, JSON.stringify(result)).toBe('completed'); expect(result.error).toBeUndefined(); expect(result.text).toBe('7')
})

it('preserves a conservative local fallback and infinite-work containment without process-wide CPU readings', async () => {
  const recovery = await probe('text(7)', 'fallback')
  expect(recovery.status).toBe('completed'); expect(recovery.text).toBe('7')
  const loop = await probe('while(true) await Promise.resolve()', 'fallback')
  expect(loop.status).toBe('failed'); expect(loop.error).toMatch(/CPU|interrupt/)
})

it.runIf(typeof process.threadCpuUsage === 'function')('excludes fixed trusted helper initialization from the actual guest CPU budget', async () => {
  const result = await probe('text(7)', 'initialization')
  expect(result.telemetry[1], JSON.stringify(result)).toBeGreaterThanOrEqual(45)
  expect(result.telemetry[2]).toBe(2); expect(result.telemetry[3]).toBe(1)
  expect(result.status, JSON.stringify(result)).toBe('completed'); expect(result.error).toBeUndefined(); expect(result.text).toBe('7')
})

it.runIf(typeof process.threadCpuUsage === 'function')('fails the actual cell closed if the native clock fails during a guest slice', async () => {
  const result = await probe('while(true){}', 'clock-failure')
  expect(result.status).toBe('failed'); expect(result.error).toMatch(/Thread CPU clock failed/)
})

it.runIf(typeof process.threadCpuUsage === 'function')('accounts for the completing slice before acknowledging success or store writes', async () => {
  const result = await probe("store('k',7);text(7)", 'final-clock-failure')
  expect(result.status, JSON.stringify(result)).toBe('failed')
  expect(result.error).toMatch(/Thread CPU clock failed/)
  expect(JSON.parse(result.writes)).toEqual([])
  expect(result.telemetry[4]).toBe(6)
})

it.runIf(typeof process.threadCpuUsage === 'function')('keeps caught guest exit terminal and makes no unvalidated clock read after success', async () => {
  const result = await probe("store('before',7);try{exit()}catch(e){store('after',9);while(true){}}", 'after-success-clock-failure')
  expect(result.status, JSON.stringify(result)).toBe('completed'); expect(result.error).toBeUndefined()
  expect(JSON.parse(result.writes)).toEqual([['before', 7]])
  expect(result.telemetry[4]).toBeLessThanOrEqual(6)
})
