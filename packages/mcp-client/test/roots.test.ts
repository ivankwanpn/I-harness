import { expect, it } from "vitest"
import { pathToFileURL } from "node:url"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveRootUris } from "../src/client.ts"

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
