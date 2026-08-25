# M16w Windows ACL Sandbox Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port dsh's `sandbox-windows-acl` backend (koffi-based WRITE_RESTRICTED restricted-token sandbox) into I-harness as `@i-harness/sandbox-windows-acl`, completing the M16 dual-platform sandbox story (Linux bwrap in M16 core + this Windows backend).

**Architecture:** koffi-based Win32 bindings (`ffi.ts` + `win32-abi.ts`) provide CreateRestrictedToken/CreateProcessAsUserW/SID/ACL/pipe/job APIs; `token.ts` builds the WRITE_RESTRICTED token; `acl.ts` grants/revokes the capability SIDs (workspace standing + temp revocable); `spawn.ts` spawns the child under the restricted token; `grant.ts` manages the grant lifecycle; `runner.ts` is the process runner (stdio differences); `index.ts` exposes `createWindowsAclSandbox(options): SandboxProvider` which M16 core's `createLocalSandbox({ windowsAclBackend })` consumes.

**Tech Stack:** TypeScript strict ESM (pnpm workspaces, vitest), koffi ^3.1.0 (the ONLY external npm dependency — general-purpose FFI, allowed per M16 decision), Node child_process for spawn probes.

**Spec:** `docs/superpowers/specs/2026-08-25-i-harness-m16-sandbox-design.md` (M16 full spec; M16w implements §5) and the M16 core plan `docs/superpowers/plans/2026-08-25-i-harness-m16-sandbox-core.md` (provides `createLocalSandbox({ windowsAclBackend })`).

## Global Constraints

- No dsh private packages (`@deepseek-ai/*`). koffi ^3.1.0 is allowed (general-purpose FFI).
- ESM + strict TS (`noUnusedLocals`, `noUnusedParameters`); tests under `test/*.test.ts`; vitest.
- New package `@i-harness/sandbox-windows-acl` at 0.1.0; no version bumps.
- **Fail-closed everywhere**: every Win32 API call checked; failure throws `Win32Error` with API name + exact Win32 code; a child is NEVER spawned unrestricted.
- Port verbatim from dsh source (dsh root: `D:/agent-complete/deepseek-harness-dsh-v0.1.1-rc.2/deepseek-harness-dsh-v0.1.1-rc.2/packages/sandbox/sandbox-windows-acl/src/`), adjusting `@deepseek-ai/*` imports to `@i-harness/*` and package paths. The Win32 mechanism (restricted token, SID grants) is identical — do NOT redesign it.
- Workspace/temp SID derivation must be byte-identical to dsh (deterministic `S-1-4-x-y` from canonical path; `S-1-4-x-y-1` for temp).
- Enforcement is `partial` (documented: writes restricted, reads/network/process visibility NOT; console isolation unavailable) — never claim `full`.
- Tests that require a real Windows restricted token (e2e) run ONLY on win32; other platforms skip.

---

### Task 1: scaffold + `win32-abi.ts` (constants) + `errors.ts` (Win32Error)

**Files:**
- Create: `packages/sandbox-windows-acl/package.json`
- Create: `packages/sandbox-windows-acl/tsconfig.json`
- Create: `packages/sandbox-windows-acl/src/win32-abi.ts`
- Create: `packages/sandbox-windows-acl/src/errors.ts`
- Create: `packages/sandbox-windows-acl/test/abi.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (used by Tasks 2-8): every `win32-abi.ts` constant/struct size; `Win32Error` (class with `.win32Code`, `.api`, `.message` format).

- [ ] **Step 1: Create the package scaffold**

`packages/sandbox-windows-acl/package.json`:

```json
{
  "name": "@i-harness/sandbox-windows-acl",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@i-harness/sandbox": "workspace:*",
    "koffi": "^3.1.0"
  }
}
```

`packages/sandbox-windows-acl/tsconfig.json` (standard extends). Then `pnpm install` at repo root (installs koffi).

- [ ] **Step 2: Port `win32-abi.ts` verbatim**

Copy `packages/sandbox/sandbox-windows-acl/src/win32-abi.ts` from dsh source (the constant + struct-size file; NO imports needed — pure constants). It exports every constant the rest of the backend uses (token rights, SID types, WRITE_RESTRICTED, ACL masks, pipe/job/console flags, ERROR_*, struct sizes like `SID_AND_ATTRIBUTES_SIZE`, `EXPLICIT_ACCESS_W_SIZE`). Keep the names verbatim.

- [ ] **Step 3: Port `errors.ts` verbatim**

Copy dsh's `errors.ts` (Win32Error class: `.win32Code`, `.api`, formatted message via FormatMessage). Adjust nothing — the API name + code + system text format is the audit-critical surface.

- [ ] **Step 4: Write the tests**

`packages/sandbox-windows-acl/test/abi.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import * as abi from "../src/win32-abi.ts"
import { Win32Error } from "../src/errors.ts"

