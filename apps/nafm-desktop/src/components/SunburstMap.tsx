import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatHealth, healthColor } from "../lib/format";
import type { HealthMetric, StorageNode } from "../lib/types";

interface SunburstMapProps {
  root: StorageNode;
  breadcrumbs: StorageNode[];
  metric: HealthMetric;
  analysisAvailable: boolean;
  selectedNodeId: string;
  canGoBack: boolean;
  canGoForward: boolean;
  canGoUp: boolean;
  onPreviewNode: (node: StorageNode) => void;
  onPreviewLeave: () => void;
  onPreviewCancel: () => void;
  onSelectNode: (node: StorageNode) => void;
  onBack: () => void;
  onForward: () => void;
  onUp: () => void;
  onNavigateBreadcrumb: (node: StorageNode) => void;
}

interface ArcDatum {
  node: StorageNode;
  depth: number;
  start: number;
  end: number;
}

const TAU = Math.PI * 2;
const GAP = 0.018;
const MAX_ARCS = 5_000;

function nodeWeight(node: StorageNode): number {
  return Math.max(node.total_bytes, 1);
}

function layout(root: StorageNode): ArcDatum[] {
  const arcs: ArcDatum[] = [];
  const walk = (node: StorageNode, depth: number, start: number, end: number) => {
    if (depth > 4 || node.children.length === 0 || arcs.length >= MAX_ARCS) return;
    const total = node.children.reduce((sum, child) => sum + nodeWeight(child), 0);
    let cursor = start;
    const childArcs: ArcDatum[] = [];
    for (const child of node.children) {
      if (arcs.length >= MAX_ARCS) break;
      const span = ((end - start) * nodeWeight(child)) / total;
      const arc = { node: child, depth, start: cursor, end: cursor + span };
      arcs.push(arc);
      childArcs.push(arc);
      cursor += span;
    }
    for (const arc of childArcs) walk(arc.node, depth + 1, arc.start, arc.end);
  };
  walk(root, 1, -Math.PI / 2, TAU - Math.PI / 2);
  return arcs;
}

function drawArc(
  context: CanvasRenderingContext2D,
  center: number,
  inner: number,
  outer: number,
  start: number,
  end: number,
) {
  const gap = Math.min(GAP, Math.max(0, (end - start) * 0.12));
  context.beginPath();
  context.arc(center, center, outer, start + gap, end - gap);
  context.arc(center, center, inner, end - gap, start + gap, true);
  context.closePath();
}

function hitTest(arcs: ArcDatum[], x: number, y: number, center: number, innerRadius: number, ringWidth: number) {
  const dx = x - center;
  const dy = y - center;
  const radius = Math.hypot(dx, dy);
  let angle = Math.atan2(dy, dx);
  if (angle < -Math.PI / 2) angle += TAU;
  return [...arcs].reverse().find((arc) => {
    const inner = innerRadius + (arc.depth - 1) * ringWidth;
    const gap = Math.min(GAP, Math.max(0, (arc.end - arc.start) * 0.12));
    return radius >= inner
      && radius <= inner + ringWidth - 4
      && angle >= arc.start + gap
      && angle <= arc.end - gap;
  });
}

function drawScoreLabel(
  context: CanvasRenderingContext2D,
  arc: ArcDatum,
  value: number | null,
  center: number,
  inner: number,
  outer: number,
) {
  if (value === null) return;
  const angleSpan = arc.end - arc.start;
  const radius = (inner + outer) / 2;
  if (angleSpan * radius < 43 || outer - inner < 25) return;

  const angle = (arc.start + arc.end) / 2;
  let rotation = angle + Math.PI / 2;
  if (angle > Math.PI / 2 && angle < Math.PI * 1.5) rotation += Math.PI;
  context.save();
  context.translate(center + Math.cos(angle) * radius, center + Math.sin(angle) * radius);
  context.rotate(rotation);
  context.fillStyle = "rgba(7, 11, 15, .86)";
  context.font = "700 10px -apple-system, BlinkMacSystemFont, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(`${Math.round(value)}`, 0, 0);
  context.restore();
}

