import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { onDragDrop } from "../src/core/bridge.ts";
import { emit } from "./tauri.mjs";

test("WebView2 releases each drop before forwarding it and accepts the next batch after a failure", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const original = globalThis.window;
  const posted = [];
  const events = [];
  let acceptFiles = true;
  let fail = false;
  globalThis.window = Object.assign(new EventTarget(), {
    __TAURI_INTERNALS__: globalThis.__TAURI_INTERNALS__,
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
    setTimeout,
    chrome: { webview: { postMessageWithAdditionalObjects(message, files) {
      if (fail) throw new Error("WebView2 rejected the transfer");
      posted.push([message, files]);
    } } },
  });
  function send(type, files) {
    const event = new Event(type, { cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { files, types: ["Files"] } });
    window.dispatchEvent(event);
    return event;
  }
  const dispose = await onDragDrop((event) => events.push(event), () => acceptFiles);
  try {
    const source = [{ name: "first.txt" }];
    assert.equal(send("drop", source).defaultPrevented, true);
    assert.deepEqual(posted, []);
    source.length = 0;
    mock.timers.tick(0);
    assert.deepEqual(posted, [["nubo-file-drop", [{ name: "first.txt" }]]]);
    emit("file-drag", { type: "drop", paths: ["first.txt"] });

    fail = true;
    send("drop", [{ name: "bad.txt" }]);
    mock.timers.tick(0);
    assert.deepEqual(events.at(-1), { type: "drop", paths: [] });

    fail = false;
    acceptFiles = false;
    send("drop", [{ name: "self-drop.txt" }]);
    acceptFiles = true;
    send("drop", [{ name: "second.txt" }, { name: "third.txt" }]);
    mock.timers.tick(0);
    assert.deepEqual(posted.slice(1), [["nubo-file-drop", [{ name: "second.txt" }, { name: "third.txt" }]]]);
  } finally {
    await dispose();
    globalThis.window = original;
    mock.timers.reset();
  }
});
