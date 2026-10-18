# ContextEngine R1A semantic projector implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development task-by-task. All delegated roles GPT6.1Sol. Continue the already authorized R0–R6 program.

**Goal:** Replace the message-only projection implementation with one semantic projector carrying explicit source, provenance and tool-exchange metadata while preserving valid provider requests.

**Architecture:** core-session owns one fold into ConversationProjection; renderer exposes existing LLMMessage arrays; legacy APIs become facades. No context-engine package, persistence schema bump, auth or new compaction decision owner in R1A.

**Tech Stack:** Existing TypeScript, Vitest, Node and real six-route e2e corpus.

**Spec:** `docs/superpowers/specs/2026-10-15-context-engine-r1-contracts.md`, plus approved main design/framework and overlap mapping.

## Global Constraints

- Work D:/I-harness-main, codex/v0.1.13-development, one product writer. Workers never spawn agents or push/merge/publish/install; root supplies independent review.
- No live providers, account/profile/installed-app mutations, new dependencies, unrelated branch/worktree changes, broad repo suites, reachability reseed or weakened assertions.
- Product version0.1.13-rc.1; session format remains2 for this unit. The original27/43 decomposition count stays unchanged.
- Keep maintained modules near150–400 lines, functions normally<=120, facade150–250 or smaller; no all-locals mutable deps bag, utils dump, duplicated fold/state owner, or source-code minification.
- Existing tests/scripts are not split. Add meaningful behavior tests; preserve native distinctions and genuine unsupported/unknown evidence.
- Valid existing LLMMessage/wire output is byte-equivalent; new provenance/diagnostics are additive metadata. R1B later changes accepted-response semantics explicitly.

## Task 1: Shared semantic projector with legacy fidelity and source provenance

Read this task and `docs/superpowers/specs/2026-10-15-context-engine-r1-contracts.md` first. It defines exact DTO names/fields/API and provenance rules. This is the next unit after R0 corpus review. Work only D:/I-harness-main; no recursive agents or remote/live side effects. Root supplies baseline SHA and report path.

**Files:**
- Create `packages/core-session/src/conversation/{types,sources,visibility,legacy,project,render}.ts`; only meaningful responsibilities, no empty scaffolding. Additional cohesive `exchange.ts` allowed if needed to keep fold ownership readable; report it.
- Modify `packages/core-session/src/projection/messages.ts` into API facades, preserving `deriveMessagesUpTo` prune/time semantics.
- Modify `packages/core-session/src/index.ts` exports and package README maintenance map.
- Add `packages/core-session/test/conversation-projection.test.ts`.
- Modify `e2e/context-corpus.e2e.ts` only for the carried R0 ownership test below; do not split existing suite.
- No schema/version/serialization/writer changes in this unit; no new runtime policy.

**Consumes:** Session/SessionEvent, existing LLMMessage/ProviderContinuation, prune and rewind helpers, durable admission provenance, header.seedLength/parentSession.
**Produces:** `projectConversation(session, options?)`, `renderConversation(projection)`, and the exact Conversation* DTOs in the R1 contract. Existing derive APIs delegate to these. All production consumers continue using the public package entry; no parallel legacy fold remains.

**Mandatory behaviors and independent tests:**

