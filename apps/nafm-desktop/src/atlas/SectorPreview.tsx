import type { CSSProperties } from "react";
import { fileName, formatBytes, formatShare } from "../lib/format";
import { healthAriaDescription, isPerfectHealth, nodeHealthPresentation, type HealthPresentation } from "../lib/health";
import type { HealthMetric, StorageNode } from "../lib/types";
import { CheckIcon, CloseIcon } from "../management/Icons";
import type { Sector } from "./radialGeometry";

export function labelFor(node: StorageNode): string {
  return node.name || (node.path ? fileName(node.path) : "") || "Storage";
}

export function kindLabel(node: StorageNode): string {
  switch (node.kind) {
    case "file": return "File";
    case "site": return "Storage site";
    case "local_root": return "Local volume";
    case "smb_root": return "Network volume";
    case "smaller_items": return "Grouped entries";
    default: return "Folder";
  }
}

export interface ArcPreview {
  id: string;
  input: "pointer" | "keyboard" | "touch";
  x: number;
  y: number;
}

interface SectorPreviewProps {
  preview: ArcPreview;
  sector: Sector;
  root: StorageNode;
  metric: HealthMetric | null;
  targetCompleteness: number;
  onOpen: () => void;
  onClose: () => void;
}

export function PreviewSummary({ node, root, metric, score, awaitingInventory = false }: {
  node: StorageNode;
  root: StorageNode;
  metric: HealthMetric | null;
  score: HealthPresentation | null;
  awaitingInventory?: boolean;
}) {
  return (
    <div className="atlas-sector-preview__body">
      <span className="atlas-sector-preview__kind">{kindLabel(node)}</span>
      <strong>{labelFor(node)}</strong>
      <span className="atlas-sector-preview__meta">
        {awaitingInventory ? "Awaiting inventory" : formatBytes(node.total_bytes)}
        {!awaitingInventory && root.total_bytes > 0 && ` · ${formatShare(node.total_bytes, root.total_bytes)} of ${labelFor(root)}`}
      </span>
      {score && (
        <span className="atlas-sector-preview__meta">
          {healthAriaDescription(score, metric === "coverage_health" ? "coverage" : "space", node.file_count > 0)}
          {isPerfectHealth(score) && <CheckIcon className="atlas-score-check" />}
        </span>
      )}
    </div>
  );
}

export function SectorPreview({ preview, sector, root, metric, targetCompleteness, onOpen, onClose }: SectorPreviewProps) {
  const { node } = sector;
  const interactive = preview.input === "touch";
  const score = metric ? nodeHealthPresentation(node, metric, targetCompleteness) : null;
  const action = node.kind === "file" ? "View details" : node.kind === "smaller_items" ? "Show contents" : "Open folder";
  return (
    <div
      className="atlas-sector-preview"
      data-input={preview.input}
      data-above={preview.y > 55 || undefined}
      style={{ "--anchor-x": `${preview.x}%`, "--anchor-y": `${preview.y}%`, "--branch-color": score?.color ?? sector.color } as CSSProperties}
      role={interactive ? "group" : undefined}
      aria-label={interactive ? `Preview of ${labelFor(node)}` : undefined}
      aria-hidden={interactive ? undefined : true}
    >
      <PreviewSummary node={node} root={root} metric={metric} score={score} />
      {interactive && (
        <>
          <button type="button" className="atlas-sector-preview__open" onClick={onOpen}>{action}</button>
          <button type="button" className="atlas-sector-preview__dismiss" aria-label="Dismiss preview" onClick={onClose}><CloseIcon /></button>
        </>
      )}
    </div>
  );
}
