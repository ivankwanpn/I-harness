import { gzipSync } from "node:zlib"
export const prefix = "node-v22.23.3-linux-x64/"
export function archive(extra: { name: string; type?: string; data?: Buffer; target?: string }[] = []) {
  const entries = [
    { name: prefix + "bin/node", data: Buffer.from([0x7f, 69, 76, 70, 1]) },
    { name: prefix + "lib/node_modules/npm/package.json", data: Buffer.from('{"version":"10.9.9"}') },
    { name: prefix + "lib/node_modules/npm/bin/npm-cli.js", data: Buffer.from("npm") },
    { name: prefix + "lib/node_modules/npm/bin/npx-cli.js", data: Buffer.from("npx") }, ...extra,
  ]
  const blocks = entries.flatMap(entry => {
    const header = Buffer.alloc(512)
    header.write(entry.name, 0, 100); header.write("0000755\0", 100)
    header.write((entry.data?.length ?? 0).toString(8).padStart(11, "0") + "\0", 124)
    header.fill(32, 148, 156); header[156] = (entry.type ?? "0").charCodeAt(0)
    header.write(entry.target ?? "", 157, 100); header.write("ustar\0", 257)
    header.write(header.reduce((total, byte) => total + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148)
    const data = Buffer.alloc(Math.ceil((entry.data?.length ?? 0) / 512) * 512)
    entry.data?.copy(data); return [header, data]
  })
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
}