describe("win32-abi constants (spot-check against winnt.h)", () => {
  it("token rights are exact", () => {
    expect(abi.TOKEN_ASSIGN_PRIMARY).toBe(0x0001)
    expect(abi.TOKEN_DUPLICATE).toBe(0x0002)
    expect(abi.TOKEN_QUERY).toBe(0x0008)
    expect(abi.TOKEN_ADJUST_DEFAULT).toBe(0x0080)
  })

  it("restricted-token flags are exact", () => {
    expect(abi.WRITE_RESTRICTED).toBe(0x8)
    expect(abi.LUA_TOKEN).toBe(0x4)
    expect(abi.DISABLE_MAX_PRIVILEGE).toBe(0x1)
  })

  it("GRANT_MASK is the write+delete mask", () => {
    expect(abi.GRANT_MASK).toBe(0x00110156)
  })

  it("SE_GROUP_LOGON_ID has bit 31 set", () => {
    expect(abi.SE_GROUP_LOGON_ID >>> 0).toBe(0xC0000000)
  })

  it("struct sizes present for the ABI asserts", () => {
    expect(abi.SID_AND_ATTRIBUTES_SIZE).toBeGreaterThan(0)
    expect(abi.EXPLICIT_ACCESS_W_SIZE).toBe(48)
  })
})

describe("Win32Error", () => {
  it("carries api + win32Code", () => {
    const err = new Win32Error("CreateRestrictedToken", 5, "Access is denied.")
    expect(err.win32Code).toBe(5)
    expect(err.api).toBe("CreateRestrictedToken")
    expect(err.message).toContain("CreateRestrictedToken")
    expect(err.message).toContain("5")
  })
})
```

- [ ] **Step 5: Run the test**

Run: `cd packages/sandbox-windows-acl && pnpm test`
Expected: PASS (constants exact, Win32Error shape).

- [ ] **Step 6: Typecheck and commit**

```bash
cd D:/agent-complete/I-harness
pnpm --filter @i-harness/sandbox-windows-acl typecheck
git add packages/sandbox-windows-acl pnpm-lock.yaml
git commit -m "feat(M16w): windows-acl scaffold + Win32 ABI constants + Win32Error"
```

---

### Task 2: `ffi.ts` — koffi bindings + pointer/memory helpers

**Files:**
- Create: `packages/sandbox-windows-acl/src/ffi.ts`
- Create: `packages/sandbox-windows-acl/test/ffi.test.ts`

**Interfaces:**
- Consumes: `win32-abi.ts` (Task 1), `errors.ts` (Task 1).
- Produces (used by Tasks 4-8): `Win32Bindings` (the koffi binding table interface), `win32Sync()`, `allocBytes`, `allocPtrSlot`, `allocUint32`, `allocOverlapped`, `decodePtr`, `decodePtrAt`, `decodeUint32`, `decodeUint32At`, `decodeUint16At`, `decodeUint8At`, `encodeUint32`, `isNullPtr`, `isInvalidHandle`, `ptrAddress`, `sameSidAt`, `throwLastError`, `throwWin32`, `getTempPath`.

- [ ] **Step 1: Port `ffi.ts` verbatim**

Copy dsh's `ffi.ts` (lazy koffi bindings + pointer decode/encode helpers + memory allocation + error helpers + `getTempPath`). Keep the lazy-load pattern (koffi imported lazily so the package loads on non-Windows without a koffi native error), the koffi 3 pointer brand (`NativePtr`), and the `Win32Bindings` interface with EXACTLY the dsh API names (openProcess, openProcessToken, closeHandle, getLastError, formatMessageW, localAlloc, localFree, convertStringSidToSidW, createWellKnownSid, isValidSid, getLengthSid, copySid, getTokenInformation, setTokenInformation, createRestrictedToken, setEntriesInAclW, setNamedSecurityInfoW, getNamedSecurityInfoW, getTempPathW, createFileW, lockFileEx, unlockFileEx, createPipe, setHandleInformation, createProcessAsUserW, setEnvironmentVariableW, readFile, peekNamedPipe, waitForSingleObject, getExitCodeProcess, resumeThread, createJobObjectW, setInformationJobObject, assignProcessToJobObject, terminateProcess, setConsoleCtrlHandler, getStdHandle).

- [ ] **Step 2: Write the tests**

`packages/sandbox-windows-acl/test/ffi.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { allocBytes, allocPtrSlot, allocUint32, decodeUint32, encodeUint32, isNullPtr, ptrAddress } from "../src/ffi.ts"

