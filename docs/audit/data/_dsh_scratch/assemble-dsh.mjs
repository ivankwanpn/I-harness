// Assemble the final D3 dsh deliverable from the merged mechanisms + coverage + authored sections.
import { readFileSync, writeFileSync } from 'node:fs'

const DIR = 'D:/I-harness-main/docs/audit/data/_dsh_scratch'
const OUT = 'D:/I-harness-main/docs/audit/data/2026-09-11-d3-dsh.json'
const ROOT = 'D:/agent-complete/deepseek-harness-dsh-v0.1.5-rc.2'
const read = (p) => JSON.parse(readFileSync(p, 'utf8'))

const merged = read(`${DIR}/_merged-tmp.json`)
const moduleCoverage = read(`${DIR}/_coverage.json`)
const checklist = read('D:/I-harness-main/docs/audit/data/2026-09-11-d3-modules.json')

// ---- mechanisms I re-opened and confirmed myself in this session --------------
const CONFIRMED_BY_ME = {
  'in-process-delivery-tiers': 're-read packages/core/agent-loop/src/agent.ts:128-147 (send/followup/steer/inject and the waking-after-abort reclassification) and located the InboxTarget/InboxState declarations at packages/core/agent/src/types.ts:29-36, which corrected the one bad citation in the salvage',
  'fs-error-taxonomy-and-harness-error-codes': 'opened packages/fs/fs/src/types.ts around the cited lines: FsWriteIntent two-arm union and FsObservation arms present as claimed',
  'seq-contiguity-and-branded-sequence-types': 'opened packages/core/session/src/types.ts:30-58 and packages/core/session/src/index.ts:570-572; branded SessionSeq/SessionLogOffset with -0 rejection present',
  'delegation-depth-quota': 'opened packages/subagent/subagent/src/depth.ts:28-36 and packages/subagent/tool-subagent/src/index.ts:129; delegationDepthOf and the maxDepth default 3 / "provider-managed" union match exactly',
  'sandbox-mode-vocabulary-and-per-call-policy': 'opened packages/sandbox/sandbox/src/index.ts:29; the closed three-value SandboxMode union is exactly as claimed',
  'local-spill-store-session-scoped-private-write': 'opened packages/spill/spill-local/src/store.ts:109-120; mkdir 0o700, open "wx" 0o600 and the randomBytes(6) name all match',
}

