import { h, clear, svg } from "./dom";
import { Bridge } from "../core/bridge";
import { HOST_OS } from "../core/pills";
import { ICONS } from "./icons";
import { State } from "../core/state";
import type { ViewActions, ViewHost } from "./views";
import { N_, t, tl } from "../i18n/i18n";

/** Dashed rounded rect drawn as SVG so the dashes can march like on macOS. */
export function dashedFrame(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const el = document.createElementNS(ns, "svg");
  el.setAttribute("class", "drop-frame");
  el.setAttribute("preserveAspectRatio", "none");
  const rect = document.createElementNS(ns, "rect");
  rect.setAttribute("x", "0.75");
  rect.setAttribute("y", "0.75");
  rect.setAttribute("width", "calc(100% - 1.5px)");
  rect.setAttribute("height", "calc(100% - 1.5px)");
  rect.setAttribute("rx", "20");
  rect.setAttribute("fill", "none");
  rect.setAttribute("stroke-width", "1.5");
  rect.setAttribute("stroke-dasharray", "6 5");
  el.append(rect);
  return el;
}

export function buildUpload(actions: ViewActions): ViewHost {
  const frame = dashedFrame();
  const title = h("div", { class: "drop-title", text: tl("Drop your files here") });
  const tags = h(
    "div",
    { class: "drop-tags" },
    ...[N_("PDF"), N_("Images"), N_("Code"), N_("Docs")].map((chip) => h("span", { text: tl(chip) })),
  );
  const empty = h("div", { class: "drop-body" }, title, tags);
  const list = h("div", { class: "shelf-list" });
  const error = h("div", { class: "shelf-error", role: "status" });
  const clearAll = h("button", {
    class: "shelf-clear", text: tl("Clear all"),
    onclick: () => {
      State.shelfFiles = [];
      State.shelfError = "";
      State.notify();
    },
  });
  const shelf = h("div", { class: "shelf" },
    h("div", { class: "shelf-head" }, h("b", { text: tl("Drop your files here") }), clearAll),
    list, error);
  let lastKey = "";
  const card = h(
    "div",
    { class: "card drop-card" },
    frame,
    empty, shelf,
  );
  const el = h("div", { class: "view drop-view" }, card);

  return {
    el,
    sync() {
      card.classList.toggle("over", State.fileDragOver);
      const emptyShelf = State.shelfFiles.length === 0 && !State.shelfError;
      empty.hidden = !emptyShelf;
      frame.style.display = emptyShelf ? "" : "none";
      shelf.hidden = emptyShelf;
      clearAll.hidden = State.shelfFiles.length === 0 && !State.shelfError;
      error.textContent = State.shelfError;
      error.hidden = !State.shelfError;
      const key = JSON.stringify([State.shelfFiles, State.stateOverride === "thinking"]);
      if (lastKey === key) return;
      lastKey = key;
      const scroll = list.scrollTop;
      clear(list);
      for (const entry of State.shelfFiles) {
        const item = h("div", { class: entry.ready ? "shelf-file ready" : "shelf-file", title: entry.name },
          svg(ICONS.doc, 22), h("span", { text: entry.name }));
        if (entry.ready) {
          if (HOST_OS === "windows") {
            item.addEventListener("pointerdown", (start) => {
              if (start.button !== 0 || !start.isPrimary || State.shelfDragging) return;
              start.preventDefault();
              const gesture = new AbortController();
              const end = () => gesture.abort();
              const options = { signal: gesture.signal };
              window.addEventListener("pointerup", end, options);
              window.addEventListener("pointercancel", end, options);
              window.addEventListener("blur", end, options);
              document.documentElement.addEventListener("pointerleave", end, options);
              window.addEventListener("pointermove", (e) => {
                if (e.pointerId !== start.pointerId) return;
                if (!(e.buttons & 1) || !item.isConnected) {
                  end();
                  return;
                }
                if (Math.hypot(e.clientX - start.clientX, e.clientY - start.clientY) < 6) return;
                end();
                if (State.shelfDragging) return;
                State.shelfDragging = true;
                void Bridge.dragShelfFile(entry.path)
                  .then((moved) => {
                    if (!moved) return;
                    State.shelfFiles = State.shelfFiles.filter((file) => file !== entry);
                    if (State.promptFile?.path === entry.path) State.promptFile = null;
                  })
                  .catch((err) => { State.shelfError = String(err).replace(/^Error:\s*/, ""); })
                  .finally(() => {
                    State.shelfDragging = false;
                    State.notify();
                  });
              }, options);
            });
          } else {
            item.draggable = true;
            item.addEventListener("dragstart", (e) => {
              if (!e.dataTransfer) return;
              e.dataTransfer.effectAllowed = "copy";
              const uri = "file://" + entry.path.split("/").map(encodeURIComponent).join("/");
              e.dataTransfer.setData("text/uri-list", uri);
              State.shelfDragging = true;
            });
            item.addEventListener("dragend", () => { State.shelfDragging = false; });
          }
        }
        const ask = h("button", {
          class: "file-action", title: tl("Ask a question"), "aria-label": tl("Ask a question"),
          disabled: !entry.ready || State.stateOverride === "thinking",
          onclick: () => {
            if (State.stateOverride === "thinking") return;
            State.promptFile = { name: entry.name, path: entry.path };
            actions.setView("prompt");
          },
        }, svg(ICONS.bubbleRound, 14));
        const remove = h("button", {
          class: "file-action", title: tl("Remove file"), "aria-label": tl("Remove file"),
          onclick: () => {
            State.shelfFiles = State.shelfFiles.filter((file) => file !== entry);
            State.notify();
          },
        }, svg(ICONS.xmark, 13));
        list.append(h("div", { class: "shelf-tile" }, item, h("div", { class: "shelf-actions" }, ask, remove)));
      }
      list.scrollTop = scroll;
    },
  };
}

export function buildUploading(): ViewHost {
  const label = h("span", { class: "up-name" });
  const percent = h("span", { class: "up-pct" });
  const fill = h("div", { class: "up-fill" });
  const glow = h("div", { class: "up-glow" });
  const card = h(
    "div",
    { class: "card up-card" },
    h("div", { class: "up-row" }, label, percent),
    h("div", { class: "up-track" }, fill, glow),
  );
  const el = h("div", { class: "view" }, card);

  return {
    el,
    sync() {
      const done = State.uploadProgress >= 0.999;
      const pct = Math.round(State.uploadProgress * 100);
      label.textContent = done
        ? `✓  ${State.droppedFile?.name ?? t("File")}`
        : t("Uploading {name}", { name: State.droppedFile?.name ?? t("file") });
      label.classList.toggle("done", done);
      percent.textContent = done ? "" : `${pct} %`;
      const w = State.uploadProgress * 526;
      fill.style.width = `${w}px`;
      glow.style.transform = `translateX(${Math.max(0, w - 14)}px)`;
      glow.style.opacity = State.uploadProgress > 0.01 ? "1" : "0";
      card.classList.toggle("done", done);
    },
  };
}
