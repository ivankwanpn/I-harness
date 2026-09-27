# Desktop image admission reference

## Problem

`session/prompt` admits image bytes before a turn runs. The admission must remain durable so a queued prompt can recover after a process restart. At promotion, `core-agent` currently writes the same base64 into `user/message`; a JSONL log therefore contains each submitted image twice. SDK history and Desktop also retain both copies even though the timeline only shows `user/message`.

## Contract

1. A new inbox-backed image prompt keeps its complete `ImageInput[]` in its `agent/input/admitted` event. Its promoted `user/message` carries `imageInputId` equal to that admission's `inputId` and does not carry `images`. Text-only prompts have neither new field nor images.
2. `deriveMessages` resolves an image reference from the most recent earlier admission with that ID, even if compaction or rewind shadows the admission for model visibility. A missing reference fails explicitly; silently turning an image prompt into text is forbidden. Direct `agent.run(task, signal, images)` and older inline `user/message.images` remain valid.
3. SDK `session/history` and `session/event` present a hydrated `user/message.images` to clients and omit image bytes from the admission event. This is a transport view only: the persisted log remains the recovery source, and the SDK never mutates the session events. A history page starting after the admission still hydrates its message.
4. Desktop's retained event window drops `agent/input/admitted.images` on receipt, including from older gateways. It keeps the hydrated user message image for the timeline.
5. A forked session retaining an image message must also retain its referenced admission. If a rewind/fork cut would leave the user message without its admission, the fork must include the admission or materialize inline images. Existing compaction and rewind behavior must not hide or lose the image from model requests.
6. No new remote service or account state. The image count and size admission gates remain ten images, 10 MB each, 20 MB aggregate in Desktop/SDK; existing lower-level generic `ImageInput` validation remains compatible.

## Evidence required

- Raw JSONL from a new image prompt contains the base64 exactly once and cold load still projects the image to the model.
- SDK history, including a page starting after admission, and live notifications show the image once on the user message; neither exposes the admission bytes.
- Desktop window retains no admission base64 and displays the user image after reconnect.
- Direct inline images and older saved sessions still work. A missing reference fails without fabricating a successful text-only answer.
- Fork/rewind tests cover an image-bearing turn, followed by full package tests, typecheck, E2E, reachability and packaged Electron QA.
