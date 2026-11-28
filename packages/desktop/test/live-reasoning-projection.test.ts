import { expect, it } from "vitest"
import { applyHistory, applyNotification, emptyEventWindow, timelineEvents, type EventWindow, type WireEvent } from "../src/renderer/session/event-window.ts"
import { createLiveTimelineProjection } from "../src/renderer/session/live-timeline.ts"
import { projectTimeline } from "../src/renderer/session/project.ts"

const chunk = (offset: number, text: string, streamId = "r", atSeq = 4): WireEvent =>
  ({type:"reasoning/chunk",streamId,offset,text,atSeq})

it("keeps recorded rows stable on live text growth and matches a full fold through gaps, replay and settlement", () => {
  const project = createLiveTimelineProjection()
  let window: EventWindow = applyHistory(emptyEventWindow(), {events:[
    {type:"turn/start",seq:0}, {type:"user/message",text:"first",seq:1}, {type:"turn/end",seq:2},
    {type:"turn/start",seq:3}, {type:"step/start",seq:4}, {type:"tool/call",name:"read",callId:"c",args:{},seq:5}
  ],nextSeq:6})
  function check() {
    const result = project(window)
    const rendered = result.rows.map(row => row.kind === "other" && row.transient && result.reasoningText?.has(row.id)
      ? {...row, detail: result.reasoningText.get(row.id)} : row)
    expect(rendered).toEqual(projectTimeline(timelineEvents(window)))
    return result
  }
  window = applyNotification(window,chunk(0,"A"))
  const initial = check()
  window = applyNotification(window,chunk(1,"B"))
  const growing = check()
  expect(growing.rows).toBe(initial.rows)
  expect(growing.reasoningText?.get("reasoning:r")).toBe("AB")
  expect(growing.rows.map(row=>row.id)).toEqual(["message:1","reasoning:r","tool:c"])
  window = applyNotification(window,chunk(4,"E")); check()
  window = applyNotification(window,chunk(2,"CD")); check()
  window = applyNotification(window,chunk(0,"second","s",6)); check()
  window = applyNotification(window,chunk(6," block","s",6)); check()
  window = applyHistory(window,{events:[{type:"reasoning",streamId:"r",text:"complete",seq:6}],nextSeq:7})
  check()
  expect(applyNotification(window,chunk(5,"old frame"))).toBe(window)
})
