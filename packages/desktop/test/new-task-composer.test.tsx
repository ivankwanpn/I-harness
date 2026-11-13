// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { webcrypto } from "node:crypto"
import { Workbench } from "../src/renderer/shell/Workbench.tsx"
import { useUiStore } from "../src/renderer/shell/ui-store.ts"
import type { DraftRequest, DurableDraft, UnsentDraft } from '../src/shared/attachment-drafts.ts'
import { DurableDraftClient } from '../src/renderer/session/durable-draft-client.ts'

function durableDrafts(beforeSave?: (draft: UnsentDraft) => Promise<void>) {
  const records = new Map<string, DurableDraft>()
  let revision = 0, clears = 0, clearAttempts = 0, refuseClear = false
  const key = (scope: DraftRequest['scope']) => JSON.stringify([scope.workspaceId, scope.identity])
  return {
    get clears() { return clears },
    get clearAttempts() { return clearAttempts },
    refuseClear(value: boolean) { refuseClear = value },
    read(workspaceId: string) { return records.get(key({ workspaceId, identity: 'new-task:unassigned' })) },
    async request(input: DraftRequest): Promise<DurableDraft> {
      const id = key(input.scope), previous = records.get(id) ?? { revision: null, draft: null }
      if (input.kind === 'desktop/draft/load') return structuredClone(previous)
      expect(input.expectedRevision).toBe(previous.revision)
      if (input.kind === 'desktop/draft/clear') {
        clearAttempts++
        if (refuseClear) throw Error('Original durable clear refused')
        clears++
      }
      const snapshot = input.kind === 'desktop/draft/save' ? structuredClone(input.draft) : null
      if (snapshot) await beforeSave?.(snapshot)
      const next = { revision: String(++revision), draft: snapshot }
      records.set(id, next)
      return structuredClone(next)
    },
  }
}

afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); useUiStore.setState({ surface: "conversation", reviewOpen: false, locale: "zh-TW" }) })
it("offers image attachments only for the selected model's declared image input", async () => {
  const request = vi.fn(async (input: any) => {
    if (input.kind === "desktop/provider/directory") return [{ id: "fixture", displayName: "Fixture", configured: true, models: [{ id: "text-model", inputModalities: ["text"] }, { id: "vision-model", inputModalities: ["text", "image"] }] }]
    if (input.kind === "workspace/attachments/pick") return { paths: [], images: [], texts: [] }
  })
  render(<Workbench bridge={{ request, onEvent: () => () => {} }} workspaces={[{ id: "modality-draft", label: "Fixture", path: "D:/fixture" }]} selectedWorkspaceId="modality-draft"
    capabilities={{ "session-create": ["1"], "desktop-draft-create": ["1"], "desktop-input": ["1"], "prompt-context": ["1"], "prompt-images": ["1"] }} onSelectWorkspace={() => {}} onSelectSession={() => {}} />)
  fireEvent.click(screen.getByRole("button", { name: "選擇模型" }))
  fireEvent.click(await screen.findByRole("button", { name: "text-model" }))
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "選擇模型" })).toBeNull())
  fireEvent.click(screen.getByRole("button", { name: "新增附件" }))
  await waitFor(() => expect(request).toHaveBeenCalledWith({ kind: "workspace/attachments/pick", workspaceId: "modality-draft", allowImages: false }))
  fireEvent.click(screen.getByRole("button", { name: "text-model" }))
  fireEvent.click(await screen.findByRole("button", { name: "vision-model" }))
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "選擇模型" })).toBeNull())
  fireEvent.click(screen.getByRole("button", { name: "新增附件" }))
  await waitFor(() => expect(request).toHaveBeenLastCalledWith({ kind: "workspace/attachments/pick", workspaceId: "modality-draft", allowImages: true }))
  expect(request.mock.calls.some(([input]) => input.kind === "session/create")).toBe(false)
})

