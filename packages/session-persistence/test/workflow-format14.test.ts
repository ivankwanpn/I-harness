import { expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { encodeFactBatch, legacyPrefixDigest, type SessionEvent } from '@i-harness/core-session'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { isKnownEventType } from '../src/format/registry.ts'

it('reads the original JSONL Workflow frame at physical14 and refuses physical13 without activating a producer', async () => {
  const root = join(process.env.IH_CONFIG_DIR!, 'workflow-format')
  await mkdir(root)
  const prefix = legacyPrefixDigest(0, new Uint8Array())
  const journal = { version: 1 as const, legacyBodyBytes: 0, legacyEventCount: 0, legacyPrefixDigest: prefix, separatorBytes: 0 as const }
  const events: SessionEvent[] = [
    { type: 'agent/input/admitted', version: 1, inputId: 'human', text: 'work', delivery: 'queue', intent: 'user', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'session.prompt' }, seq: 0 },
    { type: 'agent/delivery-generation', version: 1, op: 'open', recipientSessionId: 'parent', generationId: 'g', originInputSeq: 0, seq: 1 },
    { type: 'tool/call', callId: 'call', name: 'workflow_run', args: {}, seq: 2 }, { type: 'tool/dispatch', callId: 'call', eventSeq: 2, seq: 3 },
    { type: 'agent/delivery-source', version: 1, kind: 'workflow', sourceNamespace: 'workflow', sourceId: 'original', recipientSessionId: 'parent', generationId: 'g', callSeq: 2, delivery: 'parent', seq: 4 },
    { type: 'workflow/end', version: 1, sourceSeq: 4, invocationId: 'original', execution: { dispatch: 'unknown', outcome: 'unknown' }, reason: 'launch-unknown', seq: 5 },
  ]
  const frame = encodeFactBatch('original-workflow', prefix, events)
  const write = async (formatVersion: number) => writeFile(join(root, 'parent.jsonl'), Buffer.concat([Buffer.from(JSON.stringify({ sessionId: 'parent', createdAt: 'fixture', formatVersion, journal }) + '\n'), frame.bytes]))
  expect(isKnownEventType('workflow/end')).toBe(true)
  await write(14)
  expect((await createJsonlBackend(root).read('parent')).events).toEqual(events)
  await write(13)
  await expect(createJsonlBackend(root).read('parent')).rejects.toThrow()
})
