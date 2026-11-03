// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { InstructionsPane } from '../src/renderer/session/InstructionsPane.tsx'
import { InstructionSettings } from '../src/renderer/settings/InstructionSettings.tsx'
import { useLocale } from '../src/renderer/design/i18n.ts'
import { useUiStore } from '../src/renderer/shell/ui-store.ts'
const root = process.env.IH_CONFIG_DIR?.trim() ?? '', modulePath = process.env.IH_I6_PLAYWRIGHT?.trim() ?? '', executablePath = process.env.IH_I6_BROWSER?.trim() ?? ''
const missing = Object.entries({ IH_CONFIG_DIR: root, IH_I6_PLAYWRIGHT: modulePath, IH_I6_BROWSER: executablePath }).filter(([, value]) => !value).map(([name]) => name)
// This is an optional browser suite. Skip its hooks as well as its tests before
// importing browser tooling or creating a profile; configured failures stay failures.
describe.skipIf(missing.length > 0)(missing.length ? `Optional instruction browser visuals — skipped: missing ${missing.join(', ')}` : 'Optional isolated instruction browser visuals', () => {
const originalLocale = useLocale.getState().locale
let context: any
beforeAll(async () => { const { chromium } = await import(/* @vite-ignore */ pathToFileURL(modulePath).href); context = await chromium.launchPersistentContext(join(root, 'i6-browser-profile'), { executablePath, headless: true }) })
afterAll(async () => { await context?.close(); useLocale.setState({ locale: originalLocale }) })
it('renders light and dark instruction sources at wide and narrow widths without overflow', async () => {
  const bridge = { request: async (input: { kind: string }) => input.kind === 'desktop/instructions/subscribe' ? { subscriptionId: 's', scope: { sessionId: 'p' }, cursor: { epoch: 'e', revision: 1 }, report: { state: 'ready', effectivePolicy: { enabled: true, maxBytes: 24000 }, publication: { fingerprint: 'a'.repeat(64), bytes: 123, sources: [{ path: 'C:/work/project/subfolder/AGENTS.md', kind: 'AGENTS.md', state: 'loaded', bytes: 123 }] } } } : input.kind === 'desktop/instructions/settings' ? { saved: { enabled: true, maxBytes: 24000, globalSources: ['C:/rules/AGENTS.md'] } } : {}, onEvent: () => () => {} }
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../src/renderer')
  const css = ['design/tokens.css', 'vendor/zcode/styles.css', 'session/instructions.css', 'settings/instruction-settings.css'].map(path => readFileSync(join(dir, path), 'utf8')).join('\n')
  const page = await context.newPage()
  for (const locale of ['en', 'zh-TW'] as const) {
    useLocale.setState({ locale }); const rendered = render(<InstructionsPane bridge={bridge as never} workspaceId="w" sessionId="p" />); await screen.findByText('C:/work/project/subfolder/AGENTS.md')
    const markup = rendered.container.innerHTML
    for (const theme of ['light', 'dark']) for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 800 }); await page.setContent(`<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8"><style>${css}</style></head><body>${markup}</body></html>`)
    const metrics = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, body: document.documentElement.scrollWidth, card: !!document.querySelector('.instructions-sources li') }))
    expect(metrics.card).toBe(true); expect(metrics.body).toBeLessThanOrEqual(metrics.viewport)
    await page.screenshot({ path: join(root, `i6-${locale}-${theme}-${width}.png`) })
    }
    rendered.unmount()
    const settings = render(<InstructionSettings bridge={bridge as never} workspaceId="w" />); await screen.findByDisplayValue('24000')
    for (const theme of ['light', 'dark']) for (const width of [320, 1280]) {
      await page.setViewportSize({ width, height: 800 }); await page.setContent(`<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8"><style>${css}</style></head><body>${settings.container.innerHTML}</body></html>`)
      const metrics = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, body: document.documentElement.scrollWidth }))
      expect(metrics.body).toBeLessThanOrEqual(metrics.viewport); await page.screenshot({ path: join(root, `i6-settings-${locale}-${theme}-${width}.png`) })
    }
    settings.unmount()
  }
  await page.close()
}, 20000)

