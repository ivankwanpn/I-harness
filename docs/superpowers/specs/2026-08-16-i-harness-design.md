# I-harness — Design Spec

Date: 2026-08-16
Status: Approved by user (2026-08-16)

## Purpose

Create a clean, standard Node.js project skeleton named **I-harness** in
`D:\agent-complete\I-harness`. It is a blank starting template for a future
AI agent, with no business logic. The directory will eventually live alongside
the existing agent projects (`deepseek-harness-master`, `opencode-anchored-standard`,
etc.) in `D:\agent-complete`.

## Technical Decisions

Analyzed the existing agent projects in `D:\agent-complete`:

| Project                  | Language   | Module system | Runner                |
|--------------------------|------------|---------------|-----------------------|
| deepseek-harness-master  | TypeScript | ESM           | Node ≥22 / pnpm       |
| opencode-1.18.18         | TypeScript | ESM           | Bun                   |
| opencode-anchored-standard | TypeScript | ESM         | Node ≥22.19 + node --test |
| dsh-anchored-standard-main | TS / .mjs | ESM           | Node ≥22.19 + node --test |

Decision: **TypeScript + ESM** (`"type": "module"`). This matches every
existing agent project and aligns with modern AI SDKs (OpenAI, Vercel AI SDK),
which are ESM-first.

## Project Structure

```
I-harness/
├── package.json          # "type": "module", name: "i-harness", engines: node >=22
├── tsconfig.json         # strict, ESM, noEmit
├── .gitignore
├── README.md
├── src/
│   └── index.ts          # entry, hello example
└── test/
    └── index.test.ts     # Node built-in test runner
```

## Components

### package.json
- `name`: `i-harness`
- `version`: `0.1.0`
- `private`: `true`
- `type`: `module`
- `engines.node`: `>=22`
- `description`: blank AI agent starting template
- `license`: MIT
- Scripts:
  - `test`: `node --test test/`
  - `typecheck`: `tsc --noEmit`
  - `check`: `npm run typecheck && npm run test`
- devDependencies: `typescript`, `@types/node`

### tsconfig.json
- `target`: `ESNext`
- `module`: `ESNext`
- `moduleResolution`: `bundler`
- `strict`: `true`
- `noEmit`: `true`
- `allowImportingTsExtensions`: `true`
- `skipLibCheck`: `true`
- `include`: `["src/**/*.ts", "test/**/*.ts"]`

### src/index.ts
- Exports a simple `hello(name: string): string` function as a placeholder
  entry point.

### test/index.test.ts
- Uses Node's built-in `node:test` and `node:assert/strict` (no test framework
  dependency, matching sibling projects).
- Tests `hello()`.

### .gitignore
- `node_modules/`
- `*.tsbuildinfo`

### README.md
- Brief project description and usage (npm install / npm run check).

## Testing Strategy

- Node 24 (installed: v24.15.0) natively runs `.ts` via type stripping, so
  `node --test test/` runs TypeScript tests with zero build step.
- `npm run check` gates on typecheck then test.

## Error Handling

- None beyond TypeScript strict rules; the template has no runtime behavior.

## Out of Scope (YAGNI)

- No ESLint/prettier, no vitest, no build step, no monorepo tooling, no
  framework dependencies. These can be added later when the agent's
  requirements are known.