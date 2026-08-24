# M14 Multimodal (Image Input) v0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add image input end-to-end at the smallest coherent scope: users and tools attach images to events, `deriveMessages` projects them as content parts, vision providers receive protocol-correct wire shapes, text-only providers get placeholders — all behavior unchanged when no image is present.

**Architecture:** `core-session` owns the new `ImageInput`/`LLMContentPart` types and the projection (audit seam F01-3 stays: the model only sees `deriveMessages` output). `llm-seam` adds `projectImagesForTextModel` (negative capability placeholder). `provider` gains `inputModalities`. The three real adapters shape parts into their protocol wire form; `llm-mock` and compaction tolerate image-bearing messages.

**Tech Stack:** pnpm monorepo, ESM + strict TypeScript, vitest. Packages: `core-session`, `llm-seam`, `provider`, `llm-openai`, `llm-openai-compatible`, `llm-anthropic`, `llm-mock`, `compaction`, `apps/cli`.

## Global Constraints

- No bun. No `@ai-sdk/*`. No new external dependencies (workspace links only).
- ESM + strict TS; tests under `test/*.test.ts` per package; pnpm workspaces.
- No version bumps; no new session event types; `CURRENT_FORMAT_VERSION` stays 1.
- Audit seam F01-3: model only sees `deriveMessages` output; `assertMessagesFromLog` holds.
- Behavior unchanged when no image is present (string content preserved; no-image path byte-identical).
- `ImageInput` = `{ mediaType: "image/png"|"image/jpeg"|"image/webp"|"image/gif", dataBase64 (canonical, no data: prefix, no whitespace), name?, width?, height? }`.
- Spec: `docs/superpowers/specs/2026-08-24-i-harness-m14-multimodal-design.md` (read it first).

---

### Task 1: core-session — types, parts projection, image flush, search text, intake validation

**Files:**
- Modify: `packages/core-session/src/index.ts` (SessionEvent + LLMMessage types, `deriveMessages`, `deriveSearchText`, `append` validation)
- Test: `packages/core-session/test/session.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces (used by all later tasks):
  - `export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif"`
  - `export interface ImageInput { mediaType: ImageMediaType; dataBase64: string; name?: string; width?: number; height?: number }`
  - `export type LLMContentPart = { type: "text"; text: string } | { type: "image"; image: ImageInput }`
  - `export type LLMMessage = { role: "user"; content: string | LLMContentPart[] } | { role: "assistant"; content: string; toolCalls?: ... } | { role: "tool"; toolCallId: string; content: string | LLMContentPart[] }`
  - `deriveMessages(session): LLMMessage[]` — user images → parts (text first); tool/result `output.images` → tool message text + synthetic user message `Attached image(s) from tool result:`
  - `deriveSearchText(ev): string` — image descriptor line
  - `append` throws on malformed `images?` (mediaType whitelist, canonical base64, ≤20, ≤200MiB)

- [ ] **Step 1: Write the failing tests**

Append to `packages/core-session/test/session.test.ts` (reuse its imports — `createSession`, `append`, `deriveMessages`, `deriveSearchText` are already imported):

