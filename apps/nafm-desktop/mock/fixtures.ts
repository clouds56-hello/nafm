import type { SiteOverview, StorageNode } from "../src/lib/types";

export type PreviewScenario = "populated" | "large" | "deep" | "partial" | "empty" | "scanning"
  | "first-inventory" | "scan-failed" | "slow" | "slow-scan-start" | "recovery" | "workspace-recovery";

export const PREVIEW_WORKSPACE = "Studio workspace";

type SampleSite = Pick<SiteOverview, "id" | "name" | "location" | "kind">;
type SampleEntry = readonly [name: string, contents: number | readonly SampleEntry[]];
type SampleRoot = { name: string; path: string; entries: readonly SampleEntry[] };

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const KiB = 1024;
const brandGuidelines: SampleEntry = ["Brand guidelines.pdf", 65 * MiB];
export const INVENTORY_DATE = "2025-11-04T10:15:00.000Z";

const months = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const projects: readonly SampleEntry[] = [
  ["Brand campaign", [
    ["Trailer master.mov", 92 * GiB],
    ["Camera originals.mxf", 67 * GiB],
    ["Campaign assembly.mov", 19 * GiB],
  ]],
  ["Product launch", [
    ["Launch film.mov", 41 * GiB],
    ["B-roll", [["Interviews.mxf", 17 * GiB], ["Studio details.mxf", 8 * GiB]]],
    ["Grade references.zip", 850 * MiB],
  ]],
  ["Exhibition catalog", [
    ["Print masters.tif", 14 * GiB],
    ["Proofs.pdf", 120 * MiB],
  ]],
  ["Typography study", [["Type specimens.pdf", 270 * MiB], ["Notes.txt", 18 * 1024]]],
  ["Encoding tests", [["Test patterns.mov", 4 * GiB], ["Unrendered.txt", 0]]],
  ["Design references", [["Reference scans.zip", 3 * GiB]]],
  ["Backup campaign", [["Trailer master.mov", 92 * GiB], ["Campaign assembly.mov", 19 * GiB]]],
  ...months.map<SampleEntry>((month, index) => [
    `2024 ${month}`,
    [["Contact sheet.pdf", (16 + index * 7) * MiB], ["Production notes.txt", (8 + index) * 1024]],
  ]),
];

const productionArchive: readonly SampleEntry[] = [
  ["2025 Campaigns", [
    ["Spring Launch", [
      ["Camera Originals", [
        ["Second Unit", [
          ["Interview Selects", [["Day 03 interview.mxf", 24 * GiB], ["Transcript.txt", 84 * 1024]]],
          ["Location Footage", [["Street scenes.mxf", 11 * GiB]]],
        ]],
        ["First Unit", [["Set footage.mxf", 29 * GiB]]],
      ]],
      ["Edit References", [["Shot list.pdf", 14 * MiB]]],
    ]],
    ["Fall Launch", [["Proofs.pdf", 49 * MiB]]],
  ]],
  ["Delivery notes.txt", 19 * 1024],
];

const photographs: readonly SampleEntry[] = [
  ["Editorial", [["Summer contact sheets.tif", 24 * GiB], ["Street portraits.raw", 19 * GiB]]],
  ["Location scouting", [["Coastal walk.raw", 22 * GiB], ["Old town.raw", 15 * GiB]]],
  ["Studio portraits", [["Medium format scans.tif", 37 * GiB], ["Portrait selects.zip", 21 * GiB]]],
  ["Reference images", [["Surfaces.tif", 7 * GiB], brandGuidelines]],
  ...Array.from({ length: 96 }, (_, index): SampleEntry => [
    `Proof ${String(index + 1).padStart(3, "0")}.jpg`, 2 * MiB - index * 1024,
  ]),
];

