#!/usr/bin/env node
// Repeatable long-session baseline for the Desktop timeline projections.
//
// Usage (from the repo root):
//   node --import tsx packages/desktop/scripts/profile-long-session.mjs [--out DIR] [--soak N]
//
// Fixtures and the JSON baseline are written OUTSIDE the repo by default
// (`D:\frontend-research\desktop-perf`). Renderer heap and mounted DOM row
// counts are NOT measurable here; the Electron smoke records those.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import { applyHistory, applyNotification, emptyEventWindow } from "../src/renderer/session/event-window.ts"
import { projectTimeline } from "../src/renderer/session/project.ts"

const args = process.argv.slice(2)
const outIndex = args.indexOf("--out")
const soakIndex = args.indexOf("--soak")
const outDir = outIndex === -1 ? "D:/frontend-research/desktop-perf" : args[outIndex + 1]
const soakRounds = soakIndex === -1 ? 50 : Number(args[soakIndex + 1])

function events(count, tag) {
  const list = []
  for (let index = 0; index < count; index += 1) {
    list.push(index % 2 === 0
      ? { type: "user/message", text: `${tag} user ${index}`, seq: index }
      : { type: "assistant/message", text: `${tag} assistant ${index}`, seq: index })
  }
  return list
}

function timed(work) {
  const start = performance.now()
  const value = work()
  return { ms: Number((performance.now() - start).toFixed(2)), value }
}

const stamp = new Date().toISOString().replaceAll(":", "-")
mkdirSync(outDir, { recursive: true })
const fixtureDir = join(outDir, `fixtures-${stamp}`)
mkdirSync(fixtureDir, { recursive: true })

// 100 session fixtures (small) + one 10k and one 100k event fixture.
for (let index = 0; index < 100; index += 1) {
  writeFileSync(join(fixtureDir, `session-${String(index).padStart(3, "0")}.json`),
    JSON.stringify({ id: `session-${index}`, events: events(20, `s${index}`) }))
}
const tenK = events(10_000, "small")
const hundredK = events(100_000, "large")
writeFileSync(join(fixtureDir, "events-10000.json"), JSON.stringify(tenK))
writeFileSync(join(fixtureDir, "events-100000.json"), JSON.stringify(hundredK))

const project10k = timed(() => projectTimeline(tenK))
const project100k = timed(() => projectTimeline(hundredK))

let windowState = emptyEventWindow()
const history10k = timed(() => { windowState = applyHistory(windowState, { events: tenK, nextSeq: tenK.length }) })
const history100k = timed(() => { windowState = applyHistory(windowState, { events: hundredK, nextSeq: hundredK.length }) })
const notification = timed(() => {
  for (let index = 0; index < 5_000; index += 1) {
    windowState = applyNotification(windowState, { type: "assistant/chunk", text: `chunk ${index}`, seq: 200_000 + index })
  }
})

// Soak: repeated session switches (replay merge + projection) must not trend up.
const switchTimes = []
for (let round = 0; round < soakRounds; round += 1) {
  const start = performance.now()
  let local = emptyEventWindow()
  local = applyHistory(local, { events: round % 2 === 0 ? tenK : hundredK, nextSeq: 1 })
  projectTimeline(local.events)
  switchTimes.push(Number((performance.now() - start).toFixed(2)))
}

const head = switchTimes.slice(0, 5)
const tail = switchTimes.slice(-5)
const average = (list) => Number((list.reduce((sum, value) => sum + value, 0) / list.length).toFixed(2))
const baseline = {
  machine: `${process.platform} ${process.arch} node ${process.version}`,
  generatedAt: new Date().toISOString(),
  outDir,
  projectTimeline: { "10k": project10k.ms, "100k": project100k.ms },
  eventWindow: {
    history10kMs: history10k.ms,
    history100kMs: history100k.ms,
    notifications5000Ms: notification.ms,
    retainedEvents: windowState.events.length,
  },
  switchSoak: {
    rounds: soakRounds,
    averageMs: average(switchTimes),
    first5AverageMs: average(head),
    last5AverageMs: average(tail),
  },
}
const baselinePath = join(outDir, `baseline-${stamp}.json`)
writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`)
console.log(JSON.stringify({ baselinePath, ...baseline }, null, 2))
