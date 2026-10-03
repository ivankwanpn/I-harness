import { extname } from "node:path"
export const READER_LIMITS = { inputBytes: 16 * 1024 * 1024, entries: 256, entryBytes: 8 * 1024 * 1024, expandedBytes: 32 * 1024 * 1024, expansionRatio: 1000, textBytes: 32 * 1024, pdfPages: 100, timeoutMs: 15_000 } as const
export function documentFormat(name: string, header: Uint8Array): string | undefined {
  const extension = extname(name).toLowerCase()
  if ([".doc", ".xls", ".ppt", ".docm", ".xlsm", ".pptm", ".xlsb", ".odt", ".ods", ".odp", ".rar", ".7z", ".tar", ".gz"].includes(extension)) throw new Error(`Unsupported legacy, macro-enabled or archive attachment format: ${extension}`)
  if (Buffer.from(header).subarray(0, 5).toString("ascii") === "%PDF-") return ".pdf"
  if ([".pdf", ".docx", ".xlsx", ".pptx", ".zip"].includes(extension)) return extension
  if (header[0] === 0x50 && header[1] === 0x4b && [3, 5, 7].includes(header[2] ?? -1)) return ".zip"
  return undefined
}
