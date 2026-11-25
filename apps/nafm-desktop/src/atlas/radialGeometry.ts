import type { StorageNode } from "../lib/types";

export interface Sector {
  parentId: string;
  ancestors: readonly StorageNode[];
  hitPath: string;
  node: StorageNode;
  color: string;
  branch: string;
  tier: number;
  from: number;
  to: number;
  path: string;
  weight: number;
}

export const CENTER = 300;
export const TURN = Math.PI * 2;
export const ORIGIN = -Math.PI / 2;
export const SEAM = .12;
export const RINGS = [
  { inner: 114, outer: 176, radius: 135, width: 24, labelRadius: 161, gap: .058, minimum: .054 },
  { inner: 176, outer: 220, radius: 185, width: 15, labelRadius: 206, gap: .034, minimum: .033 },
  { inner: 220, outer: 256, radius: 227, width: 8, labelRadius: 244, gap: .023, minimum: .025 },
] as const;
const PALETTE = ["#b1b8ff", "#f1bfae", "#c6d99b", "#bcabed", "#83cec9", "#e6aebb", "#d7d4a4"];
const MAX_SIBLINGS = 16;

export function polar(radius: number, angle: number) {
  return {
    x: CENTER + radius * Math.cos(angle),
    y: CENTER + radius * Math.sin(angle),
  };
}

export function orbitPath(radius: number, from: number, to: number): string {
  const start = polar(radius, from);
  const end = polar(radius, to);
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${Math.abs(to - from) > Math.PI ? 1 : 0} ${to > from ? 1 : 0} ${end.x} ${end.y}`;
}

function hitSector(inner: number, outer: number, from: number, to: number) {
  const innerEnd = polar(inner, to);
  const innerStart = polar(inner, from);
  const large = to - from > Math.PI ? 1 : 0;
  return `${orbitPath(outer, from, to)} L ${innerEnd.x} ${innerEnd.y} A ${inner} ${inner} 0 ${large} 0 ${innerStart.x} ${innerStart.y} Z`;
}

function rankedBranches(parent: StorageNode) {
  const byBytes = parent.total_bytes > 0 || parent.children.some((child) => child.total_bytes > 0);
  const children = parent.children.map((node) => ({
    node,
    weight: byBytes ? Math.max(0, node.total_bytes) : Math.max(1, node.file_count),
  })).sort((a, b) => b.weight - a.weight);
  const totalWeight = Math.max(
    byBytes ? parent.total_bytes : parent.file_count,
    children.reduce((total, child) => total + child.weight, 0),
  );
  return { visible: children.slice(0, MAX_SIBLINGS), totalWeight };
}

function branchColor(index: number) {
  return PALETTE[index % PALETTE.length];
}

// Directory order can change independently of the size-ranked atlas.
export function directoryBranchColors(parent: StorageNode) {
  const { visible } = rankedBranches(parent);
  const colors = new Map(visible.map(({ node }, index) => [node.id, branchColor(index)]));
  const group = visible.find(({ node }) => node.kind === "smaller_items");
  return (node: StorageNode) => colors.get(node.id) ?? (group && colors.get(group.node.id)) ?? "var(--atlas-muted)";
}

export function branchSectors(
  parent: StorageNode,
  tier: number,
  from: number,
  to: number,
  inherited?: Pick<Sector, "color" | "branch" | "ancestors">,
): Sector[] {
  const ring = RINGS[tier];
  if (!ring || parent.children.length === 0) return [];
  const { visible, totalWeight } = rankedBranches(parent);
  const ancestors = inherited ? [...inherited.ancestors, parent] : [];
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
      parentId: parent.id,
      ancestors,
      hitPath: hitSector(ring.inner, ring.outer, start, end),
      color: inherited?.color ?? branchColor(index),
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
