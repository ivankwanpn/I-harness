import { SettingsStore } from '@i-harness/settings'

const [command, ...rest] = process.argv.slice(2)
let continueLoad
const loadGate = new Promise(resolve => { continueLoad = resolve })
let supplyKey
const keyGate = new Promise(resolve => { supplyKey = resolve })
let gated = false, waiting = false
const timeout = globalThis.setTimeout
// Observe the real native lease retry; do not substitute its acquisition result.
globalThis.setTimeout = (...args) => {
  if (!waiting && new Error().stack?.includes('fs-lock')) {
    waiting = true
    process.send?.({ event: 'lease-waiting' })
  }
  return timeout(...args)
}
for (const name of ['load', 'loadObserved']) {
  const original = SettingsStore.prototype[name]
  SettingsStore.prototype[name] = async function (...args) {
    const value = await original.apply(this, args)
    if (!gated && process.env.IH_TEST_GATE_LOAD === '1') {
      gated = true
      process.send?.({ event: 'loaded' })
      await loadGate
    }
    return value
  }
}
const entry = await import(`../../src/${command}.ts`)
const run = entry[{ roles: 'runRolesCommand', provider: 'runProviderCommand', models: 'runModelsCommand' }[command]]
let started = false
process.on('message', async message => {
  if (message === 'continue') continueLoad()
  if (message === 'key') supplyKey('owned-fixture-key')
  if (message !== 'go' || started) return
  started = true
  process.send?.({ event: 'started' })
  try {
    const options = command === 'provider' ? { async readKey() { process.send?.({ event: 'key-input' }); return keyGate } } : undefined
    const code = await run([command, ...rest], options)
    process.exitCode = code
    process.send?.({ event: 'result', code }, () => process.disconnect())
  } catch (error) {
    process.exitCode = 1
    process.send?.({ event: 'result', code: 1, error: error instanceof Error ? error.message : String(error) }, () => process.disconnect())
  }
})
process.send?.({ event: 'ready' })
