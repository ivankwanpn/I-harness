/** A PE32+ image header and one file-backed executable section, never launched. */
export function nativeExecutableFixture(marker = 1): Buffer {
  const bytes = Buffer.alloc(1024)
  bytes.write("MZ", 0, "ascii")
  bytes.writeUInt32LE(128, 60)
  bytes.write("PE\0\0", 128, "ascii")
  bytes.writeUInt16LE(0x8664, 132)
  bytes.writeUInt16LE(1, 134)
  bytes.writeUInt16LE(240, 148)
  bytes.writeUInt16LE(0x22, 150)
  bytes.writeUInt16LE(0x20b, 152)
  bytes.writeUInt32LE(4096, 168)
  bytes.writeBigUInt64LE(0x140000000n, 176)
  bytes.writeUInt32LE(4096, 184)
  bytes.writeUInt32LE(512, 188)
  bytes.writeUInt32LE(8192, 208)
  bytes.writeUInt32LE(512, 212)
  bytes.writeUInt16LE(3, 220)
  bytes.writeUInt32LE(16, 260)
  bytes.write(".text", 392, "ascii")
  bytes.writeUInt32LE(512, 400)
  bytes.writeUInt32LE(4096, 404)
  bytes.writeUInt32LE(512, 408)
  bytes.writeUInt32LE(512, 412)
  bytes.writeUInt32LE(0x60000020, 428)
  bytes[512] = marker
  return bytes
}
