import { useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";

function revealPopoverItem(popup: HTMLElement, item: HTMLElement) {
  const top = popup.getBoundingClientRect().top + popup.clientTop;
  const bottom = top + popup.clientHeight;
  const bounds = item.getBoundingClientRect();
  if (bounds.top < top) popup.scrollTop += bounds.top - top;
  else if (bounds.bottom > bottom) popup.scrollTop += bounds.bottom - bottom;
}

export function focusPopoverItem(popup: HTMLElement, item: HTMLElement) {
  item.focus({ preventScroll: true });
  revealPopoverItem(popup, item);
}

export function useAnchoredPopover(
  initialFocus: string,
  scrollBehavior: "follow" | "dismiss" = "follow",
  align: "start" | "end" = "end",
) {
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [focusSelector, setFocusSelector] = useState<string | null>(null);
  const open = focusSelector !== null;

  function show(selector = initialFocus) {
    setFocusSelector(selector);
  }

  function toggle() {
    setFocusSelector((current) => current === null ? initialFocus : null);
  }

  function close(restoreFocus = false) {
    setFocusSelector(null);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }

  useLayoutEffect(() => {
    const button = trigger.current;
    const popup = panel.current;
    if (!focusSelector || !button || !popup) return;
    popup.showPopover?.();

    let anchor: DOMRect;
    const position = () => {
      anchor = button.getBoundingClientRect();
      const { width } = popup.getBoundingClientRect();
      const gap = 6;
      const edge = 8;
      const below = window.innerHeight - anchor.bottom - gap - edge;
      const above = anchor.top - gap - edge;
      const openAbove = popup.scrollHeight + 2 > below && above > below;
      popup.style.maxHeight = Math.max(0, openAbove ? above : below) + "px";
      popup.style.top = (openAbove ? anchor.top - gap - popup.offsetHeight : anchor.bottom + gap) + "px";
      const left = align === "start" ? anchor.left : anchor.right - width;
      popup.style.left = Math.max(edge, Math.min(left, window.innerWidth - edge - width)) + "px";
    };
    const handleResize = () => {
      position();
      const active = document.activeElement;
      if (active instanceof HTMLElement && popup.contains(active)) revealPopoverItem(popup, active);
    };
    const handleScroll = (event: Event) => {
      if (scrollBehavior === "dismiss" && event.target instanceof Node && event.target.contains(button)) {
        const current = button.getBoundingClientRect();
        // A sticky header can stay in place while its list or the page scrolls.
        if (current.top === anchor.top && current.bottom === anchor.bottom
          && current.left === anchor.left && current.right === anchor.right) return;
        setFocusSelector(null);
        if (popup.contains(document.activeElement)) button.focus({ preventScroll: true });
      } else {
        position();
      }
    };
    const dismissOutside = (event: Event) => {
      if (event.target instanceof Node && !popup.contains(event.target) && !button.contains(event.target)) {
        setFocusSelector(null);
      }
    };
    position();
    const initialItem = popup.querySelector<HTMLElement>(focusSelector);
    if (initialItem) focusPopoverItem(popup, initialItem);
    window.addEventListener("resize", handleResize);
    document.addEventListener("scroll", handleScroll, true);
    document.addEventListener("pointerdown", dismissOutside, true);
    document.addEventListener("focusin", dismissOutside);
    return () => {
      window.removeEventListener("resize", handleResize);
      document.removeEventListener("scroll", handleScroll, true);
      document.removeEventListener("pointerdown", dismissOutside, true);
      document.removeEventListener("focusin", dismissOutside);
    };
  }, [focusSelector, scrollBehavior, align]);

  const containerProps = {
    onMouseDown(event: MouseEvent) {
      // Keep WebKit from focusing the scroll pane before the control receives its click.
      if (event.button === 0 && event.target instanceof Element) {
        event.preventDefault();
        event.target.closest<HTMLElement>("button, input")?.focus({ preventScroll: true });
      }
    },
    onKeyDown(event: KeyboardEvent) {
      if (!open || event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    },
  };

  return { open, trigger, panel, show, close, toggle, containerProps };
}