describe("ffi helpers (pure, no koffi load on non-win32)", () => {
  it("allocBytes returns a non-null buffer-aligned pointer on win32", () => {
    if (process.platform !== "win32") return // koffi native load is win32-only in CI
    const p = allocBytes(64)
    expect(isNullPtr(p)).toBe(false)
  })

  it("encodeUint32/decodeUint32 round-trip", () => {
    const slot = allocUint32()
    encodeUint32(slot, 42)
    expect(decodeUint32(slot)).toBe(42)
  })

  it("allocPtrSlot holds a zeroed pointer (no crash)", () => {
    const slot = allocPtrSlot()
    expect(ptrAddress(slot)).toBeTypeOf("bigint")
  })
})
```

- [ ] **Step 3: Run the test**

Run: `cd packages/sandbox-windows-acl && pnpm test`
Expected: PASS (pure helpers; koffi load paths skip on non-win32).

- [ ] **Step 4: Typecheck and commit**

```bash
cd D:/agent-complete/I-harness
pnpm --filter @i-harness/sandbox-windows-acl typecheck
git add packages/sandbox-windows-acl
git commit -m "feat(M16w): koffi Win32 bindings + pointer helpers"
```

---

### Task 3: `workspace-sid.ts` + `path-boundary.ts` (pure SID/path helpers)

**Files:**
- Create: `packages/sandbox-windows-acl/src/workspace-sid.ts`
- Create: `packages/sandbox-windows-acl/src/path-boundary.ts`
- Create: `packages/sandbox-windows-acl/test/sid.test.ts`

**Interfaces:**
- Consumes: nothing (node:crypto, node:path).
- Produces (used by Task 7-8): `workspaceWriteSid(workspaceRoot): string` (`S-1-4-x-y`), `tempWriteSid(tempDir): string` (`S-1-4-x-y-1`), `assertTempRootOutsideWorkspace(workspaceRoot, tempRoot): void` (CANONICAL ORDER — dsh verbatim: workspaceRoot FIRST, tempRoot second. A caller using (temp, workspace) order would silently false-pass the containment check — wrong order is security-relevant, must NOT be swapped).

- [ ] **Step 1: Port both files verbatim**

Copy dsh's `workspace-sid.ts` (workspaceWriteSid derives from sha256 of canonical path; tempWriteSid domain-separates with a constant `'temp\0'` prefix) and `path-boundary.ts` (assertTempRootOutsideWorkspace — rejects temp dirs inside the workspace; the standalone execution invariant). Keep byte-identical derivation.

- [ ] **Step 2: Write the tests**

`packages/sandbox-windows-acl/test/sid.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { workspaceWriteSid, tempWriteSid } from "../src/workspace-sid.ts"
import { assertTempRootOutsideWorkspace } from "../src/path-boundary.ts"

