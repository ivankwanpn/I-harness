import { expect, it } from "vitest"
import type { CompiledSandboxPolicy, ProcessSpec } from "@i-harness/sandbox"
import { captureRequest, parseWslInventory } from "../src/admission.ts"

const root = "D:\\I-harness-main"
const spec = (): ProcessSpec => ({ argv: ["/usr/bin/bash", "-c", "true"], cwd: root, env: { PATH: "/usr/bin:/bin" },
  owner: { sessionId: "owner" }, transport: "pipe", lifetime: "complete-tree", argumentEncoding: "crt" })
const policy = (): CompiledSandboxPolicy => ({ mode: "read-only", owner: { sessionId: "owner" }, authorityRevision: "r1",
  authorityKind: "bound", primaryRoot: root, readable: "caller", authorityRoots: [root], writeRoots: [], referenceRoots: [], fingerprint: "fp" })

it("captures complete detached frozen spec and policy before awaits", () => {
  const s = spec(), p = policy()
  const captured = captureRequest(s, p)
  ;(s.argv as string[])[0] = "/usr/bin/false"
  ;(s.env as Record<string, string>).PATH = "/bad"
  ;(p.authorityRoots as string[]).push("C:\\")
  ;(p.owner as { sessionId: string }).sessionId = "foreign"
  expect(captured.spec.argv[0]).toBe("/usr/bin/bash")
  expect(captured.spec.env.PATH).toBe("/usr/bin:/bin")
  expect(captured.policy.authorityRoots).toEqual([root])
  expect(captured.policy.owner.sessionId).toBe("owner")
  expect(Object.isFrozen(captured.policy.owner)).toBe(true)
})

it("refuses unsupported transports, policies, argv, ownership and roots locally", () => {
  const requests: [ProcessSpec, CompiledSandboxPolicy][] = [
    [{ ...spec(), transport: "pty" }, policy()],
    [{ ...spec(), lifetime: "retain-tree" }, policy()],
    [{ ...spec(), argumentEncoding: "cmd-verbatim" }, policy()],
    [{ ...spec(), argv: ["C:\\Windows\\System32\\cmd.exe"] }, policy()],
    [{ ...spec(), argv: ["/mnt/c/Windows/System32/cmd.exe"] }, policy()],
    [{ ...spec(), env: { WSL_INTEROP: "socket" } }, policy()],
    [spec(), { ...policy(), mode: "danger-full-access" }],
    [spec(), { ...policy(), owner: { sessionId: "foreign" } }],
    [{ ...spec(), cwd: "C:\\Windows" }, policy()],
    [spec(), { ...policy(), writeRoots: [root] }],
    [spec(), { ...policy(), authorityRoots: ["\\\\server\\share"] }],
    [spec(), { ...policy(), mode: "workspace-write", writeRoots: [root], referenceRoots: [root + "\\packages"] }],
    [spec(), Object.assign(policy(), { requireReadIsolation: true })],
    [spec(), Object.assign(policy(), { denyPaths: [root] })],
  ]
  for (const [s, p] of requests) expect(() => captureRequest(s, p)).toThrow()
})

it("requires the exact requested WSL2 inventory entry, including UTF16 launcher output", () => {
  const inventory = Buffer.from("  NAME       STATE      VERSION\r\n* Ubuntu     Stopped    2\r\n  Ubuntu-1   Running    1\r\n", "utf16le")
  expect(parseWslInventory(inventory, "Ubuntu")).toBe(true)
  expect(parseWslInventory(inventory, "Ubuntu-1")).toBe(false)
  expect(parseWslInventory(inventory, "Ubun")).toBe(false)
  expect(parseWslInventory(inventory, "--exec")).toBe(false)
})
