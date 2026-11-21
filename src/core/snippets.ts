// Quick texts (src-tauri/src/snippets.rs keeps them in snippets.json): short
// texts under a name, pasted where you are typing with one click on the island.

import { Bridge } from "./bridge";

export interface Snippet {
  id: string;
  label: string;
  text: string;
}

/** The page's copy of the list. */
export const Snippets = {
  items: [] as Snippet[],
  loaded: false,
};

export async function loadSnippets(): Promise<Snippet[]> {
  const items = await Bridge.snippetsLoad();
  Snippets.items = items ?? Snippets.items;
  Snippets.loaded = items != null;
  return Snippets.items;
}

/** Saves the whole list; false when it could not be written (the page's copy is left as it was). */
export async function saveSnippets(items: Snippet[]): Promise<boolean> {
  const kept = await Bridge.snippetsSave(items);
  if (!kept) return false;
  Snippets.items = kept;
  return true;
}

export function newSnippetId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  return c?.randomUUID ? c.randomUUID() : `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** The chip's name: what was typed, else the first line of the text. */
export function snippetLabel(s: Pick<Snippet, "label" | "text">): string {
  const named = s.label.trim();
  if (named) return named;
  const line = s.text.trim().split(/\r?\n/)[0] ?? "";
  return line.length > 40 ? line.slice(0, 40) : line;
}
