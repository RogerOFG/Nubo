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

test("a snoozed reminder rings after five minutes across midnight", async () => {
  const { postponeReminder, pendingReminder } = await import("../src/core/todos.ts");
  const now = new Date(2026, 10, 24, 23, 59);
  const task = { id: "snooze", title: "Task", time: "23:58", daily: true, doneDay: "", notifiedDay: dayOf(now) };
  assert.ok(pendingReminder(task, dayOf(now)));
  assert.ok(pendingReminder(task, "2026-11-25"));
  assert.ok(!pendingReminder({ ...task, doneDay: dayOf(now) }, "2026-11-25"));
  const later = postponeReminder(task, now.getTime());
  assert.equal(later.time, task.time);
  assert.ok(!pendingReminder(later, dayOf(now)));
  assert.deepEqual(dueTasks([later], new Date(2026, 10, 25, 0, 3, 59)), []);
  assert.deepEqual(dueTasks([later], new Date(2026, 10, 25, 0, 4)), [later]);
});

test("the open task list redraws when reminder data arrives elsewhere", async () => {
  const { installFakeDom } = await import("./fakedom.mjs");
  const { State } = await import("../src/core/state.ts");
  const { Todos, hasPendingReminders } = await import("../src/core/todos.ts");
  const { buildTasks } = await import("../src/views/tasks.ts");
  installFakeDom();
  const view = buildTasks({});
  assert.equal(view.el.querySelector(".tk-item"), null);
  try {
    State.view = "tasks";
    Todos.loaded = true;
    Todos.tasks = [task({ title: "Recordatorio pendiente", notifiedDay: dayOf(new Date()) })];
    assert.ok(hasPendingReminders());
    view.sync();
    assert.equal(view.el.querySelector(".tk-item").querySelector(".tk-title").textContent, "Recordatorio pendiente");
  } finally {
    State.view = "overview";
    view.sync();
    Todos.tasks = [];
    Todos.loaded = false;
  }
});
