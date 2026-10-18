# Playwright compatibility and Official plugin comparison

Read-only evidence collected by the root controller on 2026-10-15. This user-added scope supplements the current-version long-session repair; it does not restart completed units or introduce a provider platform.

The immediate failure is a configuration dialect mismatch. The official [Playwright plugin configuration](https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/external_plugins/playwright/.mcp.json) inspected that day contains this complete six-line direct server map:

```json
{
  "playwright": {
    "command": "npx",
    "args": ["@playwright/mcp@latest"]
  }
}
```

The primary [Claude plugin reference](https://code.claude.com/docs/en/plugins-reference) also describes plugin MCP maps. The inspected current IH common parser at `packages/plugin-registry/src/install.ts:127–190` requires an object-valued `mcpServers` wrapper at line 134. Async reads, sync/runtime reads and rekeying share this parser. Staged installation calls rekey at line 298 and therefore rejects the official direct map before final installation.

The screenshot's candidate `.i-harness/plugins/.claude-plugins-official__playwright.tmp-uuid` identifies that staging phase. Existing cleanup removes the candidate after failure, and existing installation parks the old installation only after validation. The temporary filename alone does not establish a leftover directory or broken rollback. Inspected bounds were `install.ts:127–218`, `:288–303`, `:512–564`, and the existing test at `test/install.test.ts:382–401`; this was source evidence, not an executed new RED test.

The repair accepts both direct maps and existing wrapped maps through the common parser. An own `mcpServers` property keeps wrapped precedence and must validate as the existing wrapper; malformed wrappers never fall back to direct-map parsing. Only absent wrappers select the direct dialect. Existing per-server field/type validation, unsupported SSE handling, namespacing, 64-character key handling, atomic installation rollback and source preservation remain in force. A literal direct server named `mcpServers` is reserved by this precedence rule. Existing wrapped extra-field handling is preserved; direct and wrapped entries are never merged.

The regression must exercise the actual synthetic install → rekey → async read → sync/runtime read chain, plus invalid atomic rollback. It must not run `npx`, download/install a live plugin, alter a profile or account, or expand into MCP bundles/manifest features.

## What the DSH reference actually implements

The user supplied `D:/agent-complete/deepseek-harness-dsh-v0.2.1-alpha.2`. Its inspected [CLI package](D:/agent-complete/deepseek-harness-dsh-v0.2.1-alpha.2/apps/cli/package.json) is `@deepseek-ai/dsh`, version `0.2.1-alpha.2`. This local identity was checked directly; the directory name was not used as proof of the running package version.

| Surface | Inspected behavior | Meaning for IH |
| --- | --- | --- |
| Official bundle catalog | Only `@deepseek-ai/dsh-subagent-claude-code` and `@deepseek-ai/dsh-subagent-codex` are named. Catalog metadata is offline and does not import provider code. | A curated source badge and a built-in runtime bundle are different categories. |
| Install target | Release targets use `name@runningVersion`. Source targets validate a realpath-anchored CLI/workspace/bundle-patch/runtime tree and use `link:absolute-path`; a missing source does not silently fall back to the registry. | Explain source/version provenance and make invalid local-source selection actionable. Do not pin an unrelated MCP package to IH's version. |
| Bundle listing | The inspected `listBundles` method separates official, availability, installed, enabled and error state. | UI state should distinguish availability, installation and activation rather than report one generic success. |
| Install pipeline | README describes `saveExact`, the shared `installBundle` pipeline and limits of rollback when activation fails. | Keep actual rollback boundaries visible; do not claim all side effects were undone. |
| Codex provider | Package is `0.2.1-alpha.2`, with Cordis/DSH peer metadata and `dsh.bundle`; it uses official app-server one-shot `@openai/codex` `0.153.4`. The inspected README describes an offline entry, global `subagent_codex` enablement and native spawn only on delegation. | This is a DSH runtime provider package, not a Claude marketplace `.mcp.json` plugin. |
| Claude provider | Inspected package is `0.2.1-alpha.2`, with Cordis/DSH peer metadata and `dsh.bundle`, using Claude SDK `0.3.263`. | It belongs to the same runtime bundle category. Its README and full installer body were not inspected. |

The [DSH release notes](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-alpha.2) inspected by root corroborate on-demand matching release packages. Other screenshot features are not new requirements.

Exact local evidence bounds:

- [official-bundle-packages.ts](D:/agent-complete/deepseek-harness-dsh-v0.2.1-alpha.2/packages/boot/app-boot/src/official-bundle-packages.ts) and [official-bundles.ts](D:/agent-complete/deepseek-harness-dsh-v0.2.1-alpha.2/packages/boot/app-boot/src/official-bundles.ts): catalog/source isolation.
- [official-bundles.generated.ts](D:/agent-complete/deepseek-harness-dsh-v0.2.1-alpha.2/packages/boot/app-boot/src/official-bundles.generated.ts): naming and metadata comments only, not a complete generated catalog audit.
- [official-install-target.ts](D:/agent-complete/deepseek-harness-dsh-v0.2.1-alpha.2/packages/boot/plugin-manager/src/official-install-target.ts): complete file read.
- [plugin-manager index.ts](D:/agent-complete/deepseek-harness-dsh-v0.2.1-alpha.2/packages/boot/plugin-manager/src/index.ts:282): complete `listBundles` method, lines 282–354; not the entire installer implementation.
- [plugin-manager README](D:/agent-complete/deepseek-harness-dsh-v0.2.1-alpha.2/packages/boot/plugin-manager/README.md:36): lines 36–57 covering catalog/version/state/install.
- [Codex package](D:/agent-complete/deepseek-harness-dsh-v0.2.1-alpha.2/packages/subagent/subagent-codex/package.json): complete; [Codex README](D:/agent-complete/deepseek-harness-dsh-v0.2.1-alpha.2/packages/subagent/subagent-codex/README.md): first 58 lines.
- [Claude package](D:/agent-complete/deepseek-harness-dsh-v0.2.1-alpha.2/packages/subagent/subagent-claude-code/package.json): complete; no Claude README claim.
- IH `packages/desktop/src/renderer/settings/PluginMarketplace.tsx:62`: exact official-source context only. Its official button points to `anthropics/claude-plugins-official`; IH's ordinary plugin registry installs files/skills/hooks/MCP rather than DSH native bundles.

Future Official plugin work can reuse clearer source/version/status vocabulary, offline loader isolation and actionable diagnostics. Introducing Cordis, NPM native provider bundles or DSH's platform is outside this repair/candidate scope. These are future suggestions, not implemented features or platform correctness claims.

## Qualification boundary

The root research was read-only. It did not run new installer tests, install a plugin, execute the configured command, read live credentials or modify either source tree. The fresh supplemental implementer must produce actual behavioral RED/GREEN, affected tests/types, a local commit and independent spec/quality review before this added repair joins Task 8's final range. All original eight repair units still complete. Tasks before7b retain the historical Desktop/gateway0.1.12 state;7b implements the explicitly selected0.1.13-rc.1 candidate. A later human instruction authorizes Root to report progress, push the reviewed branch checkpoint and prepare a draft/candidate after this supplement; formal publication is not implied. Task 8 qualification is still required before release-ready claims. Implementers perform no remote writes, merge, live profile changes or paused decomposition work.
