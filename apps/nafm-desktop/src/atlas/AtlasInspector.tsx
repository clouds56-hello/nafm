import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { CloseIcon } from "../management/Icons";
import "./inspector.css";
import "./atlas-inspector-drawer.css";

export type InspectorView = "contents" | "details";

interface AtlasInspectorProps {
  id: string;
  view: InspectorView | null;
  onViewChange: (view: InspectorView) => void;
  onClose: () => void;
  contents: ReactNode;
  details: ReactNode;
}

const tabs = [
  { view: "contents", label: "Contents" },
  { view: "details", label: "Details" },
] as const;

export function AtlasInspector({ id, view, onViewChange, onClose, contents, details }: AtlasInspectorProps) {
  const contentsTab = useRef<HTMLButtonElement>(null);
  const detailsTab = useRef<HTMLButtonElement>(null);
  const activeTab = view === "contents" ? contentsTab : detailsTab;

  useLayoutEffect(() => {
    if (view) activeTab.current?.focus({ preventScroll: true });
  }, [view, activeTab]);

  if (!view) return null;

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
