import { openCommitLog } from '../../src/store.ts'

const log = await openCommitLog({ root: process.argv[2], sessionId: '__documents__' }, 'read')
const side = log.view().documents.get('x')
process.send({ kind: 'ready' })
process.on('message', async message => {
  if (message === 'read') process.send({ kind: 'read', text: Buffer.from(await log.readSidecar(side.digest)).toString() })
  if (message === 'close') { await log.close(); process.disconnect() }
})
