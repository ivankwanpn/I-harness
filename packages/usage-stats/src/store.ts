import { createHash, randomUUID } from "node:crypto"
import { link, mkdir, open, readdir, readFile, unlink } from "node:fs/promises"
import { join } from "node:path"
import { aggregateUsage, validateUsagePrice, validateUsageQuery, validateUsageRecord } from "./aggregate.js"
import type { UsagePrice, UsageQuery, UsageRecord, UsageSnapshot } from "./types.js"

export interface UsageStore {
  record(record: UsageRecord): Promise<void>
  query(query: UsageQuery): Promise<UsageSnapshot>
  setPricing(price: UsagePrice): Promise<void>
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex") }
function code(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code }

/** Publish fully flushed files with a no-replace hard link, safe across independent processes. */
async function publish(directory: string, name: string, content: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  const temporary = join(directory, `${randomUUID()}.tmp`)
  const destination = join(directory, name)
  try {
    const file = await open(temporary, "wx", 0o600)
    try { await file.writeFile(content, "utf8"); await file.sync() } finally { await file.close() }
    try { await link(temporary, destination) } catch (error) {
      if (code(error) !== "EEXIST") throw error
      if (await readFile(destination, "utf8") !== content) throw new Error("Usage record ID collision: existing record is immutable")
    }
    // Windows does not support opening directories for fsync; file contents remain flushed.
    if (process.platform !== "win32") {
      const folder = await open(directory, "r")
      try { await folder.sync() } finally { await folder.close() }
    }
  } finally {
    await unlink(temporary).catch(error => { if (code(error) !== "ENOENT") throw error })
  }
}

async function load<T>(directory: string, validate: (value: unknown) => T, filename: (value: T) => string, warnings: string[]): Promise<T[]> {
  let files: string[]
  try { files = await readdir(directory) } catch (error) { if (code(error) === "ENOENT") return []; throw error }
  const result: T[] = []
  // Bounded IO concurrency avoids exhausting descriptors on large histories.
  for (let index = 0; index < files.length; index += 32) {
    const batch = await Promise.all(files.slice(index, index + 32).filter(name => name.endsWith(".json")).map(async name => {
      try {
        const value = validate(JSON.parse(await readFile(join(directory, name), "utf8")))
        if (filename(value) !== name) throw new Error("Mismatched record identity")
        return value
      } catch {
        warnings.push("A corrupt or unreadable usage file was skipped; totals may be incomplete.")
        return undefined
      }
    }))
    for (const value of batch) if (value !== undefined) result.push(value)
  }
  return result
}

export function createUsageStore(directory: string): UsageStore {
  const recordsDirectory = join(directory, "records"), pricesDirectory = join(directory, "prices")
  const recordName = (record: UsageRecord) => `${hash(record.id)}.json`
  const priceName = (price: UsagePrice) => `${hash(JSON.stringify(price))}.json`
  return {
    async record(value) {
      const record = validateUsageRecord(value)
      await publish(recordsDirectory, recordName(record), JSON.stringify(record))
    },
    async setPricing(value) {
      const price = validateUsagePrice(value)
      await publish(pricesDirectory, priceName(price), JSON.stringify(price))
    },
    async query(value) {
      const query = validateUsageQuery(value), warnings: string[] = []
      const [records, allPrices] = await Promise.all([
        load(recordsDirectory, validateUsageRecord, recordName, warnings),
        load(pricesDirectory, validateUsagePrice, priceName, warnings),
      ])
      const prices = new Map<string, UsagePrice>()
      // Timestamp defines the effective update. Content tie-break makes concurrent equal timestamps deterministic.
      allPrices.sort((a, b) => b.updatedAt - a.updatedAt || JSON.stringify(a).localeCompare(JSON.stringify(b)))
      for (const price of allPrices) {
        const key = JSON.stringify([price.providerId, price.modelId])
        if (!prices.has(key)) prices.set(key, price)
      }
      return aggregateUsage(records, query, [...prices.values()], [...new Set(warnings)])
    },
  }
}
