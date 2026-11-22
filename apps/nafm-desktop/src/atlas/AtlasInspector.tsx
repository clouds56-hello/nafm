import { useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { CloseIcon } from "../management/Icons";
import "./inspector.css";
import "./atlas-inspector-drawer.css";

export type InspectorView = "contents" | "details";

interface AtlasInspectorProps {
  view: InspectorView | null;
  initialView: InspectorView;
  contentsKey: string;
  detailsKey: string | null;
  restoreFocus: boolean;
  origin: RefObject<SVGGElement | null>;
  onViewChange: (view: InspectorView) => void;
  onClose: () => void;
  contents: ReactNode;
  details: ReactNode;
}

const tabs = [
  { view: "contents", label: "Contents" },
  { view: "details", label: "Details" },
] as const;

export function AtlasInspector({
  view, initialView, contentsKey, detailsKey, restoreFocus, origin, onViewChange, onClose, contents, details,
}: AtlasInspectorProps) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const contentsTab = useRef<HTMLButtonElement>(null);
  const detailsTab = useRef<HTMLButtonElement>(null);
  const lastView = useRef<{ view: InspectorView; target: string | null } | null>(null);
  const wasOpen = useRef(false);
  const contentsPane = useRef<HTMLDivElement>(null);
  const detailsPane = useRef<HTMLDivElement>(null);
  const contentsScroll = useRef(new Map<string, number>());
  const detailsScroll = useRef({ target: detailsKey, top: 0 });
  const activeTab = view === "contents" ? contentsTab : detailsTab;

  useLayoutEffect(() => {
    if (view) lastView.current = { view, target: detailsKey };
    if (detailsScroll.current.target !== detailsKey) detailsScroll.current = { target: detailsKey, top: 0 };
    if (view === "contents" && contentsPane.current) contentsPane.current.scrollTop = contentsScroll.current.get(contentsKey) ?? 0;
    if (view === "details" && detailsPane.current) detailsPane.current.scrollTop = detailsScroll.current.top;
  }, [view, contentsKey, detailsKey]);

  useLayoutEffect(() => {
    if (view) {
      activeTab.current?.focus({ preventScroll: true });
    } else if (wasOpen.current) {
      if (restoreFocus && document.activeElement === document.body) {
        const target = origin.current?.isConnected ? origin.current : trigger.current;
        target?.focus({ preventScroll: true });
      }
      origin.current = null;
    }
    wasOpen.current = view !== null;
  }, [view, activeTab, restoreFocus, origin]);

  if (!view) {
    return (
      <button
        className="atlas-inspector-trigger"
        type="button"
        ref={trigger}
        aria-expanded={false}
        onClick={() => onViewChange(lastView.current?.target === detailsKey ? lastView.current.view : initialView)}
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
    <aside id={id} className="atlas-inspector atlas-inspector-drawer" aria-label="Inspector">
      <header className="atlas-inspector-bar">
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
              onClick={() => onViewChange(tab.view)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <button className="atlas-inspector-close" type="button" aria-label="Close inspector" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      {tabs.map((tab) => (
        <div
          key={tab.view}
          id={`${id}-${tab.view}-panel`}
          className="atlas-inspector-pane"
          ref={tab.view === "contents" ? contentsPane : detailsPane}
          onScroll={(event) => {
            if (view !== tab.view) return;
            const top = event.currentTarget.scrollTop;
            if (view === "details") detailsScroll.current = { target: detailsKey, top };
            else if (top) contentsScroll.current.set(contentsKey, top);
            else contentsScroll.current.delete(contentsKey);
          }}
          role="tabpanel"
          aria-labelledby={`${id}-${tab.view}-tab`}
          tabIndex={0}
          hidden={view !== tab.view}
        >
          {tab.view === "contents" ? contents : details}
        </div>
      ))}
    </aside>
  );
}
