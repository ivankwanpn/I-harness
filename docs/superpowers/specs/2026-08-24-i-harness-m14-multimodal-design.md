# M14 Design — Multimodal (Image Input) v0

Date: 2026-08-24. Milestone: M14. Status: design.

## 1. Framing

### 1.1 Problem

The model pool is gaining vision ability (e.g. DeepSeek V4 Flash Vision Exp).
I-harness's message model is text-only end-to-end: `LLMMessage` content is a
plain string (`packages/core-session`), `deriveMessages` projects text only,
all four LLM adapters build text-only wire bodies, and `ProviderProfile` has no
capability metadata. A user cannot attach an image to a message, and a tool
cannot return one, even when the configured model supports input images.

Parity validation (2026-08-24): dsh v0.1.1-rc.2 ships a full
`unified-image-request-pipeline` (normalized content-addressed attachment →
route-owned request version → provider file id); codex-rust 0.149.1 has
`InputImage` content items, local-media snapshotting, and image-aware
compaction. Both references confirm the same core design principles.

### 1.2 Goal

Add **image input** end-to-end, at the smallest coherent scope that is fully
usable: a user can attach images to a `user/message`, a tool can attach images
to its result, the model-visible message surface carries them as parts,
ai-capable providers receive them in protocol-correct wire shape, and
text-only providers get deterministic placeholders. All existing behavior is
unchanged when no image is present.

### 1.3 Non-goals (out of scope for M14 v0)

- **Normalization / re-encoding** (EXIF orientation, metadata strip, color
  profile conversion, 16-bit → 8-bit, resolution shrink): deferred. Images
  pass through byte-identically. dsh's normalization ladder is an
  independently-versioned follow-up (`transformVersion` identity gives a clean
  migration).
- **Content-addressed attachment store** (durable refs, dedup, verification):
  deferred. V0 embeds canonical base64 in session events. dsh's `attachment`
  package is the reference when store lands; the store is the migration path
  for bloated JSONL/SQLite sessions.
- **Request-version derivation / variantId cache**: deferred (part of the
  store milestone).
- **Provider file upload lifecycle** (DeepSeek Files API, 7-day expiry, stale
  id recovery): deferred — transport optimization.
- **Output image generation** (`imagegen`): dsh is input-only scope; not in
  M14.
- **Image-aware compaction replay** (dsh replays shadowed images into the
  summarizer): v0 keeps the summarizer text-only (descriptor list). Requires
  the store + route policy to be worth it; buy later.
- **Audio**: deferred (codex has LocalAudio; not requested).
- **No new session event types; no `CURRENT_FORMAT_VERSION` bump; no new
  external dependencies (workspace links only); no version bumps.** All
  `image` support is additive fields + type extensions.

## 2. Confirmed decisions (brainstorm 2026-08-24)

| Decision | Choice |
|---|---|
| Scope | v0 inline-base64 (no normalization/store/cache; input-only) |
| Durable | Pure inline-base64 events (bytes embedded in the session log) |
| Seam | `LLMMessage.content` → `string \| LLMContentPart[]` (string preserved when no image) |
| Capability | `ProviderProfile.inputModalities` (absent ⇒ text-only; placeholder projection) |
| Tool-result image | Images flow into the following `user` message (fixed label) |
| Event carrier | `user/message`, `tool/result` gain `images?: ImageInput[]` (additive fields) |

## 3. Types (core-session)

### 3.1 ImageInput / parts

```ts
export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif"

export interface ImageInput {
  mediaType: ImageMediaType
  dataBase64: string      // canonical base64 — NO `data:` prefix, NO whitespace
  name?: string
  width?: number          // host-provided informational metadata (NOT verified in v0)
  height?: number
}

export type LLMContentPart =
  | { type: "text"; text: string }
  | { type: "image"; image: ImageInput }
```

`LLMMessage` becomes:

```ts
export type LLMMessage =
  | { role: "user"; content: string | LLMContentPart[] }
  | { role: "assistant"; content: string; toolCalls?: { id: string; name: string; args: unknown }[] }
  | { role: "tool"; toolCallId: string; content: string | LLMContentPart[] }
```

