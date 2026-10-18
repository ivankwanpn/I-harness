export type CheckpointShape =
  | { readonly kind: 'complete'; readonly text: string }
  | { readonly kind: 'invalid'; readonly reason: 'framing' | 'sections' | 'empty-section' }
const open = '<compacted-summary>', close = '</compacted-summary>'
const sections = ['Objective', 'Important Details', 'Work State', 'Next Move', 'Relevant Files', 'Sensitive Instructions', 'Tool Work Summary']
/** Syntactic acceptance only; content accuracy and authority are not proven. */
export function inspectCheckpoint(text: string): CheckpointShape {
  const value = text.trim(), lines = value.split(/\r?\n/)
  if (lines[0] !== open || lines.at(-1) !== close || value.split(open).length !== 2 || value.split(close).length !== 2) return { kind: 'invalid', reason: 'framing' }
  const headings = lines.flatMap((line, index) => /^##(?:\s|$)/.test(line) ? [{ line, index }] : [])
  if (headings.length !== sections.length || headings.some((heading, i) => heading.line !== `## ${sections[i]}`)
    || lines.slice(1, headings[0]?.index).some(line => line.trim())) return { kind: 'invalid', reason: 'sections' }
  if (headings.some((heading, i) => !lines.slice(heading.index + 1, headings[i + 1]?.index ?? lines.length - 1).join('\n').trim())) return { kind: 'invalid', reason: 'empty-section' }
  return { kind: 'complete', text: value }
}
