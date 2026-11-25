import { useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import type { AtlasInspection } from "../hooks/useDashboard";
import type { DirectoryFileDirection } from "../lib/types";
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
  fileStep?: {
    previous: boolean;
    next: boolean;
    pending: DirectoryFileDirection | null;
    status: string;
    onStep: (direction: DirectoryFileDirection) => void;
  };
  folderName?: string;
  detailsKey: string | null;
  origin: RefObject<SVGGElement | null>;
  onViewChange: (view: InspectorView) => void;
  onEnterContents: (tab: HTMLButtonElement) => void;
  contentsRevealOrigin?: Element | null;
  onBackToContents: () => void;
  onClose: () => void;
  contents: ReactNode;
  details: ReactNode;
}

const tabs = [
  { view: "contents", label: "Contents" },
  { view: "details", label: "Details" },
] as const;

export function AtlasInspector({
  view, initialView, siteId, inspection, openedFile, contentsPane, fileOpen, fileStep, folderName, detailsKey, origin,
  onViewChange, onEnterContents, contentsRevealOrigin, onBackToContents, onClose, contents, details,
}: AtlasInspectorProps) {
  const id = useId();
  const drawer = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const contentsTab = useRef<HTMLButtonElement>(null);
  const detailsTab = useRef<HTMLButtonElement>(null);
  const lastView = useRef<{ view: InspectorView; target: string | null } | null>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const stepFromFile = useRef<string | null>(null);
  const canStepFiles = Boolean(fileStep);
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
    const enteringContents = screen === "contents" && enterList.current;
    enterList.current = false;
    previousView.current = { screen, siteId, file, inspection };
    const openedHere = inspection !== null && openedFile.current === inspection;
    if (openedHere) openedFile.current = null;
    const active = document.activeElement;
    const steppedFile = canStepFiles && openedHere && changedFile && previous.screen === "file"
      && stepFromFile.current === previous.file;
    if (changedFile || screen !== "file" || !canStepFiles) stepFromFile.current = null;
    if (steppedFile && active && active !== document.body) return;
    const focusedOutside = active && active !== document.body && !drawer.current?.contains(active);
    const inspectingFile = screen === "file" || previous.screen === "file";
    // Atlas history owns focus when entering or leaving a result inspected in the map.
    const inspectionHistory = previous.screen && screen && !inspectingFile && previous.inspection !== inspection;
    const restoringFile = screen === "file" && previous.inspection !== inspection && !openedHere;
    const leavingFile = previous.screen === "file" && screen === "contents" && previous.inspection !== inspection;
    const movedDuringReveal = screen === "contents" && contentsRevealOrigin && active && active !== document.body
      && active !== contentsRevealOrigin && !detailsPane.current?.contains(active);
    if ((previous.screen === screen && !changedFile)
      || inspectionHistory
      || movedDuringReveal
      || (focusedOutside && (previous.siteId !== siteId || restoringFile || leavingFile))) return;
    if (screen && (!previous.screen || origin.current || inspectingFile)) revealInCompactAtlas(drawer.current);
    if (screen === "file") {
      backButton.current?.focus({ preventScroll: true });
    } else if (screen) {
      const tab = (screen === "contents" ? contentsTab : detailsTab).current;
      tab?.focus({ preventScroll: true });
      if (enteringContents && tab) onEnterContents(tab);
    } else if (previous.screen) {
      if (document.activeElement === document.body) {
        restoreAtlasPanelFocus(trigger.current, origin.current);
      }
      origin.current = null;
    }
  }, [screen, siteId, inspection, openedFile, detailsKey, origin, canStepFiles, onEnterContents, contentsRevealOrigin]);

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
      <header className="atlas-inspector-bar" data-file-step={screen === "file" && canStepFiles || undefined}>
        {screen === "file" ? (
          <>
            <div className="atlas-inspector-file-nav">
              <button type="button" ref={backButton} aria-label="Back to Contents" onClick={onBackToContents}>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M13 8H3m5-5L3 8l5 5" />
                </svg>
                {fileStep ? (
                  <span className="atlas-inspector-file-context">
                    Contents
                    <small title={folderName}>{folderName}</small>
                  </span>
                ) : "Contents"}
              </button>
              {!fileStep && <span title={folderName}>{folderName}</span>}
            </div>
            {fileStep && (
              <div className="atlas-inspector-file-steps" role="group" aria-label="Browse files">
                {(["previous", "next"] as const).map((direction) => {
                  const label = direction === "previous" ? "Previous file" : "Next file";
                  const unavailable = !fileStep[direction] || Boolean(fileStep.pending);
                  return (
                    <button
                      key={direction} type="button" className="atlas-inspector-file-step" title={label} aria-label={label}
                      aria-disabled={unavailable || undefined} aria-busy={fileStep.pending === direction || undefined}
                      onClick={(event) => {
                        if (unavailable) return;
                        event.currentTarget.focus({ preventScroll: true });
                        stepFromFile.current = detailsKey;
                        fileStep.onStep(direction);
                      }}
                    >
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
                        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d={direction === "previous" ? "m10 4-4 4 4 4" : "m6 4 4 4-4 4"} />
                      </svg>
                    </button>
                  );
                })}
              </div>
            )}
          </>
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
        {screen === "file" && fileStep && <p className="atlas-inspector-file-step-status" role="status">{fileStep.status}</p>}
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
