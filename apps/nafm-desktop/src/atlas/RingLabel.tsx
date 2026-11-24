import { useId, useLayoutEffect, useState, type RefObject } from "react";
import { formatBytes } from "../lib/format";
import { formatHealthScore, isPerfectHealth, nodeHealthPresentation } from "../lib/health";
import type { HealthMetric } from "../lib/types";
import { CENTER, RINGS, orbitPath, type Sector } from "./radialGeometry";
import { labelFor } from "./SectorPreview";

interface Label {
  name: string;
  value: string;
  path: string;
  offset: number;
  fontSize: number;
  fontWeight: number;
}

const preferredSize = [15, 12.5, 11.5] as const;
const graphemes = typeof Intl.Segmenter === "function" ? new Intl.Segmenter() : null;

function fitName(name: string, available: number, measure: (text: string) => number, tier: number) {
  if (measure(name) <= available) return name;
  if (tier === 2 || !graphemes) return "";
  const letters = Array.from(graphemes.segment(name), (part) => part.segment);
  // A few isolated letters reveal little on a busy map. The full name remains in the preview.
  let low = tier === 0 ? 4 : 7;
  let high = letters.length - 1;
  let fit = "";
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const candidate = letters.slice(0, count).join("").trimEnd() + "…";
    if (measure(candidate) <= available) {
      fit = candidate;
      low = count + 1;
    } else {
      high = count - 1;
    }
  }
  return fit;
}

function ringValue(sector: Sector, metric: HealthMetric | null, targetCompleteness: number) {
  if (metric === null) return formatBytes(sector.node.total_bytes);
  const score = nodeHealthPresentation(sector.node, metric, targetCompleteness);
  if (score.value === null) return "";
  return `${formatHealthScore(score)}/100${isPerfectHealth(score) ? " ✓" : ""}`;
}

function layoutLabels(
  sectors: Sector[], scale: number, fontFamily: string, context: CanvasRenderingContext2D,
  metric: HealthMetric | null, targetCompleteness: number,
) {
  const labels = new Map<string, Label>();
  const measure = (text: string) => context.measureText(text).width;
  for (const sector of sectors) {
    const { tier, from, to } = sector;
    const ring = RINGS[tier];
    const radius = ring.labelRadius;
    // SVG text scales with the viewBox. Reserve a readable size in screen pixels on small charts.
    const minimumSize = (tier === 0 ? 13 : 12) / scale;
    let fontSize = Math.max(preferredSize[tier], minimumSize);
    const clearance = Math.min(radius - (ring.radius + ring.width / 2), ring.outer - radius);
    const arcLength = (to - from) * radius;
    if (fontSize * .48 > clearance || arcLength < 2 * fontSize) continue;
    const fontWeight = tier === 0 ? 630 : 540;
    context.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
    const fullName = labelFor(sector.node);
    // Use a slightly smaller face if doing so keeps a complete name legible.
    const compactSize = Math.max(minimumSize, fontSize * .84);
    if (compactSize < fontSize && measure(fullName) > arcLength - fontSize) {
      const preferredFont = context.font;
      context.font = `${fontWeight} ${compactSize}px ${fontFamily}`;
      if (measure(fullName) <= arcLength - compactSize) fontSize = compactSize;
      else context.font = preferredFont;
    }
    const padding = fontSize / 2;
    const available = arcLength - 2 * padding;
    const name = fitName(fullName, available, measure, tier);
    if (!name) continue;
    let value = "";
    if (tier === 0 && name === fullName) {
      const metricText = ringValue(sector, metric, targetCompleteness);
      const suffix = ` · ${metricText}`;
      if (metricText && measure(name + suffix) <= available) value = suffix;
    }

    // Aim toward a horizontal tangent, leaving the complete label inside its sector.
    const middle = (from + to) / 2;
    const tangent = Math.PI / 2 + Math.round((middle - Math.PI / 2) / Math.PI) * Math.PI;
    const inset = (measure(name + value) / 2 + padding) / radius;
    const shift = Math.min((to - from) / 4, (to - from) / 2 - inset);
    const angle = middle + Math.max(-shift, Math.min(shift, tangent - middle));
    const reverse = Math.sin(angle) > 0;
    labels.set(sector.node.id, {
      name, value, fontSize, fontWeight,
      path: reverse ? orbitPath(radius, to, from) : orbitPath(radius, from, to),
      offset: (reverse ? to - angle : angle - from) * radius,
    });
  }
  return labels;
}

export function useRingLabels(
  plot: RefObject<HTMLElement | null>, sectors: Sector[], metric: HealthMetric | null, targetCompleteness: number,
) {
  const [labels, setLabels] = useState(() => new Map<string, Label>());
  useLayoutEffect(() => {
    const figure = plot.current;
    const context = document.createElement("canvas").getContext("2d");
    if (!figure || !context) return;
    let lastWidth = -1;
    const fit = () => {
      const width = figure.getBoundingClientRect().width;
      if (width === lastWidth) return;
      lastWidth = width;
      setLabels(layoutLabels(sectors, width / (2 * CENTER), getComputedStyle(figure).fontFamily, context, metric, targetCompleteness));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(figure);
    return () => observer.disconnect();
  }, [plot, sectors, metric, targetCompleteness]);
  return labels;
}

export function RingLabel({ label }: { label: Label }) {
  const pathId = useId();
  return (
    <g className="radial-atlas__label" aria-hidden="true" pointerEvents="none">
      <defs><path id={pathId} d={label.path} /></defs>
      <text textAnchor="middle" dy=".34em" fontSize={label.fontSize} fontWeight={label.fontWeight}>
        <textPath href={`#${pathId}`} startOffset={label.offset}>
          {label.name}{label.value && <tspan className="radial-atlas__label-value">{label.value}</tspan>}
        </textPath>
      </text>
    </g>
  );
}
