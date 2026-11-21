import test from "node:test";
import assert from "node:assert/strict";
import { parseLrc, lineIndexAt, lyricWindow } from "../src/core/lyrics.ts";

const LRC = `[ar:Someone]\n[00:10.50] First\n[00:14.00] Second\n[00:14.00][01:02.5] Chorus\n[00:20.000]\n[00:25.1] Last`;

test("parseLrc reads stamps, repeats and skips tags", () => {
  const lines = parseLrc(LRC);
  assert.equal(lines[0].text, "First");
  assert.equal(lines[0].time, 10.5);
  assert.equal(lines.filter((l) => l.text === "Chorus").length, 2);
  assert.ok(lines.some((l) => l.text === "" && l.time === 20));
  assert.deepEqual(lines.map((l) => l.time), [...lines.map((l) => l.time)].sort((a, b) => a - b));
});

test("lineIndexAt finds the line being sung", () => {
  const lines = parseLrc(LRC);
  assert.equal(lineIndexAt(lines, 5), -1);
  assert.equal(lineIndexAt(lines, 10.5), 0);
  assert.equal(lines[lineIndexAt(lines, 16)].text, "Chorus");
});

test("lyricWindow runs one second ahead", () => {
  const lines = parseLrc(LRC);
  assert.equal(lyricWindow(lines, 12.9).current, "First");
  assert.equal(lyricWindow(lines, 13.1).current, "Chorus");
  assert.equal(lyricWindow(lines, 0).current, "");
});
