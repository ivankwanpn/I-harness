import { describe, expect, it } from "vitest"
import { DurableDraftClient } from "../src/renderer/session/durable-draft-client.ts"
import type { DurableDraft, UnsentDraft, DraftRequest } from "../src/shared/attachment-drafts.ts"
const draft = (prompt: string): UnsentDraft => ({ prompt, references: [], images: [], texts: [], contextRefs: [] })
const scope = { workspaceId: "w", identity: "s" }
describe("durable draft client admission races", () => {
  it("retirement discards a pending restore and prevents an unmount flush or admission from saving", async () => {
    let finish!: (record: DurableDraft) => void, current = draft(""), writes = 0
    const request = async (value: DraftRequest): Promise<DurableDraft> => { if (value.kind === "desktop/draft/load") return new Promise(resolve => { finish = resolve }); writes++; return { revision: "late", draft: null } }
    const client = new DurableDraftClient(scope, request, () => current, value => { current = value }, () => {})
    const loading = client.restore(); client.retire(); finish({ revision: "old", draft: draft("deleted payload") }); await loading
    client.changed(); await client.flush(); expect(await client.admitted(client.capture(), () => { current = draft("oops") })).toBe(false)
    expect(current.prompt).toBe(""); expect(writes).toBe(0)
  })
  it("retains edits made while a restart load is pending and saves them using the loaded revision", async () => {
    let finish!: (record: DurableDraft) => void, current = draft(""), record: DurableDraft = { revision: "old", draft: { ...draft("disk"), texts: [{ id: 9, name: "restored.txt", text: "saved attachment" }] } }
    const request = async (value: DraftRequest): Promise<DurableDraft> => { if (value.kind === "desktop/draft/load") return new Promise((resolve) => { finish = resolve }); if (value.kind === "desktop/draft/save") { expect(value.expectedRevision).toBe("old"); record = { revision: "new", draft: value.draft }; return record }; throw new Error("unexpected clear") }
    const client = new DurableDraftClient(scope, request, () => current, (value) => { current = value }, () => {})
    const loading = client.restore(); current = draft("new edit"); client.changed(); finish(record); await loading; await client.flush()
    expect(current.prompt).toBe("new edit"); expect(record.draft?.prompt).toBe("new edit"); expect(current.texts[0]?.text).toBe("saved attachment")
  })
  it("does not let an old admission erase a newer edit", async () => {
    let current = draft("sent"), record: DurableDraft = { revision: null, draft: null }, clearCalls = 0
    const request = async (value: DraftRequest): Promise<DurableDraft> => { if (value.kind === "desktop/draft/load") return record; if (value.kind === "desktop/draft/save") return record = { revision: "saved", draft: value.draft }; clearCalls++; return record = { revision: "cleared", draft: null } }
    const client = new DurableDraftClient(scope, request, () => current, (value) => { current = value }, () => {})
    await client.restore(); const sent = client.capture(); current = draft("newer"); client.changed()
    expect(await client.admitted(sent, () => { current = draft("") })).toBe(false)
    expect(current.prompt).toBe("newer"); expect(clearCalls).toBe(0)
  })
  it("shows save failures while keeping the in-memory draft available", async () => {
    let current = draft("keep"), error = ""
    const request = async (value: DraftRequest): Promise<DurableDraft> => { if (value.kind === "desktop/draft/load") return { revision: null, draft: null }; throw new Error("quota exceeded") }
    const client = new DurableDraftClient(scope, request, () => current, (value) => { current = value }, (value) => { error = value ?? "" })
    await client.restore(); client.changed(); await expect(client.flush()).rejects.toThrow(/quota/)
    expect(current.prompt).toBe("keep"); expect(error).toContain("quota")
  })
  it("persists edits typed during a pending durable clear using the returned tombstone revision", async () => {
    let finish!: (record: DurableDraft) => void, current = draft("sent"), record: DurableDraft = { revision: null, draft: null }
    const request = async (value: DraftRequest): Promise<DurableDraft> => {
      if (value.kind === "desktop/draft/load") return record
      if (value.kind === "desktop/draft/clear") return new Promise((resolve) => { finish = resolve })
      expect(value.expectedRevision).toBe(record.revision)
      return record = { revision: "saved", draft: value.draft }
    }
    const client = new DurableDraftClient(scope, request, () => current, (value) => { current = value }, () => {})
    await client.restore(); await client.flush(); const clearing = client.admitted(client.capture(), () => { current = draft("") })
    await new Promise((resolve) => setTimeout(resolve, 0)); current = draft("typed during clear"); client.changed(); record = { revision: "tombstone", draft: null }; finish(record)
    expect(await clearing).toBe(false); await client.flush()
    expect(current.prompt).toBe("typed during clear"); expect(record.draft?.prompt).toBe("typed during clear")
  })
})

