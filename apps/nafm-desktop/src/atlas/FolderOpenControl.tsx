import { useId, useLayoutEffect, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { FolderOpenDestination, StorageNode } from "../lib/types";
import { FolderIcon, OpenInIcon, TerminalIcon } from "../management/Icons";
import { useAnchoredPopover } from "./useAnchoredPopover";
import "./folder-open.css";

interface FolderOpenControlProps {
  node: StorageNode;
  onOpen: (node: StorageNode, destination: FolderOpenDestination) => Promise<void>;
  tabIndex?: number;
}

export function canOpenFolder(node: StorageNode): boolean {
  return Boolean(node.path) && (node.kind === "directory" || node.kind === "local_root" || node.kind === "smb_root");
}

export function restoreFolderOpenFocus(button: HTMLButtonElement) {
  if (!button.isConnected) return;
  const pane = button.closest<HTMLElement>(".atlas-inspector-pane");
  if (!pane) {
    button.focus({ preventScroll: true });
    return;
  }

  const toolbar = pane.closest(".atlas-shell")?.querySelector(".atlas-toolbar");
  const bounds = pane.getBoundingClientRect();
  const paneTop = Math.max(0, bounds.top, toolbar?.getBoundingClientRect().bottom ?? 0);
  const bottom = Math.min(window.innerHeight, bounds.bottom);
  const list = button.closest<HTMLElement>(".atlas-directory-list");
  const header = list && pane.querySelector(".atlas-directory-header");
  const top = Math.max(paneTop, header?.getBoundingClientRect().bottom ?? paneTop);
  const anchor = button.getBoundingClientRect();
  if (top < bottom && anchor.height > 0 && anchor.top < bottom && anchor.bottom > top) {
    button.focus({ preventScroll: true });
    return;
  }

  if (list && top < bottom) {
    // The previous row can still be mounted in the virtual buffer behind the sticky header.
    const visible = Array.from(list.querySelectorAll<HTMLElement>("[data-entry-id]")).find((entry) => {
      const row = entry.getBoundingClientRect();
      return row.height > 0 && row.top >= top - 1 && row.bottom <= bottom + 1;
    });
    (visible ?? list).focus({ preventScroll: true });
  } else {
    const target = paneTop < bottom ? pane : toolbar?.querySelector<HTMLElement>(".atlas-toolbar-navigation h1");
    target?.focus({ preventScroll: true });
  }
}

const dismissOnScroll = { focusAfterDismiss: restoreFolderOpenFocus };

export function FolderOpenControl(props: FolderOpenControlProps) {
  return canOpenFolder(props.node) ? <FolderOpenMenu key={props.node.id} {...props} /> : null;
}

function FolderOpenMenu({ node, onOpen, tabIndex }: FolderOpenControlProps) {
  const id = useId();
  const { open, trigger, panel, show, close, toggle, containerProps } = useAnchoredPopover('[role="menuitem"]', dismissOnScroll);
  const [opening, setOpening] = useState(false);
  const remote = /^smb:\/\//i.test(node.path ?? "");
  const label = `Open ${node.name} in…`;

  useLayoutEffect(() => {
    const button = trigger.current;
    const menu = panel.current;
    const surface = button?.closest<HTMLElement>(".atlas-toolbar-navigation, .atlas-readout");
    const contents = button?.closest(".atlas-directory")?.closest<HTMLElement>(".atlas-inspector-pane");
    if (!button) return;
    return () => {
      const active = document.activeElement;
      if (active !== button && !menu?.contains(active)) return;
      queueMicrotask(() => {
        if (button.isConnected || document.activeElement !== document.body) return;
        const replacement = surface?.isConnected ? surface.querySelector<HTMLElement>(".atlas-folder-open-trigger")
          ?? (surface.matches(".atlas-readout") ? surface : surface.querySelector<HTMLElement>("h1")) : contents;
        // Contents can then restore its history cursor from the pane.
        if (replacement?.getClientRects().length) replacement.focus({ preventScroll: true });
      });
    };
  }, [open, panel, trigger]);

  async function launch(destination: FolderOpenDestination) {
    if (opening || (destination === "terminal" && remote)) return;
    close(true);
    setOpening(true);
    try {
      await onOpen(node, destination);
    } finally {
      setOpening(false);
    }
  }

  function navigateMenu(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Tab") {
      // Continue normal tab navigation from the icon, including in the portal fallback.
      close(true);
      return;
    }
    if (event.shiftKey) return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    switch (event.key) {
      case "ArrowDown": next = (index + 1) % items.length; break;
      case "ArrowUp": next = (index - 1 + items.length) % items.length; break;
      case "Home": next = 0; break;
      case "End": next = items.length - 1; break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
    items[next].focus();
  }

  const menu = open && (
    <div id={id} ref={panel} role="menu" aria-label={label} className="atlas-folder-open-menu" popover="manual" onKeyDown={navigateMenu}>
      <button type="button" role="menuitem" tabIndex={-1} onClick={() => void launch("file_manager")}>
        <FolderIcon /> File manager
      </button>
      <button type="button" role="menuitem" tabIndex={-1} aria-label="Terminal"
        aria-disabled={remote || undefined} aria-describedby={remote ? id + "-terminal-hint" : undefined}
        onClick={() => void launch("terminal")}>
        <TerminalIcon />
        <span>Terminal{remote && <small id={id + "-terminal-hint"}>Requires a local folder</small>}</span>
      </button>
    </div>
  );

  return (
    <div className="atlas-folder-open" {...containerProps}>
      <button ref={trigger} type="button" className="atlas-folder-open-trigger" title={label}
        aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
        aria-disabled={opening || undefined} tabIndex={tabIndex}
        onClick={opening ? undefined : toggle}
        onKeyDown={(event) => {
          if (opening || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
            || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
          event.preventDefault();
          event.stopPropagation();
          show(event.key === "ArrowUp" ? '[role="menuitem"]:last-child' : undefined);
        }}>
        <OpenInIcon />
      </button>
      {menu && (typeof HTMLElement.prototype.showPopover === "function" ? menu : createPortal(menu, document.body))}
    </div>
  );
}
