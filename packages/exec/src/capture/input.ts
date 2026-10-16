import type { ExecCommand } from "../index.ts"

export function validateInput(command: ExecCommand): void {
  if (command.input !== undefined && command.inputBytes !== undefined) throw new Error("input and inputBytes are mutually exclusive")
  if (command.inputBytes !== undefined && (!(command.inputBytes instanceof Uint8Array) || command.inputBytes.byteLength > 2 * 1024 * 1024)) {
    throw new Error("inputBytes must be bytes bounded to 2 MiB")
  }
}
