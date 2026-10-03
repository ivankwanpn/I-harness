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
