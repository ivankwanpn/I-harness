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
