import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { formatHealth, healthColor } from "../lib/format";
import {
  formatHealthForCanvas,
  healthAriaDescription,
  nodeCompleteness,
  nodeHealthPresentation,
  type HealthPresentation,
} from "../lib/health";
import type { HealthMetric, StorageNode } from "../lib/types";

interface SunburstMapProps {
  root: StorageNode;
  breadcrumbs: StorageNode[];
  metric: HealthMetric;
  coverageTargetCompleteness: number;
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
const ARC_TRACK_COLOR = healthColor(null);

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

function arcProgress(presentation: HealthPresentation): number {
  if (presentation.value === null) return 0;
  if (presentation.state === "exact") return 1;
  return Math.min(1, Math.max(0, presentation.completeness));
}

function drawProgressBoundary(
  context: CanvasRenderingContext2D,
  center: number,
  radius: number,
  start: number,
  end: number,
) {
  const gap = Math.min(GAP, Math.max(0, (end - start) * 0.12));
  context.beginPath();
  context.arc(center, center, radius, start + gap, end - gap);
  context.strokeStyle = "rgba(255, 255, 255, .2)";
  context.lineWidth = 1;
  context.stroke();
}

function drawRoundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const right = x + width;
  const bottom = y + height;
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(right - radius, y);
  context.quadraticCurveTo(right, y, right, y + radius);
  context.lineTo(right, bottom - radius);
  context.quadraticCurveTo(right, bottom, right - radius, bottom);
  context.lineTo(x + radius, bottom);
  context.quadraticCurveTo(x, bottom, x, bottom - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
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
  presentation: HealthPresentation,
  center: number,
  inner: number,
  outer: number,
) {
  if (presentation.value === null || presentation.value === 100) return;
  const angleSpan = arc.end - arc.start;
  const radius = (inner + outer) / 2;
  if (angleSpan * radius < 43 || outer - inner < 25) return;

  const angle = (arc.start + arc.end) / 2;
  let rotation = angle + Math.PI / 2;
  if (angle > Math.PI / 2 && angle < Math.PI * 1.5) rotation += Math.PI;
  context.save();
  context.translate(center + Math.cos(angle) * radius, center + Math.sin(angle) * radius);
  context.rotate(rotation);
  context.font = "700 10px -apple-system, BlinkMacSystemFont, sans-serif";
  const label = formatHealthForCanvas(presentation);
  const labelWidth = Math.max(24, context.measureText(label).width + 10);
  drawRoundedRect(context, -labelWidth / 2, -8, labelWidth, 16, 6);
  context.fillStyle = "rgba(7, 11, 15, .76)";
  context.fill();
  context.strokeStyle = "rgba(255, 255, 255, .1)";
  context.lineWidth = 1;
  context.stroke();
  context.fillStyle = "rgba(245, 248, 249, .94)";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label, 0, 0);
  context.restore();
}