```ts
describe("M14 multimodal", () => {
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

  it("projects a user/message with images into parts (text first)", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "hey", images: [{ mediaType: "image/png", dataBase64: PNG }] })
    const msgs = deriveMessages(s)
    expect(msgs[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "hey" },
        { type: "image", image: { mediaType: "image/png", dataBase64: PNG } },
      ],
    })
  })

  it("keeps user/message content a plain string when no images", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "hi" })
    expect(deriveMessages(s)[0]).toEqual({ role: "user", content: "hi" })
  })

  it("flushes tool-result images into a synthetic user message after the tool result", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "go" })
    append(s, { type: "assistant/message", text: "", toolCalls: [{ id: "c1", name: "shot", args: {} }] })
    append(s, { type: "tool/result", callId: "c1", name: "shot", output: { ok: true, images: [{ mediaType: "image/png", dataBase64: PNG }] } })
    append(s, { type: "step/end" })
    const msgs = deriveMessages(s)
    const results = msgs.filter((m) => m.role === "user" || m.role === "tool")
    expect(results.some((m) => m.role === "tool" && m.content === '{"ok":true,"images":[{"mediaType":"image/png","dataBase64":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="}]}')).toBe(true)
    const synthetic = results.find((m) => m.role === "user" && Array.isArray(m.content) && m.content.length === 2)! as { content: { type: string; text?: string; image?: unknown }[] }
    expect(synthetic.content[0]).toEqual({ type: "text", text: "Attached image(s) from tool result:" })
    expect(synthetic.content[1]).toMatchObject({ type: "image", image: { mediaType: "image/png" } })
  })

  it("deriveSearchText emits an image descriptor, never base64", () => {
    const s = createSession()
    const ev = { type: "user/message", text: "look", images: [{ mediaType: "image/png", dataBase64: PNG, name: "diagram.png", width: 100, height: 50 }] }
    const txt = deriveSearchText(ev as never)
    expect(txt).toContain("look")
    expect(txt).toContain("image: diagram.png 100x50 ")
    expect(txt).not.toContain(PNG.slice(10, 30))
  })

  it("append validates images at intake (mediaType, base64, count, bytes)", () => {
    const s = createSession()
    expect(() => append(s, { type: "user/message", text: "t", images: [{ mediaType: "image/bmp" as never, dataBase64: PNG }] })).toThrow(/media type/)
    expect(() => append(s, { type: "user/message", text: "t", images: [{ mediaType: "image/png", dataBase64: "not!base64!" }] })).toThrow(/base64/)
    const many = Array.from({ length: 21 }, () => ({ mediaType: "image/png" as const, dataBase64: PNG }))
    expect(() => append(s, { type: "user/message", text: "t", images: many })).toThrow(/20 images/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core-session && pnpm test`
Expected: FAIL — `images` is not on `user/message` type / `LLMContentPart` undefined.

- [ ] **Step 3: Implement**

In `packages/core-session/src/index.ts`:

1. Add the types after `SessionHeader`:

```ts
export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif"

export interface ImageInput {
  mediaType: ImageMediaType
  dataBase64: string // canonical base64 — NO `data:` prefix, NO whitespace
  name?: string
  width?: number // host-provided informational metadata (NOT verified in v0)
  height?: number
}

export type LLMContentPart =
  | { type: "text"; text: string }
  | { type: "image"; image: ImageInput }
```

2. Add `images?: ImageInput[]` to `user/message` in the `SessionEvent` union.

3. Change `LLMMessage`:

```ts
export type LLMMessage =
  | { role: "user"; content: string | LLMContentPart[] }
  | { role: "assistant"; content: string; toolCalls?: { id: string; name: string; args: unknown }[] }
  | { role: "tool"; toolCallId: string; content: string | LLMContentPart[] }
```

4. Add intake validation to `append` (before the push). Real validation helpers:

```ts
const IMAGE_MEDIA_TYPES = new Set<ImageMediaType>(["image/png", "image/jpeg", "image/webp", "image/gif"])
const MAX_IMAGES_PER_MESSAGE = 20
const MAX_IMAGE_BYTES_PER_MESSAGE = 200 * 1024 * 1024

function isValidBase64(s: string): boolean {
  return /^[A-Za-z0-9+/]*={0,2}$/.test(s) && s.length % 4 === 0 && !s.includes(" ")
}

function validateImages(images: ImageInput[], evType: string): void {
  if (images.length > MAX_IMAGES_PER_MESSAGE) {
    throw new Error(`image attachment: at most ${MAX_IMAGES_PER_MESSAGE} images per ${evType}`)
  }
  let bytes = 0
  for (const img of images) {
    if (!IMAGE_MEDIA_TYPES.has(img.mediaType)) {
      throw new Error(`image attachment: unsupported media type ${String(img.mediaType)}`)
    }
    if (!isValidBase64(img.dataBase64)) {
      throw new Error(`image attachment: dataBase64 must be canonical base64 (no data: prefix, no whitespace)`)
    }
    bytes += Math.ceil((img.dataBase64.length * 3) / 4)
  }
  if (bytes > MAX_IMAGE_BYTES_PER_MESSAGE) {
    throw new Error(`image attachment: aggregate bytes exceed ${MAX_IMAGE_BYTES_PER_MESSAGE}`)
  }
}
```

In `append`, after the `assistant/message` source check and before `const ev = ...`:

