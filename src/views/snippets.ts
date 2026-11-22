// Quick texts: cards on the island, each one a text that a click copies to the
// clipboard, ready to paste. The same dashed card as the file drop, beside Nubo.
//
// "Edit" turns the cards into buttons that open their editor; "+" starts a new
// one. The editor takes the keyboard (like the chat field) and gives it back
// when it closes or the view changes.

import { h, clear, svg } from "./dom";
import { ICONS } from "./icons";
import { dashedFrame } from "./upload";
import { Bridge } from "../core/bridge";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { Snippets, loadSnippets, newSnippetId, saveSnippets, snippetLabel, type Snippet } from "../core/snippets";
import { t, tl } from "../i18n/i18n";
import type { ViewActions, ViewHost } from "./views";

const MAX_LABEL = 40;
const MAX_TEXT = 20_000;

export function buildSnippets(actions: ViewActions): ViewHost {
  const frame = dashedFrame();
  const title = h("div", { class: "drop-title", text: tl("Quick texts") });
  const editBtn = h("button", { class: "snip-tool" });
  const addBtn = h("button", { class: "snip-tool", title: tl("New text") }, svg(ICONS.plus, 11, { stroke: 2.2 }));
  const head = h("div", { class: "snip-head" }, title, h("div", { class: "grow" }), editBtn, addBtn);
  const chips = h("div", { class: "snip-chips" });
  const hint = h("div", { class: "snip-hint" });

  // The editor, built once and shown in place of the chips.
  const label = h("input", { class: "snip-input", type: "text", placeholder: tl("Name"), spellcheck: false }) as HTMLInputElement;
  label.maxLength = MAX_LABEL;
  const saveBtn = h("button", { class: "snip-btn primary", text: tl("Save") });
  const cancelBtn = h("button", { class: "snip-btn", text: tl("Cancel") });
  const deleteBtn = h("button", { class: "snip-btn danger", text: tl("Delete") });
  const text = h("textarea", { class: "snip-text", placeholder: tl("Text to copy"), spellcheck: false }) as HTMLTextAreaElement;
  text.maxLength = MAX_TEXT;
  const editor = h(
    "div",
    { class: "snip-editor" },
    h("div", { class: "snip-editor-row" }, label, saveBtn, cancelBtn, deleteBtn),
    text,
  );

  const body = h("div", { class: "drop-body snip-body" }, head, chips, editor, hint);
  const card = h("div", { class: "card drop-card" }, frame, body);
  const el = h("div", { class: "view" }, card);

  let editMode = false;
  /** The editor is open: for this chip, or for a new one when `editingId` is null. */
  let editing = false;
  let editingId: string | null = null;
  let loading = false;
  let message = "";
  let messageTimer: number | null = null;
  const flashing = new Map<string, number>();

  function say(msg: string, ms = 2500) {
    message = msg;
    if (messageTimer != null) window.clearTimeout(messageTimer);
    messageTimer = window.setTimeout(() => {
      message = "";
      messageTimer = null;
      render();
    }, ms);
    render();
  }

  async function copy(s: Snippet, card: HTMLElement) {
    const ok = (await Bridge.snippetCopy(s.text)) === true;
    const prior = flashing.get(s.id);
    if (prior != null) window.clearTimeout(prior);
    card.classList.toggle("ok", ok);
    card.classList.toggle("bad", !ok);
    card.querySelector(".snip-mark")?.replaceChildren(ok ? svg(ICONS.check, 12, { stroke: 2.4 }) : svg(ICONS.xmark, 11));
    const note = card.querySelector(".snip-preview");
    if (note) note.textContent = ok ? t("Copied") : t("Couldn't copy");
    Sound.play(ok ? "blip" : "error");
    flashing.set(
      s.id,
      window.setTimeout(() => {
        flashing.delete(s.id);
        render();
      }, 1300),
    );
  }

  function openEditor(s: Snippet | null) {
    editing = true;
    editingId = s?.id ?? null;
    label.value = s?.label ?? "";
    text.value = s?.text ?? "";
    deleteBtn.style.display = s ? "" : "none";
    message = "";
    render();
    actions.keyboard(true);
    actions.holdOpen(true);
    window.setTimeout(() => (s ? text : label).focus(), 80);
  }

  function closeEditor() {
    if (!editing) return;
    editing = false;
    editingId = null;
    actions.keyboard(false);
    actions.holdOpen(false);
    render();
  }

  async function save() {
    const body = text.value;
    if (body.trim() === "") {
      text.focus();
      return;
    }
    const entry: Snippet = { id: editingId ?? newSnippetId(), label: label.value.trim(), text: body };
    const items = editingId
      ? Snippets.items.map((x) => (x.id === editingId ? entry : x))
      : [...Snippets.items, entry];
    if (await saveSnippets(items)) {
      closeEditor();
      Sound.play("blip");
    } else {
      say(t("Couldn't save"));
    }
  }

  async function remove() {
    if (!editingId) return;
    const id = editingId;
    if (await saveSnippets(Snippets.items.filter((x) => x.id !== id))) closeEditor();
    else say(t("Couldn't save"));
  }

  /** The text on one line, for the card's second line. */
  function preview(body: string): string {
    return body.replace(/\s+/g, " ").trim().slice(0, 90);
  }

  function render() {
    body.classList.toggle("editing", editing);
    editBtn.style.display = editing || Snippets.items.length === 0 ? "none" : "";
    addBtn.style.display = editing ? "none" : "";
    editBtn.textContent = editMode ? t("Done") : t("Edit");
    editBtn.classList.toggle("on", editMode);
    clear(chips);
    for (const s of Snippets.items) {
      const card = h(
        "button",
        { class: editMode ? "snip-card edit" : "snip-card", title: s.text.slice(0, 300) },
        h("span", { class: "snip-mark" }, svg(editMode ? ICONS.pencil : ICONS.copy, 12, { stroke: 1.8 })),
        h("span", { class: "snip-name", text: snippetLabel(s) }),
        h("span", { class: "snip-preview", text: preview(s.text) }),
      );
      card.addEventListener("click", () => {
        if (editMode) openEditor(s);
        else void copy(s, card);
      });
      chips.append(card);
    }
    if (message) hint.textContent = message;
    else if (editMode) hint.textContent = t("Click a text to change it.");
    else if (Snippets.items.length === 0) hint.textContent = t("No quick texts yet. Press + to add one.");
    else hint.textContent = t("Click a text to copy it, then paste it with Ctrl+V.");
    hint.classList.toggle("is-failed", message !== "");
  }

  async function reload() {
    if (loading) return;
    loading = true;
    await loadSnippets();
    loading = false;
    render();
  }

  addBtn.addEventListener("click", () => {
    actions.blip();
    openEditor(null);
  });
  editBtn.addEventListener("click", () => {
    actions.blip();
    editMode = !editMode;
    render();
  });
  saveBtn.addEventListener("click", () => void save());
  cancelBtn.addEventListener("click", () => closeEditor());
  deleteBtn.addEventListener("click", () => void remove());
  const keys = (e: Event) => {
    const key = (e as KeyboardEvent).key;
    if (key === "Escape") {
      e.preventDefault();
      closeEditor();
    }
    if (key === "Enter" && (e.target === label || (e as KeyboardEvent).ctrlKey)) {
      e.preventDefault();
      void save();
    }
    e.stopPropagation(); // Escape closes the editor, not the island
  };
  label.addEventListener("keydown", keys);
  text.addEventListener("keydown", keys);

  render();
  return {
    el,
    sync() {
      // Leaving the view with the editor open gives the keyboard back.
      if (State.view !== "snippets" && editing) closeEditor();
      if (State.view === "snippets" && !Snippets.loaded) void reload();
    },
    focus() {
      editMode = false;
      void reload();
    },
  };
}
