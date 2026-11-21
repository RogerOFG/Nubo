// Tasks and notes (src-tauri/src/todo.rs keeps them in todo.json). The rules
// here are pure — what is done today, what is due — so they can be tested; the
// page's copy and its saving are at the bottom.

import { Bridge } from "./bridge";

export interface Task {
  id: string;
  title: string;
  /** "HH:MM" (24 h), or "" for a task without a reminder. */
  time: string;
  /** Comes back every day: done today, open again tomorrow. */
  daily: boolean;
  /** The day ("YYYY-MM-DD") it was ticked off, or "". */
  doneDay: string;
  /** The day it was last reminded: a reminder is once a day. */
  notifiedDay: string;
}

export interface Note {
  id: string;
  title: string;
  text: string;
}

export interface TodoData {
  tasks: Task[];
  notes: Note[];
}

/** Local day as "YYYY-MM-DD". */
export function dayOf(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/** Minutes after midnight of an "HH:MM", or null when it is not one. */
export function minutesOf(time: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(time);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

/** Ticked off for `day`: a daily task only for that day, any other task for good. */
export function isDone(task: Task, day: string): boolean {
  return task.daily ? task.doneDay === day : task.doneDay !== "";
}

/**
 * What the list shows on `day`: the daily tasks and the others, except those
 * ticked off on an earlier day (they are done and gone from today's list).
 */
export function tasksFor(tasks: readonly Task[], day: string): Task[] {
  return tasks.filter((t) => t.daily || t.doneDay === "" || t.doneDay >= day);
}

/** [done, total] of today's list. */
export function counts(tasks: readonly Task[], day: string): [number, number] {
  const list = tasksFor(tasks, day);
  return [list.filter((t) => isDone(t, day)).length, list.length];
}

/** Open and past its time: shown in red. */
export function isOverdue(task: Task, now: Date): boolean {
  const at = minutesOf(task.time);
  return at != null && !isDone(task, dayOf(now)) && now.getHours() * 60 + now.getMinutes() > at;
}

/** Tasks whose time has come and that have not been reminded today. */
export function dueTasks(tasks: readonly Task[], now: Date): Task[] {
  const day = dayOf(now);
  const minute = now.getHours() * 60 + now.getMinutes();
  return tasksFor(tasks, day).filter((t) => {
    const at = minutesOf(t.time);
    return at != null && at <= minute && t.notifiedDay !== day && !isDone(t, day);
  });
}

export function newId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  return c?.randomUUID ? c.randomUUID() : `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// ── The page's copy ──────────────────────────────────────────────────────────

export const Todos: TodoData & { loaded: boolean } = { tasks: [], notes: [], loaded: false };

export async function loadTodos(): Promise<void> {
  const data = await Bridge.todoLoad();
  if (!data) return;
  Todos.tasks = data.tasks;
  Todos.notes = data.notes;
  Todos.loaded = true;
}

/** Saves both lists; false when it could not be written (the page's copy is left as it was). */
export async function saveTodos(next: TodoData): Promise<boolean> {
  const kept = await Bridge.todoSave(next);
  if (!kept) return false;
  Todos.tasks = kept.tasks;
  Todos.notes = kept.notes;
  Todos.loaded = true;
  return true;
}
