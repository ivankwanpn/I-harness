# WSL2 product integration

User authorisation: continue the existing experiment until it is a genuinely usable feature. The user subsequently supplied Codex configuration screenshots and asked to follow their separation of approval, three sandbox modes, four web access/search modes and managed workspace dependencies. Continue on `codex/wsl2-sandbox-experiment` from `1c46040e`.

## Product outcome

Windows users can select WSL2, select an installed distribution, inspect its dependencies and run Linux Bash through CLI and Desktop agent tools. Foreground/background shell, Code Mode and child agents use the same captured execution context and authority. Native host helpers are deliberately routed as host operations before preparation; no error-triggered backend retry occurs. The shipped CLI and Desktop contain the exact worker assets, independent of the source checkout.

## Configuration and semantics

Keep `windowsSandboxBackend` as `legacy | psec | wsl`. Add `wslExecution: { distribution: string, networkAccess: boolean, workspaceDependencies: boolean }` with default distribution `Ubuntu`, networkAccess false and workspaceDependencies true. Existing backend default stays legacy. New assemblies capture the configuration; existing running executions retain their backend. UI describes when new assemblies use changed settings and shows actual assembly status.

The sandbox choices are read-only, workspace-write and danger-full-access. In WSL: RO has a read-only caller-visible filesystem; WW rebinds captured writable roots and private tmpfs /tmp; full access permits caller filesystem writes outside the project but still locks explicit references. Network defaults off for RO/WW, and on for full access; the explicit networkAccess option enables networking in the confined modes. Namespace/process ownership, trusted launcher environment, consumed mount FDs, interop masking and Unix socket/io_uring restrictions remain active. Full access does not become a Windows escape hatch.

Web access/search is independent of command networking. Add `webSearchMode: disabled | cached | indexed | live`. New configurations default cached; persisted older configurations without this field preserve their prior live webfetch behaviour. Disabled rejects/excludes web access; cached reads bounded stored pages/search results without fetching; indexed permits external page fetch only through URLs admitted by the configured search provider/index; live permits normal HTTP(S) fetch/search. IH uses its own configured provider and local cache, not an invented OpenAI index. No search provider means no callable websearch; webfetch reports real mode/miss/availability. All results retain the existing external-content trust notice.

## Trusted execution target

Add optional `executionTarget: host | wsl` to captured process/exec requests; omitted means host. It is assigned by registered host tools, not accepted as a new model permission parameter. Backend selection sees the detached specification. WSL requests bypass Windows PATH resolution and Windows case-insensitive environment rewriting; source shell bindings supply explicit Linux argv/environment. Host requests keep native execution behaviour. Target, distribution/options and executable binding participate in approval identity/context so a changed environment cannot reuse a prepared approval blindly.

WSL Agent Shell resolves to Linux Bash; bash/shell tools execute there, use guest path information in the prompt, and avoid Windows startup profiles. Explicit native PowerShell and native trusted search/LSP/helper operations retain a distinct host target; they are not retried through WSL. Agent tool availability/description must be truthful when a surface is unsupported. Native human terminal remains a separate existing surface.

Current background shell requests use retain-tree, whereas the experiment has only complete-tree. Give WSL foreground promotion and background capture an explicit root-bound complete-tree lifetime, with corresponding job metadata and descriptions; do not claim descendants survive a completed command. Exact transport requests retain their requested semantics and refuse unsupported PTY/retain-tree. This matches a usable pipe/background job feature without silently claiming a Linux PTY implementation.

Reference locks need a separate capability from general deny-path isolation. Add optional `referenceProtection` requirement/probe feature; old denyPaths-capable drivers satisfy it, and WSL advertises its verified readonly-reference protection. Do not weaken the current compiler's overlap or owner/revocation fences.

## Practical preparation

Preflight already demonstrated a real desktop project refused by the experiment's two-second inventory budget. Improve metadata enumeration using kernel mount metadata/statx or equivalent descriptor-safe operations; avoid redundant per-file opens/readers while preserving no-follow, nlink, mount, ancestry and stale-inventory checks. Use finite larger production limits, cancellable/progress-aware preparation and a bounded preparation deadline distinct from short control-write deadlines. Admit internal-only hardlinks only when all inode links are accounted for within the captured writable roots; otherwise refuse. Never omit dependency/git directories merely to make tests pass. No stale persistent inventory cache may grant authority.

Provide diagnostics containing discovered WSL2 distributions, Python/Bash/bubblewrap usability, Linux toolchain availability, network policy, exact backend and actionable failure reason. Normal unsupported/unsafe layouts refuse cleanly. Preserve the original experiment's safety invariants and recorded RED evidence.

## Managed dependencies

Expose a Codex-style workspace-dependency toggle, diagnose and repair/retry actions. Existing Python/bubblewrap are inspected without changing WSL configuration. Managed Linux Node/npm may be installed in a versioned IH-owned runtime cache when explicitly allowed by this setting/action, with pinned official artifact digest, archive limits/path validation, staging and atomic promotion. No automatic apt/sudo, global package installation, password access or distribution reconfiguration. Missing system prerequisites produce exact repair instructions. Tests and local qualification use repository-owned cache/settings/artifact roots only. Linux executable PATH entries point to captured managed assets; cached tools are read-only to the task.

## UI and packaging

Use the current settings row/group style with concise Chinese labels and dropdown descriptions matching the supplied Codex reference: approval, sandbox access, web access, WSL execution and workspace dependencies are distinct controls. WSL-specific controls appear when selected, with distribution selector, runtime diagnosis and networking explanation. Preserve IH's existing approval vocabulary rather than inventing unsupported Codex policies.

Copy/verify the package-owned worker and runtime metadata into CLI and Desktop builds. Fixed loaders recognise source and packaged paths. Build candidates only in new repository-local task directories; do not replace/publish the official release or install the candidate into the user's existing app.

## Acceptance

- Existing legacy/psec settings and native tools remain compatible; WSL config normalisation/roundtrip and actual new assembly selection work.
- Real Desktop and CLI tool calls, Code Mode and child context run Linux Bash with the selected mode, distribution and captured environment.
- Real source projects including Desktop-sized trees admit within a measured finite budget; unsafe hardlinks/mounts/path changes still refuse, with cancellable preparation.
- RO/WW/full-access and both networking states have controlled file/network effects; explicit reference data is preserved.
- Background/promotion, cancellation, owner isolation, reference revocation, missing runtime and transport failure produce truthful lifetime/cleanup facts.
- Four web modes have observable cache/index/live/disabled behaviour; redirects and provider changes cannot widen indexed access; no provider does not fabricate search.
- Managed dependency download/install uses only a pinned official artifact and controlled cache, and disabled setting does not install.
- Real packaged CLI/gateway consume worker assets without source lookup; Desktop settings controls and installed-runtime diagnostics work in UI tests and a candidate runtime.
- TDD, task reviews, final review, relevant tests/typechecks and reachability/production graph gates pass. The previously blocked native nested-mount witness is not retried; conservative mount-ID refusal is maintained.
