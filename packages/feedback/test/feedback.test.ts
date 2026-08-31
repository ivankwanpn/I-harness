import { describe, expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionEvent } from "@i-harness/core-session"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createSessionCoordinator, type SessionCoordinator } from "@i-harness/session-persistence"
import {
  FEEDBACK_DOC_KEY_PREFIX,
  FeedbackBadRequestError,
  FeedbackNoteEmptyError,
  FeedbackNoteTooLargeError,
  FeedbackPersistenceError,
  FeedbackVersionConflictError,
  createMessageFeedbackStore,
  type MessageFeedbackPutRequest,
  type MessageFeedbackStore,
} from "../src/index.ts"

// ── Store-level: doc round-trip + CAS + validation (no HTTP) ────────────────
async function withStore(
  run: (store: MessageFeedbackStore, coordinator: SessionCoordinator, root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "i-harness-web-host-feedback-"))
  const coordinator = createSessionCoordinator(createJsonlBackend(root))
  try {
    await run(createMessageFeedbackStore(coordinator), coordinator, root)
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

/** Seed a session whose log has assistant/message at seq 1 and 3. */
async function seedSession(coordinator: SessionCoordinator): Promise<string> {
  const { id } = await coordinator.create()
  await coordinator.append(id, [
    { type: "user/message", text: "hi", seq: 0 },
    { type: "assistant/message", text: "hello", seq: 1 },
    { type: "user/message", text: "again", seq: 2 },
    { type: "assistant/message", text: "second reply", seq: 3 },
  ] as SessionEvent[])
  return id
}

describe("message feedback store (task 4.3)", () => {
  it("put creates an item with version 1 under the `feedback-<sessionId>` doc", async () => {
    await withStore(async (store, coordinator) => {
      const id = await seedSession(coordinator)
      const { item } = await store.put(id, { messageId: "1", rating: "like" })
      expect(item).toEqual({
        messageId: "1", rating: "like", version: 1,
        updatedAt: expect.any(String) as string,
      })
      const doc = await coordinator.getDocument(`${FEEDBACK_DOC_KEY_PREFIX}${id}`)
      expect(doc).toEqual({ formatVersion: 1, items: [item] })
    })
  })

  it("list returns insertion order and an empty list for a session with no feedback", async () => {
    await withStore(async (store, coordinator) => {
      const id = await seedSession(coordinator)
      expect((await store.list(id)).items).toEqual([])
      await store.put(id, { messageId: "1", rating: "like" })
      await store.put(id, { messageId: "3", rating: "dislike", note: "回答有误" })
      expect((await store.list(id)).items.map(i => i.messageId)).toEqual(["1", "3"])
    })
  })

  it("whole-value upsert: an absent note erases a stored note (DSH parity)", async () => {
    await withStore(async (store, coordinator) => {
      const id = await seedSession(coordinator)
      const withNote = await store.put(id, { messageId: "1", rating: "like", note: "good" })
      expect(withNote.item.note).toBe("good")
      const stripped = await store.put(id, { messageId: "1", rating: "dislike" })
      expect(stripped.item.note).toBeUndefined()
      expect(stripped.item.version).toBe(2)
    })
  })

  it("CAS: exact ifVersion wins and bumps; stale ifVersion → version-conflict with current", async () => {
    await withStore(async (store, coordinator) => {
      const id = await seedSession(coordinator)
      const first = (await store.put(id, { messageId: "1", rating: "like" })).item
      // Exact observed version: the overwrite succeeds and bumps.
      const second = (await store.put(id, { messageId: "1", rating: "dislike", ifVersion: first.version })).item
      expect(second).toMatchObject({ rating: "dislike", version: 2 })
      // Stale write: the client thinks the item is at version 1, the store has 2.
      const stale = store.put(id, { messageId: "1", rating: "like", ifVersion: first.version })
      await expect(stale).rejects.toMatchObject({
        name: "FeedbackVersionConflictError",
        code: "version-conflict",
      })
      expect(await stale.catch((error: FeedbackVersionConflictError) => error.current)).toEqual(second)
    })
  })

  it("ifVersion is never applied lazily: known item, wrong version, and absent item both conflict", async () => {
    await withStore(async (store, coordinator) => {
      const id = await seedSession(coordinator)
      const { item } = await store.put(id, { messageId: "1", rating: "like" })
      const wrong = store.put(id, { messageId: "1", rating: "like", ifVersion: item.version + 1 })
      await expect(wrong).rejects.toBeInstanceOf(FeedbackVersionConflictError)
      // New target with a version → the expected 'current' is null.
      const absent = store.put(id, { messageId: "3", rating: "like", ifVersion: 1 })
      await expect(absent).rejects.toMatchObject({
        code: "version-conflict",
        current: null,
      })
    })
  })

  it("put without ifVersion forces the overwrite (version still bumps)", async () => {
    await withStore(async (store, coordinator) => {
      const id = await seedSession(coordinator)
      await store.put(id, { messageId: "1", rating: "like" })
      const forced = (await store.put(id, { messageId: "1", rating: "dislike" })).item
      expect(forced).toMatchObject({ rating: "dislike", version: 2 })
    })
  })

  it("an identical-value put is a no-op: stored item returns, version does not bump", async () => {
    await withStore(async (store, coordinator) => {
      const id = await seedSession(coordinator)
      const first = (await store.put(id, { messageId: "1", rating: "like" })).item
      const again = (await store.put(id, { messageId: "1", rating: "like" })).item
      expect(again).toEqual(first)
      expect(again.version).toBe(1)
    })
  })

  it("target validation: messageId must name an assistant/message seq", async () => {
    await withStore(async (store, coordinator) => {
      const id = await seedSession(coordinator)
      // seq 0 / seq 2 are user messages, 99 is out of range.
      for (const messageId of ["0", "2", "99", "-1"]) {
        await expect(store.put(id, { messageId, rating: "like" })).rejects.toMatchObject({
          name: /Feedback(MessageNotFoundError|BadRequestError)/,
        })
      }
      await expect(store.put(id, { messageId: "1", rating: "like" })).resolves.toMatchObject({ item: { messageId: "1" } })
    })
  })

  it("validation: bad rating, blank/oversized note, malformed ifVersion and messageId are 400-shaped", async () => {
    await withStore(async (store, coordinator) => {
      const id = await seedSession(coordinator)
      await expect(store.put(id, { messageId: "1", rating: "meh" } as unknown as MessageFeedbackPutRequest))
        .rejects.toBeInstanceOf(FeedbackBadRequestError)
      await expect(store.put(id, { messageId: "1", rating: "like", note: "   " })).rejects.toBeInstanceOf(FeedbackNoteEmptyError)
      await expect(store.put(id, { messageId: "1", rating: "like", note: "好".repeat(1366) })).rejects.toBeInstanceOf(FeedbackNoteTooLargeError)
      await expect(store.put(id, { messageId: "1", rating: "like", note: 42 as unknown as string })).rejects.toBeInstanceOf(FeedbackBadRequestError)
      await expect(store.put(id, { messageId: "1", rating: "like", ifVersion: 1.5 })).rejects.toBeInstanceOf(FeedbackBadRequestError)
      await expect(store.put(id, { messageId: "", rating: "like" })).rejects.toBeInstanceOf(FeedbackBadRequestError)
      await expect(store.put(id, { messageId: " 1", rating: "like" })).rejects.toBeInstanceOf(FeedbackBadRequestError)
      // A failed put writes nothing.
      expect((await store.list(id)).items).toEqual([])
    })
  })

  it("delete: matching version removes; mismatch 409; absence succeeds; no ifVersion removes", async () => {
    await withStore(async (store, coordinator) => {
      const id = await seedSession(coordinator)
      await store.put(id, { messageId: "1", rating: "like" })
      await store.put(id, { messageId: "3", rating: "dislike" })
      // Absence is success regardless of version (DSH parity).
      expect(await store.delete(id, "77", 99)).toEqual({ absent: true })
      // Version mismatch → conflict (stored item still there).
      await expect(store.delete(id, "3", 0)).rejects.toBeInstanceOf(FeedbackVersionConflictError)
      // Exact version removes.
      expect(await store.delete(id, "3", 1)).toEqual({ absent: true })
      expect((await store.list(id)).items.map(i => i.messageId)).toEqual(["1"])
      // Without ifVersion removes too.
      expect(await store.delete(id, "1")).toEqual({ absent: true })
      expect((await store.list(id)).items).toEqual([])
    })
  })

  it("durability: a fresh store + coordinator over the same root sees the doc (round-trip)", async () => {
    const root = await mkdtemp(join(tmpdir(), "i-harness-web-host-feedback-"))
    try {
      const firstCoord = createSessionCoordinator(createJsonlBackend(root))
      const id = await seedSession(firstCoord)
      await createMessageFeedbackStore(firstCoord).put(id, { messageId: "1", rating: "like", note: "存了" })
      const second = createSessionCoordinator(createJsonlBackend(root))
      const items = (await createMessageFeedbackStore(second).list(id)).items
      expect(items).toEqual([
        { messageId: "1", rating: "like", note: "存了", version: 1, updatedAt: expect.any(String) as string },
      ])
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it("the write-behind is flushed before the target check (a click right after render)", async () => {
    const root = await mkdtemp(join(tmpdir(), "i-harness-web-host-feedback-"))
    try {
      const coordinator = createSessionCoordinator(createJsonlBackend(root))
      const { id } = await coordinator.create()
      // Production shape: enqueue straight into the batched write-behind
      // (≤200 ms window) and immediately cast a vote — no other flush in
      // between. put() must flush first or the target check would 400.
      coordinator.enqueue(id, [
        { type: "user/message", text: "hi" },
        { type: "assistant/message", text: "hello" },
      ] as SessionEvent[])
      const store = createMessageFeedbackStore(coordinator)
      const { item } = await store.put(id, { messageId: "1", rating: "like" })
      expect(item.messageId).toBe("1")
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it("verify-after-write: a doc write that never lands fails loudly, never a silent success", async () => {
    const root = await mkdtemp(join(tmpdir(), "i-harness-web-host-feedback-"))
    try {
      // Seed state through a healthy coordinator first.
      const okCoord = createSessionCoordinator(createJsonlBackend(root))
      const id = await seedSession(okCoord)
      await createMessageFeedbackStore(okCoord).put(id, { messageId: "1", rating: "like" })
      // Then swap to a backend whose putDocument FAILS. The coordinator's M6
      // contract is report-never-reject, so coordinator.putDocument still
      // resolves — only the store's verify-after-write can catch the loss.
      const failing = createSessionCoordinator({
        ...createJsonlBackend(root),
        putDocument: async () => { throw new Error("disk full") },
      }, { reportBackgroundFailure: () => {} })
      const store = createMessageFeedbackStore(failing)
      await expect(store.put(id, { messageId: "1", rating: "dislike", ifVersion: 1 }))
        .rejects.toBeInstanceOf(FeedbackPersistenceError)
      await expect(store.delete(id, "1")).rejects.toBeInstanceOf(FeedbackPersistenceError)
      // The failed writes left the durable doc untouched (old state visible).
      const items = (await createMessageFeedbackStore(failing).list(id)).items
      expect(items).toEqual([{
        messageId: "1", rating: "like", version: 1, updatedAt: expect.any(String) as string,
      }])
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })
})
