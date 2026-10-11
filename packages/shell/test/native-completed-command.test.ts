import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { dirname, join, resolve, sep, win32 } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { withExecCallerScope } from "@i-harness/exec"
import { createOwnedExec } from "../../sandbox-windows-psec/test/owned-exec.ts"
import { createShellTools } from "../src/index.ts"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const bash = win32.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe")
describe.skipIf(process.platform !== "win32" || !existsSync(bash))("native completed shell command", () => {
  it.each(["bash", "shell"])("%s preserves a child command whose stdin close races its completed output", async name => {
    const fixtureRoot = join(repo, ".tmp")
    mkdirSync(fixtureRoot, { recursive: true })
    const fixture = mkdtempSync(join(fixtureRoot, "native-completed-shell-"))
    // The native workload completes normally before capture closes stdin. This
    // controls only scheduling; command execution, output and EOF remain real.
    const exec = createOwnedExec(fixture, backend => ({ ...backend, async prepare(...args) {
      const prepared = await backend.prepare(...args)
      return { ...prepared, async commit(validate) {
        const handle = await prepared.commit(validate)
        return { ...handle, io: { ...handle.io, async endInput() {
          await handle.rootExited
          await handle.io.endInput()
        } } }
      } }
    } }))
    try {
      const tools = createShellTools({ exec, cwd: fixture, agentShell: () => ({ id: "owned-bash", label: "Owned Git Bash", command: bash, dialect: "posix" }) })
      const tool = tools.find(tool => tool.name === name)!
      const result = await withExecCallerScope({ sessionId: "native-child", parentSessionId: "native-parent" }, () =>
        tool.execute({ command: "printf 'effect\\n' >> effects.txt; printf 'SUBAGENT_DISPATCH_OK\\n'; uname -o" }, {}))
      expect(result).toMatchObject({ exitCode: 0, stdout: expect.stringMatching(/SUBAGENT_DISPATCH_OK\nMsys\n/) })
      expect(readFileSync(join(fixture, "effects.txt"), "utf8")).toBe("effect\n")
    } finally {
      await exec.dispose()
      const actual = realpathSync.native(fixture)
      if (!actual.startsWith(realpathSync.native(fixtureRoot) + sep)) throw new Error("Fixture cleanup escaped repository .tmp")
      rmSync(actual, { recursive: true, force: true })
    }
  }, 10_000)
})
