import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatBytes, formatCount, percent } from "../lib/format";
import type { StorageNode } from "../lib/types";

interface SunburstMapProps {
  root: StorageNode;
  selectedNodeId: string;
  onSelectNode: (node: StorageNode) => void;
}

interface ArcDatum {
  node: StorageNode;
  depth: number;
  start: number;
  end: number;
  color: string;
}

const TAU = Math.PI * 2;
const GAP = 0.018;
const PALETTE = [192, 206, 222, 238, 259, 278, 304, 330, 15, 43];
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
  return Math.max(node.total_bytes, node.duplicate_bytes, 1);
}

function layout(root: StorageNode): ArcDatum[] {
  const arcs: ArcDatum[] = [];
  const walk = (node: StorageNode, depth: number, start: number, end: number, branch: number) => {
    if (depth > 4 || node.children.length === 0 || arcs.length >= MAX_ARCS) return;
    const total = node.children.reduce((sum, child) => sum + nodeWeight(child), 0);
    let cursor = start;
    const childArcs: Array<{ child: StorageNode; start: number; end: number; branch: number }> = [];
    for (const [index, child] of node.children.entries()) {
      if (arcs.length >= MAX_ARCS) break;
      const span = ((end - start) * nodeWeight(child)) / total;
      const arcStart = cursor;
      const arcEnd = cursor + span;
      const childBranch = depth === 1 ? index : branch;
      const hue = PALETTE[childBranch % PALETTE.length];
      const saturation = Math.round(48 + percent(child.duplicate_bytes, child.total_bytes) * 0.34);
      const lightness = Math.max(38, 66 - depth * 5);
      arcs.push({ node: child, depth, start: arcStart, end: arcEnd, color: `hsl(${hue} ${saturation}% ${lightness}%)` });
      childArcs.push({ child, start: arcStart, end: arcEnd, branch: childBranch });
      cursor = arcEnd;
    }
    for (const childArc of childArcs) {
      walk(childArc.child, depth + 1, childArc.start, childArc.end, childArc.branch);
    }
  };
  walk(root, 1, -Math.PI / 2, TAU - Math.PI / 2, 0);
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
    return radius >= inner && radius <= inner + ringWidth - 4 && angle >= arc.start && angle <= arc.end;
  });
}

export function SunburstMap({ root, selectedNodeId, onSelectNode }: SunburstMapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
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
    glow.addColorStop(0, "rgba(71, 217, 224, .06)");
    glow.addColorStop(1, "rgba(7, 9, 13, 0)");
    context.fillStyle = glow;
    context.fillRect(0, 0, size, size);

    arcs.forEach((arc) => {
      const inner = innerRadius + (arc.depth - 1) * ringWidth;
      const outer = inner + ringWidth - 4;
      drawArc(context, center, inner, outer, arc.start, arc.end);
      const selected = arc.node.id === selectedNodeId;
      const isHovered = hovered?.node.id === arc.node.id;
      context.globalAlpha = selected || isHovered ? 1 : 0.8;
      context.fillStyle = arc.color;
      context.fill();
      if (selected || isHovered) {
        context.save();
        context.strokeStyle = selected ? "rgba(255,255,255,.95)" : "rgba(255,255,255,.65)";
        context.lineWidth = selected ? 2 : 1;
        context.shadowColor = arc.color;
        context.shadowBlur = 12;
        context.stroke();
        context.restore();
      }
    });
    context.globalAlpha = 1;

    context.beginPath();
    context.arc(center, center, innerRadius - 7, 0, TAU);
    context.fillStyle = "rgba(14, 18, 25, .96)";
    context.fill();
    context.strokeStyle = "rgba(255,255,255,.07)";
    context.stroke();

  }, [arcs, hovered, innerRadius, ringWidth, selectedNodeId, size]);

  useEffect(() => {
    setCurrentRootId(root.id);
  }, [root.id]);

  const getPointerArc = useCallback((event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return hitTest(arcs, event.clientX - rect.left, event.clientY - rect.top, size / 2, innerRadius, ringWidth);
  }, [arcs, innerRadius, ringWidth, size]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
    const current = Math.max(0, arcs.findIndex((arc) => arc.node.id === (hovered?.node.id ?? selectedNodeId)));
    if (["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      const offset = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
      setHovered(arcs[(current + offset + arcs.length) % arcs.length] ?? null);
    } else if ((event.key === "Enter" || event.key === " ") && hovered) {
      event.preventDefault();
      onSelectNode(hovered.node);
      if (hovered.node.children.length > 0) setCurrentRootId(hovered.node.id);
    }
  };

  return (
    <div className="sunburst-frame" ref={frameRef}>
      <div className="map-breadcrumb" aria-label="Current map location">
        {rootPath.slice(-3).map((node, index, visible) => (
          <span key={node.id}>{index > 0 && <i>/</i>}{node.name || "Site"}{index === visible.length - 1 && <b />}</span>
        ))}
      </div>
      <canvas
        ref={canvasRef}
        className="sunburst-canvas"
        role="img"
        tabIndex={0}
        aria-label={`Radial storage map for ${root.name}. Use arrow keys to explore and Enter to select.`}
        onPointerMove={(event) => setHovered(getPointerArc(event) ?? null)}
        onPointerLeave={() => setHovered(null)}
        onClick={(event) => {
          const arc = getPointerArc(event);
          if (arc) {
            onSelectNode(arc.node);
            if (arc.node.children.length > 0) setCurrentRootId(arc.node.id);
          }
        }}
        onKeyDown={handleKeyDown}
      />
      <button
        className="map-center-control"
        type="button"
        onClick={() => {
          if (!parentRoot) return;
          setCurrentRootId(parentRoot.id);
          onSelectNode(parentRoot);
        }}
        disabled={!parentRoot}
        aria-label={parentRoot ? `Return to ${parentRoot.name}` : `${currentRoot.name}, map root`}
      >
        <small>{parentRoot ? "← BACK TO" : "CURRENT ROOT"}</small>
        <strong>{currentRoot.name.length > 15 ? `${currentRoot.name.slice(0, 14)}…` : currentRoot.name}</strong>
        <span>{formatBytes(currentRoot.duplicate_bytes)}</span>
      </button>
      <div className="map-legend" aria-hidden="true">
        <span><i className="legend-unique" />Unique</span>
        <span><i className="legend-duplicate" />Duplicate-heavy</span>
      </div>
      <p className="sr-only" aria-live="polite">
        {hovered ? `${hovered.node.name}, ${formatCount(hovered.node.file_count)} files, ${formatBytes(hovered.node.duplicate_bytes)} reclaimable` : ""}
      </p>
    </div>
  );
}
