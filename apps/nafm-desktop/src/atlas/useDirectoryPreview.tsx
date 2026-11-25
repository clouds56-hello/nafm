import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { formatBytes, formatCount } from "../lib/format";
import { nodeHealthPresentation, verificationStatus, type HealthPresentation } from "../lib/health";
import type { HealthMetric, StorageNode } from "../lib/types";
import { ModifiedDate } from "./ModifiedDate";
import { directoryBranchColors } from "./radialGeometry";
import { labelFor, PreviewSummary } from "./SectorPreview";
import "./directory-preview.css";

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

function DirectoryHoverCard({ anchor, input, pane, node, root, metric, score, awaitingInventory, color, id, onEnter, onLeave, onDismiss }: {
  anchor: HTMLButtonElement;
  input: RowPreview["input"];
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
  onDismiss: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const inspector = pane.closest(".atlas-inspector-drawer") ?? pane;
    const header = pane.querySelector(".atlas-directory-header");
    const shell = pane.closest(".atlas-shell");
    const toolbar = shell?.querySelector(".atlas-toolbar");
    const sites = shell?.querySelector('[data-atlas-panel="sites"]');
    const position = () => {
      const row = anchor.getBoundingClientRect();
      const bounds = pane.getBoundingClientRect();
      const viewportTop = Math.max(0, toolbar?.getBoundingClientRect().bottom ?? 0);
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = window.innerHeight;
      const visibleTop = Math.max(viewportTop, bounds.top, header?.getBoundingClientRect().bottom ?? 0);
      if (!pane.contains(anchor) || Math.min(row.bottom, bounds.bottom, viewportHeight) <= Math.max(row.top, visibleTop)
        || Math.min(row.right, bounds.right, viewportWidth) <= Math.max(row.left, bounds.left, 0)) {
        onDismiss();
        return;
      }
      const panel = inspector.getBoundingClientRect();
      const gap = 8;
      const { width } = card.getBoundingClientRect();
      const maxX = viewportWidth - width - gap;
      const left = panel.left - width - gap;
      const right = panel.right + gap;
      const sitesBounds = sites?.getBoundingClientRect();
      const fitsBesideInspector = (x: number) => x >= gap && x <= maxX && (
        !sitesBounds || sitesBounds.bottom <= viewportTop || sitesBounds.top >= viewportHeight
        || x + width + gap <= sitesBounds.left || x - gap >= sitesBounds.right
      );
      const side = fitsBesideInspector(left) ? left : fitsBesideInspector(right) ? right : null;
      let x = row.left;
      let y: number;
      if (side !== null) {
        card.style.maxHeight = `${Math.max(0, viewportHeight - viewportTop - 2 * gap)}px`;
        x = side;
        y = row.top + (row.height - card.getBoundingClientRect().height) / 2;
      } else {
        // Compact layouts need a clear scroll surface and unobstructed inspector controls.
        const panelTop = Math.min(viewportHeight, panel.top);
        const panelBottom = Math.max(0, panel.bottom);
        const above = panelTop - viewportTop - 2 * gap;
        const below = viewportHeight - panelBottom - 2 * gap;
        card.style.maxHeight = `${Math.max(0, above, below)}px`;
        y = above >= below ? panelTop - gap - card.getBoundingClientRect().height : panelBottom + gap;
      }
      const maxY = viewportHeight - card.getBoundingClientRect().height - gap;
      card.style.left = `${Math.max(gap, Math.min(maxX, x))}px`;
      card.style.top = `${Math.max(viewportTop + gap, Math.min(maxY, y))}px`;
    };
    const handleScroll = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node) || !target.contains(anchor)) return;
      if (target === pane && (input !== "keyboard" || document.activeElement !== anchor)) onDismiss();
      else position();
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(card);
    observer.observe(anchor);
    observer.observe(inspector);
    if (inspector !== pane) observer.observe(pane);
    if (header) observer.observe(header);
    if (toolbar) observer.observe(toolbar);
    if (sites) observer.observe(sites);
    window.addEventListener("resize", position);
    document.addEventListener("scroll", handleScroll, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      document.removeEventListener("scroll", handleScroll, true);
    };
  }, [anchor, input, onDismiss, pane]);

  return createPortal(
    <div ref={cardRef} id={id} className="atlas-directory-preview" role="tooltip" data-input={input}
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
  const dismissCard = useCallback(() => {
    cancelTimers();
    setPreview((current) => current === shown ? null : current);
  }, [cancelTimers, shown]);

  // An old tooltip must not follow a recycled row, an inactive tab, or a newly sorted directory.
  useLayoutEffect(() => {
    if (preview && (!shown || !preview.anchor.isConnected || preview.anchor.dataset.entryId !== preview.nodeId)) close();
  });
  useEffect(() => cancelTimers, [cancelTimers]);
  useEffect(() => {
    if (!shown) return;
    const dismissKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !document.querySelector("dialog[open]")) {
        event.preventDefault();
        close();
      }
    };
    const dismissOutside = (event: Event) => {
      if (event.target instanceof Element && !event.target.closest(".atlas-directory-preview") && !shown.anchor.contains(event.target)) close();
    };
    window.addEventListener("keydown", dismissKey, true);
    document.addEventListener("pointerdown", dismissOutside, true);
    document.addEventListener("focusin", dismissOutside, true);
    return () => {
      window.removeEventListener("keydown", dismissKey, true);
      document.removeEventListener("pointerdown", dismissOutside, true);
      document.removeEventListener("focusin", dismissOutside, true);
    };
  }, [shown, close]);

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
    <DirectoryHoverCard anchor={shown.anchor} input={shown.input} pane={pane} node={entry} root={root} metric={metric} score={score} awaitingInventory={awaitingInventory}
      color={colorFor(entry, score)} id={id} onEnter={cancelTimers} onLeave={leave} onDismiss={dismissCard} />
  ) : null;
  return { bind, card };
}
