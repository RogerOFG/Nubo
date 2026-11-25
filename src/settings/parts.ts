// Small pieces every settings section draws with.

import { h } from "../views/dom";

export function statusDot(ok: boolean): HTMLElement {
  return h("i", { class: "dot", style: `background:${ok ? "#22c55e" : "#f4505e"}` });
}

export function renderDiff(text: string): HTMLElement {
  const box = h("div", { class: "diff" });
  for (const line of text.split("\n")) {
    const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
    box.append(h("div", { class: cls, text: line }));
  }
  return box;
}


let fieldSequence = 0;

/** Keeps each setting's explanation and accessible control name together. */
export function settingsField(title: string, control: HTMLElement, detail?: string, unit?: HTMLElement): HTMLElement {
  const id = `general-field-${++fieldSequence}`;
  const name = h("span", { class: "general-field-name", id, text: title });
  const description = detail ? h("p", { class: "hint", id: `${id}-detail`, text: detail }) : null;
  control.setAttribute("aria-labelledby", id);
  if (description) control.setAttribute("aria-describedby", description.id);
  return h("div", { class: "general-field" },
    h("div", { class: "general-field-copy" }, name, description),
    h("div", { class: "general-control" }, control, unit),
  );
}

export function settingsCard(title: string, ...children: HTMLElement[]): HTMLElement {
  return h("section", { class: "general-card" }, h("h2", { text: title }), ...children);
}