// ---- hint corrections --------------------------------------------------------
const hintCorrections = [
  { module: 'guard/timeout-policy', hintWas: 'infra', assigned: 'tools', why: 'Not tooling: it is a Cordis plugin that injects ["tools"] and wraps the tools/execute call chain, arming the deadline a tool declares and mapping its own expiry to a structured TOOL_TIMEOUT result (packages/guard/timeout-policy/src/index.ts:26-31,46). It changes tool-execution semantics, which is a tools-domain capability.' },
  { module: 'context/time-context', hintWas: 'infra', assigned: 'context', why: 'A prompt-context contributor, not tooling: it renders the current time into the assembled request, validates the time zone at plugin apply and owns a refresh interval (packages/context/time-context).' },
  { module: 'session/session-format', hintWas: 'infra', assigned: 'session', why: 'The session log format-version codec contract — durability of the persisted log, the definition of the session domain.' },
  { module: 'session/session-format-catalog', hintWas: 'infra', assigned: 'session', why: 'The version catalogue the adjacent migration chain is validated against; part of log durability.' },
  { module: 'session/session-format-v0-to-v1', hintWas: 'infra', assigned: 'session', why: 'A real adjacent migration edge for persisted session logs, not build tooling.' },
  { module: 'session/session-format-v1-to-v2', hintWas: 'infra', assigned: 'session', why: 'A real adjacent migration edge for persisted session logs, not build tooling.' },
  { module: 'session/session-format-v2-to-v3', hintWas: 'infra', assigned: 'session', why: 'A real adjacent migration edge for persisted session logs, not build tooling.' },
  { module: 'client/ui-brand-official', hintWas: 'infra', assigned: 'interface', why: 'A browser-side brand asset plugin for the Web GUI, not tooling; it is client presentation, which the interface domain excludes from scope but which is still not infrastructure.' },
  { module: 'util/output-retention', hintWas: 'infra', assigned: 'context', why: 'Bounded model-facing output retention with exact omission metadata — the arithmetic that decides what the model still sees. It is honestly a library (no ctx/registration/events), but its subject matter is context, not build tooling.' },
  { module: 'preset/persona', hintWas: 'safety', assigned: 'loop', why: 'Persona/prompt content applied to an agent. It carries no confinement, permission or approval semantics, which is what the safety domain is scoped to.' },
  { module: 'identity/anonymous-user-id', hintWas: 'safety', assigned: 'ops', why: 'Stable anonymous identity generation/persistence for telemetry. No sandbox, approval or danger-classification behaviour whatsoever.' },
  { module: 'bundle/base', hintWas: 'service', assigned: 'infra', why: 'Composition manifest only: the package substance is cordis.patch.yml and src/index.ts exports {}. It serves no transport surface and grants no external consumer anything.' },
  { module: 'bundle/web-app', hintWas: 'service', assigned: 'infra', why: 'A profile patch that composes rows; the transport it enables is contributed by host/webserver and api/gateway, which are separately listed.' },
  { module: 'bundle/sdk-app', hintWas: 'service', assigned: 'infra', why: 'A profile patch selecting which already-listed services an embedder gets. Composition, not a transport surface.' },
  { module: 'bundle/sdk-minimal', hintWas: 'service', assigned: 'infra', why: 'A minimal profile patch. Composition, not a transport surface.' },
  { module: 'bundle/acp-app', hintWas: 'service', assigned: 'infra', why: 'A profile patch composing the ACP transport; the ACP implementation itself is acp/acp.' },
  { module: 'bundle/headless', hintWas: 'service', assigned: 'loop', why: 'NOT a manifest: it ships a real one-shot direct Agent driver (create one Agent via the core registry, drive to quiescence, stream reasoning to stderr, flush the Session, print final text, exit — packages/bundle/headless/src/index.ts:1-11). Driving an agent to quiescence is a loop-domain capability, and this is dsh\'s non-interactive entry point.' },
  { module: 'e2b/e2b', hintWas: 'service', assigned: 'tools', why: 'The e2b path is remote tool execution (command execution, filesystem and PTY inside a cloud sandbox), not a transport for external consumers. Its siblings e2b/fs-e2b and e2b/subprocess-e2b are already hinted tools.' },
  { module: 'web/web', hintWas: 'service', assigned: 'tools', why: 'The ctx.web service seam itself: provider registries plus provider-selecting execution for search and fetch (packages/web/web/src/index.ts:1-6). Search/fetch are model-facing capabilities, not a service transport.' },
  { module: 'web/web-fetch-http', hintWas: 'service', assigned: 'tools', why: 'A fetch provider behind the web tool, not a transport surface.' },
  { module: 'web/web-search-deepseek', hintWas: 'service', assigned: 'tools', why: 'A search provider behind the web tool, not a transport surface.' },
  { module: 'web/web-search-exa', hintWas: 'service', assigned: 'tools', why: 'A search provider behind the web tool, not a transport surface.' },
  { module: 'web/web-search-perplexity', hintWas: 'service', assigned: 'tools', why: 'A search provider behind the web tool, not a transport surface.' },
  { module: 'experimental/webworker-packer', hintWas: 'service', assigned: 'infra', why: 'A build-time packer producing the Web Worker bundle for client plugins. Build tooling.' },
  { module: 'experimental/webworker-runtime', hintWas: 'service', assigned: 'interface', why: 'The browser-side Web Worker runtime hosting client plugins off the main thread. It is client runtime infrastructure for presentation, not a backend service surface.' },
  { module: 'experimental/agent-team', hintWas: 'loop', assigned: 'subagent', why: 'Team roster identity, provisioning, durable shared mailbox and task board, runtime admission cutoff — multi-agent coordination, which is the subagent domain. Its agent-team siblings are covered there too.' },
  { module: 'experimental/agent-team-profile', hintWas: 'loop', assigned: 'subagent', why: 'Team profile definition (which roles/roster a team instantiates), a delegation concern.' },
  { module: 'experimental/agent-team-web-profile', hintWas: 'loop', assigned: 'subagent', why: 'The team profile the Web bundle ships; still roster definition, not the turn engine.' },
  { module: 'experimental/tool-agent-team', hintWas: 'loop', assigned: 'tools', why: 'A model-facing tool (agent-team), so it belongs to the tool-exposure domain even though the capability it drives is subagent-domain.' },
  { module: 'experimental/client-ui-agent-team', hintWas: 'loop', assigned: 'interface', why: 'Browser UI for the agent-team surface. Client presentation, not the turn engine.' },
  { module: 'session-query/session-query', hintWas: 'loop', assigned: 'retrieval', why: 'Cross-session search and lineage reads, which the retrieval domain scope names explicitly. It does not participate in the turn engine.' },
  { module: 'session-query/session-query-sqlite', hintWas: 'loop', assigned: 'retrieval', why: 'The SQLite index backing cross-session query — a retrieval index, not a loop component.' },
  { module: 'session-query/tool-session-query', hintWas: 'loop', assigned: 'tools', why: 'The model-facing tool wrapper over session-query. Tool exposure belongs to the tools domain.' },
  { module: 'session-query/session-log-export', hintWas: 'loop', assigned: 'session', why: 'Session log export/serialization is log lifecycle, i.e. the session domain, not the loop.' },
  { module: 'session/session-turn-outline', hintWas: 'loop', assigned: 'session', why: 'A fold over the session log producing per-turn structure — a log projection, the session domain\'s defining activity.' },
  { module: 'session/session-telemetry', hintWas: 'session', assigned: 'ops', why: 'Telemetry record capture and its export seam. Observability is the ops domain; it does not define log durability.' },
  { module: 'session/session-telemetry-otel', hintWas: 'session', assigned: 'ops', why: 'The OpenTelemetry exporter for captured telemetry records — observability, not log durability.' },
  { module: 'session/session-title', hintWas: 'session', assigned: 'retrieval', why: 'Session titling is a derived, searchable summary of a session — retrieval-domain derivation, not log durability.' },
  { module: 'session/session-title-llm', hintWas: 'session', assigned: 'retrieval', why: 'The LLM-backed titling driver; same reasoning as session/session-title.' },
  { module: 'session/session-title-first-prompt-llm', hintWas: 'session', assigned: 'retrieval', why: 'A title provider over the session log — retrieved summary, not durability.' },
  { module: 'session/session-title-all-prompts-llm', hintWas: 'session', assigned: 'retrieval', why: 'A title provider over the session log — retrieved summary, not durability.' },
  { module: 'context/session-reference', hintWas: 'session', assigned: 'retrieval', why: 'Cross-session snapshot preparation: exact reads, projection and budgets across OTHER sessions (packages/context/session-reference/src/index.ts:1-5). It is cross-session retrieval; it never owns the receiving session\'s durability. (It also feeds pre-step context, which is why context is defensible — noted rather than hidden.)' },
  { module: 'llm/token-meter', hintWas: 'model', assigned: 'context', why: 'Token accounting over the assembled context, including replay-aware folding of prior metering events. It measures the context window; it is not a provider, credential or wire-protocol concern.' },
  { module: 'llm/plugin-package-inventory-deepseek', hintWas: 'model', assigned: 'extension', why: 'Package inventory exposed as plugin metadata for the plugin surface — extension-domain inventory, not a model capability.' },
  { module: 'goal/tool-goal', hintWas: 'tools', assigned: 'subagent', why: 'The goal tool drives durable goal state and automatic continuation, a delegation/extension capability. Only its exposure is tools-domain.' },
  { module: 'jobs/tool-jobs', hintWas: 'tools', assigned: 'subagent', why: 'The jobs tool exposes the background-job registry whose parent-wake semantics are a subagent capability.' },
  { module: 'workflow/tool-workflow', hintWas: 'tools', assigned: 'subagent', why: 'The workflow tool drives subagent fan-out orchestration.' },
  { module: 'workflow/tool-ralph', hintWas: 'tools', assigned: 'subagent', why: 'The Ralph tool drives fresh-agent iterative rounds — a delegation capability.' },
  { module: 'todo/tool-todo', hintWas: 'tools', assigned: 'extension', why: 'The todo tool writes the durable todo list. The extension domain scope names "todos and goals as durable extension state".' },
  { module: 'schedule/schedule', hintWas: 'subagent', assigned: 'extension', why: 'Durable timer/schedule wakeups. The extension domain scope names scheduling explicitly; recorded here as a boundary call between subagent and extension.' },
  { module: 'skill/tool-skill', hintWas: 'tools', assigned: 'extension', why: 'The skill tool loads a skill\'s instructions; skills are named in the extension domain scope.' },
  { module: 'skill/skill-filesystem', hintWas: 'tools', assigned: 'extension', why: 'The filesystem-discovered skills provider — a skills-source concern, named in the extension domain scope.' },
  { module: 'lsp/tool-lsp', hintWas: 'tools', assigned: 'extension', why: 'The LSP tool; LSP is named in the extension domain scope.' },
  { module: 'interaction/tool-ask-user', hintWas: 'tools', assigned: 'extension', why: 'The ask-user tool belongs with the question/approval interaction surface rather than the tool-execution domain.' },
  { module: 'webhook/webhook-github', hintWas: 'tools', assigned: 'service', why: 'GitHub payload shaping over the outbound webhook delivery service; its sibling webhook/webhook is already hinted service.' },
  { module: 'subagent/tool-subagent', hintWas: 'tools', assigned: 'subagent', why: 'Recorded as a boundary call: the delegation protocol (depth quota, provider gate, settlement) is subagent-domain, and only the tool\'s schema/validation face is tools-domain. Kept in subagent so the delegation protocol stays in one row.' },
  { module: 'subagent/tool-subagent-control', hintWas: 'tools', assigned: 'subagent', why: 'The control half of the delegation protocol (message/steer/interrupt/collect over an existing child), kept with the protocol for the same reason.' },
  { module: 'client/ui-permission-presets', hintWas: 'safety', assigned: 'interface', why: 'The browser UI for permission presets. The permission rule model itself lives in interaction/permission-presets (safety); this package is presentation.' },
  { module: 'client/ui-approval', hintWas: 'safety', assigned: 'interface', why: 'The browser UI for the approval flow; the approval service is interaction/user-approval (safety).' },
]

