// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { createTextDiff } from '../../text-diff/src/index.ts'
import type { TimelineRow } from '../src/renderer/session/project.ts'
import { SessionChangesPane } from '../src/renderer/review/SessionChangesPane.tsx'
import { ReviewPane } from '../src/renderer/review/ReviewPane.tsx'
afterEach(cleanup)
const edit = (id: string, after: string): TimelineRow => ({ id, kind: 'tool', name: 'edit', resultReceived: true, turn: { id: 'turn-1', complete: true }, output: { change: createTextDiff('a.txt', 'before\n', after + '\n') } })
it('shows recorded diff versions without Git or commit actions', () => {
  render(<SessionChangesPane rows={[edit('one', 'first'), edit('two', 'second')]} />)
  expect(screen.queryByText('提交訊息')).toBeNull()
  const buttons = screen.getAllByRole('button', { name: /查看變更 a.txt/ })
  expect(buttons).toHaveLength(2)
  fireEvent.click(buttons[0]!)
  expect(within(screen.getByRole('region', { name: '選取的檔案差異' })).getByText('+first')).toBeTruthy()
  fireEvent.click(buttons[1]!)
  expect(within(screen.getByRole('region', { name: '選取的檔案差異' })).getByText('+second')).toBeTruthy()
})
it('does not show a previous conversation diff after switching the source rows', () => {
  const view = render(<SessionChangesPane rows={[edit('one', 'first')]} />)
  expect(screen.getByText('+first')).toBeTruthy()
  view.rerender(<SessionChangesPane rows={[]} />)
  expect(screen.queryByText('+first')).toBeNull()
  expect(screen.getByText('此範圍尚無已記錄的檔案變更')).toBeTruthy()
})
it('does not render a Git commit form for a non-Git folder', () => {
  render(<ReviewPane changes={{ kind: 'unavailable', reason: 'not-git-repo' }} onSelect={vi.fn()} onRefresh={vi.fn()} onCommit={vi.fn()} />)
  expect(screen.getByText('不是 Git 工作區，無法列出變更')).toBeTruthy()
  expect(screen.queryByRole('textbox', { name: '提交訊息' })).toBeNull()
  expect(screen.queryByRole('button', { name: '提交已暫存變更' })).toBeNull()
})
