import { createContextOutputService } from '../src/index.ts'

const [root, refId] = process.argv.slice(2)
if (!root || !refId) throw Error('Missing controlled child fixture')
const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
try {
  const read = await service.read({ sessionId: 's' }, { refId })
  const search = await service.search({ sessionId: 's' }, { query: 'needle' })
  console.log(JSON.stringify({ text: read.text, hits: search.hits.map(hit => hit.ref.id) }))
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.name : String(error) }))
} finally { await service.close() }