- `assistant` stays text-only (model output is text; no image generation).
- When no image is present, `content` stays a string — existing adapters keep
  working unchanged, and the audit seam `assertMessagesFromLog` (which
  JSON-compares `deriveMessages` output) still holds.

### 3.2 Session events (additive fields)

```ts
| { type: "user/message"; text: string; images?: ImageInput[]; seq?: number; source?: { kind: "plugin"; plugin: string } }
| { type: "tool/result"; callId: string; name: string; output: unknown; seq?: number }
```

`tool/result.output` is an opaque `unknown` — a tool opts into returning images
by including an `images?: ImageInput[]` property in its output object. The
registry/agent does not reinterpret it; only `deriveMessages` (and
`deriveSearchText`) read that optional property.

`CURRENT_FORMAT_VERSION` stays 1 (additive fields only; the JSONL header
versioning is untouched).

## 4. deriveMessages (the single projection)

`deriveMessages` is the audit seam F01-3 — the model only ever sees what it
derives. Rules:

1. **`user/message`**: if `ev.images?.length` → `content: [{ type: "text", text: ev.text }, ...ev.images.map((image) => ({ type: "image", image }))]`; else → `content: ev.text` (string). Text always first, images after, in event order.
2. **`assistant/message`**, **`compaction/summary`**: unchanged (text only).
3. **`tool/result`**: if `(ev.output as { images?: ImageInput[] }).images?.length` → the tool message stays `{ role: "tool", toolCallId, content: JSON.stringify(ev.output) }` (text), and an immediately-following synthetic `user` message is emitted by the projection:
   ```ts
   { role: "user", content: [
     { type: "text", text: "Attached image(s) from tool result:" },
     ...images.map((image) => ({ type: "image", image })),
   ]}
   ```
   This keeps protocol role alternation legal (Anthropic/OpenAI do not accept
   image blocks in a tool message) and matches dsh's serialize-time
   `TOOL_RESULT_IMAGE_TEXT` choice — moved to the projection layer so the
   session log stays canonical and the model-visible surface is deterministic.
   The synthetic user message is a projection artifact, NEVER a session event.
4. **Flush order**: tool/result images flush inside the existing
   `flushToolBlock` — after all pending tool results of the step, before the
   next boundary (the `step/end` flush). This keeps
   `[assistant toolCalls → tool results → (synthetic user images)]` contiguous
   within the step.

`assertMessagesFromLog` needs no change — it compares the derive output, and
the derive output now includes parts; both sides go through the same function.

## 5. deriveSearchText

Image events contribute a one-line descriptor (never the bytes):

- `user/message` with images: append
  `image: <name|unnamed> <width>x<height|?> <bytes>B base64:<8-char-prefix>` per
  image, after the text.
- `tool/result` with `output.images`: same descriptor appended to the
  `JSON.stringify(ev.output)` line.

This keeps FTS `session-query` searchable without indexing base64 blobs (dsh
makes images non-searchable — a descriptor is a middle ground that preserves
usability).

## 6. Provider capability (negative capability)

### 6.1 ProviderProfile

```ts
export interface ProviderProfile {
  name: string
  displayName: string
  protocol: ProviderProtocol
  baseUrl?: string
  apiKey?: string
  models?: string[]
  defaultModel?: string
  inputModalities?: ("text" | "image")[]   // NEW — absent = text-only (negative capability)
}
```

Explicit omission is **negative capability**: a profile without
`inputModalities` containing `"image"` is treated as text-only (dsh catalog
rule). The registry stores it verbatim; `buildModelClient` forwards it to the
adapter.

### 6.2 projectImagesForTextModel

`llm-seam` exports a pure function:

```ts
export function projectImagesForTextModel(messages: LLMMessage[]): LLMMessage[]
```

Replaces every `{ type: "image" }` part with a text placeholder
`[image omitted: model is text-only; base64:<8>]` in user AND tool-result
synthetic messages, while text parts survive. The `LLMRequest.messages` is the
input; adapters call this when `inputModalities` lacks `"image"`.

## 7. Adapter wire shaping (llm-openai / openai-compatible / anthropic)

Each adapter already maps `LLMMessage[]` → protocol body. Add a shared
`src/to-wire.ts`-style helper per protocol (a small module in each adapter, or a
shared `llm-wire` if the three shape functions are near-identical):

