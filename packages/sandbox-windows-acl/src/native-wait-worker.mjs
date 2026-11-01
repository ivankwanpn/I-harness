import { parentPort, workerData } from 'node:worker_threads'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createDrainWorkerProtocol } from './native-wait-protocol.mjs'

// Fixed entry: no eval, script path, function selector, DLL path or command in drain messages.
if (!parentPort || workerData?.protocol !== 1 || typeof workerData.epoch !== 'string' ||
    !Number.isInteger(workerData.capacity) || workerData.capacity < 1 || workerData.capacity > 8192 ||
    !isAbsolute(workerData.bridgePath ?? '') || !isAbsolute(workerData.koffiEntry ?? '') || !/^[a-f0-9]{64}$/.test(workerData.bridgeSha256 ?? '')) {
  throw new Error('invalid ACL wait worker startup contract')
}
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('ACL wait worker requires Windows x64')
const actual = createHash('sha256').update(readFileSync(workerData.bridgePath)).digest('hex')
if (actual !== workerData.bridgeSha256) throw new Error('ACL wait bridge hash mismatch in worker')
// A dedicated Node environment runs Koffi InitModule and owns a distinct InstanceData.last_error.
// Never replace this with main-environment Koffi.async: other synchronous users share its field.
const { default: koffi } = await import(pathToFileURL(workerData.koffiEntry).href)
if (koffi.version !== workerData.koffiVersion) throw new Error('ACL worker Koffi pin mismatch')
const library = koffi.load(workerData.bridgePath)
const call = library.func('__stdcall', 'ih_acl_unregister_wait_and_drain', 'uint32', ['void *'])
const epoch = workerData.epoch
const handle = createDrainWorkerProtocol({
  epoch, capacity: workerData.capacity,
  send: message => parentPort.postMessage(message),
  drain: registration => call(registration),
  shutdown: () => parentPort.close(),
})
parentPort.on('message', handle)
parentPort.postMessage({ type: 'ready', epoch })
