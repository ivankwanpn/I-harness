# Media and session controls implementation plan

> **For agentic workers:** Use executing-plans for implementation and verification. Work is authorized by the user's image, video, Stop, archive, and shared-sidebar requests.

**Goal:** Restore usable conversations after malformed image output, support visual and audible video content, and make conversation navigation and controls consistent.

**Architecture:** A shared image-validation leaf validates decoded content before tool admission and quarantines invalid historical images only in outgoing provider projections. A shared media tool decodes local video with bounded native processes and sends audio to a separately configured provider model. Desktop uses one retained ProjectSidebar and authoritative running/idle state.

**Tech stack:** TypeScript, React, Vitest, Electron, Sharp, FFmpeg/FFprobe.

**Evidence:** The original corrupt PNG has SHA-256 a4bcd7b80c65e14e3809783fc4c587ce66a995dcc142e25bf61c9337ef6f3443 and invalid IDAT CRC/zlib data. It replayed at Anthropic messages[105].content[1]. Completed reusable children were incorrectly rejected as active. Pending rewind is independent of title.

## Constraints

- Keep original user session files unchanged.
- Never silently describe unread audio as analyzed; report partial coverage.
- Keep current-turn cancellation separate from queued inputs and independent child ownership.
- Retain genuine pending rewind and durable-work archive guards.
- User chose the existing project-grouped sidebar for both Home and project entry points.
- Use synthetic media and mocked provider transport for tests; no live paid inference.

## Image validation

- [x] Reproduce exact bad PNG through Code Mode and real Anthropic wire projection.
- [x] Add strict container/pixel validation in `packages/image-validation`, bounded child lifetime/concurrency/cache, and real PNG/JPEG/GIF/WebP fixtures.
- [x] Order Code Mode output admission and completion so validation precedes persistence and observations.
- [x] Validate `attachment` save/read and add immutable image projection to all five real adapters.
- [x] Cover historical tool output, valid neighbors, byte identity, tool adjacency, cancellation, and animation truncation.
- [x] Verify native decoder from the shipped Electron gateway.

## Conversation controls and shared navigation

- [x] Reproduce running-state loss after selection and missing Stop with follow-up drafts.
- [x] Restore running from ordered queue snapshots; retain Stop while sending/drafting; cancellation acknowledgement does not imply settlement.
- [x] Permit waiting children only after checking ended turns, consumed inbox, empty mailbox, and no live resources.
- [x] Join already-scheduled live rewind finalizers and retain unresolved cold recordings.
- [x] Localize archive blockers and cover named/unnamed sessions.
- [x] Replace HomeSidebar with one retained ProjectSidebar; preserve expansion, scroll, management menus, and read-state routing.

## Video and audio

- [x] Add `read_video` to shared assembly, with bounded duration/frame/file limits and subprocess cancellation.
- [x] Decode real video frames and PCM; normalize WAV container lengths; mark sparse frame timestamps approximate.
- [x] Add explicit `llm.videoAudio` selection, provider-runtime audio request, Desktop setting, and both CLI/Desktop callbacks.
- [x] Add external/native-picked video references without placing media bytes into prompt history.
- [x] Cover real synthetic video+sound, silent video, disguised playlists, corrupt frames, audio route credentials, header collisions, and unconfigured/failed audio.
- [x] Verify dependency payload and application packaging, then run the complete Desktop suite.

## Delivery

- [x] Review final diff and resolve findings.
- [x] Build a separate 0.1.5 local candidate and record verification evidence.
- [x] Report exact support limits and configuration, with a usable local artifact.