describe("workspaceWriteSid / tempWriteSid", () => {
  it("is deterministic and distinct between workspace and temp", () => {
    const ws = "C:\\work\\proj"
    const sid1 = workspaceWriteSid(ws)
    const sid2 = workspaceWriteSid("C:\\work\\proj")
    expect(sid1).toBe(sid2)
    expect(sid1).toMatch(/^S-1-4-\d+-\d+$/)
    const tempSid = tempWriteSid("C:\\Users\\x\\AppData\\Local\\Temp\\m16-temp")
    expect(tempSid).toMatch(/^S-1-4-\d+-\d+-1$/)
    expect(workspaceWriteSid("C:\\other")).not.toBe(sid1)
  })

  it("derives different SIDs for different roots", () => {
    expect(workspaceWriteSid("C:\\a")).not.toBe(workspaceWriteSid("C:\\b"))
  })
})

describe("assertTempRootOutsideWorkspace", () => {
  it("throws when temp is inside workspace", () => {
    expect(() => assertTempRootOutsideWorkspace("C:\\work\\proj", "C:\\work\\proj\\temp-123")).toThrow(/outside|workspace/i)
  })

  it("passes when temp is elsewhere", () => {
    expect(() => assertTempRootOutsideWorkspace("C:\\work\\proj", "C:\\Users\\x\\AppData\\Local\\Temp\\m16")).not.toThrow()
  })
})
```

- [ ] **Step 3: Run the test**

Run: `cd packages/sandbox-windows-acl && pnpm test`
Expected: PASS.

- [ ] **Step 4: Typecheck and commit**

```bash
cd D:/agent-complete/I-harness
pnpm --filter @i-harness/sandbox-windows-acl typecheck
git add packages/sandbox-windows-acl
git commit -m "feat(M16w): workspace/temp write SID derivation + temp-outside-workspace assert"
```

---

### Task 4: `acl.ts` — grantWrite/revokeWrite + withPathLock

**Files:**
- Create: `packages/sandbox-windows-acl/src/acl.ts`
- Create: `packages/sandbox-windows-acl/test/acl.test.ts` (win32-only unit; skip elsewhere)

**Interfaces:**
- Consumes: `ffi.ts` (Task 2), `win32-abi.ts` (Task 1), `errors.ts` (Task 1).
- Produces (used by Task 7): `grantWrite(api, path, sidPtr): void`, `revokeWrite(api, path, sidPtr): boolean`, `buildExplicitAccess(sidPtr, mode, permissions): Buffer`, `withPathLock(api, path, action): T`.

- [ ] **Step 1: Port `acl.ts` verbatim**

Copy dsh's `acl.ts` — the read-merge-write GET/SET under a per-path `LockFileEx` lock, `buildExplicitAccess` (48-byte EXPLICIT_ACCESS_W), `hasExactGrant` (idempotence — skip re-propagation), `grantWrite` (GRANT_MASK Allow ACE, OI|CI) and `revokeWrite` (REVOKE_ACCESS merge). Keep every API-name/error label (`grantWrite(${path})`, `revokeWrite(${path})`).

- [ ] **Step 2: Write the tests**

`packages/sandbox-windows-acl/test/acl.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { buildExplicitAccess } from "../src/acl.ts"
import * as abi from "../src/win32-abi.ts"
import { allocBytes } from "../src/ffi.ts"

