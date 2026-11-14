// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { webcrypto } from "node:crypto"
import { Workbench } from "../src/renderer/shell/Workbench.tsx"
import { useUiStore } from "../src/renderer/shell/ui-store.ts"
import type { DraftRequest, DurableDraft, UnsentDraft } from '../src/shared/attachment-drafts.ts'
import { DurableDraftClient } from '../src/renderer/session/durable-draft-client.ts'
import { Composer, draftKey } from '../src/renderer/session/Composer.tsx'

function durableDrafts(beforeSave?: (draft: UnsentDraft) => Promise<void>) {
  const records = new Map<string, DurableDraft>()
  let revision = 0, clears = 0, clearAttempts = 0, refuseClear = false
  const key = (scope: DraftRequest['scope']) => JSON.stringify([scope.workspaceId, scope.identity])
  return {
    get clears() { return clears },
    get clearAttempts() { return clearAttempts },
    refuseClear(value: boolean) { refuseClear = value },
    read(workspaceId: string, identity = 'new-task:unassigned') { return records.get(key({ workspaceId, identity })) },
    seed(workspaceId: string, draft: UnsentDraft) {
      records.set(key({ workspaceId, identity: 'new-task:unassigned' }), { revision: String(++revision), draft: structuredClone(draft) })
    },
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

it('persists accepted cleanup through an existing cached client when the remounted composer has no draft requester', async () => {
  const workspaceId = 'cached-draft-client', sessionId = 'original-session', drafts = durableDrafts()
  const props = { workspaceId, sessionId, canSend: true, running: false, onPrompt: async () => {}, onCancel: () => {} }
  let mounted = render(<Composer {...props} draftRequest={drafts.request} />)
  try {
    fireEvent.change(screen.getByRole('textbox', { name: '提示' }), { target: { value: 'original cached payload' } })
    await waitFor(() => expect(drafts.read(workspaceId, sessionId)?.draft?.prompt).toBe('original cached payload'))
    mounted.unmount()
    mounted = render(<Composer {...props} />)
    expect((screen.getByRole('textbox', { name: '提示' }) as HTMLTextAreaElement).value).toBe('original cached payload')
    fireEvent.click(screen.getByRole('button', { name: '送出' }))
    await waitFor(() => expect((screen.getByRole('textbox', { name: '提示' }) as HTMLTextAreaElement).value).toBe(''))
    await waitFor(() => expect(drafts.read(workspaceId, sessionId)?.draft?.prompt).toBe(''))
  } finally { mounted.unmount() }
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

it.each([
  { remountBeforeAck: false, equal: false }, { remountBeforeAck: true, equal: false },
  { remountBeforeAck: false, equal: true }, { remountBeforeAck: true, equal: true },
])('keeps the second submission association across the first acknowledgement (remount=$remountBeforeAck, equal=$equal)', async ({ remountBeforeAck, equal }) => {
  vi.stubGlobal('crypto', webcrypto)
  const workspaceId = `overlapping-durable-new-task-${remountBeforeAck}-${equal}`
  const drafts = durableDrafts()
  const first = Promise.withResolvers<void>(), second = Promise.withResolvers<void>()
  const selected = vi.fn(), effects = new Map<string, number>()
  let secondAttempts = 0, firstToken: string | undefined
  const request = vi.fn(async (input: any) => {
    if (input.kind.startsWith('desktop/draft/')) return drafts.request(input)
    if (input.kind === 'desktop/provider/directory') return [{ id: 'fixture', displayName: 'Fixture', configured: true, models: [{ id: 'overlap-model' }, { id: 'later-overlap-model' }] }]
    if (input.kind === 'session/create') return { sessionId: 'original-overlap-session' }
    if (input.kind === 'desktop/session/input/submit') {
      firstToken ??= input.clientToken
      if (input.clientToken === firstToken) await first.promise
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
      if (!equal) {
        fireEvent.click(screen.getByRole('button', { name: 'overlap-model' }))
        fireEvent.click(await screen.findByRole('button', { name: 'later-overlap-model' }))
      }
    }
    const secondText = equal ? 'first accepted input' : 'second pending input'
    if (equal && remountBeforeAck) fireEvent.change(screen.getByRole('textbox', { name: '提示' }), { target: { value: '' } })
    fireEvent.change(screen.getByRole('textbox', { name: '提示' }), { target: { value: secondText } })
    await waitFor(() => expect((screen.getByRole('button', { name: '送出' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: '送出' }))
    await waitFor(() => expect(submissions()).toHaveLength(2))
    expect(submissions()[1].clientToken).not.toBe(submissions()[0].clientToken)
    if (equal) expect(submissions()[1]).toEqual({ ...submissions()[0], clientToken: submissions()[1].clientToken })
    await act(async () => first.resolve())
    await waitFor(() => expect(selected).toHaveBeenCalledTimes(1))
    await act(async () => second.resolve())
    await waitFor(() => expect((screen.getByRole('button', { name: '送出' }) as HTMLButtonElement).disabled).toBe(false))
    await waitFor(() => expect(JSON.parse(drafts.read(workspaceId)!.draft!.metadata!).token).toBe(submissions()[1].clientToken))
    expect(JSON.parse(drafts.read(workspaceId)!.draft!.metadata!).selection.model).toBe(remountBeforeAck && !equal ? 'later-overlap-model' : 'overlap-model')
    expect(drafts.read(workspaceId)?.draft?.prompt).toBe(secondText)
    expect(drafts.clearAttempts).toBe(0)
    mounted.unmount()
    mounted = render(<Workbench {...props} />)
    await waitFor(() => expect((screen.getByRole('textbox', { name: '提示' }) as HTMLTextAreaElement).value).toBe(secondText))
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

it.each(['creation', 'model', 'hash'] as const)('retains a newer model and reasoning draft after a delayed %s response and admission failure', async stage => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let first = true
  if (stage === 'hash') {
    vi.stubGlobal('crypto', {
      randomUUID: () => webcrypto.randomUUID(),
      subtle: { async digest(...args: Parameters<typeof webcrypto.subtle.digest>) {
        const result = await webcrypto.subtle.digest(...args)
        if (first) { first = false; entered.resolve(); await release.promise }
        return result
      } },
    })
  } else vi.stubGlobal('crypto', webcrypto)
  const drafts = durableDrafts(), creations = new Map<string, string>()
  const request = vi.fn(async (input: any) => {
    if (input.kind.startsWith('desktop/draft/')) return drafts.request(input)
    if (input.kind === 'desktop/provider/directory') return [{ id: 'fixture', displayName: 'Fixture', configured: true, models: [{ id: 'model-a' }, { id: 'model-b' }] }]
    if (input.kind === 'session/create') {
      if (stage === 'creation') { entered.resolve(); await release.promise }
      if (!creations.has(input.clientToken)) creations.set(input.clientToken, `delayed-${stage}`)
      return { sessionId: creations.get(input.clientToken) }
    }
    if (input.kind === 'session/model/set' && stage === 'model' && first) { first = false; entered.resolve(); await release.promise }
    if (input.kind === 'desktop/session/input/submit') throw Error('retain model draft')
  })
  const mounted = render(<Workbench bridge={{ request, onEvent: () => () => {} }} workspaces={[{ id: `draft-${stage}`, label: 'Fixture', path: 'D:/fixture' }]} selectedWorkspaceId={`draft-${stage}`}
    capabilities={{ 'session-create': ['1'], 'desktop-draft-create': ['1'], 'desktop-drafts': ['1'], 'desktop-input': ['1'] }} onSelectWorkspace={() => {}} onSelectSession={() => {}} />)
  try {
    fireEvent.change(screen.getByRole('textbox', { name: '提示' }), { target: { value: 'Keep later selection' } })
    fireEvent.click(screen.getByRole('button', { name: '選擇模型' }))
    fireEvent.click(await screen.findByRole('button', { name: 'model-a' }))
    await waitFor(() => expect((screen.getByRole('button', { name: '思考強度：Default' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: '送出' }))
    await entered.promise
    fireEvent.click(screen.getByRole('button', { name: /model-a/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'model-b' }))
    await waitFor(() => expect((screen.getByRole('button', { name: '思考強度：Default' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: '思考強度：Default' }))
    fireEvent.click(screen.getByRole('button', { name: 'High' }))
    await waitFor(() => expect((screen.getByRole('button', { name: '思考強度：High' }) as HTMLButtonElement).disabled).toBe(false))
    await act(async () => release.resolve())
    await waitFor(() => expect(request.mock.calls.filter(([input]) => input.kind === 'desktop/session/input/submit')).toHaveLength(1))
    await waitFor(() => expect((screen.getByRole('button', { name: '送出' }) as HTMLButtonElement).disabled).toBe(false))
    expect(screen.queryByText('retain model draft')).toBeNull()
    expect(screen.getByRole('button', { name: /model-b/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: '思考強度：High' })).toBeTruthy()
    expect((screen.getByRole('textbox', { name: '提示' }) as HTMLTextAreaElement).value).toBe('Keep later selection')
    const liveMetadata = JSON.parse(localStorage.getItem(`${draftKey(`draft-${stage}`, 'new-task:unassigned')}:submission`)!)
    expect(liveMetadata.token).toBeUndefined()
    fireEvent.click(screen.getByRole('button', { name: '送出' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith({ kind: 'session/model/set', workspaceId: `draft-${stage}`, sessionId: `delayed-${stage}`, selection: { provider: 'fixture', model: 'model-b', reasoningEffort: 'high' } }))
    const creationCalls = request.mock.calls.filter(([input]) => input.kind === 'session/create').map(([input]) => input)
    expect(creationCalls).toHaveLength(stage === 'model' ? 1 : 2)
    expect(new Set(creationCalls.map(input => input.clientToken)).size).toBe(1)
    expect(creations.size).toBe(1)
    await waitFor(() => expect(request.mock.calls.filter(([input]) => input.kind === 'desktop/session/input/submit')).toHaveLength(2))
    const inputs = request.mock.calls.filter(([input]) => input.kind === 'desktop/session/input/submit').map(([input]) => input)
    expect(inputs[1].clientToken).not.toBe(inputs[0].clientToken)
  } finally { await act(async () => release.resolve()); mounted.unmount() }
})

it('binds the send before its first draft-save await and retires its session only for a newer unsent draft', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const workspaceId = 'early-intent-capture'
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let armed = false, original: UnsentDraft | undefined
  const drafts = durableDrafts(async draft => {
    if (!armed || original) return
    original = draft; entered.resolve(); await release.promise
  })
  const selected = vi.fn(), sessions = new Map<string, string>()
  const request = vi.fn(async (input: any) => {
    if (input.kind.startsWith('desktop/draft/')) return drafts.request(input)
    if (input.kind === 'desktop/provider/directory') return [{ id: 'fixture', displayName: 'Fixture', configured: true, models: [{ id: 'early-model' }] }]
    if (input.kind === 'session/create') {
      if (!sessions.has(input.clientToken)) sessions.set(input.clientToken, `created-${sessions.size + 1}`)
      return { sessionId: sessions.get(input.clientToken) }
    }
    if (input.kind === 'desktop/session/input/submit') return { admitted: true }
  })
  const mounted = render(<Workbench bridge={{ request, onEvent: () => () => {} }} workspaces={[{ id: workspaceId, label: 'Fixture', path: 'D:/fixture' }]} selectedWorkspaceId={workspaceId}
    capabilities={{ 'session-create': ['1'], 'desktop-draft-create': ['1'], 'desktop-drafts': ['1'], 'desktop-input': ['1'] }} onSelectWorkspace={() => {}} onSelectSession={selected} />)
  try {
    fireEvent.click(screen.getByRole('button', { name: '選擇模型' }))
    fireEvent.click(await screen.findByRole('button', { name: 'early-model' }))
    await waitFor(() => expect((screen.getByRole('button', { name: '思考強度：Default' }) as HTMLButtonElement).disabled).toBe(false))
    armed = true
    fireEvent.change(screen.getByRole('textbox', { name: '提示' }), { target: { value: 'original captured send' } })
    fireEvent.click(screen.getByRole('button', { name: '送出' }))
    await entered.promise
    const firstOwner = JSON.parse(original!.metadata!)
    expect(typeof firstOwner.token).toBe('string')
    expect(typeof firstOwner.creationToken).toBe('string')
    expect(request.mock.calls.filter(([input]) => input.kind === 'session/create')).toHaveLength(0)
    fireEvent.change(screen.getByRole('textbox', { name: '提示' }), { target: { value: 'newer but not sent yet' } })
    await act(async () => release.resolve())
    await waitFor(() => expect(selected).toHaveBeenCalledWith('created-1'))
    const inputs = () => request.mock.calls.filter(([input]) => input.kind === 'desktop/session/input/submit').map(([input]) => input)
    expect(inputs()[0]).toMatchObject({ text: 'original captured send', clientToken: firstOwner.token })
    await waitFor(() => expect(drafts.read(workspaceId)?.draft?.prompt).toBe('newer but not sent yet'))
    expect(JSON.parse(drafts.read(workspaceId)!.draft!.metadata!)).toEqual({ selection: { provider: 'fixture', model: 'early-model' } })
    await waitFor(() => expect((screen.getByRole('button', { name: '送出' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: '送出' }))
    await waitFor(() => expect(selected).toHaveBeenCalledWith('created-2'))
    expect(inputs()).toHaveLength(2)
    expect(inputs()[1].clientToken).not.toBe(firstOwner.token)
    expect(sessions.size).toBe(2)
  } finally { await act(async () => release.resolve()); mounted.unmount() }
})

it.each([false, true])('keeps a cold same-intent token and lets the original payload conflict refuse changed context (changed=%s)', async changedContext => {
  vi.stubGlobal('crypto', webcrypto)
  const workspaceId = `cold-intent-retry-${changedContext}`, drafts = durableDrafts()
  const selection = { provider: 'fixture', model: 'cold-intent-model' }
  const contextRefs: UnsentDraft['contextRefs'] = changedContext ? [{ kind: 'file', workspaceId, path: 'notes.txt', label: 'notes.txt' }] : []
  const token = webcrypto.randomUUID(), creationToken = webcrypto.randomUUID()
  const fingerprint = JSON.stringify({ text: 'original saved input', selection, files: [], references: changedContext ? JSON.stringify(contextRefs) : undefined, texts: [], images: undefined })
  const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(fingerprint))
  const payload = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  drafts.seed(workspaceId, {
    prompt: 'original saved input', references: [], images: [], texts: [], contextRefs,
    metadata: JSON.stringify({ selection, createdId: 'original-cold-intent', creationToken, token, payload, appliedModel: JSON.stringify(selection) }),
  })
  const selected = vi.fn()
  let acceptedEffects = 1
  const request = vi.fn(async (input: any) => {
    if (input.kind.startsWith('desktop/draft/')) return drafts.request(input)
    if (input.kind === 'desktop/provider/directory') return [{ id: 'fixture', displayName: 'Fixture', configured: true, models: [{ id: 'cold-intent-model' }] }]
    if (input.kind === 'desktop/context/read') return { text: 'changed external context', truncated: false }
    if (input.kind === 'session/create' || input.kind === 'session/model/set') throw Error('Cold retry must retain the original session and model')
    if (input.kind === 'desktop/session/input/submit') {
      if (input.clientToken !== token) { acceptedEffects++; return { admitted: true } }
      if (changedContext) throw Error('Input token payload does not match its durable admission')
      return { admitted: true }
    }
  })
  const mounted = render(<Workbench bridge={{ request, onEvent: () => () => {} }} workspaces={[{ id: workspaceId, label: 'Fixture', path: 'D:/fixture' }]} selectedWorkspaceId={workspaceId}
    capabilities={{ 'session-create': ['1'], 'desktop-draft-create': ['1'], 'desktop-drafts': ['1'], 'desktop-input': ['1'], 'prompt-context': ['1'] }} onSelectWorkspace={() => {}} onSelectSession={selected} />)
  try {
    await waitFor(() => expect((screen.getByRole('button', { name: '送出' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: '送出' }))
    await waitFor(() => expect(request.mock.calls.some(([input]) => input.kind === 'desktop/session/input/submit')).toBe(true))
    const submitted = request.mock.calls.find(([input]) => input.kind === 'desktop/session/input/submit')![0]
    expect(submitted).toMatchObject({ sessionId: 'original-cold-intent', clientToken: token, text: 'original saved input' })
    if (changedContext) {
      expect(submitted.context).toContain('changed external context')
      await waitFor(() => expect((screen.getByRole('button', { name: '送出' }) as HTMLButtonElement).disabled).toBe(false))
      expect(selected).not.toHaveBeenCalled()
      expect(drafts.clearAttempts).toBe(0)
      expect(JSON.parse(drafts.read(workspaceId)!.draft!.metadata!)).toMatchObject({ token, payload, createdId: 'original-cold-intent' })
      expect(drafts.read(workspaceId)?.draft?.prompt).toBe('original saved input')
    } else {
      await waitFor(() => expect(selected).toHaveBeenCalledWith('original-cold-intent'))
      expect(drafts.clears).toBe(1)
      expect(drafts.read(workspaceId)?.draft?.prompt).toBe('')
    }
    expect(acceptedEffects).toBe(1)
    expect(request.mock.calls.filter(([input]) => input.kind === 'session/create')).toHaveLength(0)
    expect(request.mock.calls.filter(([input]) => input.kind === 'session/model/set')).toHaveLength(0)
  } finally { mounted.unmount() }
})
