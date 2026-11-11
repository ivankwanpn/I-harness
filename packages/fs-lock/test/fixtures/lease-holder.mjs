import { acquireSessionLock } from '../../src/index.ts'

const lease = await acquireSessionLock({ lockPath: process.argv[2], mode: process.argv[3] })
process.send?.({ kind: 'ready' })
process.on('message', async message => {
  if (message !== 'close') return
  await lease.release()
  process.send?.({ kind: 'released' })
  process.disconnect()
})