// ---- pluginKernel ------------------------------------------------------------
const pluginKernel = "Cordis service/plugin kernel. Every capability package in dsh IS a Cordis plugin, and the kernel is how those packages become a running product. A package contributes a capability by (1) exporting a plugin contract — a `name` for loader diagnostics plus an optional `inject` array of service keys that gates activation on their availability — and (2) either augmenting Cordis' Context via `declare module '@deepseek-ai/cordis' { interface Context { <key>: <Service> } }` or subclassing `Service` and registering itself under a string key in its constructor (`super(ctx, 'compaction')`, `super(ctx, 'typert')`). The tree contains 111 Context interface augmentations, 82 `extends Service` classes and 199 `export const inject` declarations, so the idiom is universal rather than incidental. COMPOSITION IS BY DECLARATIVE PATCH, not by import: each bundle package ships a `cordis.patch.yml` declared in package.json under `dsh.bundle.patch`, and the profile composer applies those patches as ordered insert layers over an empty profile root, addressing rows by `id` with last-write-wins per row (bundle/base inserts the shared core, bundle/headless|web-app|sdk-app|sdk-minimal|acp-app restate mode-specific rows). Row order carries no load semantics — activation is service-availability driven, and a row can be `disabled: true`. CONSEQUENCES THAT SHAPE EVERY DOMAIN: (a) capability ABSENCE is representable — an unmounted plugin simply leaves its Context key undefined, and dsh relies on this as a real signal (context's turnBoundary projection documents an absent key as 'no agent loop loaded', capability absence rather than corrupt state); (b) providers are registered per service and a second registration for a single-provider service is refused; (c) cross-domain composition happens by wrapping, not editing — guard/timeout-policy declares `inject = ['tools']` and wraps the tools/execute call chain, fs/fs-observation-policy wraps filesystem mutations, extensions/tool-cordis loads a user-authored extension at runtime; (d) the same kernel carries the scoped child contexts that give per-agent and per-session isolation (core/scope's createScope/scopeTarget) and the event dispatch modes the domains build on (emit is contained and non-vetoing, serial is awaited in order, waterfall is around-middleware); (e) the kernel is also the RPC substrate: typert registers typed endpoints as a Cordis service (`ctx.typert`) and generates the Remote faces, which is why dsh's operations are reachable as RPC rather than as slash commands. Load-bearing invariants: a plugin's `inject` list is the activation gate, so an undeclared dependency is a startup error rather than a runtime undefined; a service key is owned by one registration; and plugin teardown is fiber-owned, so unloading a domain retracts exactly the registrations it made."

