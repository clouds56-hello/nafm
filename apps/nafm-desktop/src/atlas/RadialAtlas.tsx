import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { formatBytes, formatCount, formatShare } from "../lib/format";
import { formatCompleteness, formatHealthScore, healthAriaDescription, isPerfectHealth, nodeHealthPresentation } from "../lib/health";
import type { HealthMetric, StorageNode } from "../lib/types";
import { CheckIcon } from "../management/Icons";
import { FirstScanCenter, type FirstScanState } from "./FirstScanCenter";
import { CENTER, ORIGIN, RINGS, SEAM, TURN, branchSectors, polar, type Sector } from "./radialGeometry";
import { RingLabel, useRingLabels } from "./RingLabel";
import { SectorPreview, kindLabel, labelFor, type ArcPreview } from "./SectorPreview";
import "./radial.css";

interface RadialAtlasProps {
  root: StorageNode;
  parentName?: string;
  canGoUp: boolean;
  onGoUp: () => void;
  selectedId: string | null;
  firstScan?: FirstScanState;
  metric: HealthMetric | null;
  targetCompleteness: number;
  onSelect: (node: StorageNode, origin: SVGGElement) => void;
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
  const plot = useRef<HTMLElement>(null);
  const lastControl = useRef<Element | null>(null);

  const previousRoot = useRef(props.root.id);
  const awaitingInventory = Boolean(props.firstScan);

  useLayoutEffect(() => {
    // The old arc was unmounted. On return, resume at the folder we just left.
    if (lastControl.current && !lastControl.current.isConnected && document.activeElement === document.body) {
      const returning = plot.current?.querySelector<SVGGElement>(`[data-node-id="${CSS.escape(previousRoot.current)}"]`);
      const first = plot.current?.querySelector<SVGGElement>('.radial-atlas__sector[tabindex="0"]');
      const up = plot.current?.querySelector<HTMLButtonElement>(".radial-atlas__up:enabled");
      (returning ?? first ?? up ?? plot.current)?.focus({ preventScroll: true });
    }
    previousRoot.current = props.root.id;
    lastControl.current = null;
  }, [props.root.id, awaitingInventory]);

  return (
    <RadialPlot
      key={props.root.id}
      {...props}
      plotRef={plot}
      onKeyboardNavigate={(control) => { lastControl.current = control; }}
    />
  );
}

interface RadialPlotProps extends RadialAtlasProps {
  plotRef: RefObject<HTMLElement | null>;
  onKeyboardNavigate: (control: Element | null) => void;
}