export function SunburstMap({
  root,
  breadcrumbs,
  metric,
  analysisAvailable,
  selectedNodeId,
  canGoBack,
  canGoForward,
  canGoUp,
  onPreviewNode,
  onPreviewLeave,
  onPreviewCancel,
  onSelectNode,
  onBack,
  onForward,
  onUp,
  onNavigateBreadcrumb,
}: SunburstMapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hoverCanvasRef = useRef<HTMLCanvasElement>(null);
  const breadcrumbRef = useRef<HTMLOListElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const animationFrameRef = useRef<number | null>(null);
  const hoveredNodeIdRef = useRef<string | null>(null);
  const [size, setSize] = useState(560);
  const [hovered, setHovered] = useState<ArcDatum | null>(null);
  const parentRoot = breadcrumbs.length > 1 ? breadcrumbs.at(-2) ?? null : null;
  const arcs = useMemo(() => layout(root), [root]);
  const innerRadius = size * 0.17;
  const maxDepth = arcs.reduce((maximum, arc) => Math.max(maximum, arc.depth), 1);
  const ringWidth = (size * 0.43 - innerRadius) / Math.max(1, Math.min(4, maxDepth));
  const previewArc = useCallback((next: ArcDatum | null, restore: "delayed" | "immediate" = "immediate") => {
    const nextNodeId = next?.node.id ?? null;
    if (hoveredNodeIdRef.current === nextNodeId) {
      if (!next && restore === "immediate") onPreviewCancel();
      return;
    }
    hoveredNodeIdRef.current = nextNodeId;
    setHovered(next);
    if (next) onPreviewNode(next.node);
    else if (restore === "delayed") onPreviewLeave();
    else onPreviewCancel();
  }, [onPreviewCancel, onPreviewLeave, onPreviewNode]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new ResizeObserver(([entry]) => {
      setSize(Math.max(240, Math.min(640, Math.floor(entry.contentRect.width), Math.floor(entry.contentRect.height))));
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = hoverCanvasRef.current;
    if (!canvas) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * ratio;
    canvas.height = size * ratio;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.scale(ratio, ratio);

    const drawHover = (pulse: number) => {
      context.clearRect(0, 0, size, size);
      if (!hovered) return;
      const center = size / 2;
      const inner = innerRadius + (hovered.depth - 1) * ringWidth;
      const outer = inner + ringWidth - 4;
      const color = healthColor(analysisAvailable ? hovered.node[metric] : null);
      drawArc(context, center, inner, outer, hovered.start, hovered.end);
      context.save();
      context.strokeStyle = "rgba(255,255,255,.78)";
      context.lineWidth = 1.5 + pulse * 1.5;
      context.shadowColor = color;
      context.shadowBlur = 13 + pulse * 18;
      context.stroke();
      context.restore();
    };

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!hovered) {
      drawHover(0);
      return;
    }
    if (reducedMotion.matches) {
      drawHover(0.35);
      return;
    }

    const startedAt = performance.now();
    const animate = (now: number) => {
      drawHover((Math.sin((now - startedAt) / 190) + 1) / 2);
      animationFrameRef.current = window.requestAnimationFrame(animate);
    };
    animationFrameRef.current = window.requestAnimationFrame(animate);
    return () => {
      if (animationFrameRef.current !== null) window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    };
  }, [analysisAvailable, hovered, innerRadius, metric, ringWidth, size]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * ratio;
    canvas.height = size * ratio;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.scale(ratio, ratio);
    const center = size / 2;
    context.clearRect(0, 0, size, size);

    const glow = context.createRadialGradient(center, center, innerRadius, center, center, size * 0.48);
    glow.addColorStop(0, "rgba(91, 219, 194, .07)");
    glow.addColorStop(1, "rgba(7, 9, 13, 0)");
    context.fillStyle = glow;
    context.fillRect(0, 0, size, size);

    for (const arc of arcs) {
      const inner = innerRadius + (arc.depth - 1) * ringWidth;
      const outer = inner + ringWidth - 4;
      const score = analysisAvailable ? arc.node[metric] : null;
      const color = healthColor(score);
      drawArc(context, center, inner, outer, arc.start, arc.end);
      const selected = arc.node.id === selectedNodeId;
      context.globalAlpha = selected ? 1 : 0.84;
      context.fillStyle = color;
      context.fill();
      if (selected) {
        context.save();
        context.strokeStyle = "rgba(255,255,255,.95)";
        context.lineWidth = 2;
        context.shadowColor = color;
        context.shadowBlur = 12;
        context.stroke();
        context.restore();
      }
      context.globalAlpha = 1;
      drawScoreLabel(context, arc, score, center, inner, outer);
    }

    context.beginPath();
    context.arc(center, center, innerRadius - 7, 0, TAU);
    context.fillStyle = "rgba(14, 18, 25, .96)";
    context.fill();
    context.strokeStyle = "rgba(255,255,255,.07)";
    context.stroke();
  }, [analysisAvailable, arcs, innerRadius, metric, ringWidth, selectedNodeId, size]);

  useEffect(() => {
    previewArc(null);
  }, [previewArc, root]);

  useEffect(() => {
    const breadcrumb = breadcrumbRef.current;
    if (breadcrumb) breadcrumb.scrollLeft = breadcrumb.scrollWidth;
  }, [root.id]);

  const getPointerArc = useCallback((event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return hitTest(arcs, event.clientX - rect.left, event.clientY - rect.top, size / 2, innerRadius, ringWidth);
  }, [arcs, innerRadius, ringWidth, size]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      previewArc(null, "immediate");
      return;
    }
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    if (arcs.length === 0) return;
    const current = Math.max(0, arcs.findIndex((arc) => arc.node.id === (hovered?.node.id ?? selectedNodeId)));
    if (["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      const offset = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
      const next = arcs[(current + offset + arcs.length) % arcs.length] ?? null;
      previewArc(next);
    } else if ((event.key === "Enter" || event.key === " ") && hovered) {
      event.preventDefault();
      onSelectNode(hovered.node);
      previewArc(null, "immediate");
    }
  };

  const score = analysisAvailable ? root[metric] : null;
  const metricLabel = metric === "space_health" ? "space health" : "coverage health";

  return (
    <div className={`sunburst-frame ${analysisAvailable ? "" : "is-analysis-suspended"}`} ref={frameRef}>
      <nav className="map-navigation" aria-label="Folder navigation">
        <div className="map-history-controls" aria-label="History">
          <button
            className="map-nav-button is-back"
            type="button"
            onClick={onBack}
            disabled={!canGoBack}
            aria-label="Back"
            title="Back (Alt+Left)"
          >
            <span aria-hidden="true">‹</span>
          </button>
          <button
            className="map-nav-button is-forward"
            type="button"
            onClick={onForward}
            disabled={!canGoForward}
            aria-label="Forward"
            title="Forward (Alt+Right)"
          >
            <span aria-hidden="true">›</span>
          </button>
        </div>
        <ol className="map-breadcrumb" ref={breadcrumbRef}>
          {breadcrumbs.map((node, index) => {
            const current = index === breadcrumbs.length - 1;
            return (
              <li key={node.id}>
                {index > 0 && <i aria-hidden="true">/</i>}
                <button
                  type="button"
                  onClick={current ? undefined : () => onNavigateBreadcrumb(node)}
                  disabled={current}
                  aria-current={current ? "page" : undefined}
                  title={node.path ?? node.name}
                >
                  {node.name || "Site"}
                  {current && <b aria-hidden="true" />}
                </button>
              </li>
            );
          })}
        </ol>
      </nav>
      <p className="sr-only" aria-live="polite">
        Opened {breadcrumbs.map((node) => node.name || "Site").join(" / ")}
      </p>
      <canvas
        ref={canvasRef}
        className="sunburst-canvas"
        role="img"
        tabIndex={0}
        aria-label={`Radial ${metricLabel} map for ${root.name}. Arc size is physical storage. ${analysisAvailable ? "Health colors are available." : "Health colors are suspended while hashes are pending."} Use arrow keys to explore and Enter to select.`}
        onPointerMove={(event) => {
          const next = getPointerArc(event) ?? null;
          previewArc(next, next ? "immediate" : "delayed");
        }}
        onPointerLeave={() => previewArc(null, "delayed")}
        onClick={(event) => {
          const arc = getPointerArc(event);
          if (arc) {
            onSelectNode(arc.node);
            previewArc(null, "immediate");
          }
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => previewArc(null, "immediate")}
      />
      <canvas ref={hoverCanvasRef} className="sunburst-hover-canvas" aria-hidden="true" />
      <button
        className="map-center-control health-center"
        type="button"
        onClick={() => {
          if (!parentRoot) return;
          previewArc(null, "immediate");
          onUp();
        }}
        disabled={!canGoUp || !parentRoot}
        aria-label={parentRoot ? `Up to ${parentRoot.name}` : `${root.name}, map root`}
        title={parentRoot ? `Up to ${parentRoot.name} (Alt+Up)` : undefined}
      >
        <small>{parentRoot ? "↑ UP" : metricLabel.toUpperCase()}</small>
        <strong style={{ color: healthColor(score) }}>{formatHealth(score)}</strong>
        <span title={root.name}>{root.name}</span>
      </button>
      <div className="health-legend" aria-label="Health score color scale">
        <div className="health-gradient" />
        <div><span>0 unhealthy</span><span>50</span><span>100 healthy</span></div>
      </div>
    </div>
  );
}
