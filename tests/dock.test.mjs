import test from "node:test";
import assert from "node:assert/strict";
import { dockRect } from "../src/core/dock.ts";

test("the same visual and hit rect reaches each physical edge", () => {
  assert.deepEqual(dockRect("top", null, 720, 320, 640, 160), { x: 40, y: 0, w: 640, h: 160 });
  assert.deepEqual(dockRect("bottom", 200, 720, 320, 240, 32), { x: 80, y: 288, w: 240, h: 32 });
  assert.deepEqual(dockRect("left", 400, 390, 680, 50, 152), { x: 0, y: 324, w: 50, h: 152 });
  assert.deepEqual(dockRect("right", 400, 390, 680, 50, 152), { x: 340, y: 324, w: 50, h: 152 });
});

test("a compact island stays at its anchor and the taller panel fits near a corner", () => {
  assert.deepEqual(dockRect("right", 650, 390, 680, 50, 152), { x: 340, y: 528, w: 50, h: 152 });
  assert.deepEqual(dockRect("right", 650, 390, 680, 372, 510), { x: 18, y: 170, w: 372, h: 510 });
  assert.deepEqual(dockRect("left", 25, 280, 390, 372, 510), { x: 0, y: 0, w: 280, h: 390 });
});
