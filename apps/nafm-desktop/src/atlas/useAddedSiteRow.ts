import { useLayoutEffect, useRef } from "react";

export interface AddedSiteRow {
  id: string;
  opener: HTMLButtonElement;
}

export function useAddedSiteRow(addedSite?: AddedSiteRow, onFocus?: (id: string) => void) {
  const addedButton = useRef<HTMLButtonElement>(null);
  const handled = useRef<AddedSiteRow | null>(null);

  useLayoutEffect(() => {
    // The row may arrive on a later dashboard refresh than the add-site result.
    const button = addedButton.current;
    if (!addedSite || !button || (handled.current?.id === addedSite.id && handled.current.opener === addedSite.opener)) return;
    handled.current = addedSite;
    if (document.activeElement !== addedSite.opener) return;

    const row = button.closest("li") ?? button;
    row.scrollIntoView({ block: "nearest", inline: "nearest" });
    button.focus({ preventScroll: true });
    if (document.activeElement === button) onFocus?.(addedSite.id);
  });

  return addedButton;
}
