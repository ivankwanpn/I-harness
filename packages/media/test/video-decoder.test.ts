import { afterAll, beforeAll, expect, it } from "vitest"
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createReadVideoTool, type VideoAudioAnalyzer } from "../src/index.ts"
import { decodeVideo, resolveMediaBinaries } from "../src/video-decoder.ts"
import { runMediaProcess } from "../src/process.ts"

let directory: string, withAudio: string, silent: string, singleFrame: string
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "ih-real-video-"))
  const { ffmpeg } = await resolveMediaBinaries()
  withAudio = join(directory, "tone.mp4"); silent = join(directory, "silent.mp4")
  singleFrame = join(directory, "single.mp4")
  await runMediaProcess(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-f", "lavfi", "-i", "testsrc2=size=96x64:rate=10:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=24000:duration=2", "-c:v", "mpeg4", "-c:a", "aac", "-shortest", "-y", withAudio], { maxBytes: 1024, timeoutMs: 15000 })
  await runMediaProcess(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", withAudio, "-c:v", "copy", "-an", "-y", silent], { maxBytes: 1024, timeoutMs: 15000 })
  await runMediaProcess(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", withAudio, "-frames:v", "1", "-c:v", "mpeg4", "-an", "-y", singleFrame], { maxBytes: 1024, timeoutMs: 15000 })
}, 30_000)
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }) })

it("decodes real timestamped images and audible PCM from a generated local A/V fixture", async () => {
  const result = await decodeVideo({ path: withAudio, startSeconds: 0, durationSeconds: 2, frameCount: 2 })
  expect(result.frames).toHaveLength(2)
  expect(result.frames.map(frame => frame.timestampSeconds)).toEqual([0.5, 1.5])
  expect(result.frames[0].image.dataBase64).not.toBe(result.frames[1].image.dataBase64)
  const audio = Buffer.from(result.wav!)
  expect(audio.toString("ascii", 0, 4)).toBe("RIFF")
  expect(audio.toString("ascii", 8, 12)).toBe("WAVE")
  expect(audio.readUInt32LE(4)).toBe(audio.length - 8)
  const dataOffset = audio.indexOf(Buffer.from("data")) + 8
  expect(dataOffset).toBeGreaterThan(8)
  expect(audio.readUInt32LE(dataOffset - 4)).toBe(audio.length - dataOffset)
  let magnitude = 0
  for (let index = dataOffset; index + 1 < audio.length; index += 2) magnitude += Math.abs(audio.readInt16LE(index))
  expect(magnitude).toBeGreaterThan(100_000)
  expect(audio.length).toBeLessThan(100_000)
}, 30_000)
it("reports absent sound only for a file with no audio stream", async () => {
  const result = await decodeVideo({ path: silent, startSeconds: 0, durationSeconds: 2, frameCount: 1 })
  expect(result.wav).toBeUndefined(); expect(result.audioError).toBeUndefined()
})
it("reads a one-frame clip without seeking past its only decodable frame", async () => {
  const result = await decodeVideo({ path: singleFrame, startSeconds: 0, durationSeconds: 1, frameCount: 6 })
  expect(result.frames.length).toBeGreaterThan(0)
})
it("rejects a disguised concat playlist before following referenced files", async () => {
  const playlist = join(directory, "playlist.mp4")
  await writeFile(playlist, "ffconcat version 1.0\nfile 'tone.mp4'\n")
  await expect(decodeVideo({ path: playlist, startSeconds: 0, durationSeconds: 1, frameCount: 1 })).rejects.toThrow(/whitelist/)
})
it("delivers fixture WAV to the analyzer and never persists raw audio bytes", async () => {
  let received = 0
  const analyzeAudio: VideoAudioAnalyzer = async input => { received = input.wav.length; return { status: "analyzed", analysis: "Mock analyzer received a tone fixture" } }
  const result = await createReadVideoTool({ workspace: directory, analyzeAudio }).execute({ path: "tone.mp4", frameCount: 1 }, {})
  expect(received).toBeGreaterThan(1000); expect(result.status).toBe("complete")
  expect(result.audio?.status).toBe("analyzed"); expect(result.images).toHaveLength(1)
  expect(JSON.stringify(result)).not.toContain('"wav"')
  expect((await readFile(withAudio)).length).toBeGreaterThan(100)
})