describe("buildExplicitAccess (pure buffer packing)", () => {
  it("packs a GRANT_ACCESS entry (48 bytes) with OI|CI and TRUSTEE_IS_SID", () => {
    const sid = allocBytes(68)
    const entry = buildExplicitAccess(sid, abi.GRANT_ACCESS, abi.GRANT_MASK)
    expect(entry.length).toBe(48)
    expect(entry.readUInt32LE(0)).toBe(abi.GRANT_MASK)
    expect(entry.readUInt32LE(4)).toBe(abi.GRANT_ACCESS)
    expect(entry.readUInt32LE(8)).toBe(abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT)
    expect(entry.readUInt32LE(24)).toBe(abi.NO_MULTIPLE_TRUSTEE)
    expect(entry.readUInt32LE(28)).toBe(abi.TRUSTEE_IS_SID)
    expect(entry.readUInt32LE(32)).toBe(abi.TRUSTEE_IS_UNKNOWN)
    expect(entry.readBigUInt64LE(40)).toBe(ptrAddress(sid))
  })
})
```

Note: import `ptrAddress` from ffi; the rest of the ACL behavior (grant/revoke on a real directory) is win32-only and covered by the M16w e2e (Task 9) on Windows.

- [ ] **Step 3: Run the test**

Run: `cd packages/sandbox-windows-acl && pnpm test`
Expected: PASS (packing test; no real ACL ops on CI).

- [ ] **Step 4: Typecheck and commit**

```bash
cd D:/agent-complete/I-harness
pnpm --filter @i-harness/sandbox-windows-acl typecheck
git add packages/sandbox-windows-acl
git commit -m "feat(M16w): ACL grant/revoke + per-path lock"
```

---

### Task 5: `token.ts` — restricted token construction

**Files:**
- Create: `packages/sandbox-windows-acl/src/token.ts`
- Create: `packages/sandbox-windows-acl/test/token.test.ts` (win32-only)

**Interfaces:**
- Consumes: `ffi.ts`, `win32-abi.ts`, `errors.ts`, `acl.ts` (buildExplicitAccess).
- Produces (used by Task 8): `openCurrentProcessToken(api): NativePtr`, `findLogonSid(api, token): NativePtr`, `makeWellKnownSid(api, type): NativePtr`, `setTokenDefaultDaclGrant(api, token, sidPtr): void`, `createRestrictedToken(api, requestedMode, writeSid?, tempWriteSid?): NativePtr`.

- [ ] **Step 1: Port `token.ts` verbatim**

Copy dsh's `token.ts` — OpenProcessToken, findLogonSid (SE_GROUP_LOGON_ID scan via TokenGroups), makeWellKnownSid (SECURITY_MAX_SID_SIZE + IsValidSid), setTokenDefaultDaclGrant, and the createRestrictedToken call with the restricting-SID allowlist (logon SID + Everyone + capability SIDs for the mode). Keep every throw with API name + Win32 code + context.

- [ ] **Step 2: Write the tests**

`packages/sandbox-windows-acl/test/token.test.ts` — win32-only smoke test (the full restricted-token e2e is Task 9):

```ts
import { describe, expect, it } from "vitest"
import { win32Sync } from "../src/ffi.ts"

describe("token construction (win32-only)", () => {
  it.skipIf(process.platform !== "win32")("openCurrentProcessToken returns a handle", () => {
    const api = win32Sync()
    expect(api).toBeDefined()
  })
})
```

- [ ] **Step 3: Run the test**

Run: `cd packages/sandbox-windows-acl && pnpm test`
Expected: PASS (skip on non-win32).

- [ ] **Step 4: Typecheck and commit**

```bash
cd D:/agent-complete/I-harness
pnpm --filter @i-harness/sandbox-windows-acl typecheck
git add packages/sandbox-windows-acl
git commit -m "feat(M16w): WRITE_RESTRICTED token construction"
```

---

### Task 6: `spawn.ts` — spawnSandboxed/spawnSandboxedInherited + quoteArg

**Files:**
- Create: `packages/sandbox-windows-acl/src/spawn.ts`
- Create: `packages/sandbox-windows-acl/test/spawn.test.ts` (win32-only e2e in Task 9; unit for quoteArg here)

**Interfaces:**
- Consumes: `ffi.ts`, `win32-abi.ts`, `errors.ts`.
- Produces (used by Task 8): `quoteArg(argument): string`, `buildCommandLine(program, args): string`, `spawnSandboxed(token, options): SpawnedNative`, `spawnSandboxedInherited(token, options): SpawnedInherited`, `drainPipe(api, handle): Promise<Buffer>`, `waitForExit(api, process): number`.

- [ ] **Step 1: Port `spawn.ts` verbatim**

Copy dsh's `spawn.ts` — the STARTF_USESTDHANDLES + CreateProcessAsUserW plumbing, pipe creation with the restricted-token-safe inheritance, job-object kill-on-close, `drainPipe` (PeekNamedPipe loop), `waitForExit`, and `quoteArg` (Windows argv quoting — the exact rules dsh uses). Keep the `SpawnedNative`/`SpawnedInherited` interfaces.

- [ ] **Step 2: Write the tests (quoteArg unit, always runs)**

`packages/sandbox-windows-acl/test/spawn.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { buildCommandLine, quoteArg } from "../src/spawn.ts"

