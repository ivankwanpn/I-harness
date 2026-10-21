import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const rows = []
for (const name of ['before-install-v2', 'after-install', 'B-before-install-v2', 'B-after-install']) {
  const root = '.tmp/r4hc-01/' + name
  const read = async path => JSON.parse(await readFile(root + '/' + path))
  const receipt = await read('receipt.json'), observation = await read('observations.json')
  const before = await read('before.json'), after = await read('after.json')
  assert.deepEqual(after, before)
  assert.equal(hash(await readFile(root + '/stdout.log')), receipt.stdoutSha256)
  assert.equal(hash(await readFile(root + '/stderr.log')), receipt.stderrSha256)
  const isBefore = name.includes('before'), host = name.startsWith('B-')
  assert.equal(receipt.nativeExit, isBefore ? 1 : 0)
  assert.equal(observation.closeResult.state, isBefore ? 'rejected' : 'fulfilled')
  assert.equal(host ? observation.promotionIssues : observation.issuedPromotions, 1)
  assert.equal(observation.cancellations.length, isBefore ? 1 : 0)
  if (isBefore) {
    assert.ok(observation.cancellations[0].operations.some(row => row.outcome?.kind === 'not-issued' && row.outcome.code === 'FACT_INVALID_GROUP'))
    assert.ok(observation.sourceCloses.some(row => row.state === 'rejected' && row.error?.message === 'Required source facts need recovery'))
  } else assert.ok(observation.sourceCloses.every(row => row.state === 'fulfilled'))
  const journal = observation.journal
  const targetId = host ? observation.promotionId : 'parent-notify-controlled'
  assert.equal(journal.filter(row => row.type === 'agent/input/promoted' && row.inputId === targetId).length, 1)
  assert.equal(journal.filter(row => row.type === 'agent/input/cancelled').length, 0)
  assert.equal(journal.filter(row => row.type === 'context/action' && row.op === 'close' && row.disposition === 'stopped').length, 1)
  if (host) {
    assert.equal(observation.parentRound, 3)
    assert.deepEqual(observation.childRounds, [['root/helper', 3], ['lead/helper-team', 3]])
    assert.equal(journal.filter(row => row.type === 'subagent/end').length, 1)
    assert.equal(journal.filter(row => row.type === 'team/message/delivered').length, 1)
    assert.equal(observation.producerProof.length, 2)
    for (const proof of observation.producerProof) {
      assert.equal(proof.events.filter(row => row.type === 'turn/end').length, 1)
      assert.equal(proof.results.filter(row => row.name === 'read').length, 1)
      assert.equal(proof.results.filter(row => row.name === 'code_exec').length, 1)
      assert.ok(proof.results.every(row => row.execution.outcome === 'succeeded' && row.execution.dispatch === 'dispatched'))
    }
  } else assert.equal(observation.requests, 0)
  rows.push({ name, nativeExit: receipt.nativeExit, inputs: before.length, receiptSha256: hash(await readFile(root + '/receipt.json')), observationsSha256: hash(await readFile(root + '/observations.json')), close: observation.closeResult.state, cancellations: observation.cancellations.length, promotions: 1, requests: host ? observation.requests.length : observation.requests })
}
const result = { scope: 'Independent read-only scalar/journal/receipt validation of immutable causal A/B; no product imports/runtime', rows }
await writeFile('.superpowers/sdd/2026-10-21-context-r4a-original-range-review/host-close-causal-audit.json', JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
