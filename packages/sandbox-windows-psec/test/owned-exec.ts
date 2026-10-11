import { dirname, resolve } from "node:path"
import { createExecService } from "@i-harness/exec"
import { assertExecutionAuthority, compileExecutionPolicy } from "@i-harness/sandbox-policy"
import { createWindowsUnrestrictedBackend } from "../src/index.ts"
import type { TransportExecutionBackend } from "@i-harness/sandbox"

/** Candidate selection belongs to tests, never to a runtime environment switch. */
export function createOwnedExec(root: string, wrapBackend: (backend: TransportExecutionBackend) => TransportExecutionBackend = backend => backend) {
  const helperPath = process.env.SANDBOX_HELPER
  const backend = createWindowsUnrestrictedBackend(helperPath === undefined ? {} : {
    helperPath, manifestPath: resolve(dirname(helperPath), "manifest.json"),
  })
  const authority = Object.freeze({ kind: "unbound" as const, revision: "owned-native-test", workspaceRoot: root })
  return createExecService({ workspaceRoot: root, execution: {
    defaultOwner: { sessionId: "owned-native-test" },
    selectBackend: () => wrapBackend(backend),
    resolvePolicy: owner => compileExecutionPolicy({ mode: "danger-full-access", owner, authority }),
    validateAuthority: policy => assertExecutionAuthority(policy, compileExecutionPolicy({ mode: policy.mode, owner: policy.owner, authority })),
    dispose: () => backend.dispose(),
  } })
}
