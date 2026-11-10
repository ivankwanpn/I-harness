import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'

const [root, phase] = process.argv.slice(2)
if (!root || (phase !== 'seed' && phase !== 'complete')) throw new Error('Expected root and original phase')
const path = join(root, 'target.jsonl'), originalOpen = fs.open
let cut = false
fs.open = async (...args: Parameters<typeof fs.open>) => {
  const handle = await Reflect.apply(originalOpen, fs, args)
  if (String(args[0]) !== path || args[1] !== 'r+') return handle
  return new Proxy(handle, { get(target, key) {
    const value = Reflect.get(target, key, target)
    if (key === 'write') return async (...writeArgs: unknown[]) => {
      const bytes = writeArgs[0] instanceof Uint8Array ? writeArgs[0] : undefined
      if (!cut && bytes && Buffer.from(bytes).includes(Buffer.from('"batchId":"bootstrap:child:' + phase + '"'))) {
        cut = true
        await target.write(bytes, Number(writeArgs[1]), Math.max(1, Math.floor(Number(writeArgs[2]) / 2)), Number(writeArgs[3]))
        await target.sync()
        await new Promise<void>((resolve, reject) => process.stdout.write('ORIGINAL_DURABLE_PARTIAL ' + phase + '\n', error => error ? reject(error) : resolve()))
        // Exit inside the original syscall wrapper before its Promise returns.
        // The parent resumes from this actual flushed partial frame.
        process.exit(0)
      }
      return Reflect.apply(value, target, writeArgs)
    }
    return typeof value === 'function' ? value.bind(target) : value
  } })
}
syncBuiltinESMExports()

const { createSessionCoordinator, createControlledJsonlBackend } = await import('./composed.ts')
const { pair } = await import('../child-bootstrap-fixture.ts')
const { exportConversationSeed } = await import('@i-harness/core-session')
const { compileSemanticSeed, createChildBootstrapRequestIntent, captureChildBootstrapCaptureRequest } = await import('../../src/index.ts')
const coordinator = createSessionCoordinator(createControlledJsonlBackend(root))
await coordinator.create({ sessionId: 'parent' })
await coordinator.append('parent', [{ type: 'turn/start' }, { type: 'user/message', text: 'original native seed' }, { type: 'turn/end' }])
const exported = exportConversationSeed((await coordinator.snapshot!('parent')).session, { kind: 'session', sessionId: 'parent' }, { kind: 'all' })
if (exported.kind !== 'seed') throw new Error('Original durable source required')
const values = pair(), core = { ...values.request.core, history: { selection: { kind: 'all' as const }, source: { kind: 'session' as const, sessionId: 'parent' } } }
const intent = createChildBootstrapRequestIntent(core, { kind: 'unmanaged' })
const request = captureChildBootstrapCaptureRequest({ ...values.request, core, requestIntent: intent.intent, invocation: { ...values.request.invocation, requestDigest: intent.requestDigest } })
const payload = { ...values.payload, invocation: request.invocation, seed: compileSemanticSeed(exported) }
await fs.writeFile(join(root, 'original-crash-request.json'), JSON.stringify({ request, payload }))
await coordinator.bootstrapChildTargetWithCapture!(request, { assertCurrent() {}, dependencies: { async confirm() { throw new Error('No dependencies') }, async reconcile() { throw new Error('No dependencies') } } }, async () => payload)
throw new Error('Original frame did not reach its partial syscall')
