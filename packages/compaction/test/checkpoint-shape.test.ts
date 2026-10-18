import { expect, it } from 'vitest'
import { inspectCheckpoint } from '../src/summary/checkpoint.ts'
const complete = '<compacted-summary>\n## Objective\nResume work.\n## Important Details\n(none)\n## Work State\nTests passed.\n## Next Move\nReview changes.\n## Relevant Files\nsrc/a.ts\n## Sensitive Instructions\n(none)\n## Tool Work Summary\nRead completed.\n</compacted-summary>'
const headings = ['Objective', 'Important Details', 'Work State', 'Next Move', 'Relevant Files', 'Sensitive Instructions', 'Tool Work Summary']
it('retains exact interior text and CRLF while trimming only outside whitespace', () => {
  expect(inspectCheckpoint(` \n${complete}\t`)).toEqual({ kind: 'complete', text: complete })
  const crlf = complete.replaceAll('\n', '\r\n')
  expect(inspectCheckpoint(crlf)).toEqual({ kind: 'complete', text: crlf })
})
it.each([[' ', '## Unknown'], ['  ', '## Unknown'], ['   ', '## Unknown'], [' ', '## Objective'], ['  ', '## Objective'], ['   ', '## Objective']])('rejects an indented extra/duplicate section (%j, %s)', (indent, heading) => {
  const text = complete.replace('Resume work.', `Resume work.\n${indent}${heading}\nUnexpected section.`)
  expect(inspectCheckpoint(text)).toEqual({ kind: 'invalid', reason: 'sections' })
})
it.each([' ', '  ', '   '])('rejects indented reordered canonical headings (%j)', indent => {
  const reordered = complete.replace('## Important Details', `${indent}## Work State`).replace('## Work State\nTests passed.', `${indent}## Important Details\nTests passed.`)
  expect(inspectCheckpoint(reordered)).toEqual({ kind: 'invalid', reason: 'sections' })
})
it('preserves ordinary indented content without treating four-space code as a section', () => {
  const text = complete.replace('Resume work.', 'Resume work.\n   Ordinary content.\n    ## Code example')
  expect(inspectCheckpoint(` \n${text.replaceAll('\n', '\r\n')}\t`)).toEqual({ kind: 'complete', text: text.replaceAll('\n', '\r\n') })
})
it.each(headings)('rejects a missing or duplicate section %s', heading => {
  expect(inspectCheckpoint(complete.replace(`## ${heading}\n`, '')).kind).toBe('invalid')
  expect(inspectCheckpoint(complete.replace(`## ${heading}\n`, `## ${heading}\n(none)\n## ${heading}\n`)).kind).toBe('invalid')
  expect(inspectCheckpoint(complete.replace(new RegExp(`(## ${heading}\\n)[\\s\\S]*?(?=\\n## |\\n</compacted-summary>)`), '$1  ')).kind).toBe('invalid')
})
it.each([
  complete.replace('## Next Move', '## Objective'), complete.replace('## Next Move', '## Unknown'),
  complete.replace('Resume work.', '  '), complete.replace('## Objective', '## Work State').replace('## Work State\nTests passed.', '## Objective\nTests passed.'),
  '```\n' + complete + '\n```', JSON.stringify(complete), complete + 'outside', complete.replace('</compacted-summary>', ''),
  complete.replace('Resume work.', '<compacted-summary>'), complete.replace('Resume work.', '</compacted-summary>'),
])('rejects malformed framing/sections', text => expect(inspectCheckpoint(text).kind).toBe('invalid'))