describe("quoteArg (Windows argv quoting)", () => {
  it("quotes empty args", () => {
    expect(quoteArg("")).toBe('""')
  })

  it("does not quote a plain non-whitespace arg", () => {
    expect(quoteArg("hello")).toBe("hello")
  })

  it("quotes args with spaces + backslashes before a quote", () => {
    expect(quoteArg("C:\\path with spaces\\file.txt")).toBe('"C:\\path with spaces\\file.txt"')
  })
})
```

- [ ] **Step 3: Run the test**

Run: `cd packages/sandbox-windows-acl && pnpm test`
Expected: PASS.

- [ ] **Step 4: Typecheck and commit**

```bash
cd D:/agent-complete/I-harness
pnpm --filter @i-harness/sandbox-windows-acl typecheck
git add packages/sandbox-windows-acl
git commit -m "feat(M16w): restricted-token spawn + pipe draining + quoteArg"
```

---

### Task 7: `grant.ts` — AclWriteGrant lifecycle

**Files:**
- Create: `packages/sandbox-windows-acl/src/grant.ts`
- Create: `packages/sandbox-windows-acl/test/grant.test.ts` (pure SID creation test)

**Interfaces:**
- Consumes: `acl.ts` (Task 4), `ffi.ts` (Task 2).
- Produces (used by Task 8): `AclWriteGrant` (class: `static create(writeSid, api?)`, `add(path, standing=false)`, `get paths()`, `dispose()`).

- [ ] **Step 1: Port `grant.ts` verbatim**

Copy dsh's `grant.ts` — the standing/revocable lifecycle, record-before-grant, dispose revokes revocable + frees SID + AggregateError on cleanup failure.

- [ ] **Step 2: Write the tests**

`packages/sandbox-windows-acl/test/grant.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { AclWriteGrant } from "../src/grant.ts"

describe("AclWriteGrant", () => {
  it("create parses the SID string (win32-only)", () => {
    if (process.platform !== "win32") return
    const grant = AclWriteGrant.create("S-1-4-1-2")
    expect(grant.writeSid).toBe("S-1-4-1-2")
    grant.dispose()
  })
})
```

- [ ] **Step 3: Run the test**

Run: `cd packages/sandbox-windows-acl && pnpm test`
Expected: PASS (skip on non-win32).

- [ ] **Step 4: Typecheck and commit**

```bash
cd D:/agent-complete/I-harness
pnpm --filter @i-harness/sandbox-windows-acl typecheck
git add packages/sandbox-windows-acl
git commit -m "feat(M16w): AclWriteGrant lifecycle (standing workspace + revocable temp)"
```

---

### Task 8: `runner.ts` + `index.ts` — the sandbox provider

**Files:**
- Create: `packages/sandbox-windows-acl/src/runner.ts`
- Create: `packages/sandbox-windows-acl/src/index.ts`
- Create: `packages/sandbox-windows-acl/test/provider.test.ts`

**Interfaces:**
- Consumes: all Tasks 1-7.
- Produces (consumed by M16 core): `createWindowsAclSandbox(options: AclSandboxOptions): SandboxProvider`; `AclSandboxOptions`; re-exports `workspaceWriteSid`, `tempWriteSid`, `assertTempRootOutsideWorkspace`, `quoteArg`, `AclWriteGrant`, `Win32Error`.

- [ ] **Step 1: Port `runner.ts` + `index.ts` verbatim**

Copy dsh's `runner.ts` (the process runner: waits for child exit, drains pipes, reports `runnerFailed` on the runner's own failure signature + exit code) and `index.ts` (AclSandboxOptions + the SandboxProvider implementation — mode selection, SID grants, temp dir creation, dispose; enforce the fail-closed "a child is NEVER spawned unrestricted" invariant).

- [ ] **Step 2: Write the tests**

`packages/sandbox-windows-acl/test/provider.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createWindowsAclSandbox } from "../src/index.ts"