```ts
const maybeImages = (event as { images?: unknown }).images
if (maybeImages !== undefined) {
  if (!Array.isArray(maybeImages)) throw new Error("image attachment: images must be an array")
  validateImages(maybeImages as ImageInput[], event.type)
}
```

5. `deriveMessages` — for `user/message`:

```ts
} else if (ev.type === "user/message") {
  flushToolBlock()
  const images = ev.images as ImageInput[] | undefined
  result.push(
    images && images.length > 0
      ? { role: "user", content: [{ type: "text", text: ev.text }, ...images.map((image) => ({ type: "image", image }))] }
      : { role: "user", content: ev.text },
  )
}
```

6. `deriveMessages` — for `tool/result`, extract images into a synthetic user message. In the `tool/result` branch:

```ts
} else if (ev.type === "tool/result") {
  const out = ev.output as { images?: ImageInput[] } | null | undefined
  const images = out?.images
  pendingResults.push({ role: "tool", toolCallId: ev.callId, content: JSON.stringify(ev.output) })
  if (images && images.length > 0) {
    pendingResults.push({
      role: "user",
      content: [
        { type: "text", text: "Attached image(s) from tool result:" },
        ...images.map((image) => ({ type: "image", image })),
      ],
    })
  }
}
```

7. `deriveSearchText` — image descriptor. In the `user/message` and `tool/result` cases, append a descriptor per image:

```ts
function imageDescriptor(images: ImageInput[] | undefined): string {
  if (!images || images.length === 0) return ""
  return (
    "\n" +
    images.map((i) => `image: ${i.name ?? "unnamed"} ${i.width ?? "?"}x${i.height ?? "?"} ${Math.ceil((i.dataBase64.length * 3) / 4)}B base64:${i.dataBase64.slice(0, 8)}`).join("\n")
  )
}
```

For `user/message`: `case "user/message": return ev.text + imageDescriptor((ev as { images?: ImageInput[] }).images)`.
For `tool/result`: `case "tool/result": return JSON.stringify(ev.output) + imageDescriptor((ev.output as { images?: ImageInput[] })?.images)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core-session && pnpm test && pnpm typecheck`
Expected: PASS — existing tests (string content preserved) + 5 new M14 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core-session/src/index.ts packages/core-session/test/session.test.ts
git commit -m "feat(core-session): image parts projection, tool-result image flush, search descriptors, intake validation"
```

---

### Task 2: llm-seam — projectImagesForTextModel + re-exports

**Files:**
- Modify: `packages/llm-seam/src/index.ts`
- Test: `packages/llm-seam/test/seam.test.ts`

**Interfaces:**
- Consumes: Task 1's `LLMMessage`/`LLMContentPart`/`ImageInput` re-exports.
- Produces:
  - `export function projectImagesForTextModel(messages: LLMMessage[]): LLMMessage[]` — replaces every `{ type: "image" }` part with `{ type: "text", text: "[image omitted: model is text-only; base64:<8>]" }`; text survives; used by adapters when `inputModalities` lacks `"image"`.

- [ ] **Step 1: Write the failing test**

Append to `packages/llm-seam/test/seam.test.ts`:

```ts
import { projectImagesForTextModel } from "../src/index.ts"

