# I-harness

I-harness agent runtime — M1 kernel monorepo (TypeScript + ESM, pnpm workspace).

## Requirements

- Node.js >= 22
- pnpm >= 9

## Getting started

```bash
pnpm install
pnpm test
pnpm typecheck
```

## Scripts (run from the repo root)

| Script       | Purpose                                    |
|--------------|--------------------------------------------|
| `pnpm test`  | Run every package's vitest suite (`-r test`) |
| `pnpm typecheck` | Type-check every package with `tsc --noEmit` (`-r typecheck`) |

Per-package gates:

| Package         | Extra scripts |
|-----------------|---------------|
| `@i-harness/core-tools` | `pnpm --filter @i-harness/core-tools gen-tool-catalog` / `verify-tool-catalog` |

## Package structure

```
packages/
├── core-plugin/     # plugin kernel (events, waterfall, guard, scope, lifecycle)
├── core-session/    # session event log + deriveMessages + versioned JSONL
├── core-tools/      # tool registry, guarded exec pipeline, catalog-as-artifact
├── core-agent/      # pure event-driven agent loop
├── llm-seam/        # unified LLM interface (stream events)
├── llm-mock/        # script-driven mock LLM
├── interaction/     # seam family: approval / questions / commands (fail-closed)
└── preset/          # agent preset discovery/mount
apps/
└── cli/             # headless CLI (drives the agent loop)
```

## M1 status

M1 kernel complete: plugin kernel, session event log, tool system with guarded
exec pipeline and approval seam, event-driven agent loop, LLM seam + mock,
preset mount, and a headless CLI. The acceptance task runs end-to-end:

```bash
node --import tsx apps/cli/src/index.ts run "把 src/data.txt 第一行改成 hello"
```

M2 design notes (scope-affinity semantics for guards/decision-seeding, and the
readOnly→approval policy) are recorded in
`docs/superpowers/specs/2026-08-16-i-harness-m1-kernel-design.md`.
