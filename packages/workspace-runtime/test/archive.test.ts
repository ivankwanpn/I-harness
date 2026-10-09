import { gzipSync } from "node:zlib"
import { expect, it } from "vitest"
import { readNodeArchive } from "../src/archive.ts"

const prefix = "node-v22.23.3-linux-x64/"
function archive(extra: { name: string; type?: string; data?: Buffer; target?: string }[] = []) {
  const entries = [
    { name: prefix + "bin/node", data: Buffer.from([0x7f, 69, 76, 70, 1]) },
    { name: prefix + "lib/node_modules/npm/package.json", data: Buffer.from('{"version":"10.9.9"}') },
    { name: prefix + "lib/node_modules/npm/bin/npm-cli.js", data: Buffer.from("npm") },
    { name: prefix + "lib/node_modules/npm/bin/npx-cli.js", data: Buffer.from("npx") },
    ...extra,
  ]
  const blocks = entries.flatMap(entry => {
    const header = Buffer.alloc(512)
    header.write(entry.name, 0, 100); header.write("0000755\0", 100)
    header.write((entry.data?.length ?? 0).toString(8).padStart(11, "0") + "\0", 124)
    header.fill(32, 148, 156); header[156] = (entry.type ?? "0").charCodeAt(0)
    header.write(entry.target ?? "", 157, 100); header.write("ustar\0", 257)
    const sum = header.reduce((total, byte) => total + byte, 0)
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148)
    const data = Buffer.alloc(Math.ceil((entry.data?.length ?? 0) / 512) * 512)
    entry.data?.copy(data)
    return [header, data]
  })
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
}

it("admits only regular Node/npm files and ignores the official bin symlink without extracting it", () => {
  const files = readNodeArchive(archive([{ name: prefix + "bin/npm", type: "2", target: "../lib/node_modules/npm/bin/npm-cli.js" }, { name: prefix + "README.md", data: Buffer.from("unused") }]))
  expect([...files.keys()]).toEqual(["bin/node", "lib/node_modules/npm/package.json", "lib/node_modules/npm/bin/npm-cli.js", "lib/node_modules/npm/bin/npx-cli.js"])
  expect(files.get("bin/node")!.bytes.subarray(0, 4)).toEqual(Buffer.from([0x7f, 69, 76, 70]))
})
it.each([
  [{ name: prefix + "../escape", data: Buffer.from("escape") }, "path"],
  [{ name: prefix + "lib/node_modules/npm/link", type: "1", target: prefix + "bin/node" }, "type"],
  [{ name: prefix + "lib/node_modules/npm/link", type: "2", target: "/etc/passwd" }, "type"],
  [{ name: prefix + "lib/node_modules/npm/device", type: "3" }, "type"],
  [{ name: prefix + "lib/node_modules/npm/FILE:stream", data: Buffer.from("bad") }, "path"],
  [{ name: prefix + "BIN/NODE", data: Buffer.from("duplicate") }, "duplicate"],
] as const)("refuses unsafe archive entry %s", (entry, reason) => {
  expect(() => readNodeArchive(archive([entry]))).toThrow(new RegExp(reason, "i"))
})
it("enforces the compressed archive limit before decompression", () => {
  expect(() => readNodeArchive(new Uint8Array(96 * 1024 * 1024 + 1))).toThrow(/limit/i)
})
