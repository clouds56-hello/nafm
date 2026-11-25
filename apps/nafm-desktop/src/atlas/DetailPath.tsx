import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { copyText } from "../lib/tauri";
import { CheckIcon, CopyIcon } from "../management/Icons";

// A write can outlive its Details view. Starting a second write could overwrite a newer copy.
let clipboardBusy = false;
const clipboardListeners = new Set<() => void>();

function subscribeToClipboard(listener: () => void) {
  clipboardListeners.add(listener);
  return () => { clipboardListeners.delete(listener); };
}

function isClipboardBusy() {
  return clipboardBusy;
}

function setClipboardBusy(busy: boolean) {
  clipboardBusy = busy;
  for (const listener of clipboardListeners) listener();
}

export function DetailPath({ label, path, empty }: { label: string; path: string | null; empty: string }) {
  const id = useId();
  const value = useRef<HTMLElement>(null);
  const disclosure = useRef<HTMLButtonElement>(null);
  const copy = useRef<HTMLButtonElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const copying = useSyncExternalStore(subscribeToClipboard, isClipboardBusy);

  useLayoutEffect(() => {
    const code = value.current;
    if (!code) return;
    function measure() {
      if (!code?.clientWidth) return;
      const lineHeight = Number.parseFloat(getComputedStyle(code).lineHeight);
      const clipped = code.scrollHeight > 2 * lineHeight + 1;
      if (!clipped && disclosure.current && document.activeElement === disclosure.current) {
        copy.current?.focus({ preventScroll: true });
      }
      setOverflow(clipped);
    }
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(code);
    return () => resize.disconnect();
  }, [path]);

  async function copyPath() {
    if (!path || isClipboardBusy()) return;
    setClipboardBusy(true);
    setCopyState("idle");
    try {
      await copyText(path);
      setCopyState("copied");
    } catch {
      setExpanded(true);
      setCopyState("failed");
    } finally {
      setClipboardBusy(false);
    }
  }

  return (
    <div className="atlas-detail-path">
      <dt className="atlas-detail-path-label">
        <span>{label}</span>
        {path && (
          <span className="atlas-detail-path-actions">
            {overflow && (
              <button ref={disclosure} type="button" aria-controls={id} aria-expanded={expanded}
                onClick={() => setExpanded((value) => !value)}>
                {expanded ? "Show less" : "Show full path"}
              </button>
            )}
            <button ref={copy} type="button" aria-label="Copy path"
              title={copying ? "Copying path…" : copyState === "copied" ? "Path copied" : "Copy path"}
              aria-disabled={copying || undefined} aria-busy={copying || undefined}
              onClick={(event) => {
                event.currentTarget.focus({ preventScroll: true });
                void copyPath();
              }}>
              {copyState === "copied" ? <CheckIcon /> : <CopyIcon />}
            </button>
          </span>
        )}
      </dt>
      <dd>
        {path ? (
          <div className="atlas-detail-path-value" data-overflow={overflow && !expanded || undefined}>
            <code ref={value} id={id} data-collapsed={!expanded || undefined}>{path}</code>
          </div>
        ) : empty}
        {path && (
          <span className="atlas-detail-copy-status" role="status" data-error={copyState === "failed" || undefined}>
            {copyState === "failed" ? "Couldn’t copy the path. Select it above to copy it manually."
              : copyState === "copied" ? "Path copied." : ""}
          </span>
        )}
      </dd>
    </div>
  );
}
