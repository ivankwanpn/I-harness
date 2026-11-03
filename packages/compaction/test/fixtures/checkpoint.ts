import { prepareModelRequest, type LLMRequest, type ModelClient, type PreparedModelRequest } from '@i-harness/llm-seam'
/** A test-authored checkpoint, independent of the production parser/template. */
export function completeCheckpoint(objective = 'Resume work.'): string {
  return '<compacted-summary>\n## Objective\n' + objective
    + '\n## Important Details\n(none)\n## Work State\nTests passed.\n## Next Move\nReview changes.\n## Relevant Files\nsrc/a.ts\n## Sensitive Instructions\n(none)\n## Tool Work Summary\nRead completed.\n</compacted-summary>'
}
export function checkpointOfLength(chars: number, label = 'Primary Request: retain completed work.'): string {
  const room = chars - completeCheckpoint('').length
  if (room < label.length) throw Error('Fixture checkpoint ceiling cannot hold its complete structure')
  return completeCheckpoint(label + 'x'.repeat(room - label.length))
}
/** Only these explicitly declared fixture clients certify their own text mode.
 * Neutral preparation remains truthful about custom protocol/cap uncertainty. */
export async function prepareTextFixture(this: ModelClient, request: LLMRequest): Promise<PreparedModelRequest> {
  const prepared = await prepareModelRequest({ stream: this.stream.bind(this) }, request)
  const declare = (p: PreparedModelRequest): PreparedModelRequest => Object.freeze({ ...p,
    textOutput: Object.freeze({ status: 'allowed' as const, reason: 'ordinary-text' as const }),
    withOutputCap: (cap: number | undefined) => declare(p.withOutputCap(cap)),
  })
  return declare(prepared)
}
