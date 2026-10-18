export class SummaryCheckpointError extends Error {
  constructor(readonly failure: unknown) { super("compaction: summary checkpoint persistence failed", { cause: failure }) }
}

type SummaryBlock = "retention-policy" | "output-floor" | "fixed-input" | "call-limit" | "call-policy" | "shrink-limit" | "retention-output" | "binding" | "opaque" | 'source-unrepresentable' | "refused" | "truncated" | "incomplete" | "output-incompatible" | "output-unknown" | "checkpoint-format" | "tool-output"
/** Closed engine-owned reasons; provider messages never become result data. */
export class SummaryBlockedError extends Error {
  constructor(readonly kind: SummaryBlock, facts: { chars?: number; floor?: number; input?: number; output?: number; window?: number; limit?: number } = {}) {
    const numeric = (value: number | undefined) => Number.isSafeInteger(value) && value! >= 0 ? String(value) : "unknown"
    const reasons: Record<SummaryBlock, string> = {
      'source-unrepresentable': 'compaction: selected visible source order cannot be represented completely',
      'output-incompatible': 'compaction: summary request requires structured or forced tool output',
      'output-unknown': 'compaction: summary request text output eligibility is unknown',
      'checkpoint-format': 'compaction: summary does not contain a complete framed checkpoint',
      'tool-output': 'compaction: summary produced a tool call; checkpoint was not committed',
      "retention-policy": `compaction: retained checkpoint ceiling ${numeric(facts.chars)} chars is below quality floor ${numeric(facts.floor)}`,
      "output-floor": `compaction: summary output ceiling ${numeric(facts.output)} cannot provide reasoning/retention allowance ${numeric(facts.floor)}`,
      "fixed-input": `compaction: indivisible/fixed summary input cannot fit (${numeric(facts.input)} input tokens; ${numeric(facts.output)} required output; window ${numeric(facts.window)})`,
      "call-limit": `compaction: shared summary call limit exhausted (${numeric(facts.limit)})`,
      "call-policy": "compaction: maxSummaryCalls must be an integer in [1, 8]",
      "shrink-limit": "compaction: summary overflow shrink limit exhausted (2)",
      "retention-output": `compaction: retained summary outside quality/size limits (${numeric(facts.chars)} chars; floor ${numeric(facts.floor)}; ceiling ${numeric(facts.limit)})`,
      binding: "compaction: summary binding does not match prepared model",
      opaque: "compaction: summary fixed input contains unpriced provider references",
      refused: "compaction: the provider refused to produce a summary",
      truncated: "compaction: provider truncated the summary; checkpoint was not committed",
      incomplete: "compaction: incomplete summary stream; checkpoint was not committed",
    }
    super(reasons[kind])
  }
}
