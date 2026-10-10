# Claude plugin startup Hooks compatibility

The user corrected the previous Desktop treatment of official Claude plugins: fetching, installing and using plugins from `anthropics/claude-plugins-official` is an existing supported workflow. The September real-marketplace acceptance proved superpowers skills were available to a model. It explicitly left Claude Hooks adaptation out of scope, and the CLI subsequently contained non-native Hook load failures so they could not brick unrelated plugin components. The 0.1.2 format diagnostic describes that implementation gap; it is insufficient as the functional repair now requested.

This change connects the concrete installed superpowers synchronous `SessionStart` command. The official explanatory-output-style plugin uses the same event/output contract. It does not claim implementation of every Claude lifecycle event or HTTP, prompt, agent, conditional, or asynchronous Hook type. Unsupported declarations receive individual diagnostics, and supported sibling handlers remain usable.

## Runtime and source ownership

The existing native v1 parser and authored Hook policy remain strict. Trusted hosts explicitly opt in an installed plugin root, obtained from the plugin registry's installed `hooks/hooks.json` paths. Desktop adaptation is restricted to `<configDir>/plugins/<id>/hooks/hooks.json`; project and global authored configurations do not gain this opt-in. The adapter produces runtime-only Claude metadata; native JSON cannot supply it to bypass native validation.

SessionStart receives its actual session identity, project directory and start source. Fresh assemblies use `startup`; restored conversation history uses `resume`, and the choice remains fixed across trust refreshes on that assembly. An installed matcher excluding resume is respected. Existing native lifecycle behavior is preserved.

On Windows, the process explicitly chooses Git Bash and makes its bin available to nested Bash launchers, avoiding the WSL launcher called `bash.exe` on PATH. Paths are provided through environment values; the adapter preserves shell command text rather than inserting path text into shell code. Per-plugin and per-project environment values are set, while other platform selector variables cannot redirect the official script output format.

## Approval and content

Enabling a plugin is not an implicit script grant. Existing user-layer Hook approvals remain authoritative. Claude plugin grants cover a bounded deterministic plugin content tree, including the Hook config, wrapper, actual scripts and skill resources. Git metadata is excluded, links and escaping paths are rejected. The digest is rechecked before actual execution. The UI and CLI explicitly state that the grant covers the plugin content and supported handlers sharing that reviewed configuration.

Approvals re-read current content and handler identity; an old UI confirmation cannot approve a changed bundle. A changed plugin tree requires a new grant. Installed user plugin files are read only during development; executable qualification uses an owned isolated copy or fetched installation and an isolated trust store.

## Context delivery and lifecycle

Only successful trusted SessionStart output is cached. Claude event-specific `hookSpecificOutput.additionalContext`, top-level additionalContext, successful plain stdout, and empty output have explicit handling. Following the official stdout shape rule, only text starting with `{` and ending with `}` enters JSON validation; other text remains plain context. Invalid complete-object JSON or schema, mismatched event names, nonzero exit, missing shell and timeout are diagnosed and cannot publish context. Existing native output validation remains unchanged.

Registry context is read dynamically by both main and child model prompts, including independent children with no forked history. It composes with existing goal, policy and project context; it does not replace them or rewrite conversation history. Startup execution is deduplicated across unchanged refreshes. A newly granted handler can activate on the existing assembly. Revocation, content mismatch, disposal and plugin removal withdraw context. Generation guards prevent an in-flight handler from republishing after its trust or owning registry changed.

## Verification

Behavior tests cover approval before execution, plugin-tree tamper including a skill resource, precise stale-grant rejection, same-assembly live activation, repeated-refresh deduplication, revoke/disable withdrawal, main/child dynamic context, resume matchers, and supported/unsupported siblings. Qualification must execute the actual superpowers wrapper and script in an owned profile, then inspect a real model request and the Desktop approval UI. Final delivery includes fresh package gates and independent review; the earlier 0.1.2 unsupported-format qualification is historical evidence, superseded for this supported startup contract.
