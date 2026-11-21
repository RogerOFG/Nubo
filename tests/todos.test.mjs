import test from "node:test";
import assert from "node:assert/strict";
import { counts, dayOf, dueTasks, isDone, isOverdue, minutesOf, tasksFor } from "../src/core/todos.ts";

const task = (over = {}) => ({ id: "a", title: "T", time: "", daily: false, doneDay: "", notifiedDay: "", ...over });
const at = (day, h, m) => new Date(`${day}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`);

test("dayOf and minutesOf", () => {
  assert.equal(dayOf(new Date(2026, 10, 5, 23, 59)), "2026-11-05");
  assert.equal(minutesOf("09:30"), 570);
  assert.equal(minutesOf("24:00"), null);
  assert.equal(minutesOf("9:30"), null);
  assert.equal(minutesOf(""), null);
});

test("a daily task is done for its day only, any other for good", () => {
  assert.equal(isDone(task({ daily: true, doneDay: "2026-11-20" }), "2026-11-21"), false);
  assert.equal(isDone(task({ daily: true, doneDay: "2026-11-21" }), "2026-11-21"), true);
  assert.equal(isDone(task({ doneDay: "2026-11-01" }), "2026-11-21"), true);
  assert.equal(isDone(task(), "2026-11-21"), false);
});

test("the list drops what was finished on an earlier day, and counts today", () => {
  const list = [
    task({ id: "1", doneDay: "2026-11-19" }), // finished long ago: gone
    task({ id: "2", doneDay: "2026-11-21" }), // finished today
    task({ id: "3" }), // open
    task({ id: "4", daily: true, doneDay: "2026-11-20" }), // daily, open again
  ];
  assert.deepEqual(tasksFor(list, "2026-11-21").map((t) => t.id), ["2", "3", "4"]);
  assert.deepEqual(counts(list, "2026-11-21"), [1, 3]);
});

test("a task is due once its time has come, once a day, unless done", () => {
  const day = "2026-11-21";
  const list = [
    task({ id: "early", time: "09:00" }),
    task({ id: "late", time: "18:00" }),
    task({ id: "told", time: "09:00", notifiedDay: day }),
    task({ id: "done", time: "09:00", doneDay: day }),
    task({ id: "none" }),
    task({ id: "daily", time: "09:00", daily: true, notifiedDay: "2026-11-20" }),
  ];
  assert.deepEqual(dueTasks(list, at(day, 10, 0)).map((t) => t.id), ["early", "daily"]);
  assert.deepEqual(dueTasks(list, at(day, 8, 59)).map((t) => t.id), []);
  assert.equal(isOverdue(list[0], at(day, 10, 0)), true);
  assert.equal(isOverdue(list[1], at(day, 10, 0)), false);
  assert.equal(isOverdue(list[3], at(day, 10, 0)), false);
});