it('keeps the mounted instruction settings visible at narrow and wide widths', async () => {
  const { SettingsPane } = await import('../src/renderer/settings/SettingsPane.tsx')
  useLocale.setState({ locale: 'en' })
  const bridge = { request: async (input: { kind: string }) => input.kind === 'desktop/instructions/settings' ? { saved: { enabled: true, maxBytes: 24000, globalSources: ['C:/rules/AGENTS.md'] } } : {}, onEvent: () => () => {} }
  const rendered = render(<SettingsPane workspace={{ id: 'w', path: 'C:/work', label: 'workspace' }} bridge={bridge as never} capabilities={{ 'desktop-instructions': ['1'] }} onClose={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Execution and permissions' })); await screen.findByRole('heading', { name: 'Instruction settings' }); await screen.findByDisplayValue('24000')
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../src/renderer')
  const css = ['design/tokens.css', 'vendor/zcode/styles.css', 'design/controls.css', 'shell/workbench-tools.css', 'settings/instruction-settings.css'].map(path => readFileSync(join(dir, path), 'utf8')).join('\n')
  const page = await context.newPage()
  for (const theme of ['light', 'dark']) for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 800 }); await page.setContent(`<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8"><style>${css}</style></head><body>${rendered.container.innerHTML}</body></html>`)
    const visible = await page.evaluate(() => { const pane = document.querySelector<HTMLElement>('.instruction-settings'); if (!pane) return false; const box = pane.getBoundingClientRect(); return box.width > 0 && box.left >= -1 && box.right <= innerWidth + 1 })
    expect(visible).toBe(true); await page.screenshot({ path: join(root, `i6-settings-mounted-${theme}-${width}.png`) })
  }
  rendered.unmount(); await page.close()
}, 20000)

it('keeps the mounted workbench instruction pane within light and dark narrow layouts', async () => {
  const { Workbench } = await import('../src/renderer/shell/Workbench.tsx')
  useLocale.setState({ locale: 'en' }); useUiStore.setState({ reviewOpen: false, surface: 'conversation', sidebarCollapsed: true })
  const bridge = { request: async (input: { kind: string }) => input.kind === 'desktop/instructions/subscribe' ? { subscriptionId: 's', scope: { sessionId: 'p' }, cursor: { epoch: 'e', revision: 1 }, report: { state: 'ready', publication: { fingerprint: 'a'.repeat(64), bytes: 123, sources: [{ path: 'C:/work/project/AGENTS.md', kind: 'AGENTS.md', state: 'loaded', bytes: 123 }] } } } : {}, onEvent: () => () => {} }
  const rendered = render(<Workbench projects={[]} bridge={bridge as never} workspaces={[{ id: 'w', path: 'C:/work', label: 'workspace' }]} selectedWorkspaceId="w" selectedSessionId="p" capabilities={{ 'desktop-instructions': ['1'] }} onSelectWorkspace={() => {}} onSelectSession={() => {}} conversation={{ rows: [], canSend: false, running: false, pending: [], onPrompt: async () => {}, onCancel() {}, onCancelTask() {}, onCancelQueue() {}, onReply: async () => {} }} />)
  fireEvent.click(screen.getByRole('button', { name: /workbench tools/i })); fireEvent.click(screen.getByRole('button', { name: 'Instructions' })); await screen.findByText('C:/work/project/AGENTS.md')
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../src/renderer')
  const css = ['design/tokens.css', 'vendor/zcode/styles.css', 'design/controls.css', 'shell/workbench-tools.css', 'session/instructions.css'].map(path => readFileSync(join(dir, path), 'utf8')).join('\n')
  const page = await context.newPage()
  for (const theme of ['light', 'dark']) for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 800 }); await page.setContent(`<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8"><style>${css}</style></head><body>${rendered.container.innerHTML}</body></html>`)
    const visible = await page.evaluate(() => { const pane = document.querySelector<HTMLElement>('.instructions-pane'); if (!pane) return false; const box = pane.getBoundingClientRect(); return box.width > 0 && box.left >= -1 && box.right <= innerWidth + 1 })
    expect(visible).toBe(true); await page.screenshot({ path: join(root, `i6-workbench-${theme}-${width}.png`) })
  }
  rendered.unmount(); await page.close(); useUiStore.setState({ reviewOpen: false, surface: 'conversation', sidebarCollapsed: false })
}, 20000)
})
