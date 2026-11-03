const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
type Run = { role: 'user' | 'assistant'; indices: number[]; blocks: Record<string, unknown>[] }
/** Read only: Messages combines consecutive same-role messages into one turn.
 * A result-bearing user run continues the assistant tool loop even when it
 * also carries text/images. Pairing and ordering remain grammar-owned.
 * https://platform.claude.com/docs/en/api/messages/create
 * https://platform.claude.com/docs/en/build-with-claude/thinking-tool-workflows
 * (checked 2026-10-16). No companion labels or neutral provenance guesses. */
export function ongoingAnthropicToolTurn(messages: unknown): { assistantIndices: ReadonlySet<number>; firstBlock: Record<string, unknown> | undefined } | undefined {
  if (!Array.isArray(messages)) return
  const runs: Run[] = []
  for (const [index, message] of messages.entries()) {
    if (!record(message) || message.role !== 'user' && message.role !== 'assistant') return
    let run = runs.at(-1)
    if (!run || run.role !== message.role) { run = { role: message.role, indices: [], blocks: [] }; runs.push(run) }
    run.indices.push(index)
    if (typeof message.content === 'string') run.blocks.push({ type: 'text', text: message.content })
    else if (Array.isArray(message.content)) for (const block of message.content) if (record(block)) run.blocks.push(block)
  }
  let turn: { assistantIndices: Set<number>; firstBlock: Record<string, unknown> | undefined } | undefined
  let continuing = false
  for (let index = 0; index < runs.length; index++) {
    const run = runs[index]!
    if (run.role === 'assistant') {
      if (!continuing || !turn) turn = { assistantIndices: new Set(), firstBlock: run.blocks[0] }
      for (const messageIndex of run.indices) turn.assistantIndices.add(messageIndex)
      continuing = false
    } else {
      const previous = runs[index - 1]
      const calls = new Set(previous?.role === 'assistant' ? previous.blocks.filter(block => block.type === 'tool_use').map(block => block.id) : [])
      // The grammar rejects missing/duplicate/orphan results. This analysis
      // only identifies which validated result-bearing run continues a turn.
      continuing = calls.size > 0 && run.blocks.some(block => block.type === 'tool_result' && calls.has(block.tool_use_id))
      if (!continuing) turn = undefined
    }
  }
  return continuing ? turn : undefined
}
