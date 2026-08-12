import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatBytes, formatCount, formatHealth } from "../lib/format";
import type { HealthMetric, StorageNode } from "../lib/types";

interface SunburstMapProps {
  root: StorageNode;
  metric: HealthMetric;
  selectedNodeId: string;
  onPreviewNode: (node: StorageNode | null) => void;
  onSelectNode: (node: StorageNode) => void;
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

function findPath(root: StorageNode, targetId: string, trail: StorageNode[] = []): StorageNode[] | null {
  const nextTrail = [...trail, root];
  if (root.id === targetId) return nextTrail;
  for (const child of root.children) {
    const found = findPath(child, targetId, nextTrail);
    if (found) return found;
  }
  return null;
}

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

function healthColor(value: number | null): string {
  if (value === null) return "#4b535c";
  const clamped = Math.min(100, Math.max(0, value));
  if (clamped <= 50) {
    const amount = clamped / 50;
    return mixColor([245, 112, 111], [240, 184, 91], amount);
  }
  return mixColor([240, 184, 91], [91, 219, 194], (clamped - 50) / 50);
}

function mixColor(from: [number, number, number], to: [number, number, number], amount: number): string {
  const channels = from.map((channel, index) => Math.round(channel + (to[index] - channel) * amount));
  return `rgb(${channels.join(" ")})`;
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

export function SunburstMap({ root, metric, selectedNodeId, onPreviewNode, onSelectNode }: SunburstMapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hoverCanvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const animationFrameRef = useRef<number | null>(null);
  const [size, setSize] = useState(560);
  const [hovered, setHovered] = useState<ArcDatum | null>(null);
  const [currentRootId, setCurrentRootId] = useState(root.id);
  const rootPath = useMemo(() => findPath(root, currentRootId) ?? [root], [currentRootId, root]);
  const currentRoot = rootPath.at(-1) ?? root;
  const parentRoot = rootPath.length > 1 ? rootPath.at(-2) ?? null : null;
  const arcs = useMemo(() => layout(currentRoot), [currentRoot]);
  const innerRadius = size * 0.17;
  const maxDepth = arcs.reduce((maximum, arc) => Math.max(maximum, arc.depth), 1);
  const ringWidth = (size * 0.43 - innerRadius) / Math.max(1, Math.min(4, maxDepth));
  const previewArc = useCallback((next: ArcDatum | null) => {
    setHovered((current) => {
      if (current?.node.id === next?.node.id) return current;
      onPreviewNode(next?.node ?? null);
      return next;
    });
  }, [onPreviewNode]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new ResizeObserver(([entry]) => {
      setSize(Math.max(280, Math.min(640, Math.floor(entry.contentRect.width))));
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
      const color = healthColor(hovered.node[metric]);
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
  }, [hovered, innerRadius, metric, ringWidth, size]);

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
      const color = healthColor(arc.node[metric]);
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
      drawScoreLabel(context, arc, arc.node[metric], center, inner, outer);
    }

    context.beginPath();
    context.arc(center, center, innerRadius - 7, 0, TAU);
    context.fillStyle = "rgba(14, 18, 25, .96)";
    context.fill();
    context.strokeStyle = "rgba(255,255,255,.07)";
    context.stroke();
  }, [arcs, innerRadius, metric, ringWidth, selectedNodeId, size]);

  useEffect(() => {
    setCurrentRootId(root.id);
    previewArc(null);
  }, [previewArc, root.id]);

  const getPointerArc = useCallback((event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return hitTest(arcs, event.clientX - rect.left, event.clientY - rect.top, size / 2, innerRadius, ringWidth);
  }, [arcs, innerRadius, ringWidth, size]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      previewArc(null);
      return;
    }
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
      if (hovered.node.children.length > 0) setCurrentRootId(hovered.node.id);
      previewArc(null);
    }
  };

  const score = currentRoot[metric];
  const metricLabel = metric === "space_health" ? "space health" : "coverage health";

  return (
    <div className="sunburst-frame" ref={frameRef}>
      <div className="map-breadcrumb" aria-label="Current map location">
        {rootPath.slice(-3).map((node, index, visible) => (
          <span key={node.id}>
            {index > 0 && <i>/</i>}{node.name || "Site"}{index === visible.length - 1 && <b />}
          </span>
        ))}
      </div>
      <canvas
        ref={canvasRef}
        className="sunburst-canvas"
        role="img"
        tabIndex={0}
        aria-label={`Radial ${metricLabel} map for ${root.name}. Arc size is physical storage. Use arrow keys to explore and Enter to select.`}
        onPointerMove={(event) => {
          const next = getPointerArc(event) ?? null;
          previewArc(next);
        }}
        onPointerLeave={() => previewArc(null)}
        onClick={(event) => {
          const arc = getPointerArc(event);
          if (arc) {
            onSelectNode(arc.node);
            if (arc.node.children.length > 0) setCurrentRootId(arc.node.id);
            previewArc(null);
          }
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => previewArc(null)}
      />
      <canvas ref={hoverCanvasRef} className="sunburst-hover-canvas" aria-hidden="true" />
      <button
        className="map-center-control health-center"
        type="button"
        onClick={() => {
          if (!parentRoot) return;
          previewArc(null);
          setCurrentRootId(parentRoot.id);
          onSelectNode(parentRoot);
        }}
        disabled={!parentRoot}
        aria-label={parentRoot ? `Return to ${parentRoot.name}` : `${currentRoot.name}, map root`}
      >
        <small>{parentRoot ? "← BACK" : metricLabel.toUpperCase()}</small>
        <strong>{formatHealth(score)}{score === null ? "" : <em>/100</em>}</strong>
        <span title={currentRoot.name}>{currentRoot.name}</span>
      </button>
      <div className="health-legend" aria-label="Health score color scale">
        <div className="health-gradient" />
        <div><span>0 unhealthy</span><span>50</span><span>100 healthy</span></div>
        <small><i /> Gray means not scanned or unavailable</small>
      </div>
      <p className="sr-only" aria-live="polite">
        {hovered
          ? `${hovered.node.name}, ${formatCount(hovered.node.file_count)} files, ${formatBytes(hovered.node.total_bytes)}, ${formatHealth(hovered.node[metric])} ${metricLabel}`
          : ""}
      </p>
    </div>
  );
}
