// The Tasks tab: tasks on the left (tick them off, a time to be reminded at,
// every day or once) and notes on the right, both in view at once.
//
// "+" starts a new one and a click on a row opens its editor, which replaces
// the list in its card. The editor takes the keyboard (as the chat field does)
// and gives it back when it closes or the tab changes.

import { h, clear, svg } from "./dom";
import { ICONS } from "./icons";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import {
  Todos, counts, dayOf, isDone, isOverdue, loadTodos, newId, pendingReminder, postponeReminder, saveTodos, tasksFor, type Note, type Task,
} from "../core/todos";
import { t, tl } from "../i18n/i18n";
import type { ViewActions, ViewHost } from "./views";

const MAX_TITLE = 120;
const MAX_NOTE = 5000;

function reminderTime(task: Task): string {
  return task.snoozedUntil ? new Date(task.snoozedUntil).toTimeString().slice(0, 5) : task.time;
}

export function buildTasks(actions: ViewActions): ViewHost {
  // ── Tasks card ──────────────────────────────────────────────────────────────
  const counter = h("span", { class: "tk-count" });
  const addTask = h("button", { class: "tk-add", title: tl("New task") }, svg(ICONS.plus, 11, { stroke: 2.4 }));
  const taskList = h("div", { class: "tk-list" });

  const taskTitle = h("input", { class: "tk-input", type: "text", placeholder: tl("What needs doing?"), spellcheck: false }) as HTMLInputElement;
  taskTitle.maxLength = MAX_TITLE;
  const taskTime = h("input", { class: "tk-input tk-time", type: "time", title: tl("Reminder time") }) as HTMLInputElement;
  const taskDaily = h("button", { class: "tk-chip", text: tl("Every day") });
  const taskSave = h("button", { class: "tk-btn primary", text: tl("Save") });
  const taskCancel = h("button", { class: "tk-btn", text: tl("Cancel") });
  const taskDelete = h("button", { class: "tk-btn danger", text: tl("Delete") });
  const taskEditor = h(
    "div",
    { class: "tk-editor" },
    taskTitle,
    h("div", { class: "tk-editor-row" }, taskTime, taskDaily),
    h("div", { class: "tk-editor-row" }, taskSave, taskCancel, taskDelete),
  );
  const taskCard = h(
    "div",
    { class: "card tk-card" },
    h("div", { class: "tk-head" }, h("b", { text: tl("Tasks") }), counter, h("div", { class: "grow" }), addTask),
    taskList,
    taskEditor,
  );

  // ── Notes card ──────────────────────────────────────────────────────────────
  const addNote = h("button", { class: "tk-add", title: tl("New note") }, svg(ICONS.plus, 11, { stroke: 2.4 }));
  const noteList = h("div", { class: "tk-list" });
  const noteTitle = h("input", { class: "tk-input", type: "text", placeholder: tl("Title"), spellcheck: false }) as HTMLInputElement;
  noteTitle.maxLength = MAX_TITLE;
  const noteText = h("textarea", { class: "tk-input tk-text", placeholder: tl("Write your note…"), spellcheck: false }) as HTMLTextAreaElement;
  noteText.maxLength = MAX_NOTE;
  const noteSave = h("button", { class: "tk-btn primary", text: tl("Save") });
  const noteCancel = h("button", { class: "tk-btn", text: tl("Cancel") });
  const noteDelete = h("button", { class: "tk-btn danger", text: tl("Delete") });
  const noteEditor = h(
    "div",
    { class: "tk-editor" },
    noteTitle,
    noteText,
    h("div", { class: "tk-editor-row" }, noteSave, noteCancel, noteDelete),
  );
  const noteCard = h(
    "div",
    { class: "card tk-card" },
    h("div", { class: "tk-head" }, h("b", { text: tl("Notes") }), h("div", { class: "grow" }), addNote),
    noteList,
    noteEditor,
  );

  const el = h("div", { class: "view" }, h("div", { class: "tk-row" }, taskCard, noteCard));

  // ── State ───────────────────────────────────────────────────────────────────
  let editingTask: { id: string | null; daily: boolean; shownTime: string } | null = null;
  let editingNote: { id: string | null } | null = null;
  let loading = false;
  let timer: number | null = null;

  const editing = () => editingTask != null || editingNote != null;

  function keyboard() {
    const on = editing();
    actions.keyboard(on);
    actions.holdOpen(on);
  }

  async function persist(next: { tasks?: Task[]; notes?: Note[] }): Promise<boolean> {
    const ok = await saveTodos({ tasks: next.tasks ?? Todos.tasks, notes: next.notes ?? Todos.notes });
    if (!ok) Sound.play("error");
    else State.notify();
    render();
    return ok;
  }

  // Tasks
  function paintDaily() {
    taskDaily.classList.toggle("on", editingTask?.daily === true);
  }

  function openTask(task: Task | null) {
    closeNote(false);
    const shownTime = task ? reminderTime(task) : "";
    editingTask = { id: task?.id ?? null, daily: task?.daily ?? false, shownTime };
    taskTitle.value = task?.title ?? "";
    taskTime.value = shownTime;
    taskDelete.style.display = task ? "" : "none";
    paintDaily();
    render();
    keyboard();
    window.setTimeout(() => taskTitle.focus(), 80);
  }

  function closeTask(release = true) {
    if (!editingTask) return;
    editingTask = null;
    render();
    if (release) keyboard();
  }

  async function saveTask() {
    const title = taskTitle.value.trim();
    if (!editingTask || title === "") {
      taskTitle.focus();
      return;
    }
    const id = editingTask.id;
    const old = id ? Todos.tasks.find((x) => x.id === id) : undefined;
    const time = taskTime.value;
    const keepSchedule = old != null && editingTask.shownTime === time;
    const entry: Task = {
      id: id ?? newId(),
      title,
      time: keepSchedule ? old.time : time,
      daily: editingTask.daily,
      doneDay: old?.doneDay ?? "",
      // A changed time is a new reminder, even if today's had been given.
      notifiedDay: keepSchedule ? old.notifiedDay : "",
      snoozedUntil: keepSchedule ? old.snoozedUntil : undefined,
    };
    const tasks = id ? Todos.tasks.map((x) => (x.id === id ? entry : x)) : [...Todos.tasks, entry];
    if (await persist({ tasks })) closeTask();
  }

  async function toggleDone(task: Task) {
    const day = dayOf(new Date());
    const doneNow = isDone(task, day);
    const tasks = Todos.tasks.map((x) => (x.id === task.id ? { ...x, doneDay: doneNow ? "" : day } : x));
    Sound.play(doneNow ? "blip" : "approve");
    await persist({ tasks });
  }

  // Notes
  function openNote(note: Note | null) {
    closeTask(false);
    editingNote = { id: note?.id ?? null };
    noteTitle.value = note?.title ?? "";
    noteText.value = note?.text ?? "";
    noteDelete.style.display = note ? "" : "none";
    render();
    keyboard();
    window.setTimeout(() => (note ? noteText : noteTitle).focus(), 80);
  }

  function closeNote(release = true) {
    if (!editingNote) return;
    editingNote = null;
    render();
    if (release) keyboard();
  }

  async function saveNote() {
    if (!editingNote) return;
    if (noteTitle.value.trim() === "" && noteText.value.trim() === "") {
      noteText.focus();
      return;
    }
    const id = editingNote.id;
    const entry: Note = { id: id ?? newId(), title: noteTitle.value.trim(), text: noteText.value };
    const notes = id ? Todos.notes.map((x) => (x.id === id ? entry : x)) : [...Todos.notes, entry];
    if (await persist({ notes })) closeNote();
  }

  // ── Drawing ─────────────────────────────────────────────────────────────────
  let renderedTasks: readonly Task[];
  let renderedNotes: readonly Note[];

  function render() {
    renderedTasks = Todos.tasks;
    renderedNotes = Todos.notes;
    const now = new Date();
    const day = dayOf(now);
    const [done, total] = counts(Todos.tasks, day);
    counter.textContent = total > 0 ? `${done}/${total}` : "";
    counter.classList.toggle("all", total > 0 && done === total);

    taskCard.classList.toggle("editing", editingTask != null);
    noteCard.classList.toggle("editing", editingNote != null);

    clear(taskList);
    const list = tasksFor(Todos.tasks, day);
    // Open ones first, in the order they were added; those done sink to the end.
    for (const task of [...list.filter((x) => !isDone(x, day)), ...list.filter((x) => isDone(x, day))]) {
      const isOn = isDone(task, day);
      const check = h("button", { class: isOn ? "tk-check on" : "tk-check", title: t("Done") }, isOn ? svg(ICONS.check, 11, { stroke: 2.8 }) : null);
      check.addEventListener("click", (e) => {
        e.stopPropagation();
        void toggleDone(task);
      });
      const pending = pendingReminder(task, day);
      const late = isOverdue(task, now) && !task.snoozedUntil;
      const postpone = pending ? h("button", {
        class: "tk-snooze", text: "+5 min",
        title: t("in {m} min", { m: 5 }),
        onclick: (event: Event) => {
          event.stopPropagation();
          void persist({ tasks: Todos.tasks.map((entry) => entry.id === task.id ? postponeReminder(entry) : entry) });
        },
      }) : null;
      const row = h(
        "div",
        { class: `tk-item${isOn ? " done" : ""}${pending ? " ring" : ""}` },
        check,
        h("span", { class: "tk-title", text: task.title }),
        task.time ? h("span", {
          class: late ? "tk-when late" : "tk-when",
          text: reminderTime(task),
        }) : null,
        task.daily ? h("span", { class: "tk-rep" }, svg(ICONS.arrowClockwise, 11, { stroke: 2 })) : null,
        postpone,
      );
      row.addEventListener("click", () => openTask(task));
      taskList.append(row);
    }
    if (list.length === 0) taskList.append(h("div", { class: "tk-empty", text: t("No tasks yet. Press + to add one.") }));

    clear(noteList);
    for (const note of Todos.notes) {
      const first = note.text.replace(/\s+/g, " ").trim().slice(0, 80);
      const row = h(
        "div",
        { class: "tk-note" },
        h("span", { class: "tk-title", text: note.title || first }),
        note.title && first ? h("span", { class: "tk-preview", text: first }) : null,
      );
      row.addEventListener("click", () => openNote(note));
      noteList.append(row);
    }
    if (Todos.notes.length === 0) noteList.append(h("div", { class: "tk-empty", text: t("No notes yet. Press + to add one.") }));
  }

  async function reload() {
    if (loading) return;
    loading = true;
    await loadTodos();
    loading = false;
    render();
  }

  // ── Wiring ──────────────────────────────────────────────────────────────────
  addTask.addEventListener("click", () => {
    actions.blip();
    openTask(null);
  });
  addNote.addEventListener("click", () => {
    actions.blip();
    openNote(null);
  });
  taskDaily.addEventListener("click", () => {
    if (!editingTask) return;
    editingTask.daily = !editingTask.daily;
    paintDaily();
  });
  taskSave.addEventListener("click", () => void saveTask());
  taskCancel.addEventListener("click", () => closeTask());
  taskDelete.addEventListener("click", () => {
    const id = editingTask?.id;
    if (!id) return;
    void persist({ tasks: Todos.tasks.filter((x) => x.id !== id) }).then((ok) => ok && closeTask());
  });
  noteSave.addEventListener("click", () => void saveNote());
  noteCancel.addEventListener("click", () => closeNote());
  noteDelete.addEventListener("click", () => {
    const id = editingNote?.id;
    if (!id) return;
    void persist({ notes: Todos.notes.filter((x) => x.id !== id) }).then((ok) => ok && closeNote());
  });
  const keys = (e: Event) => {
    const key = (e as KeyboardEvent).key;
    if (key === "Escape") {
      e.preventDefault();
      closeTask();
      closeNote();
    } else if (key === "Enter" && (e.target === taskTitle || e.target === taskTime)) {
      e.preventDefault();
      void saveTask();
    } else if (key === "Enter" && e.target === noteTitle) {
      e.preventDefault();
      noteText.focus();
    } else if (key === "Enter" && (e as KeyboardEvent).ctrlKey && e.target === noteText) {
      e.preventDefault();
      void saveNote();
    }
    e.stopPropagation(); // Escape closes the editor, not the island
  };
  for (const input of [taskTitle, taskTime, noteTitle, noteText]) input.addEventListener("keydown", keys);

  render();
  return {
    el,
    sync() {
      const shown = State.view === "tasks";
      // Leaving the tab with an editor open gives the keyboard back.
      if (!shown && editing()) {
        closeTask(false);
        closeNote(false);
        keyboard();
      }
      if (shown && !Todos.loaded) void reload();
      if (shown && (renderedTasks !== Todos.tasks || renderedNotes !== Todos.notes)) render();
      // Times turn red as they pass: redrawn each half minute while the tab is on screen.
      if (shown && timer == null) timer = window.setInterval(() => !editing() && State.view === "tasks" && render(), 30_000);
      else if (!shown && timer != null) {
        window.clearInterval(timer);
        timer = null;
      }
    },
    focus() {
      void reload();
    },
  };
}
