import { execFile } from "node:child_process"
import { promisify } from "node:util"

/** Measure reply text independently of the controls in the same bubble. */
export function renderedAssistantBodies(document) {
  return [...document.querySelectorAll(".timeline-assistant")]
    .filter(bubble => bubble.getClientRects().length > 0)
    .map(bubble => [...bubble.childNodes]
      .filter(node => node.nodeType !== 1 || !node.matches(".message-actions, .timeline-partial-reply"))
      .map(node => node.innerText ?? node.textContent ?? "")
      .join("\n")
      .trim())
}

export async function sampleDesktopProcesses(pid) {
  if (process.platform !== "win32") return null
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid Desktop process ID")
  // Keep command lines inside the sampler. Its output is limited to process
  // identity, a fixed role name and counters.
  const command = `
    $ErrorActionPreference = 'Stop'
    $root = ${pid}
    $query = 'ProcessId=' + $root + ' OR ParentProcessId=' + $root
    $seen = [System.Collections.Generic.HashSet[int]]::new()
    $pending = @(Get-CimInstance Win32_Process -Filter $query)
    $rows = while ($pending.Count) {
      $parents = @()
      foreach ($entry in $pending) {
        $id = [int]$entry.ProcessId
        if (!$seen.Add($id)) { continue }
        if ($id -ne $root) { $parents += "ParentProcessId=$id" }
        $process = Get-Process -Id $id -ErrorAction SilentlyContinue
        if (!$process) { continue }
        $argv = $entry.CommandLine
        $role = if ($id -eq $root) { 'desktop-main' }
          elseif ($argv -match '(?:^|\\s)--desktop-host(?:\\s|$)') { 'desktop-host' }
          elseif ($argv -match '(?:^|\\s)--type=renderer(?:\\s|$)') { 'renderer' }
          elseif ($argv -match '(?:^|\\s)--type=gpu-process(?:\\s|$)') { 'gpu' }
          elseif ($argv -match '(?:^|\\s)--type=utility(?:\\s|$)') { 'utility' }
          else { 'other' }
        [pscustomobject]@{
          pid=$id; parentPid=$entry.ParentProcessId; role=$role; cpuSeconds=$process.CPU
          workingSet=$process.WorkingSet64; privateBytes=$process.PrivateMemorySize64
        }
      }
      $pending = if ($parents.Count) { @(Get-CimInstance Win32_Process -Filter ($parents -join ' OR ')) } else { @() }
    }
    @($rows) | ConvertTo-Json -Compress -AsArray
  `
  const { stdout } = await promisify(execFile)("pwsh", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, timeout: 20_000 })
  return stdout.trim() ? JSON.parse(stdout) : null
}

// These functions are evaluated in the fixture renderer. Keep their bodies
// independent of the Node process and avoid sampling transcript content.
export function rendererState() {
  const marker = document.querySelector(".connection-state")
  const workspace = ["online", "offline", "connecting", "reconnecting", "idle"].find(state =>
    marker?.classList.contains("connection-" + state)) ?? "unknown"
  return {
    visibility: document.hidden ? "hidden" : document.hasFocus() ? "foreground" : "visible-unfocused",
    workspace,
    network: navigator.onLine ? "online" : "offline",
  }
}

export function installRendererSoakObserver(readState) {
  if (typeof window.ihSoakSample === "function") return

  const interval = 50
  const key = state => JSON.stringify(state)
  let state = readState()
  let since = performance.now()
  let beganAt = since
  let lastTick
  let transitions = 0
  let omittedGaps = 0
  let buckets = new Map()

  function bucket() {
    const id = key(state)
    let stats = buckets.get(id)
    if (!stats) {
      stats = { ...state, observedMs: 0, callbacks: 0, measuredGaps: 0, maxGapMs: null, gapsOver100Ms: 0 }
      buckets.set(id, stats)
    }
    return stats
  }

  function update(at) {
    const next = readState()
    if (key(next) === key(state)) return
    bucket().observedMs += at - since
    since = at
    state = next
    transitions++
    if (lastTick !== undefined) omittedGaps++
    lastTick = undefined
  }

  const refresh = () => update(performance.now())
  document.addEventListener("visibilitychange", refresh)
  for (const event of ["focus", "blur", "online", "offline"]) window.addEventListener(event, refresh)
  const connection = new MutationObserver(refresh)
  let marker
  function observeConnection() {
    const current = document.querySelector(".connection-state")
    if (current === marker) return
    marker = current
    connection.disconnect()
    if (current) {
      connection.observe(current, { attributes: true, attributeFilter: ["class"] })
      if (current.parentNode) connection.observe(current.parentNode, { childList: true })
    }
  }
  observeConnection()

  const timer = setInterval(() => {
    const now = performance.now()
    observeConnection()
    update(now)
    const stats = bucket()
    stats.callbacks++
    if (lastTick !== undefined) {
      const gap = now - lastTick
      stats.measuredGaps++
      stats.maxGapMs = Math.max(gap, stats.maxGapMs ?? 0)
      if (gap > 100) stats.gapsOver100Ms++
    }
    lastTick = now
  }, interval)

  window.ihSoakSample = () => {
    const now = performance.now()
    update(now)
    bucket().observedMs += now - since
    const sample = {
      observationMs: now - beganAt, timerIntervalMs: interval, transitions, omittedGaps,
      stateAtSample: state, byState: [...buckets.values()], heapBytes: performance.memory?.usedJSHeapSize,
    }
    buckets = new Map()
    since = beganAt = now
    lastTick = undefined
    transitions = omittedGaps = 0
    return sample
  }
  window.addEventListener("pagehide", () => {
    clearInterval(timer)
    connection.disconnect()
    document.removeEventListener("visibilitychange", refresh)
    for (const event of ["focus", "blur", "online", "offline"]) window.removeEventListener(event, refresh)
    delete window.ihSoakSample
  }, { once: true })
}

export function sumProcessRoles(processes) {
  if (!processes) return null
  const roles = Object.create(null)
  for (const process of processes) {
    const role = roles[process.role] ??= { count: 0, workingSet: 0, privateBytes: 0, cpuSeconds: 0 }
    role.count++
    role.workingSet += process.workingSet
    role.privateBytes += process.privateBytes
    role.cpuSeconds += process.cpuSeconds ?? 0
  }
  return roles
}
