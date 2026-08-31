import { createTextRetainer } from "@i-harness/output-retention"

export const DEFAULT_MAX_CHARS = 128_000
export const DEFAULT_FETCH_MAX_BYTES = 512_000

// 只做 html/plain；不支援 text/html 以外大類的 file 型態（text 原樣）。
export function extractText(body: string, contentType: string | null): string {
  const isHtml = (contentType ?? "").toLowerCase().startsWith("text/html")
  if (!isHtml) return body
  return body
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => { try { return String.fromCodePoint(parseInt(hex, 16)) } catch { return " " } })
    .replace(/&#(\d+);/g, (_, dec: string) => { try { return String.fromCodePoint(parseInt(dec, 10)) } catch { return " " } })
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export function extractTitle(html: string): string | undefined {
  const m = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)
  return m ? m[1]!.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() : undefined
}

/** 串流讀 body，超過 maxBytes 就 destroy 連線（有界記憶體）。 */
export async function readBodyLimited(res: Response, maxBytes: number): Promise<{ text: string; truncatedAt: number | null }> {
  if (!res.body) return { text: await res.text(), truncatedAt: null }
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.length
    if (total > maxBytes) {
      await reader.cancel()
      const joined = Buffer.concat(chunks).toString("utf-8")
      // 加上明確截斷標記：回傳已收部分（等於找到位置前內容）
      return { text: joined, truncatedAt: total }
    }
  }
  return { text: Buffer.concat(chunks).toString("utf-8"), truncatedAt: null }
}

export function capText(text: string, maxChars: number): { text: string; truncated: boolean } {
  const r = createTextRetainer({ maxBytes: maxChars, mode: "headTail" })
  r.push(text)
  return { text: r.finish().text, truncated: r.finish().truncated }
}