const pluginKernelEvidence = [
  'packages/compaction/compaction/src/index.ts:81-99',
  'packages/typert/registry/src/service.ts:446-455',
  'packages/bundle/base/src/index.ts:1-9',
  'packages/bundle/base/cordis.patch.yml:12',
  'packages/bundle/base/cordis.patch.yml:15-23',
  'packages/bundle/base/package.json:41-45',
  'packages/guard/timeout-policy/src/index.ts:26-31',
]

// ---- assemble ----------------------------------------------------------------
const perDomain = Object.fromEntries(
  Object.entries(merged.domains).map(([d, a]) => [d, a.length]))
const totalMechs = Object.values(perDomain).reduce((n, c) => n + c, 0)
const totalEvidence = Object.values(merged.domains).flat()
  .reduce((k, m) => k + m.evidence.length, 0)
const totalConstants = Object.values(merged.domains).flat()
  .reduce((k, m) => k + m.constants.length, 0)

const out = {
  source: 'dsh',
  sourcePath: ROOT,
  moduleCount: checklist.sources.dsh.modules.length,
  domainsCovered: Object.keys(merged.domains).length,
  mechanismCount: totalMechs,
  evidenceCitations: totalEvidence,
  constantsCaptured: totalConstants,
  pluginKernel,
  pluginKernelEvidence,
  domains: merged.domains,
  moduleCoverage,
  hintCorrections,
  domainsAbsent: [],
  coverageAccounting: {
    checklistModules: checklist.sources.dsh.modules.length,
    unmappedFromChecklist: checklist.sources.dsh.unmapped,
    totalAccountedFor: checklist.sources.dsh.modules.length + (checklist.sources.dsh.unmapped?.length ?? 0),
    coverageEntries: Object.keys(moduleCoverage).length,
    uncovered: [],
    note: 'Validated by resolving every listed module (plus the one `unmapped` entry core/scope) against these glob patterns: 268/268 resolve to at least one entry, and no entry is dead. Patterns cover the uniform groups; where a namespace is NOT uniform the non-uniform members are listed by exact name instead (e.g. client/connection, client/file-upload, client/hmr, client/modules are named individually rather than absorbed into client/ui-*).',
  },
  verification: {
    salvagedFrom: '_dsh_scratch/ (this deliverable merges every parseable artifact found there from the interrupted prior run: _mine-loop, _mine-context, session, subagent, _fs_raw, _shell_partA-E, _spill_raw, safety-model, service-interface-ops, ext-retrieval).',
    citationsChecked: totalEvidence,
    citationsResolved: 3252,
    citationsUnresolvable: 1,
    citationNote: 'Every evidence string in every entry was parsed as path:line[-line] and checked for file existence AND line-range validity against the source tree. 3252/3253 resolve. The single failure (packages/core/agent-loop/src/types.ts:29-36, in loop/in-process-delivery-tiers) was a wrong package path and has been corrected to packages/core/agent/src/types.ts:29-36 after I located the declarations myself.',
    verifiedFlagMeaning: 'true = the prior agent states it opened the cited lines with the read tool (its own claim; see citationsChecked for the machine-checked part).',
    independentlyConfirmedByThisAgent: CONFIRMED_BY_ME,
    independentlyConfirmedCount: Object.keys(CONFIRMED_BY_ME).length,
    notRechecked: 'The remaining 309 entries were NOT individually re-opened by this agent. Their citations are machine-validated (file exists, line range in bounds) and the 6-entry sample I did open matched its claims exactly, but the claims themselves should be treated as single-source until an adversarial pass samples them.',
    repairsMade: [
      '_shell_partA.json was corrupt and unparseable (no JSON parser would read it): mechanisms[24].what (pwsh-prompt-sentinel-and-echo-stripping) contained unescaped inner double quotes and unescaped <, > and backtick characters. Repaired with \\u0022/\\u003c/\\u003e/\\u0060 escapes; the file now parses and its 25 mechanisms are included. The `what` prose was recovered in full (it was not truncated).',
      'loop/in-process-delivery-tiers: corrected the one wrong evidence path.',
      'loop/in-process-delivery-tiers: completed an invariant string that ended mid-clause ("...must").',
      'bundle/headless: corrected a coverage note I had initially written as "profile bundle only" — the package ships a real one-shot Agent driver.',
    ],
  },
  notes: merged.notes.join('\n\n'),
}

writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`, { encoding: 'utf8' })
const bytes = readFileSync(OUT).length
process.stdout.write(JSON.stringify({
  written: OUT, bytes,
  source: out.source, moduleCount: out.moduleCount,
  domainsCovered: out.domainsCovered, mechanismCount: out.mechanismCount,
  evidenceCitations: out.evidenceCitations, constantsCaptured: out.constantsCaptured,
  coverageEntries: Object.keys(moduleCoverage).length,
  hintCorrections: hintCorrections.length,
  domainsAbsent: out.domainsAbsent.length,
  perDomain,
}, null, 2) + '\n')
