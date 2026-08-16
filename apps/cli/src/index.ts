import { pathToFileURL } from "node:url"
import { runHeadless } from "./run.ts"

export { runHeadless } from "./run.ts"
export type { HeadlessOptions, HeadlessResult } from "./run.ts"

export function main(argv: string[]): Promise<number> {
  const cmd = argv[2]
  if (cmd === "run") {
    const task = argv.slice(3).join(" ")
    return runHeadless(task, { workspace: process.cwd() }).then((r) => {
      console.log(r.finalText)
      return r.exitCode
    })
  }
  console.error("usage: i-harness run <task>")
  return Promise.resolve(1)
}

// Entry guard: invoke main only when this module is executed directly as the
// process entry point (e.g. `node --import tsx apps/cli/src/index.ts run "..."`),
// never when it is merely imported (tests, other modules). Both sides are
// compared as file:// URLs — a raw path string never equals a file URL, so
// comparing import.meta.url (a URL) to pathToFileURL(argv[1]).href holds on
// Windows and POSIX alike.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).then((code) => process.exit(code))
}