### 7.1 OpenAI Responses (`/v1/responses`)
```ts
// user content parts →
{ role: "user", content: [
  { type: "input_text", text: part.text },
  { type: "input_image", image_url: `data:${image.mediaType};base64,${image.dataBase64}` },
]}
```
Tool-results: in the agent path, `deriveMessages` ALREADY emits the synthetic
user message carrying the images. For the direct `LLMRequest` path (no
agent/session, host constructs messages by hand and calls the adapter), the
adapter must ALSO collapse a tool message with an images-bearing content array
into: the `function_call_output` item (text only) followed by a `user` item
carrying the images with the `"Attached image(s) from tool result:"` label —
identical to what deriveMessages produces, so both paths converge on the same
wire shape.

### 7.2 OpenAI compatible (chat completions `/v1/chat/completions`)
```ts
content: [
  { type: "text", text: part.text },
  { type: "image_url", image_url: { url: `data:${mediaType};base64,${dataBase64}` } },
]
```

### 7.3 Anthropic Messages
```ts
content: [
  { type: "text", text: part.text },
  { type: "image", source: { type: "base64", media_type: mediaType, data: dataBase64 } },
]
```

All three: when a user message's content is a string, emit the legacy text-only
shape (byte-identical to today) — the parts union is only touched when images
exist.

### 7.4 llm-mock

The mock client must accept a `user/message` with images (for e2e) and produce
`LLMStreamEvent` whose `text/chunk` carries the text parts — images are ignored
by the mock (it never emits an image tool call). This keeps existing mock-based
tests green.

## 8. Limits / validation (fail-loud, v0)

Validation happens at the **intake boundary** — where an `ImageInput[]` is first
attached to an event (core-session `append` when an event carries `images?`, and
the agent loop when it appends a user/tool event with images). `deriveMessages`
is a pure projection and does NOT throw on image fields (an image-bearing event
already validated once cannot break derive; if a malformed image somehow
reaches derive — e.g. loaded from a persisted log that predates validation —
derive treats it like any other data and the adapter's wire builder validates
again before a request is sent).

- **Media type whitelist**: `image/png|jpeg|webp|gif` only — anything else
  throws at intake (fail-loud; no silent drop).
- **Canonical base64**: `dataBase64` must be valid base64 without whitespace and
  without a `data:` prefix — else throw at intake, and the adapter re-validates
  once per request (defense against bypass).
- **Count cap**: `images.length <= 20` per message (dsh admission cap) — else
  throw at intake.
- **Aggregate byte cap**: the sum of decoded `dataBase64` lengths `<= 200 MiB`
  per message — else throw at intake. (No re-encode; a 200MiB cap bounds log
  growth.)
- These are **hardcaps**, not config knobs, in v0 (dsh makes them configurable;
  YAGNI for v0).
- `width`/`height` are host-provided informational metadata (not verified —
  there is no decode in v0); `name` likewise.

## 9. Compaction

`activeTokens` (M11, `packages/compaction/src/tokens.ts`) estimates tokens from
derived message content lengths. With parts:

- A `{ type: "image" }` part charges a fixed per-image estimate (codex uses
  ~1,844 tokens / 7,373 bytes for a resized non-original image; use a fixed
  `IMAGE_TOKEN_ESTIMATE = 1024` per image as a conservative default — no
  re-encode, no pixel math in v0).
- `deriveMessages`-based token counting walks parts: text part → chars/4;
  image part → `IMAGE_TOKEN_ESTIMATE`.
- The **summarizer input stays text-only**: M11's `maybeCompact`/`compact` seam
  derives messages from the session; when it builds the summarizer request it
  must TEXT-ONLY-project the derived messages — text parts survive, image parts
  become the `deriveSearchText` one-line descriptor (`image: <name> <w>x<h>
  <bytes>B base64:<8>`). The summary is text; image bytes are never replayed
  into the summarizer. This is the documented v0 deviation from dsh (dsh
  replays shadowed images through the same route policy; that requires the
  store milestone).

## 10. CLI

