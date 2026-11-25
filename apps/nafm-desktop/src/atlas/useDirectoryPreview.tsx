import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { formatBytes, formatCount } from "../lib/format";
import { nodeHealthPresentation, verificationStatus, type HealthPresentation } from "../lib/health";
import type { HealthMetric, StorageNode } from "../lib/types";
import { directoryBranchColors } from "./radialGeometry";
import { labelFor, PreviewSummary } from "./SectorPreview";
import "./directory-preview.css";

const shortDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const fullDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function ModifiedDate({ node, compact = false }: { node: StorageNode; compact?: boolean }) {
  const time = node.modified_unix_millis;
  const date = time == null ? null : new Date(time);
  if (!date || !Number.isFinite(date.getTime())) return <>Date unavailable</>;
  return <time dateTime={date.toISOString()}>{(compact ? shortDate : fullDate).format(date)}</time>;
}

export function DirectoryEntryLabel({ node, awaitingInventory, showDate }: {
  node: StorageNode;
  awaitingInventory: boolean;
  showDate: boolean;
}) {
  return (
    <>
      <span className="atlas-directory-name">
        <span className="atlas-directory-icon" data-kind={node.kind} aria-hidden="true" />
        <span className="atlas-directory-identity">
          <span>{labelFor(node)}</span>
          {showDate ? <span className="atlas-directory-modified"><ModifiedDate node={node} compact /></span>
            : node.kind !== "file" && (
              <span className="atlas-directory-count">
                {awaitingInventory ? "Awaiting inventory" : `${formatCount(node.file_count)} ${node.file_count === 1 ? "file" : "files"}`}
              </span>
            )}
        </span>
      </span>
      <span className="atlas-directory-size">{awaitingInventory ? "—" : formatBytes(node.total_bytes)}</span>
      <span className="atlas-directory-chevron" aria-hidden="true" />
    </>
  );
}

interface PreviewOptions {
  root?: StorageNode;
  entries?: readonly StorageNode[];
  metric: HealthMetric | null;
  targetCompleteness: number;
  awaitingInventory: boolean;
  active: boolean;
  contentsKey: string;
  scrollPane: RefObject<HTMLDivElement | null>;
}

interface RowPreview {
  nodeId: string;
  anchor: HTMLButtonElement;
  key: string;
  input: "pointer" | "keyboard";
}

