import { useCallback, useId, useLayoutEffect, useRef, type RefObject } from "react";
import type { StorageNode } from "../lib/types";
import { CheckIcon, DriveIcon, FolderIcon, NetworkIcon } from "../management/Icons";
import { useAnchoredPopover } from "./useAnchoredPopover";
import "./folder-breadcrumbs.css";

interface FolderBreadcrumbsProps {
  breadcrumbs: readonly StorageNode[];
  siteName: string | null;
  canBack: boolean;
  canForward: boolean;
  canUp: boolean;
  onNavigate: (node: StorageNode) => void;
  heading: RefObject<HTMLHeadingElement | null>;
  onTriggerRemoved: (focused: HTMLElement) => void;
}

export function FolderBreadcrumbs({
  breadcrumbs, siteName, canBack, canForward, canUp, onNavigate, heading, onTriggerRemoved,
}: FolderBreadcrumbsProps) {
  const id = useId();
  const { open, trigger, panel, show, toggle, close, containerProps } = useAnchoredPopover("button", "follow", "start");
  const attachTrigger = useCallback((button: HTMLButtonElement | null) => {
    trigger.current = button;
    if (button) return () => {
      trigger.current = null;
      onTriggerRemoved(button);
    };
  }, [onTriggerRemoved, trigger]);
  const requestedFolder = useRef<string>(null);
  const current = breadcrumbs.at(-1);
  const previousFolder = useRef(current?.id);
  const site = breadcrumbs[0];
  const parent = breadcrumbs.at(-2);
  const hasAncestors = Boolean(parent);
  const omittedFolders = breadcrumbs.length > 3;

  useLayoutEffect(() => {
    if (previousFolder.current === current?.id) return;
    previousFolder.current = current?.id;
    const restoreFocus = requestedFolder.current === current?.id;
    requestedFolder.current = null;
    if (open) close(Boolean(panel.current?.contains(document.activeElement)));
    if (restoreFocus && document.activeElement === document.body) {
      (trigger.current ?? heading.current)?.focus({ preventScroll: true });
    }
  }, [close, current?.id, heading, open, panel, trigger]);

  function name(node: StorageNode) {
    return node.name || siteName || "Storage";
  }

  function navigate(node: StorageNode) {
    requestedFolder.current = node.id;
    if (open) close(true);
    onNavigate(node);
  }

  if (!current || !site) {
    return <h1 className="atlas-toolbar-site-fallback" ref={heading} tabIndex={-1}>{siteName ?? "Explore your storage"}</h1>;
  }

  const activeName = (
    <span id={`${id}-name`} className="atlas-toolbar-current" aria-current="location" title={name(current)}>
      {name(current)}
    </span>
  );
  const visibleAncestors = parent ? parent === site ? [site] : [site, parent] : [];

  return (
    <ol className="atlas-toolbar-breadcrumbs">
      {visibleAncestors.map((node, index) => (
        <li key={node.id} className="atlas-toolbar-ancestor">
          {index > 0 && (
            <span className="atlas-toolbar-separator" aria-hidden="true">{omittedFolders ? "/ … /" : "/"}</span>
          )}
          <button type="button" title={name(node)} onClick={() => navigate(node)}>{name(node)}</button>
        </li>
      ))}
      <li className="atlas-toolbar-location" {...containerProps}>
        {hasAncestors && <span className="atlas-toolbar-separator" aria-hidden="true">/</span>}
        <h1 ref={heading} tabIndex={-1} aria-labelledby={`${id}-name`}>
          {hasAncestors ? (
            <button
              className="atlas-path-trigger" ref={attachTrigger} type="button"
              aria-label="Show folder path" aria-describedby={`${id}-name`}
              aria-expanded={open} aria-controls={open ? id : undefined}
              onClick={toggle}
              onKeyDown={(event) => {
                if (!open && event.key === "ArrowDown") {
                  event.preventDefault();
                  show();
                }
              }}
            >
              {activeName}
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m3 4.5 3 3 3-3" />
              </svg>
            </button>
          ) : activeName}
        </h1>
        {open && hasAncestors && (
          <div className="atlas-folder-hierarchy" id={id} ref={panel} role="group" aria-label="Folder hierarchy" popover="manual"
            onKeyDown={(event) => {
              if (event.defaultPrevented) return;
              const { altKey, metaKey, key } = event;
              const back = canBack && ((altKey && key === "ArrowLeft") || (metaKey && key === "["));
              const forward = canForward && ((altKey && key === "ArrowRight") || (metaKey && key === "]"));
              const up = canUp && (altKey || metaKey) && key === "ArrowUp";
              if (back || forward || up) close(true);
            }}>
            <ol>
              {breadcrumbs.map((node) => {
                const isCurrent = node.id === current.id;
                const label = name(node);
                const Icon = node.kind === "site" ? DriveIcon : node.kind === "smb_root" ? NetworkIcon : FolderIcon;
                const row = <><Icon /><span>{label}</span></>;
                return (
                  <li key={node.id} aria-current={isCurrent ? "true" : undefined}>
                    {isCurrent
                      ? <div className="atlas-path-destination">{row}<CheckIcon /></div>
                      : <button
                          className="atlas-path-destination" type="button"
                          aria-description={node.kind === "site" ? "Source root" : undefined}
                          title={node.path ?? label}
                          onClick={() => navigate(node)}
                        >{row}</button>}
                  </li>
                );
              })}
            </ol>
          </div>
        )}
      </li>
    </ol>
  );
}