it('does not consume an explicitly new draft whose text matches an earlier admitted input', async () => {
 let current = draft('same text'), clears = 0
 const request = async (value: DraftRequest): Promise<DurableDraft> => {
  if (value.kind === 'desktop/draft/clear') clears++
  return { revision: 'fixture', draft: value.kind === 'desktop/draft/save' ? value.draft : null }
 }
 const client = new DurableDraftClient(scope, request, () => current, value => { current = value }, () => {})
 await client.restore()
 const original = client.capture()
 current = draft('same text'); client.changed()
 expect(await client.admitted(original, () => { current = draft('') })).toBe(false)
 expect(clears).toBe(0)
 expect(current.prompt).toBe('same text')
 await client.flush()
})

it('persists submission metadata changed during a save without changing the captured user edit', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let current = { ...draft('sent'), metadata: 'creating' }
  let record: DurableDraft = { revision: null, draft: null }, writes = 0
  const request = async (value: DraftRequest): Promise<DurableDraft> => {
    if (value.kind === 'desktop/draft/load') return structuredClone(record)
    expect(value.expectedRevision).toBe(record.revision)
    if (value.kind === 'desktop/draft/clear') return record = { revision: 'clear', draft: null }
    const snapshot = structuredClone(value.draft)
    if (++writes === 1) { entered.resolve(); await release.promise }
    return record = { revision: String(writes), draft: snapshot }
  }
  const client = new DurableDraftClient(scope, request, () => current, value => { current = { ...value, metadata: value.metadata ?? '' } }, () => {})
  await client.restore()
  const sent = client.capture()
  const saving = client.flush()
  try {
    await Promise.race([entered.promise, saving.then(() => { throw Error('Original save missed the held boundary') })])
    current = { ...current, metadata: 'created and input admitted' }
    client.changed('submission')
    expect(client.capture()).toBe(sent)
    release.resolve()
    await saving
    expect(writes).toBe(2)
    expect(record.draft?.metadata).toBe('created and input admitted')
    expect(await client.admitted(sent, () => { current = { ...current, prompt: '' } })).toBe(true)
    expect(record.draft?.prompt).toBe('')
  } finally { release.resolve(); await saving; await client.flush() }
})

it('clears an admitted edit while saving the latest submission metadata from the pending clear', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let current = { ...draft('sent'), metadata: 'input retry identity' }
  let record: DurableDraft = { revision: null, draft: null }, revision = 0
  const request = async (value: DraftRequest): Promise<DurableDraft> => {
    if (value.kind === 'desktop/draft/load') return structuredClone(record)
    expect(value.expectedRevision).toBe(record.revision)
    if (value.kind === 'desktop/draft/clear') {
      entered.resolve(); await release.promise
      return record = { revision: String(++revision), draft: null }
    }
    return record = { revision: String(++revision), draft: structuredClone(value.draft) }
  }
  const client = new DurableDraftClient(scope, request, () => current, value => { current = { ...value, metadata: value.metadata ?? '' } }, () => {})
  await client.restore(); await client.flush()
  const sent = client.capture()
  const clearing = client.admitted(sent, () => { current = { ...current, prompt: '' } })
  try {
    await Promise.race([entered.promise, clearing.then(() => { throw Error('Original clear missed the held boundary') })])
    current = { ...current, metadata: 'latest selected model only' }
    client.changed('submission')
    release.resolve()
    expect(await clearing).toBe(true)
    expect(record.draft).toMatchObject({ prompt: '', metadata: 'latest selected model only' })
  } finally { release.resolve(); await clearing; await client.flush() }
})
