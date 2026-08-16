# I-harness Blank Template Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold a clean, standard TypeScript + ESM Node.js project skeleton named I-harness in `D:\agent-complete\I-harness`, with no business logic.

**Architecture:** A blank single-package template. `src/index.ts` exports one placeholder function; `test/index.test.ts` covers it with Node's built-in test runner. TypeScript type-checks via `tsc --noEmit`; tests run via `node --test` (Node 24 type-strips `.ts` directly, so no build/transpile step is needed).

**Tech Stack:** Node.js ≥22 (installed: v24.15.0), TypeScript (strict, ESM), Node built-in `node:test` + `node:assert/strict`, npm.

## Global Constraints

- Directory: `D:\agent-complete\I-harness` (already created; is a git repo with the design spec committed).
- The project IS a git repo. All commits happen inside `D:\agent-complete\I-harness`.
- npm package name MUST be lowercase `i-harness` (npm naming rule). Directory is `I-harness`.
- `"type": "module"` (ESM). Use `import`/`export` syntax only — no `require`.
- `tsconfig.json`: `strict: true`, `module: ESNext`, `moduleResolution: bundler`, `noEmit: true`, `allowImportingTsExtensions: true`, `skipLibCheck: true`, `target: ESNext`.
- No runtime or framework dependencies. devDependencies: only `typescript` and `@types/node`.
- No ESLint, no prettier, no vitest, no build step, no monorepo tooling (out of scope per spec).
- `engines.node`: `>=22`.
- Testing: Node built-in `node:test` runner; test files live in `test/`.
- Every description/README/purpose line must reflect "blank AI agent starting template".
- Use LF line endings where possible; the repo warning about CRLF is acceptable.

---

### Task 1: Project metadata and config files

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`

**Interfaces:**
- Consumes: nothing.
- Produces: `package.json` scripts (`check`, `typecheck`, `test`) used by Task 3 to verify; `tsconfig.json` read by `tsc --noEmit` in Task 2/3.

- [ ] **Step 1: Create `package.json`**

Write exactly:

```json
{
  "name": "i-harness",
  "version": "0.1.0",
  "private": true,
  "description": "Blank AI agent starting template (TypeScript, ESM)",
  "type": "module",
  "license": "MIT",
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "test": "node --test",
    "typecheck": "tsc --noEmit",
    "check": "npm run typecheck && npm run test"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^5.9.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

Write exactly:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: Create `.gitignore`**

Write exactly:

```
node_modules/
*.tsbuildinfo
```

- [ ] **Step 4: Install dev dependencies**

Run: `npm install`
Expected: creates `node_modules/`, `package-lock.json`; no errors.

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json .gitignore package-lock.json
git commit -m "chore: initial package config for i-harness template"
```

---

### Task 2: Source entry point and its test

**Files:**
- Create: `src/index.ts`
- Create: `test/index.test.ts`

**Interfaces:**
- Consumes: config from Task 1.
- Produces: `hello(name: string): string` exported from `src/index.ts`. Task 3's `npm run check` verifies `tsc --noEmit` compiles both files and `node --test` passes.

- [ ] **Step 1: Write the failing test**

Create `test/index.test.ts`:

```ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { hello } from "../src/index.ts";

test("hello() greets the given name", () => {
  assert.equal(hello("world"), "hello, world");
});
```

Note: `allowImportingTsExtensions` + `moduleResolution: bundler` in tsconfig make the `../src/index.ts` extension explicit and valid.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — error importing `../src/index.ts` (module `hello` not exported / file does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `src/index.ts`:

```ts
export function hello(name: string): string {
  return `hello, ${name}`;
}
```

- [ ] **Step 4: Run typecheck and test to verify they pass**

Run: `npm run check`
Expected: PASS — `tsc --noEmit` exits 0, and the test passes.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/index.test.ts
git commit -m "feat: add placeholder hello module with test"
```

---

### Task 3: README and final verification

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: everything from Tasks 1-2.
- Produces: final verified template; `npm run check` is the acceptance gate.

- [ ] **Step 1: Create `README.md`**

Write:

````markdown
# I-harness

Blank AI agent starting template (TypeScript + ESM).

## Requirements

- Node.js >= 22

## Getting started

```bash
npm install
npm run check
```

## Scripts

| Script             | Purpose                                   |
|--------------------|-------------------------------------------|
| `npm test`         | Run tests with Node's built-in test runner |
| `npm run typecheck`| Type-check with `tsc --noEmit`            |
| `npm run check`    | Typecheck then run tests                  |
````

- [ ] **Step 2: Final acceptance verification**

Run: `npm run check`
Expected: PASS (tsc exits 0, all tests green).

- [ ] **Step 3: Verify final tree**

Run: `ls` (or `Get-ChildItem`)
Expected: `docs/`, `node_modules/`, `package.json`, `package-lock.json`, `src/`, `test/`, `tsconfig.json`, `README.md`, `.gitignore`.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: add README for i-harness template"
```

---

### Task 4: Plan complete verification

**Files:**
- None (verification only).

**Interfaces:**
- Consumes: all prior tasks.

- [ ] **Step 1: Run the full gate one final time**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 2: Confirm clean git status**

Run: `git status --short`
Expected: empty output (working tree clean).

- [ ] **Step 3: Print final log**

Run: `git log --oneline`
Expected: three commits: `chore: initial package config...`, `feat: add placeholder hello module with test`, `docs: add README...`.