export function SunburstMap({
  root,
  breadcrumbs,
  metric,
  coverageTargetCompleteness,
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
  const healthDescriptionId = useId();
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
      const presentation = nodeHealthPresentation(
        hovered.node,
        metric,
        coverageTargetCompleteness,
      );
      const color = healthColor(presentation.value);
      const shadowColor = presentation.state === "exact"
        ? color
        : "rgba(210, 220, 224, .45)";
      drawArc(context, center, inner, outer, hovered.start, hovered.end);
      context.save();
      context.strokeStyle = "rgba(255,255,255,.78)";
      context.lineWidth = 1.5 + pulse * 1.5;
      context.shadowColor = shadowColor;
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
  }, [coverageTargetCompleteness, hovered, innerRadius, metric, ringWidth, size]);

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
      const presentation = nodeHealthPresentation(
        arc.node,
        metric,
        coverageTargetCompleteness,
      );
      const color = healthColor(presentation.value);
      const selected = arc.node.id === selectedNodeId;

      drawArc(context, center, inner, outer, arc.start, arc.end);
      context.globalAlpha = selected ? 0.94 : 0.78;
      context.fillStyle = ARC_TRACK_COLOR;
      context.fill();

      const progress = arcProgress(presentation);
      if (progress > 0) {
        const thickness = outer - inner;
        const progressOuter = inner + thickness * progress;
        drawArc(context, center, inner, progressOuter, arc.start, arc.end);
        context.globalAlpha = 1;
        context.fillStyle = color;
        context.fill();
        if (progress < 1 && (arc.end - arc.start) * progressOuter >= 10) {
          drawProgressBoundary(context, center, progressOuter, arc.start, arc.end);
        }
      }

      context.globalAlpha = 1;
      if (selected) {
        drawArc(context, center, inner, outer, arc.start, arc.end);
        context.save();
        context.strokeStyle = "rgba(255,255,255,.95)";
        context.lineWidth = 2;
        context.shadowColor = presentation.state === "exact"
          ? color
          : "rgba(210, 220, 224, .45)";
        context.shadowBlur = 12;
        context.stroke();
        context.restore();
      }
      drawScoreLabel(context, arc, presentation, center, inner, outer);
    }

    context.beginPath();
    context.arc(center, center, innerRadius - 7, 0, TAU);
    context.fillStyle = "rgba(14, 18, 25, .96)";
    context.fill();
    context.strokeStyle = "rgba(255,255,255,.07)";
    context.stroke();
  }, [arcs, coverageTargetCompleteness, innerRadius, metric, ringWidth, selectedNodeId, size]);

  useEffect(() => {
    previewArc(null);
  }, [root.id]);

  useEffect(() => {
    const hoveredNodeId = hoveredNodeIdRef.current;
    if (!hoveredNodeId) return;
    const rebound = arcs.find((arc) => arc.node.id === hoveredNodeId) ?? null;
    if (!rebound) {
      previewArc(null);
      return;
    }
    setHovered(rebound);
    onPreviewNode(rebound.node);
  }, [arcs, onPreviewNode, previewArc]);

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

  const rootPresentation = nodeHealthPresentation(root, metric, coverageTargetCompleteness);
  const metricLabel = metric === "space_health" ? "space health" : "coverage health";
  const rootCoverageUnavailableReason = metric === "coverage_health"
    && rootPresentation.state === "unavailable"
    && (nodeCompleteness(root) === 0 || coverageTargetCompleteness === 0)
    ? "no verified comparison is available"
    : undefined;
  const rootHealthDescription = healthAriaDescription(
    rootPresentation,
    metric === "space_health" ? "space" : "coverage",
    root.file_count > 0,
    rootCoverageUnavailableReason,
  );

  return (
    <div className={`sunburst-frame is-analysis-${rootPresentation.state}`} ref={frameRef}>
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
      <p id={healthDescriptionId} className="sr-only">
        Arc size is physical storage. The current folder has {rootHealthDescription}. {rootPresentation.state === "partial"
          ? "For estimated arcs, verified content fills from the inner edge outward; the unverified remainder is neutral gray."
          : rootPresentation.state === "unavailable"
            ? "Unavailable health is shown in neutral gray."
            : "Health colors are exact."} Use arrow keys to explore and Enter to select.
      </p>
      <canvas
        ref={canvasRef}
        className="sunburst-canvas"
        role="img"
        tabIndex={0}
        aria-label={`Radial ${metricLabel} map for ${root.name}`}
        aria-describedby={healthDescriptionId}
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
        aria-describedby={healthDescriptionId}
        title={parentRoot ? `Up to ${parentRoot.name} (Alt+Up)` : `${root.name} is the map root`}
      >
        <small>{parentRoot ? "↑ UP" : metricLabel.toUpperCase()}</small>
        <strong style={{ color: rootPresentation.color }}>
          {formatHealth(rootPresentation.value)}
        </strong>
        <span title={root.name}>{root.name}</span>
      </button>
      <div className="health-legend" aria-label="Health score color and verification progress legend">
        <div className="health-gradient" />
        <div><span>0 unhealthy</span><span>50</span><span>100 healthy</span></div>
        {rootPresentation.state === "partial" && (
          <small>Inner fill: verified · Gray: pending or unavailable</small>
        )}
      </div>
    </div>
  );
}