function largePhotoLibrary(): SampleEntry[] {
  const subjects = ["Harbor survey", "Glasshouse", "Night market", "Botanical study", "Studio session", "Rooftop portraits"];
  const formats = [
    { extension: "jpg", minimum: 700 * KiB, spread: 12 * MiB },
    { extension: "dng", minimum: 18 * MiB, spread: 52 * MiB },
    { extension: "tif", minimum: 48 * MiB, spread: 180 * MiB },
    { extension: "xmp", minimum: 3 * KiB, spread: 16 * KiB },
    { extension: "heic", minimum: 2 * MiB, spread: 8 * MiB },
  ];
  const captures = Array.from({ length: 4_096 - photographs.length }, (_, index): SampleEntry => {
    const subject = subjects[index % subjects.length];
    const { extension, minimum, spread } = formats[Math.floor(index / subjects.length) % formats.length];
    const frame = String(index + 1).padStart(4, "0");
    const size = minimum + ((index * 1_048_573) % spread);
    return [`${subject} ${frame}.${extension}`, size];
  });
  return [...photographs, ...captures];
}

const deliverables: readonly SampleEntry[] = [
  ["Exhibition playback", [["Gallery loop.mov", 44 * GiB], ["Captions.vtt", 38 * 1024]]],
  ["Client review", [["Review cut.mp4", 12 * GiB], ["Clean audio.wav", 4 * GiB]]],
];

const sound: readonly SampleEntry[] = [
  ["Field recordings", [["Harbor ambience.wav", 10 * GiB], ["Distant rain.wav", 8 * GiB]]],
  ["Music cues", [["Cue sessions.zip", 16 * GiB], ["Stems.zip", 5 * GiB]]],
];

const documents: readonly SampleEntry[] = [
  brandGuidelines,
  ["Planning", [["Shot list.pdf", 12 * MiB], ["Schedule.csv", 19 * 1024]]],
  ["Readme.txt", 0],
];

const fieldNotes: readonly SampleEntry[] = [
  ["Survey log.pdf", 28 * MiB],
  ["Drone imagery", [["Headland survey.dng", 16 * GiB], ["Route overview.dng", 6 * GiB]]],
  ["On-location audio", [["Morning session.wav", 4 * GiB], ["Radio checks.wav", 123 * MiB]]],
  ["Unsorted", [["Placeholder.txt", 0]]],
];

const teamFiles: readonly SampleEntry[] = [
  ["Incoming", [["Dailies.mov", 21 * GiB], ["Camera reports.pdf", 17 * MiB]]],
  ["Handoff", [["Screening copy.mov", 15 * GiB], ["Artwork.zip", 2 * GiB]]],
  ["Shared references", [["Design library.zip", 870 * MiB], ["Brief.pdf", 34 * MiB]]],
  ["Campaign mirror", [["Trailer master.mov", 92 * GiB], ["Camera originals.mxf", 67 * GiB]]],
];

function joinPath(directory: string, name: string) {
  const separator = directory.includes("\\") && !directory.includes("/") ? "\\" : "/";
  return `${directory.replace(/[/\\]+$/, "")}${separator}${name}`;
}

function leafName(path: string, fallback: string) {
  return path.replace(/[/\\]+$/, "").split(/[/\\]/).at(-1) || fallback;
}

export function buildFolder(
  id: string,
  name: string,
  path: string | null,
  kind: StorageNode["kind"],
  children: StorageNode[],
): StorageNode {
  const totals = children.reduce((sum, child) => ({
    total_bytes: sum.total_bytes + child.total_bytes,
    file_count: sum.file_count + child.file_count,
    verified_file_count: sum.verified_file_count + child.verified_file_count,
    pending_hash_count: sum.pending_hash_count + child.pending_hash_count,
    verified_bytes: sum.verified_bytes + child.verified_bytes,
  }), { total_bytes: 0, file_count: 0, verified_file_count: 0, pending_hash_count: 0, verified_bytes: 0 });
  const latest = children.reduce<number | null>((date, child) =>
    child.modified_unix_millis !== null && (date === null || child.modified_unix_millis > date)
      ? child.modified_unix_millis : date, null);

  children.sort((a, b) => b.total_bytes - a.total_bytes || a.name.localeCompare(b.name));
  return populateMetrics({ id, name, path, kind, modified_unix_millis: latest, ...totals, children });
}

