import { expect, it, vi, afterEach } from "vitest"
const state = vi.hoisted(() => ({bashAvailable: true}))
afterEach(() => {state.bashAvailable = true})
const inv = Buffer.from(" NAME    STATE    VERSION\n* Ubuntu    Running    2\n  Old Guest    Stopped    1\n", "utf16le")
vi.mock("node:child_process", () => ({
  execFile: (_path: string, args: string[], options: Record<string, unknown>, cb: (err:null,stdout:Buffer,stderr:Buffer)=>void) => {
    expect(_path).toBe("C:\\Windows\\System32\\wsl.exe")
    expect(options.windowsHide).toBe(true)
    if (args[0] === "--list") cb(null, inv, Buffer.alloc(0))
    else cb(null, Buffer.from(JSON.stringify({ dependencies: { python:{available:true,path:"/usr/bin/python3"},
      bash:state.bashAvailable ? {available:true,path:"/bin/bash"} : {available:false},bubblewrap:{available:true,path:"/usr/bin/bwrap"},
      node:{available:false},npm:{available:false},socat:{available:false},git:{available:true,path:"/usr/bin/git"} },
      paths:[{windows:"D:\\I-harness-main",linux:"/mnt/d/I-harness-main"}] })), Buffer.alloc(0))
  },
  spawn: () => { throw new Error("Controlled discovery profile cannot start isolation") },
}))
import { listWslDistributions, inspectWslRuntime } from "../src/index.ts"

it("returns exact distro names, versions and states", async () => {
  expect(await listWslDistributions()).toEqual([{name:"Ubuntu",version:2,state:"Running"},{name:"Old Guest",version:1,state:"Stopped"}])
})
it("reports runtime statuses and mappings when isolation itself is unavailable", async () => {
  const info = await inspectWslRuntime("Ubuntu", ["D:\\I-harness-main"])
  expect(info.available).toBe(false)
  expect(info.dependencies.node.available).toBe(false)
  expect(info.dependencies.python).toEqual({available:true,path:"/usr/bin/python3"})
  expect(info.paths).toEqual([{windows:"D:\\I-harness-main",linux:"/mnt/d/I-harness-main"}])
})
it("does not inspect an absent or WSL1 distribution", async () => {
  expect((await inspectWslRuntime("Old Guest")).detail).toMatch(/WSL2/)
  expect((await inspectWslRuntime("Absent")).available).toBe(false)
})
it("reports missing mandatory Bash before declaring or probing an available shell environment", async () => {
  state.bashAvailable = false
  const info = await inspectWslRuntime("Ubuntu", ["D:\\I-harness-main"])
  expect(info.available).toBe(false)
  expect(info.detail).toMatch(/missing.*bash/i)
})
