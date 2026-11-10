// Copied beside an isolated shipped runtime by smoke-compiled-gateway.mjs.
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join } from "node:path"

const workspace = join(import.meta.dirname, "workspace")
const config = join(import.meta.dirname, "config")
mkdirSync(workspace)
mkdirSync(config)
process.env.IH_CONFIG_DIR = config
const settingsPath = join(config, "settings.json")
const credentialsPath = join(config, "credentials.json")
writeFileSync(settingsPath, JSON.stringify({
  autoTitle: false,
  sandboxMode: "read-only",
  compaction: { auto: false },
  codeMode: { mode: "off" },
}))
writeFileSync(credentialsPath, JSON.stringify({ refs: {} }))

const { createDesktopHost } = await import("./runtime/cli/src/host.js")
const { closeSystemFetch } = await import("./runtime/node_modules/@i-harness/http-transport/src/index.js")
const frames = []
const host = await createDesktopHost({
  workspace,
  sessionDir: join(import.meta.dirname, "sessions"),
  settingsPath,
  credentialsPath,
  onWrite: frame => frames.push(frame),
})
try {
  await host.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }))
  const initialized = frames.find(frame => frame.id === 1)
  assert.equal(initialized?.result?.protocolVersion, 3, JSON.stringify(frames))
} finally {
  try { await host.close() } finally { await closeSystemFetch() }
}

if (process.platform === "win32") {
  const { createWindowsAclSandbox } = await import("./runtime/node_modules/@i-harness/sandbox-windows-acl/src/index.js")
  const sandbox = createWindowsAclSandbox({
    mode: "read-only",
    writableDirs: [],
    privateTempRoot: config,
    hideChildWindows: true,
  })
  try {
    const invocation = sandbox.confine(
      [process.execPath, "-e", 'process.stdout.write("IH_COMPILED_ACL_OK")'],
      { mode: "read-only", workspaceRoot: workspace },
    )
    assert(invocation.argv[1].endsWith("runner.js"), JSON.stringify(invocation.argv))
    assert(!invocation.argv.some(arg => arg === "--import" || arg.includes("tsx") || arg.endsWith(".ts")), JSON.stringify(invocation.argv))
    const child = spawnSync(invocation.argv[0], invocation.argv.slice(1), {
      cwd: workspace,
      windowsHide: true,
      encoding: "utf8",
      timeout: 30_000,
    })
    assert.equal(child.status, 0, child.stderr)
    assert.equal(child.stdout, "IH_COMPILED_ACL_OK")
    console.log(child.stdout)
  } finally { sandbox.dispose() }
}
console.log("IH_COMPILED_GATEWAY_OK")
