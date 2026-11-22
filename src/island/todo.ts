// Task reminders: when a task's time comes (once a day), the island opens on the
// Tasks tab with a sound, and the task rings — highlighted — for a minute and a half.
//
// The island's page keeps the clock: every 20 seconds it looks at the list.
// A task whose time passed while Nubo was closed is reminded when it starts.

import { Sound } from "../core/sound";
import { State } from "../core/state";
import type { IslandViewName } from "../core/layout";
import { Todos, dayOf, dueTasks, loadTodos, saveTodos } from "../core/todos";

const RING_MS = 90_000;
const ringing = new Map<string, number>();

/** The task is ringing: its time has just come. */
export function reminding(id: string): boolean {
  const until = ringing.get(id);
  if (until == null) return false;
  if (Date.now() > until) {
    ringing.delete(id);
    return false;
  }
  return true;
}

export function registerTodoReminders(island: { alert(view: IslandViewName): void }) {
  void loadTodos();

  const check = () => {
    if (!Todos.loaded || State.paused) return;
    const now = new Date();
    const due = dueTasks(Todos.tasks, now);
    if (due.length === 0) return;
    const day = dayOf(now);
    const ids = new Set(due.map((t) => t.id));
    // Marked in the page first: a list that cannot be written must not ring every 20 seconds.
    Todos.tasks = Todos.tasks.map((t) => (ids.has(t.id) ? { ...t, notifiedDay: day } : t));
    void saveTodos({ tasks: Todos.tasks, notes: Todos.notes });
    for (const id of ids) ringing.set(id, Date.now() + RING_MS);
    Sound.play("question");
    island.alert("tasks");
    State.notify();
  };

  window.setTimeout(check, 4000);
  window.setInterval(check, 20_000);
}