- `apps/cli` `runHeadless` is host-driven: a host attaches images
  programmatically by appending a `user/message` event carrying `images?:`
  before the run (via a pre-seeded session, cf. `resumeSessionId` restore path),
  or by driving `mockScript`. For e2e, `MockStep` gains an optional
  `images?: ImageInput[]` on its user-content step — the mock client yields a
  `text/chunk` for the text and ignores the images (it never returns image
  tool calls), while the agent/event path carries the images into the session
  and the adapter/projection handles them.
- `HeadlessOptions` gains nothing new; `ProviderProfile.inputModalities` flows
  through `buildModelClient` unchanged.

## 11. Testing

1. **core-session** (`test/session.test.ts` or equivalent):
   - `deriveMessages`: user/message with images → parts union (text first,
     images after); without images → string (byte-identical legacy).
   - tool/result with `output.images` → tool message text + synthetic user
     message with `"Attached image(s) from tool result:"` label; flush at
     step/end; survives `assertMessagesFromLog`.
   - **intake validation** (append of an event with malformed `images?`):
     invalid mediaType / non-canonical base64 / >20 images / >200MiB → throws.
   - `deriveSearchText`: descriptor line (never base64 blobs); FTS
     session-query still indexes text-only.
2. **llm-seam**: `projectImagesForTextModel` replaces images with placeholders;
   nested tool-result synthetic messages too; text parts survive.
3. **Adapters** (llm-openai / openai-compatible / anthropic): unit test wire
   shapes — text-only message byte-identical to today; image parts → correct
   `input_image` / `image_url` / `image.source.base64`; text-only provider
   (no `inputModalities`) → placeholder projection. `llm-mock` still green.
4. **core-agent + provider e2e**: an agent run with a mocked vision provider
   receives a user message containing an image → adapter emits image wire
   shape; a text-only provider → placeholder; `assertMessagesFromLog` holds.
5. **Regression**: all existing suites green — no-image path is a no-op
   (string content preserved).

## 12. Files touched

- `packages/core-session/src/index.ts` — `ImageInput`, `LLMContentPart`,
  `LLMMessage` extension, `SessionEvent` `images?`, `deriveMessages` parts +
  tool-result image flush, `deriveSearchText` descriptors.
- `packages/llm-seam/src/index.ts` — `projectImagesForTextModel`, re-exports of
  the new types.
- `packages/provider/src/index.ts` — `ProviderProfile.inputModalities` +
  `buildModelClient` forward.
- `packages/llm-openai/src/index.ts`, `packages/llm-openai-compatible/src/index.ts`,
  `packages/llm-anthropic/src/index.ts` — wire shaping + placeholder projection.
- `packages/llm-mock/src/index.ts` — tolerate image-bearing user messages.
- `packages/compaction/src/tokens.ts` — per-image token estimate.
- `apps/cli/test/cli.test.ts` — e2e.
- Tests per §11.

## 13. Global constraints (binding)

- No bun. No `@ai-sdk/*`. No new external dependencies (workspace links only).
- ESM + strict TS; tests under `test/*.test.ts` per package; pnpm workspaces.
- No version bumps; no new session event types; `CURRENT_FORMAT_VERSION` stays 1.
- Audit seam F01-3: the model only sees `deriveMessages` output; the parts
  union is the ONLY representation change — `assertMessagesFromLog` holds.
- Behavior unchanged when no image is present (string content preserved;
  text-only providers placeholders; no-image path byte-identical).

## Appendix A — reference designs (dsh v0.1.1-rc.2 + codex-rust 0.149.1)

- **dsh** `unified-image-request-pipeline`: three-layer split (normalized
  durable attachment / route-owned request version / provider file id);
  content-addressed refs in the log (v0 defers the store, keeps the principle
  "bytes never in the log" as a future migration); batch admission all-or-
  nothing; negative capability via catalog `inputModalities`; tool-result
  images ride the following user message (`TOOL_RESULT_IMAGE_TEXT`); the same
  derivation is used for compact/auxiliary streams.
- **codex** `responses` items: `InputImage` content items; `UserInput::{Image,
  LocalImage}`; local-media snapshotting bounded by caps; image-aware token
  charging + atomic image/label truncation in compaction. V0 adopts the cap
  principles and per-image token estimate; the atomic-truncation rule becomes
  relevant when the store milestone lands.
- Common: image never becomes a durable *identity* by path; provider
  capability is a negative (opt-in) catalog property.
