// Team-internal path addressing (codex AgentPath pattern adapted to the
// i-harness team convention: root is `lead`, teammates are `lead/<name>`).
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const LEAD_NAME = "lead"

export class AgentPath {
  private constructor(private readonly segments: string[]) {}

  static root(): AgentPath {
    return new AgentPath([LEAD_NAME])
  }
  static parse(s: string): AgentPath {
    const segments = s.split("/")
    if (segments.length < 1 || segments[0] !== LEAD_NAME) {
      throw new Error(`agent-team: path must be lead-prefixed (got "${s}")`)
    }
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      if (seg === LEAD_NAME && i > 0) throw new Error(`agent-team: "lead" is reserved (got "${s}")`)
      if (!NAME_RE.test(seg)) throw new Error(`agent-team: invalid path segment "${seg}" (expected ^[a-z0-9]+(-[a-z0-9]+)*$)`)
    }
    return new AgentPath(segments)
  }
  toString(): string {
    return this.segments.join("/")
  }
  isRoot(): boolean {
    return this.segments.length === 1
  }
  name(): string {
    return this.segments[this.segments.length - 1]
  }
  join(name: string): AgentPath {
    return AgentPath.parse(`${this.toString()}/${name}`)
  }
  resolve(ref: string): AgentPath {
    if (ref.startsWith("lead/")) return AgentPath.parse(ref)
    return AgentPath.parse(`${this.toString()}/${ref}`)
  }
}
