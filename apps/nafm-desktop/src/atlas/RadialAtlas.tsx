import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { fileName, formatBytes, formatCount } from "../lib/format";
import type { StorageNode } from "../lib/types";
import "./radial.css";

interface RadialAtlasProps {
  root: StorageNode;
  selectedId: string | null;
  onSelect: (node: StorageNode) => void;
}

interface Sector {
  node: StorageNode;
  color: string;
  branch: string;
  tier: number;
  from: number;
  to: number;
  path: string;
  weight: number;
}

const CENTER = 300;
const TURN = Math.PI * 2;
const ORIGIN = -Math.PI / 2;
const SEAM = .12;
const RINGS = [
  { radius: 139, width: 24, gap: .058, minimum: .054 },
  { radius: 185, width: 15, gap: .034, minimum: .033 },
  { radius: 224, width: 8, gap: .023, minimum: .025 },
] as const;
const PALETTE = ["#b1b8ff", "#f1bfae", "#c6d99b", "#bcabed", "#83cec9", "#e6aebb", "#d7d4a4"];
const MAX_SIBLINGS = 16;

function polar(radius: number, angle: number) {
  return {
    x: CENTER + radius * Math.cos(angle),
    y: CENTER + radius * Math.sin(angle),
  };
}

function orbitPath(radius: number, from: number, to: number): string {
  const start = polar(radius, from);
  const end = polar(radius, to);
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${to - from > Math.PI ? 1 : 0} 1 ${end.x} ${end.y}`;
}

function branchSectors(
  parent: StorageNode,
  tier: number,
  from: number,
  to: number,
  inherited?: Pick<Sector, "color" | "branch">,
): Sector[] {
  const ring = RINGS[tier];
  if (!ring || parent.children.length === 0) return [];

  const byBytes = parent.total_bytes > 0 || parent.children.some((child) => child.total_bytes > 0);
  const children = parent.children.map((node) => ({
    node,
    weight: byBytes ? Math.max(0, node.total_bytes) : Math.max(1, node.file_count),
  })).sort((a, b) => b.weight - a.weight);
  const totalWeight = Math.max(
    byBytes ? parent.total_bytes : parent.file_count,
    children.reduce((total, child) => total + child.weight, 0),
  );
  const visible = children.slice(0, MAX_SIBLINGS);
  const span = to - from;
  const reserved = tier === 0 ? ring.minimum : 0;
  const separator = Math.min(ring.gap, span / (visible.length * 3));
  const dataSpan = Math.max(0, span - (separator + reserved) * visible.length);
  let angle = from;

  return visible.flatMap(({ node, weight }, index) => {
    const start = angle + separator / 2;
    const end = start + reserved + (totalWeight > 0 ? dataSpan * weight / totalWeight : 0);
    angle = end + separator / 2;
    if (end - start < ring.minimum - 1e-8) return [];

    // The SVG stroke has rounded caps. Inset the centerline to keep them within their sector.
    const sweep = end - start;
    const width = Math.min(ring.width, sweep * ring.radius * .76);
    const endInset = width / (2 * ring.radius);
    const sector: Sector = {
      node,
      color: inherited?.color ?? PALETTE[index % PALETTE.length],
      branch: inherited?.branch ?? node.id,
      tier,
      from: start,
      to: end,
      path: orbitPath(ring.radius, start + endInset, end - endInset),
      weight: width,
    };
    return [sector, ...branchSectors(node, tier + 1, start, end, sector)];
  });
}

function labelFor(node: StorageNode): string {
  return node.name || (node.path ? fileName(node.path) : "") || "Storage";
}

function kindLabel(node: StorageNode): string {
  switch (node.kind) {
    case "file": return "File";
    case "site": return "Storage site";
    case "local_root": return "Local volume";
    case "smb_root": return "Network volume";
    case "smaller_items": return "Grouped entries";
    default: return "Folder";
  }
}

function positionAt(radius: number, degrees: number) {
  return polar(radius, degrees * Math.PI / 180);
}

const TICKS = Array.from({ length: 120 }, (_, index) => {
  const angle = index * 3;
  const long = index % 10 === 0;
  return { start: positionAt(long ? 256 : 261, angle), end: positionAt(267, angle), long };
});

const ORIENTATIONS = [0, 90, 180, 270].map((angle) => ({
  start: positionAt(276, angle),
  end: positionAt(284, angle),
}));

export function RadialAtlas(props: RadialAtlasProps) {
  return <RadialPlot key={props.root.id} {...props} />;
}

function RadialPlot({ root, selectedId, onSelect }: RadialAtlasProps) {
  const descriptionId = useId();
  const gradientId = useId();
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const sectors = useMemo(
    () => branchSectors(root, 0, ORIGIN + SEAM / 2, ORIGIN + TURN - SEAM / 2),
    [root],
  );
  const highlight = sectors.find((sector) => sector.node.id === (hoveredId ?? focusedId))
    ?? sectors.find((sector) => sector.node.id === selectedId);
  const shownNode = highlight?.node ?? root;
  const rootCanHaveChildren = root.kind !== "file" && root.kind !== "smaller_items";
  const caption = highlight
    ? `${formatCount(shownNode.file_count)} ${shownNode.file_count === 1 ? "file" : "files"}`
    : sectors.length === 0 && rootCanHaveChildren ? "No mapped entries" : null;
  const formattedSize = formatBytes(shownNode.total_bytes);
  const unitStart = formattedSize.lastIndexOf(" ");
  const size = formattedSize.slice(0, unitStart);
  const unit = formattedSize.slice(unitStart + 1);

  function handleSelect(event: KeyboardEvent<SVGGElement>, node: StorageNode) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    if (!event.repeat) onSelect(node);
  }

  return (
    <figure className="radial-atlas" aria-describedby={descriptionId}>
      <figcaption id={descriptionId} className="radial-atlas__sr-only">
        {labelFor(root)}, {formatBytes(root.total_bytes)}, {formatCount(root.file_count)} {root.file_count === 1 ? "file" : "files"}.
        {sectors.length > 0
          ? " Circular storage map. Segment lengths show data size and outer rings show deeper folders. Tab to a segment and press Enter or Space to select it."
          : rootCanHaveChildren && " No mapped entries."}
      </figcaption>
      <svg viewBox="0 0 600 600" role="group" aria-label={`${labelFor(root)} storage map`} className="radial-atlas__chart">
        <defs>
          <radialGradient id={gradientId} cx=".45" cy=".38" r=".65">
            <stop offset="0" stopColor="#232638" />
            <stop offset="1" stopColor="#171926" />
          </radialGradient>
        </defs>

        <g aria-hidden="true" className="radial-atlas__guides">
          <circle cx={CENTER} cy={CENTER} r="290" className="radial-atlas__limit" />
          <circle cx={CENTER} cy={CENTER} r="251" className="radial-atlas__limit" />
          <circle cx={CENTER} cy={CENTER} r="112" className="radial-atlas__limit" />
          {RINGS.map((ring) => (
            <circle key={ring.radius} cx={CENTER} cy={CENTER} r={ring.radius} className="radial-atlas__track" />
          ))}
          {TICKS.map(({ start, end, long }, index) => (
            <line key={index} x1={start.x} y1={start.y} x2={end.x} y2={end.y} className={long ? "radial-atlas__tick--major" : undefined} />
          ))}
          {ORIENTATIONS.map(({ start, end }, index) => (
            <line key={index} x1={start.x} y1={start.y} x2={end.x} y2={end.y} className="radial-atlas__tick--major" />
          ))}
          <circle className="radial-atlas__dial" cx={CENTER} cy={CENTER} r="102" fill={`url(#${gradientId})`} />
          {sectors.filter((sector) => sector.tier === 0).map((sector) => {
            const point = polar(112, (sector.from + sector.to) / 2);
            return <circle key={sector.node.id} cx={point.x} cy={point.y} r="1.7" fill={sector.color} stroke="none" />;
          })}
        </g>

        {sectors.map((sector) => {
          const { node, color, path, weight, tier, branch } = sector;
          const active = highlight?.node.id === node.id;
          const dimmed = Boolean(highlight && highlight.branch !== branch);
          return (
            <g
              key={node.id}
              className="radial-atlas__sector"
              style={{ color }}
              data-tier={tier}
              data-active={active || undefined}
              data-dimmed={dimmed || undefined}
              tabIndex={0}
              role="button"
              aria-current={node.id === selectedId || undefined}
              aria-label={`${labelFor(node)}, ${kindLabel(node)}, ${formatBytes(node.total_bytes)}`}
              onPointerEnter={() => setHoveredId(node.id)}
              onPointerLeave={() => setHoveredId((current) => current === node.id ? null : current)}
              onFocus={() => setFocusedId(node.id)}
              onBlur={() => setFocusedId((current) => current === node.id ? null : current)}
              onKeyDown={(event) => handleSelect(event, node)}
              onClick={() => onSelect(node)}
            >
              <path className="radial-atlas__target" d={path} strokeWidth={Math.max(weight, 14)} />
              <path className="radial-atlas__ring-focus" d={path} strokeWidth={weight + 5} />
              <path className="radial-atlas__ring" d={path} strokeWidth={weight} />
            </g>
          );
        })}
      </svg>
      <div className="radial-atlas__reading" aria-hidden="true">
        <span className="radial-atlas__kind" style={{ color: highlight?.color }}>{kindLabel(shownNode)}</span>
        <strong className="radial-atlas__size">{size}<span>{unit}</span></strong>
        <span className="radial-atlas__name" title={labelFor(shownNode)}>{labelFor(shownNode)}</span>
        {caption && <span className="radial-atlas__detail">{caption}</span>}
      </div>
    </figure>
  );
}