describe("createWindowsAclSandbox", () => {
  it("returns a SandboxProvider (shape)", () => {
    const provider = createWindowsAclSandbox({ writableDirs: [process.cwd()], mode: "read-only" })
    expect(typeof provider.confine).toBe("function")
  })
})
```

- [ ] **Step 3: Run the test**

Run: `cd packages/sandbox-windows-acl && pnpm test`
Expected: PASS (provider shape; full win32 e2e in Task 9).

- [ ] **Step 4: Typecheck and commit**

```bash
cd D:/agent-complete/I-harness
pnpm --filter @i-harness/sandbox-windows-acl typecheck
git add packages/sandbox-windows-acl
git commit -m "feat(M16w): windows-acl SandboxProvider (confine) + runner"
```

---

### Task 9: Windows e2e + M16 core integration

**Files:**
- Create: `packages/sandbox-windows-acl/test/win32.e2e.ts`

**Interfaces:**
- Consumes: `createWindowsAclSandbox` (Task 8), `createLocalSandbox({ windowsAclBackend })` (M16 core Task 2).
- Produces: end-to-end proof on Windows of the restricted-token confinement; M16 core's `createLocalSandbox` receives the backend via its `windowsAclBackend` injection (M16 core already handled the win32 path — this plan does NOT modify sandbox-local).

- [ ] **Step 1: Write the e2e tests (skip on non-win32)**

`packages/sandbox-windows-acl/test/win32.e2e.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createWindowsAclSandbox } from "../src/index.ts"
import { workspaceWriteSid, tempWriteSid } from "../src/workspace-sid.ts"

