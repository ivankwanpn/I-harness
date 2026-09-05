import { execFileSync } from "node:child_process"

/** Switch a Windows PTY child to UTF-8 without relying on PATH lookup. */
export function setUtf8CodePage(): void {
  execFileSync(`${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\chcp.com`, ["65001"], { stdio: "ignore" })
}