function DirectoryHoverCard({ anchor, pane, node, root, metric, score, awaitingInventory, color, id, onEnter, onLeave }: {
  anchor: HTMLButtonElement;
  pane: HTMLDivElement;
  node: StorageNode;
  root: StorageNode;
  metric: HealthMetric | null;
  score: HealthPresentation | null;
  awaitingInventory: boolean;
  color: string;
  id: string;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const inspector = pane.closest(".atlas-inspector-drawer") ?? pane;
    const position = () => {
      const row = anchor.getBoundingClientRect();
      const panel = inspector.getBoundingClientRect();
      const gap = 8;
      const viewportHeight = window.innerHeight;
      const { width } = card.getBoundingClientRect();
      const maxX = document.documentElement.clientWidth - width - gap;
      const left = panel.left - width - gap;
      const right = panel.right + gap;
      let x = row.left;
      let y: number;
      if (left >= gap || right <= maxX) {
        card.style.maxHeight = "";
        x = left >= gap ? left : right;
        y = row.top + (row.height - card.getBoundingClientRect().height) / 2;
      } else {
        // Compact layouts need a clear scroll surface and unobstructed inspector controls.
        const top = Math.min(viewportHeight, panel.top);
        const bottom = Math.max(0, panel.bottom);
        const above = top - 2 * gap;
        const below = viewportHeight - bottom - 2 * gap;
        card.style.maxHeight = `${Math.max(0, above, below)}px`;
        y = above >= below ? top - gap - card.getBoundingClientRect().height : bottom + gap;
      }
      const maxY = viewportHeight - card.getBoundingClientRect().height - gap;
      card.style.left = `${Math.max(gap, Math.min(maxX, x))}px`;
      card.style.top = `${Math.max(gap, Math.min(maxY, y))}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(card);
    observer.observe(anchor);
    observer.observe(inspector);
    window.addEventListener("resize", position);
    document.addEventListener("scroll", position, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      document.removeEventListener("scroll", position, true);
    };
  }, [anchor, pane]);

  return createPortal(
    <div ref={cardRef} id={id} className="atlas-directory-preview" role="tooltip"
      style={{ "--branch-color": color } as CSSProperties} onPointerEnter={onEnter} onPointerLeave={onLeave}>
      <PreviewSummary node={node} root={root} metric={metric} score={score} awaitingInventory={awaitingInventory} />
      <dl className="atlas-directory-preview__facts">
        <div><dt>{node.kind === "file" ? "Modified" : "Contents modified"}</dt><dd><ModifiedDate node={node} /></dd></div>
        {!awaitingInventory && <div><dt>Verification</dt><dd>{verificationStatus(node).label}</dd></div>}
      </dl>
      {node.path && <code className="atlas-directory-preview__path">{node.path}</code>}
    </div>,
    document.body,
  );
}

export function useDirectoryPreview({ root, entries, metric, targetCompleteness, awaitingInventory, active, contentsKey, scrollPane }: PreviewOptions) {
  const id = useId();
  const [preview, setPreview] = useState<RowPreview | null>(null);
  const keyboardStep = useRef(false);
  const closeTimer = useRef<number | undefined>(undefined);
  const switchTimer = useRef<number | undefined>(undefined);
  const branchColor = useMemo(() => root && directoryBranchColors(root), [root]);
  const cancelTimers = useCallback(() => {
    window.clearTimeout(closeTimer.current);
    window.clearTimeout(switchTimer.current);
  }, []);
  const close = useCallback(() => { cancelTimers(); setPreview(null); }, [cancelTimers]);
  const leave = () => {
    cancelTimers();
    closeTimer.current = window.setTimeout(close, 250);
  };
  const entry = preview && entries?.find((node) => node.id === preview.nodeId);
  const shown = active && entry && preview?.key === contentsKey ? preview : null;

  // An old tooltip must not follow a recycled row, an inactive tab, or a newly sorted directory.
  useLayoutEffect(() => {
    if (preview && (!shown || !preview.anchor.isConnected || preview.anchor.dataset.entryId !== preview.nodeId)) close();
  });
  useEffect(() => cancelTimers, [cancelTimers]);
  useEffect(() => {
    if (!shown) return;
    const pane = scrollPane.current;
    const dismissKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !document.querySelector("dialog[open]")) {
        event.preventDefault();
        close();
      }
    };
    const dismissOutside = (event: Event) => {
      if (event.target instanceof Element && !event.target.closest(".atlas-directory-preview") && !shown.anchor.contains(event.target)) close();
    };
    const handleScroll = () => {
      if (pane && shown.input === "keyboard" && document.activeElement === shown.anchor) {
        const bounds = pane.getBoundingClientRect();
        const top = pane.querySelector(".atlas-directory-header")?.getBoundingClientRect().bottom ?? bounds.top;
        const row = shown.anchor.getBoundingClientRect();
        if (row.bottom > top && row.top < bounds.bottom) return;
      }
      cancelTimers();
      setPreview((current) => current === shown ? null : current);
    };
    window.addEventListener("keydown", dismissKey, true);
    document.addEventListener("pointerdown", dismissOutside, true);
    document.addEventListener("focusin", dismissOutside, true);
    pane?.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      window.removeEventListener("keydown", dismissKey, true);
      document.removeEventListener("pointerdown", dismissOutside, true);
      document.removeEventListener("focusin", dismissOutside, true);
      pane?.removeEventListener("scroll", handleScroll);
    };
  }, [shown, scrollPane, close, cancelTimers]);

  function colorFor(node: StorageNode, score: HealthPresentation | null) {
    return score?.color ?? branchColor?.(node) ?? "var(--atlas-muted)";
  }

  function bind(node: StorageNode) {
    const score = metric ? nodeHealthPresentation(node, metric, targetCompleteness) : null;
    const open = (anchor: HTMLButtonElement, input: RowPreview["input"]) => {
      cancelTimers();
      if (active && !(shown?.nodeId === node.id && shown.input === input)) setPreview({ nodeId: node.id, input, anchor, key: contentsKey });
    };
    return {
      style: { "--entry-color": colorFor(node, score) } as CSSProperties,
      "aria-describedby": shown?.nodeId === node.id ? id : undefined,
      onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => {
        if (event.pointerType !== "touch" && !event.buttons) {
          keyboardStep.current = false;
          const anchor = event.currentTarget;
          if (shown?.input === "pointer" && shown.nodeId !== node.id) {
            // Let the pointer cross intervening rows on its way to the card.
            cancelTimers();
            switchTimer.current = window.setTimeout(() => open(anchor, "pointer"), 100);
          } else {
            open(anchor, "pointer");
          }
        }
      },
      onPointerLeave: () => { if (shown?.input === "pointer") leave(); },
      onPointerDown: () => { keyboardStep.current = false; close(); },
      onKeyDownCapture: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) {
          keyboardStep.current = true;
          open(event.currentTarget, "keyboard");
        }
      },
      onFocusCapture: (event: FocusEvent<HTMLButtonElement>) => {
        if (keyboardStep.current || event.currentTarget.matches(":focus-visible")) open(event.currentTarget, "keyboard");
        keyboardStep.current = false;
      },
      onBlur: () => { if (shown?.input === "keyboard" && shown.nodeId === node.id) close(); },
      onClickCapture: close,
    };
  }

  const score = entry && metric ? nodeHealthPresentation(entry, metric, targetCompleteness) : null;
  const pane = scrollPane.current;
  const card = root && shown && entry && pane ? (
    <DirectoryHoverCard anchor={shown.anchor} pane={pane} node={entry} root={root} metric={metric} score={score} awaitingInventory={awaitingInventory}
      color={colorFor(entry, score)} id={id} onEnter={cancelTimers} onLeave={leave} />
  ) : null;
  return { bind, card };
}
