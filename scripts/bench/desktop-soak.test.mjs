import assert from "node:assert/strict"
import test from "node:test"
import { runInNewContext } from "node:vm"
import { installRendererSoakObserver, rendererState, sumProcessRoles } from "./desktop-soak.mjs"

test("timer gaps only use callbacks from a single visibility and connection state", () => {
  let now = 0
  let tick
  let notifyConnection
  const window = new EventTarget()
  const document = new EventTarget()
  let focused = true
  let workspace = "online"
  const marker = { classList: { contains: value => value === "connection-" + workspace } }
  Object.assign(document, { hidden: false, hasFocus: () => focused, querySelector: () => marker })
  const navigator = { onLine: true }
  const vm = { window, document, navigator, performance: { now: () => now } }
  vm.MutationObserver = class {
    constructor(callback) { notifyConnection = callback }
    observe() {}
    disconnect() {}
  }
  vm.setInterval = callback => { tick = callback; return 1 }
  vm.clearInterval = () => { tick = undefined }
  runInNewContext(`(${installRendererSoakObserver})(${rendererState})`, vm)
  const callback = at => { now = at; tick() }
  callback(50)
  callback(100)
  now = 125
  document.hidden = true
  document.dispatchEvent(new Event("visibilitychange"))
  callback(700)
  callback(750)
  now = 760
  workspace = "offline"
  navigator.onLine = false
  notifyConnection()
  callback(1000)
  callback(1050)
  now = 1100
  document.hidden = false
  focused = false
  document.dispatchEvent(new Event("visibilitychange"))
  now = 1150
  focused = true
  window.dispatchEvent(new Event("focus"))
  callback(1200)
  callback(1351)
  now = 1400
  const first = window.ihSoakSample()
  assert.equal(first.observationMs, 1400)
  assert.equal(first.omittedGaps, 3)
  const find = (visibility, state) => first.byState.find(item => item.visibility === visibility && item.workspace === state)
  assert.equal(find("foreground", "online").maxGapMs, 50)
  assert.equal(find("foreground", "online").observedMs, 125)
  assert.equal(find("hidden", "online").maxGapMs, 50)
  assert.equal(find("hidden", "offline").maxGapMs, 50)
  assert.equal(find("foreground", "offline").network, "offline")
  assert.equal(find("foreground", "offline").maxGapMs, 151)
  assert.equal(find("foreground", "offline").gapsOver100Ms, 1)
  assert.equal(find("visible-unfocused", "offline").maxGapMs, null)
  assert.equal(find("visible-unfocused", "offline").observedMs, 50)

  callback(1480)
  callback(1530)
  const second = window.ihSoakSample()
  assert.equal(second.byState[0].callbacks, 2)
  assert.equal(second.byState[0].measuredGaps, 1)
  assert.equal(second.byState[0].maxGapMs, 50)
  window.dispatchEvent(new Event("pagehide"))
  assert.equal(window.ihSoakSample, undefined)
  assert.equal(tick, undefined)
})

test("sums memory by role while keeping unavailable samples distinct from zero", () => {
  assert.equal(sumProcessRoles(null), null)
  const roles = sumProcessRoles([
    { role: "desktop-host", privateBytes: 15, workingSet: 20, cpuSeconds: 3 },
    { role: "renderer", privateBytes: 10, workingSet: 25, cpuSeconds: 2 },
    { role: "renderer", privateBytes: 14, workingSet: 35, cpuSeconds: 3 },
  ])
  assert.deepEqual(roles["desktop-host"], { count: 1, privateBytes: 15, workingSet: 20, cpuSeconds: 3 })
  assert.deepEqual(roles.renderer, { count: 2, privateBytes: 24, workingSet: 60, cpuSeconds: 5 })
})