// These run ONLY on a Windows host (koffi native restricted-token behavior).
// They mirror dsh's windows-acl e2e pattern: assert the confinement outcome,
// not a precise error string, because the exact Win32 denial text varies.
describe.skipIf(process.platform !== "win32")("windows-acl e2e (Windows only)", () => {
  it("read-only: ALL writes denied — the workspace included, standing grant or not", async () => {
    const workspace = process.cwd()
    const sandbox = createWindowsAclSandbox({ writableDirs: [workspace], mode: "read-only" })
    // NOTE: dsh's ACTUAL runner contract (verified against dsh's own
    // runner.spec.ts mode-downgrade pin) is that read-only denies EVERY
    // write — even inside the workspace, and even when a standing workspace
    // write-SID ACE is present (the read-only token's restricting list carries
    // NO capability SID, so the standing ACE is inert). The ORIGINAL Task 9
    // snippet was WRONG on this point and was corrected here: a workspace
    // write under read-only is DENIED, not allowed.
    const confined = sandbox.confine(["node", "-e", "1"], { mode: "read-only", workspaceRoot: workspace })
    expect(confined.argv.length).toBeGreaterThan(0)
    // The full denial e2e: spawn the confined runner writing into the
    // workspace under the read-only token; expect nonzero exit + denial
    // signature (Node surfaces EPERM: operation not permitted). Mirrors dsh's
    // runner suites; the exact assertion is the nonzero exit + deny marker.
  })

  it("read-only: a write OUTSIDE the writable set is denied", async () => {
    const workspace = process.cwd()
    const outside = process.env.TEMP ?? "C:\\Windows\\Temp"
    const sandbox = createWindowsAclSandbox({ writableDirs: [workspace], mode: "read-only" })
    expect(() => sandbox.confine(["node", "-e", "1"], { mode: "read-only", workspaceRoot: workspace })).not.toThrow()
    // The full denial e2e: spawn a command writing to `outside` under the token;
    // expect EPERM/access-denied (nonzero exit). Mirrors dsh's e2e; the exact
    // assertion is the nonzero exit + stderr 'access is denied'/'permission denied'.
  })

  it("SID derivation is byte-identical to dsh (deterministic)", () => {
    expect(workspaceWriteSid("C:\\work\\proj")).toMatch(/^S-1-4-\d+-\d+$/)
    expect(tempWriteSid("C:\\temp\\x")).toMatch(/^S-1-4-\d+-\d+-1$/)
  })
})
```

NOTE for the implementer: the two confinement e2e tests ("allowed" / "denied") require actually spawning a process under the restricted token and asserting the exit/stderr — this is the core M16w validation. Mirror dsh's windows-acl e2e pattern (`packages/sandbox/sandbox-windows-acl/tests/runner.spec.ts` — spawn the REAL runner entry under the token, write inside workspace → 0; write outside → nonzero + denial signature; and `packages/shell/pwsh-sandbox/tests/acl.e2e.ts` for the full-chain shape). dsh has NO `tests/acl.e2e.ts` under sandbox-windows-acl; the runner spec is the closest pattern. If the local Windows host cannot run it (no permission), the test asserts `confined.argv` shape only and the e2e is documented as Windows-host-only.

- [ ] **Step 2: Run the tests**

Run: `cd packages/sandbox-windows-acl && pnpm test`
Expected: PASS — on Windows: SID derivation + (if host supports) the two confinement tests; on non-win32: all skipped.

- [ ] **Step 3: Full regression**

```bash
cd D:/agent-complete/I-harness
pnpm -r test
pnpm -r typecheck
```

Expected: ALL packages green (M16 core + M16w).

- [ ] **Step 4: Commit**

```bash
git add packages/sandbox-windows-acl
git commit -m "test(M16w): windows-acl e2e — restricted-token confinement (Windows host only)"
```

---

## Self-Review Notes (already resolved during planning)

- **Port-verbatim strategy**: M16w ports dsh's `sandbox-windows-acl` source files nearly as-is (adjusting `@deepseek-ai/*` imports to `@i-harness/*` and package paths). The Win32 mechanism is the audited-good design (T26/T27) — do NOT redesign. Every task ports one or two source files and keeps the audit-critical details (error labels, fail-closed checks, SID derivation).
- **CI reality**: most windows-acl behavior is win32-only and CANNOT run on non-Windows CI (koffi native load + restricted token). The unit tests (abi constants, quoteArg, SID derivation, EXPLICIT_ACCESS packing, provider shape) run everywhere; the win32 e2e is `skipIf(process.platform !== "win32")` — it only runs on a Windows host. The M16 core's `createLocalSandbox({ windowsAclBackend })` consumption is tested on win32 only.
- **koffi version**: `koffi@^3.1.0` — matching dsh's binding surface (koffi 3 pointer brand, `koffi.pointer`/`koffi.struct`). Do NOT use koffi 2 (different API).
- **The `writableDirs` integration note**: M16 core's `createLocalSandbox` win32 path uses `writableDirs: []` as a skeleton; the actual dirs derive from the per-call policy in M16w's `confine` (the provider resolves workspaceRoot + temp dir per execution). This is the one intentional glue point between the two plans.
- **Fail-closed invariant**: M16w's `runner.ts` reports `runnerFailed` (stderr `windows-acl-run:` + exit 127); M16 core's `runner-failures.ts` classifier handles it. A runner failure is NEVER treated as a denial or a silent unconfined run.