it.each(['success', 'newer', 'equal', 'clear-failure'] as const)('keeps the admitted new-task draft lifecycle distinct from submission metadata: %s', async mode => {
  vi.stubGlobal('crypto', webcrypto)
  const workspaceId = `durable-new-task-${mode}`
  const drafts = durableDrafts()
  const release = Promise.withResolvers<void>()
  const selected = vi.fn()
  const acknowledgements = new Map<string, string>()
  let acceptedEffects = 0
  drafts.refuseClear(mode === 'clear-failure')
  const request = vi.fn(async (input: any) => {
    if (input.kind.startsWith('desktop/draft/')) return drafts.request(input)
    if (input.kind === 'desktop/provider/directory') return [{ id: 'fixture', displayName: 'Fixture', configured: true, models: [{ id: 'draft-model' }] }]
    if (input.kind === 'session/create') return { sessionId: `admitted-${mode}` }
    if (input.kind === 'desktop/session/input/submit') {
      await release.promise
      const key = JSON.stringify([input.sessionId, input.clientToken]), payload = JSON.stringify(input)
      if (acknowledgements.has(key)) expect(acknowledgements.get(key)).toBe(payload)
      else { acknowledgements.set(key, payload); acceptedEffects++ }
      return { admitted: true }
    }
  })
  const props = {
    bridge: { request, onEvent: () => () => {} },
    workspaces: [{ id: workspaceId, label: 'Fixture', path: 'D:/fixture' }],
    selectedWorkspaceId: workspaceId,
    capabilities: { 'session-create': ['1'], 'desktop-draft-create': ['1'], 'desktop-drafts': ['1'], 'desktop-input': ['1'] },
    onSelectWorkspace: () => {}, onSelectSession: selected,
  }
  let mounted = render(<Workbench {...props} />)
  try {
    fireEvent.change(screen.getByRole('textbox', { name: '提示' }), { target: { value: 'original accepted text' } })
    fireEvent.click(screen.getByRole('button', { name: '選擇模型' }))
    fireEvent.click(await screen.findByRole('button', { name: 'draft-model' }))
    await waitFor(() => expect((screen.getByRole('button', { name: '送出' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: '送出' }))
    await waitFor(() => expect(request.mock.calls.some(([input]) => input.kind === 'desktop/session/input/submit')).toBe(true))
    const nextText = mode === 'newer' ? 'genuinely newer draft' : 'original accepted text'
    if (mode === 'newer' || mode === 'equal') {
      fireEvent.change(screen.getByRole('textbox', { name: '提示' }), { target: { value: nextText } })
    }
    await act(async () => release.resolve())
    if (mode !== 'clear-failure') await waitFor(() => expect(selected).toHaveBeenCalledWith(`admitted-${mode}`))
    if (mode === 'success') {
      await waitFor(() => expect(drafts.clears).toBe(1))
      await waitFor(() => expect(drafts.read(workspaceId)?.draft?.prompt).toBe(''))
    } else if (mode === 'clear-failure') {
      await waitFor(() => expect(drafts.clearAttempts).toBe(1))
      await waitFor(() => expect(screen.queryAllByText(/Original durable clear refused/).length).toBeGreaterThan(0))
      expect(drafts.clears).toBe(0)
      expect(selected).not.toHaveBeenCalled()
      const association = JSON.parse(drafts.read(workspaceId)!.draft!.metadata!)
      expect(association).toMatchObject({ createdId: `admitted-${mode}`, selection: { provider: 'fixture', model: 'draft-model' } })
      for (const field of ['creationToken', 'token', 'payload', 'appliedModel']) expect(typeof association[field]).toBe('string')
    } else {
      expect(drafts.clearAttempts).toBe(0)
    }
    await waitFor(() => expect(drafts.read(workspaceId)?.draft?.prompt).toBe(mode === 'success' ? '' : nextText))
    mounted.unmount()
    mounted = render(<Workbench {...props} />)
    await waitFor(() => expect((screen.getByRole('textbox', { name: '提示' }) as HTMLTextAreaElement).value).toBe(mode === 'success' ? '' : nextText))
    expect(screen.getByRole('button', { name: /draft-model/ })).toBeTruthy()
    expect(request.mock.calls.filter(([input]) => input.kind === 'session/create')).toHaveLength(1)
    expect(request.mock.calls.filter(([input]) => input.kind === 'desktop/session/input/submit')).toHaveLength(1)
    if (mode === 'clear-failure') {
      drafts.refuseClear(false)
      await waitFor(() => expect((screen.getByRole('button', { name: '送出' }) as HTMLButtonElement).disabled).toBe(false))
      fireEvent.click(screen.getByRole('button', { name: '送出' }))
      await waitFor(() => expect(selected).toHaveBeenCalledWith(`admitted-${mode}`))
      await waitFor(() => expect(drafts.clears).toBe(1))
      await waitFor(() => expect(drafts.read(workspaceId)?.draft?.prompt).toBe(''))
      const attempts = request.mock.calls.filter(([input]) => input.kind === 'desktop/session/input/submit').map(([input]) => input)
      expect(attempts).toHaveLength(2)
      expect(attempts[1]).toEqual(attempts[0])
      expect(request.mock.calls.filter(([input]) => input.kind === 'session/create')).toHaveLength(1)
      expect(request.mock.calls.filter(([input]) => input.kind === 'session/model/set')).toHaveLength(1)
      await waitFor(() => expect(JSON.parse(drafts.read(workspaceId)!.draft!.metadata!)).toEqual({ selection: { provider: 'fixture', model: 'draft-model' } }))
    }
    expect(acceptedEffects).toBe(1)
  } finally { release.resolve(); mounted.unmount() }
})

it('consumes the admitted session association in the first empty durable save before a cold draft restore', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const workspaceId = 'cold-consumed-new-task'
  const input = Promise.withResolvers<void>(), saved = Promise.withResolvers<void>(), finishSave = Promise.withResolvers<void>()
  let armed = false, emptySnapshot: UnsentDraft | undefined
  const premature = Promise.withResolvers<never>()
  void premature.promise.catch(() => {})
  const selected = vi.fn(() => { if (!emptySnapshot) premature.reject(Error('Admission navigated before the original empty save')) })
  const drafts = durableDrafts(async draft => {
    if (!armed || draft.prompt !== '' || emptySnapshot) return
    emptySnapshot = draft
    saved.resolve()
    await finishSave.promise
  })
  const request = vi.fn(async (value: any) => {
    if (value.kind.startsWith('desktop/draft/')) return drafts.request(value)
    if (value.kind === 'desktop/provider/directory') return [{ id: 'fixture', displayName: 'Fixture', configured: true, models: [{ id: 'cold-model' }] }]
    if (value.kind === 'session/create') return { sessionId: 'original-cold-session' }
    if (value.kind === 'desktop/session/input/submit') { await input.promise; return { admitted: true } }
  })
  const mounted = render(<Workbench bridge={{ request, onEvent: () => () => {} }}
    workspaces={[{ id: workspaceId, label: 'Fixture', path: 'D:/fixture' }]} selectedWorkspaceId={workspaceId}
    capabilities={{ 'session-create': ['1'], 'desktop-draft-create': ['1'], 'desktop-drafts': ['1'], 'desktop-input': ['1'] }}
    onSelectWorkspace={() => {}} onSelectSession={selected} />)
  try {
    fireEvent.change(screen.getByRole('textbox', { name: '提示' }), { target: { value: 'accepted once' } })
    fireEvent.click(screen.getByRole('button', { name: '選擇模型' }))
    fireEvent.click(await screen.findByRole('button', { name: 'cold-model' }))
    await waitFor(() => expect((screen.getByRole('button', { name: '送出' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: '送出' }))
    await waitFor(() => expect(request.mock.calls.some(([value]) => value.kind === 'desktop/session/input/submit')).toBe(true))
    armed = true
    await act(async () => input.resolve())
    await Promise.race([saved.promise, premature.promise])
    expect(JSON.parse(emptySnapshot!.metadata!)).toEqual({ selection: { provider: 'fixture', model: 'cold-model' } })
    expect(drafts.clears).toBe(1)
    expect(drafts.read(workspaceId)?.draft).toBeNull()
    expect(selected).not.toHaveBeenCalled()
    await act(async () => finishSave.resolve())
    await waitFor(() => expect(selected).toHaveBeenCalledWith('original-cold-session'))
    mounted.unmount()
    let restored: UnsentDraft = { prompt: '', references: [], images: [], texts: [], contextRefs: [] }
    const cold = new DurableDraftClient({ workspaceId, identity: 'new-task:unassigned' }, drafts.request,
      () => restored, value => { restored = value }, () => {})
    await cold.restore()
    expect(restored.prompt).toBe('')
    expect(JSON.parse(restored.metadata!)).toEqual({ selection: { provider: 'fixture', model: 'cold-model' } })
    restored = { ...restored, prompt: 'a genuinely new conversation' }
    cold.changed(); await cold.flush()
    expect(JSON.parse(drafts.read(workspaceId)!.draft!.metadata!)).not.toHaveProperty('createdId')
    expect(JSON.parse(drafts.read(workspaceId)!.draft!.metadata!)).not.toHaveProperty('token')
  } finally { await act(async () => { input.resolve(); finishSave.resolve() }); mounted.unmount() }
})

it.each([false, true])('keeps the second submission association when an earlier acknowledgement settles during it (remount=%s)', async remountBeforeAck => {
  vi.stubGlobal('crypto', webcrypto)
  const workspaceId = `overlapping-durable-new-task-${remountBeforeAck}`
  const drafts = durableDrafts()
  const first = Promise.withResolvers<void>(), second = Promise.withResolvers<void>()
  const selected = vi.fn(), effects = new Map<string, number>()
  let secondAttempts = 0
  const request = vi.fn(async (input: any) => {
    if (input.kind.startsWith('desktop/draft/')) return drafts.request(input)
    if (input.kind === 'desktop/provider/directory') return [{ id: 'fixture', displayName: 'Fixture', configured: true, models: [{ id: 'overlap-model' }, { id: 'later-overlap-model' }] }]
    if (input.kind === 'session/create') return { sessionId: 'original-overlap-session' }
    if (input.kind === 'desktop/session/input/submit') {
      if (input.text === 'first accepted input') await first.promise
      else if (++secondAttempts === 1) { await second.promise; throw Error('Second input not accepted') }
      if (!effects.has(input.clientToken)) effects.set(input.clientToken, 1)
      return { admitted: true }
    }
  })
  const props = {
    bridge: { request, onEvent: () => () => {} },
    workspaces: [{ id: workspaceId, label: 'Fixture', path: 'D:/fixture' }], selectedWorkspaceId: workspaceId,
    capabilities: { 'session-create': ['1'], 'desktop-draft-create': ['1'], 'desktop-drafts': ['1'], 'desktop-input': ['1'] },
    onSelectWorkspace: () => {}, onSelectSession: selected,
  }
  let mounted = render(<Workbench {...props} />)
  const submissions = () => request.mock.calls.filter(([input]) => input.kind === 'desktop/session/input/submit').map(([input]) => input)
  try {
    fireEvent.change(screen.getByRole('textbox', { name: '提示' }), { target: { value: 'first accepted input' } })
    fireEvent.click(screen.getByRole('button', { name: '選擇模型' }))
    fireEvent.click(await screen.findByRole('button', { name: 'overlap-model' }))
    await waitFor(() => expect((screen.getByRole('button', { name: '送出' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: '送出' }))
    await waitFor(() => expect(submissions()).toHaveLength(1))
    if (remountBeforeAck) {
      mounted.unmount()
      mounted = render(<Workbench {...props} />)
      await waitFor(() => expect((screen.getByRole('textbox', { name: '提示' }) as HTMLTextAreaElement).value).toBe('first accepted input'))
      fireEvent.click(screen.getByRole('button', { name: 'overlap-model' }))
      fireEvent.click(await screen.findByRole('button', { name: 'later-overlap-model' }))
    }
    fireEvent.change(screen.getByRole('textbox', { name: '提示' }), { target: { value: 'second pending input' } })
    await waitFor(() => expect((screen.getByRole('button', { name: '送出' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: '送出' }))
    await waitFor(() => expect(submissions()).toHaveLength(2))
    expect(submissions()[1].clientToken).not.toBe(submissions()[0].clientToken)
    await act(async () => first.resolve())
    await waitFor(() => expect(selected).toHaveBeenCalledTimes(1))
    await act(async () => second.resolve())
    await waitFor(() => expect((screen.getByRole('button', { name: '送出' }) as HTMLButtonElement).disabled).toBe(false))
    await waitFor(() => expect(JSON.parse(drafts.read(workspaceId)!.draft!.metadata!).token).toBe(submissions()[1].clientToken))
    expect(JSON.parse(drafts.read(workspaceId)!.draft!.metadata!).selection.model).toBe(remountBeforeAck ? 'later-overlap-model' : 'overlap-model')
    expect(drafts.read(workspaceId)?.draft?.prompt).toBe('second pending input')
    expect(drafts.clearAttempts).toBe(0)
    mounted.unmount()
    mounted = render(<Workbench {...props} />)
    await waitFor(() => expect((screen.getByRole('textbox', { name: '提示' }) as HTMLTextAreaElement).value).toBe('second pending input'))
    await waitFor(() => expect((screen.getByRole('button', { name: '送出' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: '送出' }))
    await waitFor(() => expect(submissions()).toHaveLength(3))
    await waitFor(() => expect(selected).toHaveBeenCalledTimes(2))
    expect(submissions()[2]).toEqual(submissions()[1])
    expect(request.mock.calls.filter(([input]) => input.kind === 'session/create')).toHaveLength(1)
    expect(effects.size).toBe(2)
    expect(drafts.clears).toBe(1)
  } finally { await act(async () => { first.resolve(); second.resolve() }); mounted.unmount() }
})

it("keeps model, effort, text and attachment as a draft until submit; failed admission retries the same session and token", async () => {
  vi.stubGlobal("crypto", webcrypto)
  let attempt = 0
  const drafts = durableDrafts()
  const request = vi.fn(async (input: any) => {
    if (input.kind.startsWith('desktop/draft/')) return drafts.request(input)
    if (input.kind === "desktop/provider/directory") return [{ id: "fixture", displayName: "Fixture", configured: true, models: [{ id: "offline-model" }] }]
    if (input.kind === "workspace/attachments/pick") return { paths: [], images: [], texts: [{ name: "notes.txt", text: "bounded fixture" }] }
    if (input.kind === "session/create") return { sessionId: "new-session" }
    if (input.kind === "desktop/session/input/submit") { if (++attempt === 1) throw new Error("admission unavailable"); return { admitted: true } }
  })
  const selected = vi.fn()
  render(<Workbench bridge={{ request, onEvent: () => () => {} }} workspaces={[{ id: "draft-root", label: "Fixture", path: "D:/fixture" }]} selectedWorkspaceId="draft-root"
    capabilities={{ "session-create": ["1"], "desktop-draft-create": ["1"], "desktop-drafts": ["1"], "desktop-input": ["1"], "prompt-context": ["1"], "desktop-review": ["1"] }} onSelectWorkspace={() => {}} onSelectSession={selected} />)
  fireEvent.change(screen.getByRole("textbox", { name: "提示" }), { target: { value: "Keep complete draft" } })
  expect(request.mock.calls.filter(([input]) => input.kind === "session/create")).toHaveLength(0)
  fireEvent.click(screen.getByRole("button", { name: "選擇模型" }))
  fireEvent.click(await screen.findByRole("button", { name: "offline-model" }))
  await waitFor(() => expect((screen.getByRole("button", { name: "思考強度：Default" }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole("button", { name: "思考強度：Default" }))
  fireEvent.click(screen.getByRole("button", { name: "High" }))
  fireEvent.click(screen.getByRole("button", { name: "新增附件" }))
  await screen.findByText("notes.txt")
  expect(request.mock.calls.filter(([input]) => input.kind === "session/create")).toHaveLength(0)
  fireEvent.click(screen.getByRole("button", { name: "送出" }))
  await waitFor(() => expect((screen.getByRole("button", { name: "送出" }) as HTMLButtonElement).disabled).toBe(false))
  expect(screen.queryByText("admission unavailable")).toBeNull()
  expect((screen.getByRole("textbox", { name: "提示" }) as HTMLTextAreaElement).value).toBe("Keep complete draft")
  expect(screen.getByText("notes.txt")).toBeTruthy()
  expect(selected).not.toHaveBeenCalled()
  expect(drafts.read('draft-root')?.draft?.prompt).toBe('Keep complete draft')
  fireEvent.click(screen.getByRole("button", { name: "送出" }))
  await waitFor(() => expect(selected).toHaveBeenCalledWith("new-session"))
  expect(request.mock.calls.filter(([input]) => input.kind === "session/create")).toHaveLength(1)
  const admissions = request.mock.calls.filter(([input]) => input.kind === "desktop/session/input/submit").map(([input]) => input)
  expect(admissions).toHaveLength(2)
  expect(admissions[0].clientToken).toBe(admissions[1].clientToken)
  expect(admissions[1].context).toContain("bounded fixture")
  expect(request).toHaveBeenCalledWith({ kind: "session/model/set", workspaceId: "draft-root", sessionId: "new-session", selection: { provider: "fixture", model: "offline-model", reasoningEffort: "high" } })
  await waitFor(() => expect(drafts.clears).toBe(1))
  await waitFor(() => expect(drafts.read('draft-root')?.draft).toMatchObject({ prompt: '', texts: [] }))
})

it.each(["creation", "model"])("retains a newer model and reasoning draft after a delayed %s response and admission failure", async (stage) => {
  vi.stubGlobal("crypto", webcrypto)
  let release!: () => void
  const deferred = new Promise<void>((resolve) => { release = resolve })
  let first = true
  const drafts = durableDrafts()
  const request = vi.fn(async (input: any) => {
    if (input.kind.startsWith('desktop/draft/')) return drafts.request(input)
    if (input.kind === "desktop/provider/directory") return [{ id: "fixture", displayName: "Fixture", configured: true, models: [{ id: "model-a" }, { id: "model-b" }] }]
    if (input.kind === "session/create") { if (stage === "creation") await deferred; return { sessionId: `delayed-${stage}` } }
    if (input.kind === "session/model/set" && stage === "model" && first) { first = false; await deferred }
    if (input.kind === "desktop/session/input/submit") throw new Error("retain model draft")
  })
  render(<Workbench bridge={{ request, onEvent: () => () => {} }} workspaces={[{ id: `draft-${stage}`, label: "Fixture", path: "D:/fixture" }]} selectedWorkspaceId={`draft-${stage}`}
    capabilities={{ "session-create": ["1"], "desktop-draft-create": ["1"], "desktop-drafts": ["1"], "desktop-input": ["1"] }} onSelectWorkspace={() => {}} onSelectSession={() => {}} />)
  fireEvent.change(screen.getByRole("textbox", { name: "提示" }), { target: { value: "Keep later selection" } })
  fireEvent.click(screen.getByRole("button", { name: "選擇模型" }))
  fireEvent.click(await screen.findByRole("button", { name: "model-a" }))
  await waitFor(() => expect((screen.getByRole("button", { name: "思考強度：Default" }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole("button", { name: "送出" }))
  await waitFor(() => expect(request.mock.calls.some(([input]) => input.kind === (stage === "creation" ? "session/create" : "session/model/set"))).toBe(true))
  fireEvent.click(screen.getByRole("button", { name: /model-a/ }))
  fireEvent.click(await screen.findByRole("button", { name: "model-b" }))
  await waitFor(() => expect((screen.getByRole("button", { name: "思考強度：Default" }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole("button", { name: "思考強度：Default" }))
  fireEvent.click(screen.getByRole("button", { name: "High" }))
  await waitFor(() => expect((screen.getByRole("button", { name: "思考強度：High" }) as HTMLButtonElement).disabled).toBe(false))
  await act(async () => release())
  await waitFor(() => expect((screen.getByRole("button", { name: "送出" }) as HTMLButtonElement).disabled).toBe(false))
  expect(screen.queryByText("retain model draft")).toBeNull()
  expect(screen.getByRole("button", { name: /model-b/ })).toBeTruthy()
  expect(screen.getByRole("button", { name: "思考強度：High" })).toBeTruthy()
  expect((screen.getByRole("textbox", { name: "提示" }) as HTMLTextAreaElement).value).toBe("Keep later selection")
  fireEvent.click(screen.getByRole("button", { name: "送出" }))
  await waitFor(() => expect(request).toHaveBeenCalledWith({ kind: "session/model/set", workspaceId: `draft-${stage}`, sessionId: `delayed-${stage}`, selection: { provider: "fixture", model: "model-b", reasoningEffort: "high" } }))
  expect(request.mock.calls.filter(([input]) => input.kind === "session/create")).toHaveLength(1)
})
