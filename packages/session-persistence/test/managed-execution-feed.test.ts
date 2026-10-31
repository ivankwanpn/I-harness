import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { composeJsonlTaskTransitionCoordinator } from '@i-harness/session-persistence-jsonl/internal/task-document-factory'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { observeColdExecutionWrites } from '../src/coordinator/cold-execution-writes.ts'

it('publishes actual installed managed code facts after observation, but not unrelated facts', async () => {
 const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'managed-exec-feed-'))
 const c = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }, taskDocumentStorageContract)
 try {
  await c.create({sessionId:'s'}); const doc = await c.openManagedDocument('s'); const action = doc.beginAction()
  const seen: string[] = []; const off = observeColdExecutionWrites(c, () => { seen.push(doc.view.events.at(-1)?.type ?? 'missing') })
  await action.facts.metadata.admit({type:'plan/mode',mode:'off'}); expect(seen).toEqual([])
  const result = await action.facts.code.record({type:'code/cell',cellId:'x',state:'started'})
  expect(result.kind).toBe('committed'); expect(seen).toEqual(['code/cell'])
  off(); action.finish()
 } finally { await c.close(); await rm(root,{recursive:true,force:true}) }
})
