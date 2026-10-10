import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { append, createSession, deriveMessages } from "@i-harness/core-session"
import { PNG } from "../../image-validation/test/fixtures.ts"
import { createReadVideoTool, type DecodedVideo, type VideoDecoder, type VideoAudioAnalyzer } from "../src/index.ts"

let workspace: string
beforeEach(async () => { workspace = await mkdtemp(join(tmpdir(), "ih-media-test-")); await writeFile(join(workspace, "clip.mp4"), "fixture") })
afterEach(async () => { await rm(workspace, { recursive: true, force: true }) })
const decoded = (audio = true): DecodedVideo => ({
  sourceDurationSeconds: 10, startSeconds: 0, durationSeconds: 10,
  frames: [{ timestampSeconds: 2, image: { mediaType: "image/png", dataBase64: PNG, width: 2, height: 2 } }],
  ...(audio ? { wav: new Uint8Array([82, 73, 70, 70]) } : {}),
})
describe("read_video", () => {
  it("keeps frame timestamps and sends sound bytes to the configured analyzer", async () => {
    const analyzer = vi.fn<VideoAudioAnalyzer>(async () => ({ status: "analyzed", analysis: "A tone is audible; no speech.", provider: "local", model: "test" }))
    const result = await createReadVideoTool({ workspace, decoder: async () => decoded(), analyzeAudio: analyzer }).execute({ path: "clip.mp4" }, {})
    expect(result.status).toBe("complete")
    expect(result.images?.[0].name).toContain("2.000s")
    expect(result.frames).toEqual([{ imageIndex: 0, timestampSeconds: 2 }])
    expect(result.audio?.status).toBe("analyzed")
    expect(analyzer.mock.calls[0]?.[0]).toMatchObject({ wav: decoded().wav, startSeconds: 0, durationSeconds: 10 })
    expect(JSON.stringify(result)).not.toContain('"wav"')
    const session = createSession()
    append(session, { type: "tool/call", callId: "video", name: "read_video", args: { path: "clip.mp4" } })
    append(session, { type: "tool/result", callId: "video", name: "read_video", output: result })
    const messages = deriveMessages(session)
    expect(JSON.stringify(messages)).toContain("A tone is audible; no speech.")
    expect(messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === "image"))).toBe(true)
  })
  it("reports a partial result when audio exists but is not configured", async () => {
    const result = await createReadVideoTool({ workspace, decoder: async () => decoded() }).execute({ path: "clip.mp4" }, {})
    expect(result.status).toBe("partial"); expect(result.audio?.status).toBe("unconfigured"); expect(result.images).toHaveLength(1)
  })
  it("distinguishes no audio stream from failed audio analysis", async () => {
    const absent = await createReadVideoTool({ workspace, decoder: async () => decoded(false) }).execute({ path: "clip.mp4" }, {})
    expect(absent.status).toBe("complete"); expect(absent.audio?.status).toBe("absent")
    const failed = await createReadVideoTool({ workspace, decoder: async () => decoded(), analyzeAudio: async () => { throw new Error("provider failed") } }).execute({ path: "clip.mp4" }, {})
    expect(failed.status).toBe("partial"); expect(failed.audio?.status).toBe("failed")
  })
  it("rejects invalid ranges and relative path escapes before decoding", async () => {
    const decoder = vi.fn<VideoDecoder>()
    const tool = createReadVideoTool({ workspace, decoder })
    for (const input of [{ path: "../clip.mp4" }, { path: "clip.mp4", durationSeconds: 61 }, { path: "clip.mp4", startSeconds: NaN }, { path: "clip.mp4", frameCount: 9 }]) {
      expect((await tool.execute(input, {})).status).toBe("error")
    }
    expect(decoder).not.toHaveBeenCalled()
  })
  it("does not invoke analysis after cancellation", async () => {
    const controller = new AbortController(), analyzeAudio = vi.fn()
    const decoder: VideoDecoder = async () => { controller.abort(); return decoded() }
    const result = await createReadVideoTool({ workspace, decoder, analyzeAudio }).execute({ path: "clip.mp4" }, { abortSignal: controller.signal })
    expect(result.code).toBe("VIDEO_ABORTED"); expect(analyzeAudio).not.toHaveBeenCalled()
  })
  it("labels selected interval coverage and preserves analyzer capability failures", async () => {
    const result = await createReadVideoTool({ workspace, decoder: async () => ({ ...decoded(), durationSeconds: 3 }), analyzeAudio: async () => ({ status: "unsupported", reason: "Model does not accept audio" }) }).execute({ path: "clip.mp4", durationSeconds: 3 }, {})
    expect(result.status).toBe("partial"); expect(result.coverage?.truncated).toBe(true); expect(result.audio?.status).toBe("unsupported")
  })
  it("rejects corrupt decoded frames before analyzing audio or returning image data", async () => {
    const analyzeAudio = vi.fn<VideoAudioAnalyzer>()
    const result = await createReadVideoTool({ workspace, decoder: async () => ({ ...decoded(), frames: [{ timestampSeconds: 0, image: { mediaType: "image/jpeg", dataBase64: "AQID" } }] }), analyzeAudio }).execute({ path: "clip.mp4" }, {})
    expect(result.status).toBe("error"); expect(result.images).toBeUndefined(); expect(analyzeAudio).not.toHaveBeenCalled()
  })
})
