const compactAtlas = "(width < 880px)";

export function isCompactAtlas() {
  return window.matchMedia(compactAtlas).matches;
}

export function watchAtlasPanelReflow(atlas: HTMLElement | null) {
  let frame = 0;
  function revealFocusedPanel() {
    const active = document.activeElement;
    if (!active || active.closest("dialog")) return;
    const panel = active.closest("[data-atlas-panel]");
    if (!panel || !atlas?.contains(panel)) return;
    const pane = active.closest(".atlas-site-rail-list, .atlas-inspector-pane");
    if (pane && !active.closest("[data-virtual-row]")) {
      const bounds = pane.getBoundingClientRect();
      const control = active.getBoundingClientRect();
      if (control.top < bounds.top || control.bottom > bounds.bottom) {
        active.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    }
    if (isCompactAtlas()) {
      const top = atlas.closest(".atlas-shell")?.querySelector(".atlas-toolbar")?.getBoundingClientRect().bottom ?? 0;
      const control = active.getBoundingClientRect();
      if (control.top < top || control.bottom > window.innerHeight) revealInCompactAtlas(panel);
    }
  }
  function afterReflow() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(revealFocusedPanel);
  }
  window.addEventListener("resize", afterReflow);
  return () => {
    window.removeEventListener("resize", afterReflow);
    cancelAnimationFrame(frame);
  };
}

export function revealInCompactAtlas(element: Element | null) {
  if (element && isCompactAtlas()) {
    element.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

export function restoreAtlasPanelFocus(launcher: HTMLButtonElement | null, origin?: SVGGElement | null) {
  const originId = origin?.dataset.nodeId;
  const arc = origin?.isConnected ? origin : originId
    ? launcher?.closest(".atlas-visualization")?.querySelector<SVGGElement>(`.radial-atlas__sector[data-node-id="${CSS.escape(originId)}"]`)
    : null;
  if (arc) {
    revealInCompactAtlas(arc);
    arc.focus({ preventScroll: true });
    return;
  }

  const otherPanel = isCompactAtlas()
    ? launcher?.closest(".atlas-panels")?.querySelector<HTMLElement>("[data-atlas-panel]")
    : null;
  const otherControl = otherPanel?.querySelector<HTMLElement>(
    ".atlas-inspector-file-nav button, [role=tab][aria-selected=true], .atlas-site-rail-select[aria-current=true]",
  ) ?? otherPanel?.querySelector<HTMLButtonElement>(".atlas-site-rail-close");
  if (otherControl) {
    revealInCompactAtlas(otherPanel ?? null);
    otherControl.focus();
    return;
  }
  revealInCompactAtlas(launcher);
  launcher?.focus({ preventScroll: true });
}
