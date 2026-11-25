import { useLayoutEffect, useRef, useState, type RefObject } from "react";

// Native scroll containers have a pixel-height limit. Scale the track for exceptionally large folders.
const MAX_TRACK_HEIGHT = 8_000_000;
const OVERSCAN = 4;

interface ViewportOptions {
  contentsKey: string;
  anchorIndex: number;
  reveal?: { index: number; position?: number | "end"; onApplied: () => void };
  total: number;
  active: boolean;
  rowHeightProperty?: string;
  scrollPane: RefObject<HTMLDivElement | null>;
  scrollPositions: Map<string, number | "end">;
}

function focusableRows(list: HTMLElement, pane: HTMLElement, header: HTMLElement | null | undefined, shift: number, rowHeight: number, total: number) {
  const paneTop = pane.getBoundingClientRect().top + pane.clientTop;
  const top = Math.max(paneTop, header?.getBoundingClientRect().bottom ?? paneTop);
  const origin = list.getBoundingClientRect().top - shift;
  const start = Math.max(0, (top - origin) / rowHeight);
  const end = Math.min(total, (paneTop + pane.clientHeight - origin) / rowHeight);
  if (end <= start) return { focusStart: 0, focusEnd: 0 };

  // Allow for subpixel alignment at either edge of a fully visible row.
  const focusStart = Math.max(0, Math.ceil(start - 1 / rowHeight));
  const focusEnd = Math.min(total, Math.floor(end + 1 / rowHeight));
  if (focusStart < focusEnd) return { focusStart, focusEnd };

  const middle = Math.floor((start + end) / 2);
  return { focusStart: middle, focusEnd: middle + 1 };
}

