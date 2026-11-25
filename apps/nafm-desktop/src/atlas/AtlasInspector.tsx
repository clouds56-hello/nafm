import { useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import type { AtlasInspection } from "../hooks/useDashboard";
import { CloseIcon } from "../management/Icons";
import { restoreAtlasPanelFocus, revealInCompactAtlas } from "./compactAtlasScroll";
import "./inspector.css";
import "./atlas-inspector-drawer.css";

export type InspectorView = "contents" | "details";

interface AtlasInspectorProps {
  view: InspectorView | null;
  initialView: InspectorView;
  siteId: string;
  inspection: AtlasInspection | null;
  openedFile: RefObject<AtlasInspection | null>;
  contentsPane: RefObject<HTMLDivElement | null>;
  fileOpen: boolean;
  folderName?: string;
  detailsKey: string | null;
  origin: RefObject<SVGGElement | null>;
  onViewChange: (view: InspectorView) => void;
  onBackToContents: () => void;
  onClose: () => void;
  contents: ReactNode;
  details: ReactNode;
}

const tabs = [
  { view: "contents", label: "Contents" },
  { view: "details", label: "Details" },
] as const;

function focusContentsRow(pane: HTMLDivElement) {
  const bounds = pane.getBoundingClientRect();
  const top = pane.querySelector(".atlas-directory-header")?.getBoundingClientRect().bottom ?? bounds.top;
  let row: HTMLButtonElement | null = null;
  if (pane.scrollTop > 0) {
    const hit = document.elementFromPoint(bounds.left + bounds.width / 2, top + 1);
    const visible = hit?.closest('[role="row"]')?.querySelector("button");
    if (visible && pane.contains(visible)) row = visible;
  }
  row ??= pane.querySelector<HTMLButtonElement>('[data-entry-id][tabindex="0"]');
  if (!row) return false;
  const rect = row.getBoundingClientRect();
  row.focus({ preventScroll: true });
  if (rect.bottom <= top || rect.top >= bounds.bottom) row.scrollIntoView({ block: "nearest" });
  return true;
}

export function AtlasInspector({
  view, initialView, siteId, inspection, openedFile, contentsPane, fileOpen, folderName, detailsKey, origin,
  onViewChange, onBackToContents, onClose, contents, details,
}: AtlasInspectorProps) {
  const id = useId();
  const drawer = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const contentsTab = useRef<HTMLButtonElement>(null);
  const detailsTab = useRef<HTMLButtonElement>(null);
  const lastView = useRef<{ view: InspectorView; target: string | null } | null>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const screen = fileOpen ? "file" : view;
  const previousView = useRef<{ screen: InspectorView | "file" | null; siteId: string; file: string | null; inspection: AtlasInspection | null }>({
    screen, siteId, file: screen === "file" ? detailsKey : null, inspection,
  });
  const enterList = useRef(false);
  const detailsPane = useRef<HTMLDivElement>(null);
  const detailsScroll = useRef({ target: detailsKey, top: 0 });

  useLayoutEffect(() => {
    if (view) lastView.current = { view: screen === "file" ? "contents" : view, target: detailsKey };
    if (detailsScroll.current.target !== detailsKey) detailsScroll.current = { target: detailsKey, top: 0 };
    if (view === "details" && detailsPane.current) detailsPane.current.scrollTop = detailsScroll.current.top;
  }, [view, screen, detailsKey]);

  useLayoutEffect(() => {
    const previous = previousView.current;
    const file = screen === "file" ? detailsKey : null;
    const changedFile = file !== null && file !== previous.file;
    previousView.current = { screen, siteId, file, inspection };
    const openedHere = inspection !== null && openedFile.current === inspection;
    if (openedHere) openedFile.current = null;
    const active = document.activeElement;
    const focusedOutside = active && active !== document.body && !drawer.current?.contains(active);
    const inspectingFile = screen === "file" || previous.screen === "file";
    // Atlas history owns focus when entering or leaving a result inspected in the map.
    const inspectionHistory = previous.screen && screen && !inspectingFile && previous.inspection !== inspection;
    const restoringFile = screen === "file" && previous.inspection !== inspection && !openedHere;
    const leavingFile = previous.screen === "file" && screen === "contents" && previous.inspection !== inspection;
    if ((previous.screen === screen && !changedFile)
      || inspectionHistory
      || (focusedOutside && (previous.siteId !== siteId || restoringFile || leavingFile))) return;
    if (screen && (!previous.screen || origin.current || inspectingFile)) revealInCompactAtlas(drawer.current);
    if (screen === "file") {
      backButton.current?.focus({ preventScroll: true });
    } else if (screen === "contents" && enterList.current) {
      if (!contentsPane.current || !focusContentsRow(contentsPane.current)) {
        contentsTab.current?.focus({ preventScroll: true });
      }
    } else if (screen) {
      (screen === "contents" ? contentsTab : detailsTab).current?.focus({ preventScroll: true });
    } else if (previous.screen) {
      if (document.activeElement === document.body) {
        restoreAtlasPanelFocus(trigger.current, origin.current);
      }
      origin.current = null;
    }
    enterList.current = false;
  }, [screen, siteId, inspection, openedFile, detailsKey, contentsPane, origin]);

  if (!view) {
    return (
      <button
        className="atlas-inspector-trigger"
        type="button"
        ref={trigger}
        aria-expanded={false}
        onClick={(event) => {
          enterList.current = event.detail === 0;
          onViewChange(lastView.current?.target === detailsKey ? lastView.current.view : initialView);
        }}
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true">
          <rect x="2" y="3" width="12" height="10" rx="1.5" />
          <path d="M7 3v10m2.5-7h2m-2 2h2m-2 2h2" />
        </svg>
        Contents &amp; details
      </button>
    );
  }

  function handleTabKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;

    let nextView: InspectorView;
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowRight":
        nextView = view === "contents" ? "details" : "contents";
        break;
      case "Home":
        nextView = "contents";
        break;
      case "End":
        nextView = "details";
        break;
      default:
        return;
    }

    event.preventDefault();
    if (nextView !== view) onViewChange(nextView);
  }

  return (
    <aside
      ref={drawer}
      id={id} className="atlas-inspector atlas-inspector-drawer"
      data-atlas-panel="inspector" data-atlas-view={view} aria-label="Inspector"
      onKeyDown={(event) => {
        if (screen !== "file" || event.key !== "ArrowLeft" || event.defaultPrevented
          || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (event.target instanceof Element && event.target.closest("dialog, input, select, textarea, [contenteditable]")) return;
        event.preventDefault();
        onBackToContents();
      }}
    >
      <header className="atlas-inspector-bar">
        {screen === "file" ? (
          <div className="atlas-inspector-file-nav">
            <button type="button" ref={backButton} aria-label="Back to Contents" onClick={onBackToContents}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M13 8H3m5-5L3 8l5 5" />
              </svg>
              Contents
            </button>
            <span title={folderName}>{folderName}</span>
          </div>
        ) : (
          <div className="atlas-inspector-tabs" role="tablist" aria-label="Inspector view" onKeyDown={handleTabKeys}>
            {tabs.map((tab) => (
              <button
                key={tab.view}
                ref={tab.view === "contents" ? contentsTab : detailsTab}
                id={`${id}-${tab.view}-tab`}
                type="button"
                role="tab"
                aria-selected={view === tab.view}
                aria-controls={`${id}-${tab.view}-panel`}
                tabIndex={view === tab.view ? 0 : -1}
                onClick={() => { if (tab.view !== view) onViewChange(tab.view); }}
              >
                {tab.label}
              </button>
            ))}
          </div>
        )}
        <button className="atlas-inspector-close" type="button" aria-label="Close inspector" onClick={(event) => {
          event.currentTarget.focus({ preventScroll: true });
          onClose();
        }}>
          <CloseIcon />
        </button>
      </header>
      {tabs.map((tab) => (
        <div
          key={tab.view}
          id={`${id}-${tab.view}-panel`}
          className="atlas-inspector-pane"
          ref={tab.view === "contents" ? contentsPane : detailsPane}
          onScroll={view === "details" && tab.view === "details" ? (event) => {
            detailsScroll.current = { target: detailsKey, top: event.currentTarget.scrollTop };
          } : undefined}
          role={screen === "file" ? undefined : "tabpanel"}
          aria-labelledby={screen === "file" ? undefined : `${id}-${tab.view}-tab`}
          tabIndex={0}
          hidden={view !== tab.view}
        >
          {tab.view === "contents" ? contents : details}
        </div>
      ))}
    </aside>
  );
}
