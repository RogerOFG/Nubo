// Raise reminders when their due time arrives, including snoozed reminders.
import { Sound } from "../core/sound";
import { State } from "../core/state";
import type { IslandViewName } from "../core/layout";
import { Todos, dayOf, dueTasks, hasPendingReminders, loadTodos, saveTodos } from "../core/todos";

export function registerTodoReminders(island: { alert(view: IslandViewName): void; reveal(): void }) {
  const check = () => {
    if (!Todos.loaded || State.paused) return;
    const now = new Date();
    const due = dueTasks(Todos.tasks, now);
    if (due.length === 0) return;
    const day = dayOf(now);
    const ids = new Set(due.map((task) => task.id));
    // Mark before saving so a failed write cannot ring on every check.
    Todos.tasks = Todos.tasks.map((task) => ids.has(task.id)
      ? { ...task, notifiedDay: day, snoozedUntil: undefined } : task);
    void saveTodos({ tasks: Todos.tasks, notes: Todos.notes });
    Sound.play("question");
    if (!State.pendingApproval) island.alert("tasks");
    State.notify();
  };

  void loadTodos().then(() => {
    check();
    if (!State.paused && State.mode === "hidden" && hasPendingReminders()) island.reveal();
    State.notify();
  });
  window.setInterval(check, 1000);
}