export function useDirectoryViewport({
  contentsKey, anchorIndex, reveal, total, active, rowHeightProperty = "--directory-row-height", scrollPane, scrollPositions,
}: ViewportOptions) {
  const listRef = useRef<HTMLUListElement>(null);
  const [geometry, setGeometry] = useState({ key: "", first: 0, capacity: 8, rowHeight: 38, shift: 0, focusStart: 0, focusEnd: 0 });
  const scale = useRef(1);

  useLayoutEffect(() => {
    const list = listRef.current;
    const pane = scrollPane.current ?? list?.closest<HTMLDivElement>(".atlas-inspector-pane");
    if (!active || !pane || !list || !total) return;
    const header = list.closest("section")?.querySelector("header");
    let rowHeight = 0;
    let capacity = 0;
    let physicalRange = 0;
    let measuredHeight = 0;
    let pendingReveal = reveal;

    const readPosition = () => {
      // A resize can dispatch scroll before ResizeObserver updates the range and row capacity.
      if (!rowHeight || !measuredHeight || pane.clientHeight !== measuredHeight) return;
      const top = Math.max(0, pane.scrollTop);
      const logicalTop = top * scale.current;
      const first = Math.min(total - 1, Math.floor(logicalTop / rowHeight));
      const shift = logicalTop - top;
      const maxTop = pane.scrollHeight - pane.clientHeight;
      const atEnd = maxTop > 0 && top >= maxTop - 1;
      scrollPositions.set(contentsKey, atEnd ? "end" : logicalTop / rowHeight);
      const { focusStart, focusEnd } = focusableRows(list, pane, header, shift, rowHeight, total);
      const focusedRow = document.activeElement?.closest<HTMLElement>("[data-virtual-row]");
      if (focusedRow && list.contains(focusedRow)) {
        const index = Number(focusedRow.dataset.virtualRow);
        if (index < first - OVERSCAN || index > first + capacity + OVERSCAN) list.focus({ preventScroll: true });
      }
      setGeometry((old) => old.key === contentsKey && old.first === first && old.capacity === capacity
        && old.rowHeight === rowHeight && old.shift === shift && old.focusStart === focusStart && old.focusEnd === focusEnd
        ? old : { key: contentsKey, first, capacity, rowHeight, shift, focusStart, focusEnd });
    };

    const measure = () => {
      if (!pane.clientHeight) return;
      const oldHeight = rowHeight;
      const oldScale = scale.current;
      rowHeight = Number.parseFloat(getComputedStyle(list).getPropertyValue(rowHeightProperty));
      // Wait for the new track before consuming a reveal that may be clamped by the previous list's height.
      if (pendingReveal && Math.abs(list.offsetHeight - Math.min(MAX_TRACK_HEIGHT, total * rowHeight)) > 1) return;
      const headerHeight = header?.getBoundingClientRect().height ?? 0;
      if (header) pane.style.setProperty("--atlas-scroll-header-height", `${headerHeight}px`);
      const visibleRows = (pane.clientHeight - headerHeight) / rowHeight;
      const resized = measuredHeight > 0 && (measuredHeight !== pane.clientHeight || oldHeight !== rowHeight);
      measuredHeight = pane.clientHeight;
      capacity = Math.max(1, Math.ceil(visibleRows));
      const oldRange = physicalRange;
      physicalRange = Math.max(0, pane.scrollHeight - pane.clientHeight);
      const excess = Math.max(0, total * rowHeight - MAX_TRACK_HEIGHT);
      scale.current = physicalRange ? 1 + excess / physicalRange : 1;
      let position = pendingReveal?.position ?? scrollPositions.get(contentsKey) ?? anchorIndex;
      if (pendingReveal) {
        const savedTop = position === "end" ? physicalRange * scale.current / rowHeight : position;
        if (pendingReveal.index < savedTop || pendingReveal.index + 1 > savedTop + visibleRows) {
          position = pendingReveal.index;
        }
      }
      if (pendingReveal || oldHeight !== rowHeight || oldScale !== scale.current || (position === "end" && physicalRange !== oldRange)) {
        pane.scrollTop = position === "end" ? physicalRange : position * rowHeight / scale.current;
      }
      if (resized && !pendingReveal) {
        const focusedRow = document.activeElement?.closest<HTMLElement>("[data-virtual-row]");
        if (focusedRow && list.contains(focusedRow)) {
          const index = Number(focusedRow.dataset.virtualRow);
          const rowTop = list.getBoundingClientRect().top + index * rowHeight - pane.scrollTop * (scale.current - 1);
          const paneTop = pane.getBoundingClientRect().top + pane.clientTop;
          const top = paneTop + headerHeight;
          const bottom = paneTop + pane.clientHeight;
          if (rowTop < top) pane.scrollTop += (rowTop - top) / scale.current;
          else if (rowTop + rowHeight > bottom) pane.scrollTop += (rowTop + rowHeight - bottom) / scale.current;
        }
      }
      readPosition();
      pendingReveal?.onApplied();
      pendingReveal = undefined;
    };

    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(pane);
    if (pendingReveal) resize.observe(list);
    if (header) resize.observe(header);
    pane.addEventListener("scroll", readPosition, { passive: true });
    return () => {
      resize.disconnect();
      pane.removeEventListener("scroll", readPosition);
      if (header) pane.style.removeProperty("--atlas-scroll-header-height");
    };
  }, [active, contentsKey, anchorIndex, reveal, rowHeightProperty, scrollPane, scrollPositions, total]);

  const position = scrollPositions.get(contentsKey) ?? anchorIndex;
  const savedRow = position === "end" ? Math.max(0, total - geometry.capacity) : Math.floor(position);
  const ready = geometry.key === contentsKey;
  const first = ready ? geometry.first : savedRow;
  const start = Math.max(0, Math.min(first, total - 1) - OVERSCAN);
  const end = Math.min(total, first + geometry.capacity + OVERSCAN + 1);
  function scrollToRow(index: number) {
    const pane = scrollPane.current;
    if (pane) pane.scrollTop = index * geometry.rowHeight / scale.current;
  }
  return {
    listRef, start, end, first, capacity: geometry.capacity, focusStart: geometry.focusStart, focusEnd: geometry.focusEnd, ready,
    trackHeight: `min(${MAX_TRACK_HEIGHT}px, calc(${total} * var(${rowHeightProperty})))`,
    rowTop: (index: number) => ready ? index * geometry.rowHeight - geometry.shift : `calc(${index} * var(${rowHeightProperty}))`,
    scrollToRow,
  };
}