function populateMetrics(node: Omit<StorageNode,
  "duplicate_bytes" | "duplicate_file_count" | "space_health" | "coverage_health" |
  "estimated_space_health" | "estimated_coverage_health" | "space_healthy_file_equivalents" |
  "space_total_files" | "coverage_covered_files" | "coverage_total_files"
>): StorageNode {
  return {
    ...node,
    duplicate_bytes: 0, duplicate_file_count: 0, space_health: null, coverage_health: null,
    estimated_space_health: null, estimated_coverage_health: null, space_healthy_file_equivalents: 0,
    space_total_files: node.file_count, coverage_covered_files: 0, coverage_total_files: 0,
  };
}

function buildTree(site: SampleSite, roots: readonly SampleRoot[], partial = false, rootId?: string): StorageNode {
  let nextFile = 0;

  function buildEntry(directoryId: string, directoryPath: string, [name, contents]: SampleEntry): StorageNode {
    const id = `${directoryId}/${name}`;
    const path = joinPath(directoryPath, name);
    if (typeof contents !== "number") {
      return buildFolder(id, name, path, "directory", contents.map((entry) => buildEntry(id, path, entry)));
    }

    const index = nextFile++;
    const pending = partial && index % 4 === 0;
    const daysBeforeScan = 1 + (index * 31) % 92;
    return populateMetrics({
      id, name, path, kind: "file", total_bytes: contents, file_count: 1,
      modified_unix_millis: Date.parse(INVENTORY_DATE) - daysBeforeScan * 86_400_000 - index * 60_000,
      verified_file_count: pending ? 0 : 1, pending_hash_count: pending ? 1 : 0,
      verified_bytes: pending ? 0 : contents, children: [],
    });
  }

  const kind = site.kind === "local" ? "local_root" : "smb_root";
  const children = roots.map(({ name, path, entries }, index) => {
    const id = rootId ?? `site_folder:${site.id}:${index}`;
    return buildFolder(id, name, path, kind, entries.map((entry) => buildEntry(id, path, entry)));
  });
  return buildFolder(`site:${site.id}`, site.name, null, "site", children);
}

export function createSampleTree(site: SampleSite, rootId?: string): StorageNode {
  return buildTree(site, [{
    name: leafName(site.location, site.name),
    path: site.location,
    entries: site.kind === "local" ? fieldNotes : teamFiles,
  }], false, rootId);
}

export function createFixtures(scenario: PreviewScenario): { sites: SiteOverview[]; trees: Map<string, StorageNode> } {
  if (scenario === "empty") return { sites: [], trees: new Map() };

  const studioDirectory = "/demo/Studio Archive";
  const studio: SampleSite = {
    id: "studio-archive", name: "Studio archive", location: joinPath(studioDirectory, "Projects"), kind: "local",
  };
  const field: SampleSite = {
    id: "field-drive", name: "Field drive", location: "/demo/Field Drive", kind: "local",
  };
  const team: SampleSite = {
    id: "team-share", name: "Team share", location: "smb://media.example.test/Studio", kind: "smb",
  };
  const studioRoots = [
    ["Projects", projects],
    ["Photo Library", scenario === "large" ? largePhotoLibrary() : photographs],
    ["Deliverables", deliverables],
    ["Sound Library", sound],
    ["Documents", documents],
    ["Sandbox", []],
    ...(scenario === "deep" ? [["Production Archive", productionArchive]] as const : []),
  ] as const;

  const trees = new Map([
    [studio.id, buildTree(studio, studioRoots.map(([name, entries]) => ({
      name, path: joinPath(studioDirectory, name), entries,
    })), scenario === "partial" || scenario === "scanning")],
    [field.id, createSampleTree(field)],
    [team.id, createSampleTree(team)],
  ]);

  const sites = [studio, field, team].map<SiteOverview>((site) => {
    const tree = trees.get(site.id)!;
    const partial = tree.pending_hash_count > 0;
    return {
      ...site,
      connection_state: "connected",
      scan_state: partial ? "idle" : "done",
      hash_status: partial ? "pending" : "ready",
      latest_inventory_at: INVENTORY_DATE,
      last_scanned_at: partial ? null : INVENTORY_DATE,
      total_files: tree.file_count,
      total_bytes: tree.total_bytes,
      verified_file_count: tree.verified_file_count,
      verified_bytes: tree.verified_bytes,
      pending_hash_count: tree.pending_hash_count,
      duplicate_files: 0,
      duplicate_bytes: 0,
    };
  });

  return { sites, trees };
}
