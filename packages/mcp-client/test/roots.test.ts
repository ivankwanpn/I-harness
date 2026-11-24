import { expect, it } from "vitest"
import { pathToFileURL } from "node:url"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { createConnectedClient, resolveRootUris } from "../src/client.ts"

it("absolute paths become file:// URIs; http(s) URLs pass through; Windows drive letters stay paths", () => {
  const ws = mkdtempSync(join(tmpdir(), "m26-roots-"))
  expect(resolveRootUris([ws])).toEqual([pathToFileURL(ws).href])
  expect(resolveRootUris(["https://example.com/r"])).toEqual(["https://example.com/r"])
  // C:\ 是盤符不是 scheme——不能把 "c:" 當 URL protocol 解析
  expect(resolveRootUris(["C:\\project\\src"])).toEqual([pathToFileURL("C:\\project\\src").href])
})

it("relative paths resolve against the process cwd", () => {
  const expected = pathToFileURL(join(process.cwd(), "relative/path")).href
  expect(resolveRootUris(["relative/path"])).toEqual([expected])
})

it("starts each stdio child and resolves its advertised roots in the owning workspace", async () => {
  const parent = await mkdtemp(join(tmpdir(), "ih-mcp-workspaces-"))
  const script = `
    const { createInterface } = require("node:readline");
    let call;
    const send = frame => console.log(JSON.stringify({ jsonrpc: "2.0", ...frame }));
    createInterface({ input: process.stdin }).on("line", line => {
      const frame = JSON.parse(line);
      if (frame.method === "initialize") send({ id: frame.id, result: { protocolVersion: frame.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } });
      if (frame.method === "tools/call") { call = frame.id; send({ id: 777, method: "roots/list", params: {} }); }
      if (frame.id === 777 && frame.result) send({ id: call, result: { content: [{ type: "text", text: JSON.stringify({ cwd: process.cwd(), uri: frame.result.roots[0].uri }) }] } });
    });
  `
  try {
    await Promise.all(["one", "two"].map(async (part, index) => {
      const workspace = join(parent, part)
      await mkdir(join(workspace, "child"), { recursive: true })
      const client = await createConnectedClient({
        transport: "stdio", command: process.execPath, args: ["-e", script], serverName: "same",
        ...(index ? { cwd: "child" } : {}), roots: ["src"],
      }, { workspace })
      try {
        const result = await client.callTool("where", {})
        expect(result.content).toEqual([{ type: "text", text: JSON.stringify({
          cwd: index ? join(workspace, "child") : workspace, uri: pathToFileURL(join(workspace, "src")).href,
        }) }])
      } finally { await client.close() }
    }))
  } finally { await rm(parent, { recursive: true, force: true }) }
})
