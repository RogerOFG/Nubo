export type IslandEdge = "top" | "right" | "bottom" | "left";

export function lateralEdge(edge: IslandEdge): boolean {
  return edge === "left" || edge === "right";
}

/** A physical edge in local CSS pixels, independent of the text direction. */
export function dockRect(edge: IslandEdge, anchor: number | null, vw: number, vh: number, w: number, h: number) {
  const width = Math.max(0, Math.min(w, vw));
  const height = Math.max(0, Math.min(h, vh));
  const lateral = lateralEdge(edge);
  const extent = lateral ? vh : vw;
  const length = lateral ? height : width;
  const start = Math.min(Math.max((anchor ?? extent / 2) - length / 2, 0), Math.max(0, extent - length));
  return {
    x: lateral ? (edge === "right" ? vw - width : 0) : start,
    y: lateral ? start : (edge === "bottom" ? vh - height : 0),
    w: width,
    h: height,
  };
}