1. Exact valid baseline messages for plain human/assistant, closed tool exchanges, parallel reverse-order results, mid-step reminders, tool images, compatible native sidecars and stepless legacy groups. Projection's exchange source refs must map to actual call/assistant/result records; no invented native order.
2. Live and JSONL-restored identical semantic items/IDs when event coordinates are valid. ownerSessionId isolates source IDs. Missing/duplicate legacy seq marks addresses unsafe and diagnostics, without granting authority or silently changing existing rendered content.
3. Current repaired compacted-step semantics remain: summary hides step/start but later accepted legacy assistant+calls+results stay grouped; shadowed end/failure remain boundaries; rewind branch lifecycle is excluded. Existing prune substitute/prefix behavior and no-unshadow rules preserved.
4. Failure/aborted/unresolved groups: no fabricated success/result, audit-only failed content stays out of render; explicit error/not-dispatched/unknown outcome evidence remains truthful. Orphan results and ambiguous IDs produce scalar diagnostics. Do not assume any raw object with a code field proves a synthetic producer.
5. Provenance: explicit matching human admission→request; plugin/internal/system/synthetic→observation; summary→derived; plain legacy user→unknown; seed-range child events→inherited. An origin's human status does not confer new child-local human authority. No text keyword classifier.
6. Source projection is pure: original session/event JSON and headers unchanged; renderer returns new array/container objects. R1A does not falsely claim deeply frozen arbitrary unknown event payloads; R1C captures that boundary.
7. Render all selected full exchange bundles including tool-image companions without separating calls/results. Input/reminder items preserve their own source/provenance and output positions. No hidden full archive payload is retained solely to render active messages.
8. Carried R0 Minor (`task-1-review.md: ownership-oracle sensitivity`): after mutating caller objects, physically send both the original prepared handle and its pre-created output-cap derivative for all six routes, asserting both retain their original semantic/native input and respective caps/packet sizes. Keep separate captures and concrete wire assertions; this closes a prepare alias regression that derivative cloning might mask.

Example API assertions (use real source data, not mocked projector):

```ts
const projection = projectConversation(session, { ownerSessionId: 'parent' })
expect(renderConversation(projection)).toEqual(expectedMessages)
expect(projection.items.find(i => i.kind === 'exchange')?.exchange?.calls.map(c => c.callId)).toEqual(['a','b'])
expect(projectConversation(legacyUser).items[0]?.provenance.authority).toBe('unknown')
expect(projectConversation(childSeed).items[0]?.provenance.kind).toBe('inherited')
expect(toJSONL(session)).toBe(originalJsonl)
```

- [ ] **Step1: Baseline.** Run core-session full suite and typecheck once, plus current R0 corpus (57 cases) if no same-head recorded result covers the exact baseline. Sequential `--maxWorkers=2 --minWorkers=1`. Save real logs/exits in this plan's workspace. Do not rerun unchanged adapter package suites.
- [ ] **Step2: RED.** Add semantic source/exchange/provenance API tests first. The new API is missing; record that expected RED. Add assertions against concrete source refs and outcomes, not only equality with deriveMessages (which will delegate to this implementation). Existing golden corpus remains independent wire oracle.
- [ ] **Step3: Implement one fold.** Move repaired visibility/grouping semantics into bounded modules, enrich emitted items at their authoritative source boundary, and render message arrays. No second fold or opaque post-hoc guess from the flattened message array. Preserve callable public signatures and old valid wire behavior.
- [ ] **Step4: GREEN and carry fix.** Run focused new tests while iterating. Strengthen original-handle corpus assertion before final runs; show it physically captures both handles. Final core-session full suite/types, core-agent `test/agent.test.ts` and `test/context-recovery.test.ts` (confirm filenames), and six-route corpus/e2e types. Run any additional narrow consumer only for a named changed boundary; all suites sequential maxWorkers2/minWorkers1.
- [ ] **Step5: Structural/audit gate.** Record before→after file/function sizes, exports, state owners and any exception. If existing reachability depends on moved ownership, run its actual before/after comparison and adapt only exact owner paths; no reseed/allowlist/fake consumer. A newly exported semantic API used by real facade is legitimate; tests alone are not a production consumer. `git diff --check` passes.
- [ ] **Step6: Commit and report.** Commit scoped change `refactor(session): project typed conversation sources and exchanges`. Report RED/GREEN, all actual commands/exits, concrete source/compatibility proof, corpus carry fix, ownership changes and remaining limitations. Root conducts fresh spec/quality review; do not spawn one yourself.

## Continuation

After clean review, root fixes R1B's exact format3/fence/accepted-event/input-provenance write contracts and proceeds. R1A alone does not claim structural selection, all input protection, immutable request snapshot, persistence upgrade, transactional compaction, or any S/CX completion. Those follow within the already approved execution.
