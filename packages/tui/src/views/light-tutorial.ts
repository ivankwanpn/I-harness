// @i-harness/tui — G2 (M46a): /tutorial topic list overlay — static content
// (terminal setup / keys / rewind / minimal). Topics → content lines; the
// loop toggles between the topic index and the selected topic's content
// (Enter in the topic list opens the content view, Enter there returns).

import type { LightPanelRow } from "./light-panel.ts"

export interface TutorialTopic {
  title: string
  /** Content lines shown under the topic (the "article"). */
  content: string[]
}

export const TUTORIAL_TOPICS: TutorialTopic[] = [
  {
    title: "terminal setup",
    content: [
      "I-harness runs in the terminal. A UTF-8 code page (Windows: chcp 65001)",
      "keeps the multibyte glyphs intact (❯ ◆ ⠼ …).",
      "Truecolor/xterm-256color terminals render the theme palette; the",
      "renderer quantizes honestly down to the terminal's (INDEXED) depth.",
    ],
  },
  {
    title: "keys",
    content: [
      "j/k scroll · Tab switches prompt ⇄ scrollback · L/H turns",
      "Ctrl+Q quit · Ctrl+Enter interject · Shift+Tab mode (normal/plan)",
      "Ctrl+S stash/pop the prompt draft (Alt+S same)",
      "F3 session picker · Ctrl+G tasks pane · Ctrl+G (minimal) $EDITOR",
      "Esc empty+≥1 turn = rewind picker (M43)",
    ],
  },
  {
    title: "rewind",
    content: [
      "Esc on an empty prompt (with ≥1 turn) arms; Esc again opens the picker.",
      "Pick a turn → a(conversation+files) b(conversation only) f(files only)",
      "→ y confirm. The M42 service restores files + truncates the journal;",
      "the scrollback shows `Rewound to turn {N}`.",
    ],
  },
  {
    title: "minimal",
    content: [
      "minimal mode hands the terminal's OWN scrollback the history:",
      "print-once content, a pinned tail region + prompt. Enter submits,",
      "Ctrl+Q quits, Ctrl+G edits the prompt in your $EDITOR, /fullscreen",
      "relaunches the same session in the full-screen TUI.",
    ],
  },
]

/** Topic index rows (title; detail = content line count). */
export function tutorialIndexRows(): LightPanelRow[] {
  return TUTORIAL_TOPICS.map((t) => ({ label: t.title, detail: `${t.content.length} lines` }))
}

/** Topic content rows (the plain "article"). */
export function tutorialContentRows(topic: TutorialTopic): LightPanelRow[] {
  return topic.content.map((line) => ({ label: line }))
}
