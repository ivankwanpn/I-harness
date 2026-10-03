import { displayedNavigationRange, type ProjectFileNavigation } from "../session/file-navigation.ts"

export function SearchText({ text, target, startLine = 1 }: { text: string; target?: Pick<ProjectFileNavigation, "line" | "column" | "endLine" | "endColumn">; startLine?: number }) {
  if (!target || target.column === undefined) return <>{text}</>
  const { start, end } = displayedNavigationRange(text, target, startLine)
  return <>{text.slice(0, start)}<mark className={start === end ? "search-caret" : undefined}>{text.slice(start, end)}</mark>{text.slice(end)}</>
}
