# Instruction cutover retirement

Status: approved for execution after IC-B acceptance at `2e9307af2e48405fbf755362b2a3248e0ca5d32a`.

Authority: the integrated v0.1.13 delivery spec and accepted main instruction consumer. This is removal of replaced paths, not the deferred general decomposition programme. Keep version 0.1.13-rc.1, Session format 12, protocol behavior, and current observation/publication ownership unchanged. No push, tag, release, or live provider requests.

## Task 1: retire replaced instruction APIs and migrate their real controls

Recheck source and package consumers at the assigned BASE. Root's preflight found no shipping consumers of `createInstructionsSection`, `installRuntimeContext`, or the synchronous legacy instruction helper chain. Both packages are private workspace packages. Historical inventories are evidence, not a promise to keep an unused API. Report a genuine supported external contract before changing that contract.

Remove the synchronous wrapper, legacy-only exports/types/constant and `files.ts` in `packages/instructions` only after confirming they are unused by the accepted observed service. Preserve all current discovery, limits, dependencies, observation, recovery and host controls. Retire `instructions.test.ts` cases that exclusively specify the removed ambient-home/ancestor/character-slicing API; list exact test dispositions.

Remove only `installRuntimeContext` and its unused import in `packages/runtime-context/src/index.ts`. Do not alter `createRuntimeContext`, original-publication settlement, or its lease behavior. Remove wrapper-only tests in runtime-context, preserving standalone current snapshots, deduplication, rewind and resource-lifetime assertions. Remove a direct package dependency and its lock importer only if no real production or test consumer remains.

Two additional test consumers are in scope and must not silently disappear:

1. `packages/core-agent/test/current-context-loopback.test.ts`: retain actual HTTP/native-signature/tool-result ordering/current-once, skills-only, explicit-clear, reduction protection and lost-publication/close controls. The test's low-level current publisher may use `createRuntimeContext` explicitly at the source update boundaries; label that boundary honestly. Do not recreate a test-only pre-step wrapper. Shipping logical-admission behavior is separately covered by the accepted actual main assembly tests.
2. `packages/session-executor/test/managed-producers.test.ts`: remove the obsolete `createInstructionsSection` mock. Use a temporary scoped AGENTS.md fixture and the actual supported assembly path. Replace the no-longer-supported pre-step snapshot trigger with an actual Agent/admission control: hold the real runtime/context receipt and prove publication/model visibility cannot pass it, then release and assert the exact current snapshot reaches the model once. Count runtime facts separately from legitimate input/step facts. Preserve the other producer/unknown/deduplication controls and original failing receipt; do not restore the removed shipping hook just for the test.

Update only the obsolete runtime/current and instructions paragraphs in `docs/CAPABILITIES-DETAIL.md` to the accepted owned logical publication, scoped observed files and UTF-8 budget behavior. State child/native mutation/UI qualification is still pending. Leave historical audit documents unchanged.

## Validation and review

Run instructions and runtime-context suites and typechecks; core-agent current-context loopback; executor managed-producers and short actual main instruction/source freshness/publication controls; affected core-agent/executor typechecks. Use package-CWD Vitest sequentially with maxWorkers=2/minWorkers=1. Preserve setup and obsolete-oracle RED results separately from product regressions.

Compare accepted current/observed service bodies before/after. Reuse the long 257-request evidence only if its executed implementation remains unchanged; do not claim file or bundle identity. Re-run original CLI build, Gateway package-copy owner, and reachability gate for changed exports/dependencies. Do not reseed, add exemptions, or create fake consumers. Explain remaining rows honestly.

Record full BASE..HEAD, changed paths, test dispositions, raw receipts and source manifests in this plan's SDD directory. Stop writing after delivery; root obtains a fresh full-range spec and quality review before integration. No whole-feature/release-complete claim from this retirement.