function RadialPlot({
  root, parentName, canGoUp, onGoUp, selectedId, firstScan, metric, targetCompleteness, onSelect, plotRef, onKeyboardNavigate,
}: RadialPlotProps) {
  const descriptionId = useId();
  const gradientId = useId();
  const [preview, setPreview] = useState<ArcPreview | null>(null);
  const pointing = useRef<string | null>(null);
  const up = useRef<HTMLButtonElement>(null);
  const [tabStop, setTabStop] = useState<string | null>(null);
  const awaitingInventory = Boolean(firstScan);
  const sectors = useMemo(() => awaitingInventory
    ? []
    : branchSectors(root, 0, ORIGIN + SEAM / 2, ORIGIN + TURN - SEAM / 2), [root, awaitingInventory]);
  const labels = useRingLabels(plotRef, sectors, metric, targetCompleteness);
  const previewSector = sectors.find((sector) => sector.node.id === preview?.id);
  const highlight = previewSector
    ?? sectors.find((sector) => sector.node.id === selectedId);
  const tabStopId = sectors.find((sector) => sector.node.id === (tabStop ?? selectedId))?.node.id
    ?? sectors[0]?.node.id;
  const rootScore = metric ? nodeHealthPresentation(root, metric, targetCompleteness) : null;
  const metricLabel = metric === "coverage_health" ? "Coverage" : "Space health";
  let caption = sectors.length === 0 ? "No mapped entries" : null;
  if (root.file_count === 0 && root.kind === "site") caption = root.children.length ? "No files found" : "No folders configured";
  else if (root.file_count === 0 && root.children.length === 0) caption = "Folder is empty";
  else if (rootScore?.state === "partial") caption = `${formatCompleteness(rootScore.completeness)} verified`;
  else if (rootScore?.state === "unavailable" && !caption) caption = "Score unavailable";
  else if (!rootScore && !caption) caption = `${formatCount(root.file_count)} ${root.file_count === 1 ? "file" : "files"}`;
  const formattedSize = formatBytes(root.total_bytes);
  const unitStart = formattedSize.lastIndexOf(" ");
  const size = formattedSize.slice(0, unitStart);
  const unit = formattedSize.slice(unitStart + 1);
  const scoreText = rootScore && formatHealthScore(rootScore);

  useEffect(() => {
    if (preview?.input !== "touch") return;
    function dismissOutside(event: Event) {
      if (!(event.target instanceof Element) || !event.target.closest(".atlas-sector-preview, .radial-atlas__sector")) setPreview(null);
    }
    function escape(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setPreview(null);
    }
    document.addEventListener("pointerdown", dismissOutside, true);
    document.addEventListener("focusin", dismissOutside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside, true);
      document.removeEventListener("focusin", dismissOutside);
      document.removeEventListener("keydown", escape);
    };
  }, [preview?.input]);

  function sectorElement(id: string | undefined) {
    return id ? plotRef.current?.querySelector<SVGGElement>(`[data-node-id="${CSS.escape(id)}"]`) : null;
  }

  function showPreview(sector: Sector, input: ArcPreview["input"], pointer?: { clientX: number; clientY: number }) {
    const frame = plotRef.current?.parentElement?.getBoundingClientRect();
    const plot = plotRef.current?.getBoundingClientRect();
    if (!frame || !plot) return;
    const anchor = polar(RINGS[sector.tier].radius, (sector.from + sector.to) / 2);
    const x = pointer?.clientX ?? plot.left + plot.width * anchor.x / (2 * CENTER);
    const y = pointer?.clientY ?? plot.top + plot.height * anchor.y / (2 * CENTER);
    setPreview({ id: sector.node.id, input, x: (x - frame.left) / frame.width * 100, y: (y - frame.top) / frame.height * 100 });
  }

  function openSector(sector: Sector, origin: SVGGElement) {
    setPreview(null);
    onSelect(sector.node, origin);
  }

  function handleSectorKey(event: KeyboardEvent<SVGGElement>, sector: Sector) {
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!event.repeat) openSector(sector, event.currentTarget);
      return;
    }
    if (event.key === "Escape" && preview) {
      event.preventDefault();
      setPreview(null);
      return;
    }

    const siblings = sectors.filter((entry) => entry.parentId === sector.parentId);
    const index = siblings.indexOf(sector);
    let next: Sector | undefined;
    switch (event.key) {
      case "ArrowLeft": next = siblings[(index + siblings.length - 1) % siblings.length]; break;
      case "ArrowRight": next = siblings[(index + 1) % siblings.length]; break;
      case "Home": next = siblings[0]; break;
      case "End": next = siblings.at(-1); break;
      case "ArrowDown": next = sectors.find((entry) => entry.parentId === sector.node.id); break;
      case "ArrowUp": next = sectors.find((entry) => entry.node.id === sector.parentId); break;
      default: return;
    }
    event.preventDefault();
    if (!next && event.key === "ArrowUp" && sector.tier === 0 && up.current) {
      up.current.focus({ preventScroll: true });
    } else {
      const destination = next ?? sector;
      sectorElement(destination.node.id)?.focus({ preventScroll: true });
      showPreview(destination, "keyboard");
    }
  }

  return (
    <>
      <figure
        ref={plotRef}
        className="radial-atlas"
        data-first-scan={awaitingInventory || undefined}
        tabIndex={-1}
        aria-describedby={descriptionId}
        onKeyDownCapture={(event) => onKeyboardNavigate(event.target as Element)}
        onPointerDownCapture={() => onKeyboardNavigate(null)}
      >
        <figcaption id={descriptionId} className="radial-atlas__sr-only">
          {labelFor(root)}. {awaitingInventory ? "Awaiting first inventory." : (
            <>{formatBytes(root.total_bytes)}, {formatCount(root.file_count)} {root.file_count === 1 ? "file" : "files"}.
              {rootScore && ` ${healthAriaDescription(rootScore, metric === "coverage_health" ? "coverage" : "space", root.file_count > 0)}.`}
            </>
          )}
          {sectors.length > 0
            ? " Circular storage map. Segment lengths show data size and outer rings show deeper folders. Left and Right move between siblings. Down moves to a child and Up to its parent. Press Enter or Space to open an item."
            : !awaitingInventory && caption}
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
            <circle className="radial-atlas__dial" cx={CENTER} cy={CENTER} r={awaitingInventory ? 150 : 102} fill={`url(#${gradientId})`} />
            {firstScan?.requestId !== undefined && !firstScan.stopping && (
              <circle className="radial-atlas__scan-sweep" cx={CENTER} cy={CENTER} r={RINGS[1].radius} pathLength="100" />
            )}
            {sectors.filter((sector) => sector.tier === 0).map((sector) => {
              const point = polar(112, (sector.from + sector.to) / 2);
              const color = metric ? nodeHealthPresentation(sector.node, metric, targetCompleteness).color : sector.color;
              return <circle key={sector.node.id} cx={point.x} cy={point.y} r="1.7" fill={color} stroke="none" />;
            })}
          </g>

          {sectors.map((sector) => {
            const { node, color, path, weight, tier, branch } = sector;
            const active = highlight?.node.id === node.id;
            const dimmed = Boolean(highlight && highlight.branch !== branch);
            const entryScore = metric ? nodeHealthPresentation(node, metric, targetCompleteness) : null;
            const partial = entryScore?.state === "partial";
            const label = labels.get(node.id);
            return (
              <g
                key={node.id}
                className="radial-atlas__sector"
                style={{ color: entryScore?.color ?? color }}
                data-node-id={node.id}
                data-tier={tier}
                data-active={active || undefined}
                data-dimmed={dimmed || undefined}
                tabIndex={node.id === tabStopId ? 0 : -1}
                role="button"
                aria-current={node.id === selectedId || undefined}
                aria-label={`${labelFor(node)}, ${kindLabel(node)}, ${formatBytes(node.total_bytes)}${root.total_bytes > 0
                  ? `, ${formatShare(node.total_bytes, root.total_bytes)} of ${labelFor(root)}` : ""}${entryScore
                  ? `, ${healthAriaDescription(entryScore, metric === "coverage_health" ? "coverage" : "space", node.file_count > 0)}`
                  : ""}`}
                onPointerDown={(event) => { pointing.current = event.pointerType; }}
                onPointerCancel={() => { pointing.current = null; }}
                onPointerMove={(event) => {
                  if (event.pointerType === "touch" || event.buttons || (preview?.input === "pointer" && preview.id === node.id)) return;
                  showPreview(sector, "pointer", event);
                }}
                onPointerLeave={() => setPreview((current) => current?.input === "pointer" && current.id === node.id ? null : current)}
                onFocus={(event) => {
                  setTabStop(node.id);
                  if (!pointing.current && event.currentTarget.matches(":focus-visible")) showPreview(sector, "keyboard");
                }}
                onBlur={() => setPreview((current) => current?.input === "keyboard" && current.id === node.id ? null : current)}
                onKeyDown={(event) => { pointing.current = null; handleSectorKey(event, sector); }}
                onClick={(event) => {
                  const touch = pointing.current === "touch" && event.detail !== 0;
                  pointing.current = null;
                  if (touch && !(preview?.input === "touch" && preview.id === node.id)) {
                    showPreview(sector, "touch", event);
                  } else {
                    openSector(sector, event.currentTarget);
                  }
                }}
              >
                <path className="radial-atlas__target" d={sector.hitPath} />
                <path className="radial-atlas__ring-focus" d={path} strokeWidth={weight + 5} />
                {partial && <path className="radial-atlas__ring-track" d={path} strokeWidth={weight} />}
                <path className="radial-atlas__ring" d={path} strokeWidth={partial ? Math.max(1, weight * entryScore.completeness) : weight} />
                {label && <RingLabel label={label} />}
              </g>
            );
          })}
        </svg>
        <div className="radial-atlas__reading">
          {firstScan ? <FirstScanCenter name={labelFor(root)} scan={firstScan} /> : (
            <>
              <span aria-hidden="true" className="radial-atlas__kind" data-metric={metric ?? undefined} style={{ color: rootScore?.color }}>
                {rootScore ? metricLabel : kindLabel(root)}
              </span>
              <strong className="radial-atlas__size" data-long-score={(scoreText?.length ?? 0) > 3 || undefined} aria-hidden="true">
                {scoreText ?? size}
                <span>{rootScore ? rootScore.value === null ? "" : "/100" : unit}</span>
                {rootScore && isPerfectHealth(rootScore) && <CheckIcon className="atlas-score-check" />}
              </strong>
              <span className="radial-atlas__name" aria-hidden="true" title={labelFor(root)}>{labelFor(root)}</span>
              {caption && <span className="radial-atlas__detail" aria-hidden="true" title={caption}>{caption}</span>}
            </>
          )}
          {parentName !== undefined && (
            <button
              ref={up} className="radial-atlas__up" type="button" disabled={!canGoUp}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" && !event.altKey && !event.metaKey && sectors[0]) {
                  event.preventDefault();
                  sectorElement(sectors[0].node.id)?.focus({ preventScroll: true });
                }
              }}
              aria-label={`Up to ${parentName}`} title={`Up to ${parentName}`}
              onClick={(event) => {
                if (event.detail === 0) onKeyboardNavigate(event.currentTarget);
                onGoUp();
              }}
            >
              <span aria-hidden="true">↑</span><span>Up<span className="radial-atlas__up-qualifier"> one level</span></span>
            </button>
          )}
        </div>
      </figure>
      {preview && previewSector && (
        <SectorPreview
          preview={preview} sector={previewSector} root={root} metric={metric} targetCompleteness={targetCompleteness}
          onClose={() => setPreview(null)}
          onOpen={() => {
            const origin = sectorElement(previewSector.node.id);
            if (origin) openSector(previewSector, origin);
          }}
        />
      )}
    </>
  );
}
