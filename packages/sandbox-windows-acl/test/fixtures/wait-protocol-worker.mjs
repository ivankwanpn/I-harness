import { parentPort, workerData } from 'node:worker_threads'
import { createDrainWorkerProtocol } from '../../src/native-wait-protocol.mjs'
let calls = 0
const run = createDrainWorkerProtocol({
  epoch: workerData.epoch, capacity: 2,
  send: message => parentPort.postMessage(message),
  drain: () => { calls++; parentPort.postMessage({ type: 'count', calls }); return workerData.status },
  shutdown: () => parentPort.close(),
})
parentPort.on('message', run)
parentPort.postMessage({ type: 'ready', epoch: workerData.epoch })