describe("M14 projectImagesForTextModel", () => {
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

  it("replaces image parts with a text placeholder and keeps text parts", () => {
    const out = projectImagesForTextModel([
      { role: "user", content: [
        { type: "text", text: "look" },
        { type: "image", image: { mediaType: "image/png", dataBase64: PNG } },
      ]},
    ])
    expect(out[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "text", text: "[image omitted: model is text-only; base64:iVBORw0K]" },
      ],
    })
  })

  it("leaves string content untouched", () => {
    const out = projectImagesForTextModel([{ role: "user", content: "plain" }])
    expect(out).toEqual([{ role: "user", content: "plain" }])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/llm-seam && pnpm test`
Expected: FAIL — `projectImagesForTextModel` undefined.

- [ ] **Step 3: Implement**

In `packages/llm-seam/src/index.ts`:

```ts
// M14 negative capability: text-only models never see image bytes. Replaces
// every image part with a deterministic text placeholder (the base64 prefix
// is a stable correlation hint, not the bytes). String content passes through.
export function projectImagesForTextModel(messages: LLMMessage[]): LLMMessage[] {
  return messages.map((m) => {
    if (typeof m.content === "string") return m
    return {
      ...m,
      content: m.content.map((part) =>
        part.type === "image"
          ? { type: "text" as const, text: `[image omitted: model is text-only; base64:${part.image.dataBase64.slice(0, 8)}]` }
          : part,
      ),
    }
  })
}
```

Also re-export the new types from core-session so adapters can import them from one place (add to the existing `export type { LLMMessage } ...` line):

```ts
export type { LLMMessage, LLMContentPart, ImageInput, ImageMediaType } from "@i-harness/core-session"
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/llm-seam && pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-seam/src/index.ts packages/llm-seam/test/seam.test.ts
git commit -m "feat(llm-seam): projectImagesForTextModel (negative-capability placeholder)"
```

---

### Task 3: provider — inputModalities

**Files:**
- Modify: `packages/provider/src/index.ts`
- Test: `packages/provider/test/provider.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ProviderProfile.inputModalities?: ("text" | "image")[]` — absent = text-only (negative capability). The `buildModelClient` forward of `inputModalities` to the three adapters lands in Task 6 (once all adapter configs accept the field); Task 3 ships only the `ProviderProfile` field + test.

- [ ] **Step 1: Write the failing test**

Append to `packages/provider/test/provider.test.ts`:

```ts
it("stores inputModalities and treats absence as text-only", () => {
  const reg = createProviderRegistry()
  reg.register({ name: "vision", displayName: "V", protocol: "openai-compatible", inputModalities: ["text", "image"] })
  reg.register({ name: "plain", displayName: "P", protocol: "openai-compatible" })
  expect(reg.get("vision")!.inputModalities).toEqual(["text", "image"])
  const plain = reg.get("plain")!.inputModalities
  expect(plain === undefined || !plain.includes("image")).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/provider && pnpm test`
Expected: FAIL — `inputModalities` not on the type (`reg.register` type error at compile; if vitest transpiles anyway, the assertion fails at runtime).

- [ ] **Step 3: Implement**

In `packages/provider/src/index.ts`, add to `ProviderProfile`:

```ts
export interface ProviderProfile {
  name: string
  displayName: string
  protocol: ProviderProtocol
  baseUrl?: string
  apiKey?: string
  models?: string[]
  defaultModel?: string
  inputModalities?: ("text" | "image")[] // M14: absent = text-only (negative capability)
}
```

And forward it through `buildModelClient` (each adapter's config gains the field in Tasks 4-6):

```ts
    case "openai-responses":
      return createOpenAIClient({ apiKey: profile.apiKey ?? "", baseUrl: profile.baseUrl, model: resolved, options: extra, inputModalities: profile.inputModalities })
    case "openai-compatible":
      return createOpenAICompatibleClient({ apiKey: profile.apiKey ?? "", baseUrl: profile.baseUrl, model: resolved, options: extra, inputModalities: profile.inputModalities })
    case "anthropic-messages":
      return createAnthropicClient({ apiKey: profile.apiKey ?? "", baseUrl: profile.baseUrl, model: resolved, options: extra, inputModalities: profile.inputModalities })
```

Note: `createOpenAIClient`/`createOpenAICompatibleClient`/`createAnthropicClient` accept the new `inputModalities?: ("text" | "image")[]` from Tasks 4-6 — until those tasks land, `buildModelClient` will fail strict typecheck on the extra field. To keep Task 3 independently green (and per the brief's step order), either (a) land Tasks 4-6 config fields first, or (b) in Task 3 add only the `ProviderProfile` field + test and defer the `buildModelClient` forward to Task 6 (the last adapter task). Recommended (b): Task 3 adds the field; Task 6 adds the three `buildModelClient` forwards once all adapter configs accept `inputModalities`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/provider && pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/provider/src/index.ts packages/provider/test/provider.test.ts
git commit -m "feat(provider): ProviderProfile.inputModalities (negative capability)"
```

---

### Task 4: llm-openai (Responses) wire shaping

**Files:**
- Modify: `packages/llm-openai/src/index.ts`
- Test: `packages/llm-openai/test/*.test.ts` (or create if none — check the file listing; if none exists, create `packages/llm-openai/test/openai.test.ts`)

**Interfaces:**
- Consumes: Task 1's `LLMMessage`/`LLMContentPart`; Task 2's `projectImagesForTextModel`.
- Produces: the OpenAI Responses wire shape for image parts (`input_text`/`input_image`); a text-only provider (no `inputModalities` with `"image"`) projects images via `projectImagesForTextModel` first. Tool-result images: deriveMessages already emits the synthetic user message for the agent path; the adapter's direct-path email (host hand-built messages) must also collapse a tool message with image parts into `function_call_output` (text) + a following `user` item with the images.

The adapter currently receives `config: OpenAIConfig`. It needs to know if the route is vision-capable. Add an optional `inputModalities?: ("text" | "image")[]` to `OpenAIConfig` and `createOpenAIClient(config)`; `buildModelClient` (Task 3 follow-up) forwards `profile.inputModalities`.

- [ ] **Step 1: Write the failing test**

Create `packages/llm-openai/test/openai.test.ts` (or append to existing):

```ts
import { describe, expect, it } from "vitest"
import { createOpenAIClient } from "../src/index.ts"

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

function captureBody(fn: (client: ReturnType<typeof createOpenAIClient>) => Promise<void>): Promise<{ input: unknown }> {
  return new Promise((resolve, reject) => {
    const original = globalThis.fetch as unknown as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      resolve(JSON.parse(String(init?.body)) as { input: unknown })
      return new Response(JSON.stringify({ id: "r", type: "response.completed", response: { output: [] } }), { status: 200 })
    }) as typeof fetch
    const client = createOpenAIClient({ apiKey: "k", model: "m", inputModalities: ["text", "image"] })
    fn(client).catch(reject)
  })
}

describe("M14 openai responses wire", () => {
  it("shapes image parts as input_image with a data URL", async () => {
    const bodyPromise = captureBody(async (client) => {
      for await (const _ of client.stream({
        systemPrompt: "s", tools: [], model: "m",
        messages: [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", image: { mediaType: "image/png", dataBase64: PNG } }] }],
      })) { /* drain */ }
    })
    const body = await bodyPromise
    const input = (body.input as { role: string; content: { type: string; text?: string; image_url?: string }[] }[])
    const user = input.find((i) => i.role === "user")!
    expect(user.content).toEqual([
      { type: "input_text", text: "look" },
      { type: "input_image", image_url: `data:image/png;base64,${PNG}` },
    ])
  })
})
```

Also check the existing test files — reuse the repo's fetch-stubbing pattern if one exists (search for `globalThis.fetch` in the package's tests). Restore `globalThis.fetch` in a `finally` in the real test (the helper above returns early; wire it carefully in the real test).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/llm-openai && pnpm test`
Expected: FAIL — the wire maps `content` as a plain string (no `input_text`/`input_image`).

- [ ] **Step 3: Implement**

In `packages/llm-openai/src/index.ts`:

1. Add to `OpenAIConfig`:
```ts
  inputModalities?: ("text" | "image")[]
```

2. In `stream`, before building the body, decide projection:

```ts
const vision = config.inputModalities?.includes("image") ?? false
const messages = vision ? request.messages : projectImagesForTextModel(request.messages)
```

3. Replace the `input: request.messages.map(...)` with `input: messages.map(...)` and shape user content via a helper:

```ts
function toInputContent(content: string | LLMContentPart[]): unknown {
  if (typeof content === "string") return content
  return content.map((part) =>
    part.type === "text"
      ? { type: "input_text", text: part.text }
      : { type: "input_image", image_url: `data:${part.image.mediaType};base64,${part.image.dataBase64}` },
  )
}
```

Use it in the user branch: `return { role: "user", content: toInputContent(m.content) }`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/llm-openai && pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-openai/src/index.ts packages/llm-openai/test/openai.test.ts
git commit -m "feat(llm-openai): image wire shaping (input_image) + text-only projection"
```

---

### Task 5: llm-openai-compatible (chat completions) wire shaping

**Files:**
- Modify: `packages/llm-openai-compatible/src/index.ts`
- Test: `packages/llm-openai-compatible/test/*.test.ts` (create if none)

**Interfaces:**
- Consumes: Task 1 types, Task 2 `projectImagesForTextModel`.
- Produces: chat-completions `content` array `[{type:"text"}, {type:"image_url", image_url:{url:"data:..."}}]`; text-only projection when no vision.

- [ ] **Step 1: Write the failing test**

Create `packages/llm-openai-compatible/test/openai-compatible.test.ts`:

```ts
import { describe, expect, it, afterEach } from "vitest"
import { createOpenAICompatibleClient } from "../src/index.ts"

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

describe("M14 openai-compatible wire", () => {
  afterEach(() => { delete (globalThis as { __fetch?: unknown }).__fetch })

  it("shapes image parts as image_url array", async () => {
    let body: { messages: { role: string; content: unknown }[] } | undefined
    const original = globalThis.fetch
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as typeof body
      return new Response("data: [DONE]", { status: 200 })
    }) as typeof fetch
    try {
      const client = createOpenAICompatibleClient({ apiKey: "k", model: "m", baseUrl: "http://x", inputModalities: ["text", "image"] })
      for await (const _ of client.stream({ systemPrompt: "s", tools: [], messages: [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", image: { mediaType: "image/png", dataBase64: PNG } }] }] })) { /* drain */ }
    } finally {
      globalThis.fetch = original
    }
    const user = body!.messages.find((m) => m.role === "user")!
    expect(user.content).toEqual([
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } },
    ])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/llm-openai-compatible && pnpm test`
Expected: FAIL — `toWireMessage` returns `{ role, content: m.content }` (plain string).

- [ ] **Step 3: Implement**

In `packages/llm-openai-compatible/src/index.ts`:

1. Add `inputModalities?: ("text" | "image")[]` to `OpenAICompatibleConfig`.
2. In `stream`, `const messages = config.inputModalities?.includes("image") ?? false ? request.messages : projectImagesForTextModel(request.messages)`.
3. Change `toWireMessage` to accept `content: string | LLMContentPart[]` and shape arrays:

```ts
function toContent(content: string | LLMContentPart[]): unknown {
  if (typeof content === "string") return content
  return content.map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : { type: "image_url", image_url: { url: `data:${part.image.mediaType};base64,${part.image.dataBase64}` } },
  )
}
```

`toWireMessage` uses `content: toContent(m.content)` in the assistant and user return paths (tool stays string — Anthropic-style role alternation is preserved by derive's synthetic user message).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/llm-openai-compatible && pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-openai-compatible/src/index.ts packages/llm-openai-compatible/test/openai-compatible.test.ts
git commit -m "feat(llm-openai-compatible): image wire shaping (image_url array)"
```

---

### Task 6: llm-anthropic wire shaping + buildModelClient forward

**Files:**
- Modify: `packages/llm-anthropic/src/index.ts`
- Modify: `packages/provider/src/index.ts` (the `buildModelClient` `inputModalities` forward — all three adapter configs now accept the field)
- Test: `packages/llm-anthropic/test/*.test.ts` (create if none)

**Interfaces:**
- Consumes: Task 1 types, Task 2 `projectImagesForTextModel`.
- Produces: Anthropic `content` array `[{type:"text"}, {type:"image", source:{type:"base64", media_type, data}}]`; tool_result stays text; text-only projection when no vision.

- [ ] **Step 1: Write the failing test**

Create `packages/llm-anthropic/test/anthropic.test.ts` (or append):

```ts
import { describe, expect, it } from "vitest"
import { createAnthropicClient } from "../src/index.ts"

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

describe("M14 anthropic wire", () => {
  it("shapes image parts as image source blocks", async () => {
    let body: { messages: { role: string; content: unknown }[] } | undefined
    const original = globalThis.fetch
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as typeof body
      return new Response(JSON.stringify({ type: "message_start", message: { role: "assistant", content: [] }, usage: { input_tokens: 0, output_tokens: 0 } }), { status: 200 })
    }) as typeof fetch
    try {
      const client = createAnthropicClient({ apiKey: "k", model: "m", baseUrl: "http://x", inputModalities: ["text", "image"] })
      for await (const _ of client.stream({ systemPrompt: "s", tools: [], messages: [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", image: { mediaType: "image/png", dataBase64: PNG } }] }] })) { /* drain */ }
    } finally {
      globalThis.fetch = original
    }
    const user = body!.messages.find((m) => m.role === "user")!
    expect(user.content).toEqual([
      { type: "text", text: "look" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
    ])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/llm-anthropic && pnpm test`
Expected: FAIL — user branch returns `{ role, content: m.content }` (string).

- [ ] **Step 3: Implement**

In `packages/llm-anthropic/src/index.ts`:

1. Add `inputModalities?: ("text" | "image")[]` to `AnthropicConfig`.
2. `const vision = config.inputModalities?.includes("image") ?? false; const messages = vision ? request.messages : projectImagesForTextModel(request.messages)`.
3. Add a helper and use it in the user branch:

```ts
function toAnthropicContent(content: string | LLMContentPart[]): unknown {
  if (typeof content === "string") return content
  return content.map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : { type: "image", source: { type: "base64", media_type: part.image.mediaType, data: part.image.dataBase64 } },
  )
}
```

Replace `return { role: m.role, content: m.content }` with `return { role: m.role, content: toAnthropicContent(m.content) }`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/llm-anthropic && pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-anthropic/src/index.ts packages/provider/src/index.ts packages/llm-anthropic/test/anthropic.test.ts
git commit -m "feat(llm-anthropic): image wire shaping (image source blocks) + provider inputModalities forward"
```

---

### Task 7: llm-mock tolerate images + compaction token estimate

**Files:**
- Modify: `packages/llm-mock/src/index.ts`
- Modify: `packages/compaction/src/tokens.ts`
- Test: `packages/llm-mock/test/*.test.ts` (if none, create) + `packages/compaction/test/*.test.ts` (check existing)

**Interfaces:**
- Consumes: Task 1 types (`ImageInput`, `LLMContentPart`).
- Produces: `MockStep.images?: ImageInput[]` — mock yields text/chunk for text and skips images; `approxTokens`/`activeTokens` handle parts (text part → chars/4, image part → fixed `IMAGE_TOKEN_ESTIMATE = 1024`). `IMAGE_TOKEN_ESTIMATE` exported.

- [ ] **Step 1: Write the failing tests**

`packages/llm-mock/test/mock.test.ts` (create if none):

```ts
import { describe, expect, it } from "vitest"
import { createMockClient } from "../src/index.ts"

describe("M14 mock", () => {
  it("tolerates a user message with images and yields the text chunk", async () => {
    const client = createMockClient([{ role: "assistant", text: "done" }])
    const events: string[] = []
    for await (const ev of client.stream({ systemPrompt: "s", tools: [], messages: [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", image: { mediaType: "image/png", dataBase64: "aGVsbG8=" } }] }] })) {
      if (ev.type === "text/chunk") events.push(ev.text)
    }
    expect(events).toEqual(["done"])
  })
})
```

`packages/compaction/test/*.test.ts` (check existing file name; append):

```ts
import { IMAGE_TOKEN_ESTIMATE, approxTokens } from "../src/tokens.ts"

it("estimates an image part at the fixed token count", () => {
  expect(approxTokens("abcd")).toBe(1)
  const parts = [
    { type: "text" as const, text: "abcd" },
    { type: "image" as const, image: { mediaType: "image/png" as const, dataBase64: "aGVsbG8=" } },
  ]
  expect(approxTokens(parts)).toBe(1 + IMAGE_TOKEN_ESTIMATE)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/llm-mock && pnpm test` and `cd packages/compaction && pnpm test`
Expected: FAIL — `IMAGE_TOKEN_ESTIMATE` undefined / `approxTokens` doesn't handle parts.

- [ ] **Step 3: Implement**

`packages/llm-mock/src/index.ts`: no code change needed for the mock itself — it reads `step.text` and ignores images. The tolerance is that the mock's `stream` doesn't choke on image-bearing messages (it doesn't inspect them). Confirm the test passes; if the type lints fail, adjust the mock's input type to `LLMRequest` (already is).

`packages/compaction/src/tokens.ts`:

```ts
export const IMAGE_TOKEN_ESTIMATE = 1024 // M14: fixed per-image estimate (no re-encode/pixel math in v0)

export function approxTokens(content: string | import("@i-harness/core-session").LLMContentPart[]): number {
  if (typeof content === "string") return Math.ceil(content.length / 4)
  let total = 0
  for (const part of content) {
    total += part.type === "text" ? Math.ceil(part.text.length / 4) : IMAGE_TOKEN_ESTIMATE
  }
  return total
}
```

`activeTokens` already calls `approxTokens(m.content)` — with the widened signature it now handles parts.

- [ ] **Step 4: Run tests to verify they pass**

Run: both packages' tests + typecheck.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-mock/src/index.ts packages/compaction/src/tokens.ts packages/llm-mock/test/mock.test.ts packages/compaction/test/*.test.ts
git commit -m "feat: mock tolerates image messages; compaction estimates image tokens"
```

---

### Task 8: API 端到端 — mock 驅動（含 buildModelClient forward 驗證）

**Files:**
- Modify: `apps/cli/src/run.ts` — no production change needed (verified: `runHeadless` takes `opts.model?: ModelClient` directly; the `ProviderProfile`/`buildModelClient` forward lives in `packages/provider`, added in Task 6)
- Test: `apps/cli/test/cli.test.ts`

**Interfaces:**
- Consumes: Task 1's image-bearing `user/message` (host appends to the session); Task 7's mock tolerance.
- Produces: an e2e pinning that an image-bearing user message flows through the agent without error and the turn completes.

- [ ] **Step 1: Write the failing test**

Append to `apps/cli/test/cli.test.ts` (reuse imports: `runHeadless`, `createMockClient` already imported, `mkdtempSync`, `join`, `tmpdir`, `rmSync`):

```ts
it("M14: agent completes when the session starts with an image-bearing user message", async () => {
  const dir = mkdtempSync(join(tmpdir(), "i-harness-m14-"))
  try {
    const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
    // Drive the agent with a pre-seeded session carrying an image-bearing
    // user/message (the host owns the session; the harness is headless).
    const session = createSession()
    append(session, { type: "user/message", text: "describe this", images: [{ mediaType: "image/png", dataBase64: PNG }] })
    const result = await runHeadless("describe this", {
      workspace: dir,
      approveAll: true,
      model: createMockClient([{ role: "assistant", text: "a tiny png" }]),
      session,
    })
    expect(result.exitCode).toBe(0)
    expect(result.finalText).toBe("a tiny png")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
```

Check whether `runHeadless` accepts a `session` option (the `Session` type is imported in `run.ts`). If it does NOT accept a pre-seeded session, host by pre-seeding via the `sessionId`/coordinator path or extend `HeadlessOptions` with `session?: Session` — the test above is the contract. Verify against the actual `HeadlessOptions` (the M10a/M11 tests reuse `result.session`, so a `session` input option may need adding).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cli && pnpm test`
Expected: FAIL — either `session` not accepted by `runHeadless` (type/compile) or the run starts a fresh session and the image-bearing seed is lost.

- [ ] **Step 3: Implement**

In `apps/cli/src/run.ts` `HeadlessOptions`, add:

```ts
  session?: Session // M14: host-provided pre-seeded session (the harness is headless; a host can seed a session with image-bearing user/message events before the run)
```

And in `runHeadless`, after `createSession(...)` (the existing M7 session construction), if `opts.session` is provided, use it instead of the fresh one:

```ts
  const session = opts.session ?? createSession((ev) => { ... })
```

(The existing `onAppend` coordinator hook lives only on `createSession`; when a host passes a pre-seeded session and also passes a coordinator, the write-behind path is the host's responsibility — document this in the comment.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/cli && pnpm test && pnpm typecheck`
Expected: PASS + the full existing CLI suite green (the `session` option defaults to undefined → fresh session, no regression).

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/run.ts apps/cli/test/cli.test.ts
git commit -m "feat(cli): host-seeded session option + M14 image e2e"
```

---

### Task 9: full gates + constraint verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full suite and typecheck**

Run: `pnpm -r test` then `pnpm -r typecheck`
Expected: exit 0 for both.

- [ ] **Step 2: Verify no scope/constraint leaks**

Run:
```bash
git diff af60e32..HEAD -- '*.ts' | grep -E "^[+-].*(CURRENT_FORMAT_VERSION|SCHEMA_VERSION)" | head -5
# expect: empty (no version constant changes)
git diff af60e32..HEAD -- 'package.json' 'packages/*/package.json' 'apps/*/package.json' | grep -E "^[+-]" | grep -v "version" | head -10
# expect: no new external dependencies
```

- [ ] **Step 3: Commit any stragglers**

```bash
git status --short
git add -A && git commit -m "chore: M14 gates green"   # only if something is uncommitted
```
