const compactAtlas = "(max-width: 760px)";

export function revealInCompactAtlas(element: Element | null) {
  if (element && window.matchMedia(compactAtlas).matches) {
    element.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

export function restoreAtlasPanelFocus(launcher: HTMLButtonElement | null, origin?: SVGGElement | null) {
  const otherPanel = window.matchMedia(compactAtlas).matches
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
  const target = origin?.isConnected ? origin : launcher;
  revealInCompactAtlas(target);
  target?.focus({ preventScroll: true });
}
