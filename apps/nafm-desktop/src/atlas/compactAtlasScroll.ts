const compactAtlas = "(width < 880px)";

export function revealInCompactAtlas(element: Element | null) {
  if (element && window.matchMedia(compactAtlas).matches) {
    element.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

export function restoreAtlasPanelFocus(launcher: HTMLButtonElement | null, origin?: SVGGElement | null) {
  if (origin?.isConnected) {
    revealInCompactAtlas(origin);
    origin.focus({ preventScroll: true });
    return;
  }

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
  revealInCompactAtlas(launcher);
  launcher?.focus({ preventScroll: true });
}
