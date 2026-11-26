import { expect, test, type Page } from "@playwright/test";
import type { FolderSimilarityPage, FolderSimilarityRequest } from "../src/lib/types";

const sourcePath = "/demo/Studio Archive/Projects/Brand campaign";
const backupPath = "/demo/Studio Archive/Projects/Backup campaign";
const mirrorPath = "smb://media.example.test/Studio/Campaign mirror";
const openError = "The matching folder is temporarily unavailable.";
const defaultSource = { url: "/mock/", folders: ["Projects", "Brand campaign"], path: sourcePath };

function folderPath(page: Page) {
  return page.getByRole("navigation", { name: "Folder path" });
}

function currentFolder(page: Page) {
  return folderPath(page).locator('[aria-current="location"]');
}

function inspector(page: Page) {
  return page.getByRole("complementary", { name: "Inspector" });
}

function similarFoldersButton(page: Page) {
  return inspector(page).getByRole("button", { name: "Similar folders", exact: true });
}

function folderDetails(page: Page) {
  return inspector(page).getByRole("region", { name: "Storage details" });
}

async function inspectSource(page: Page, source = defaultSource) {
  await page.goto(source.url);
  await expect(currentFolder(page)).toHaveText("Studio archive");
  const map = page.getByRole("region", { name: "Circular storage map" });
  for (const folder of source.folders) {
    await map.getByRole("button", { name: new RegExp(`^${folder},`) }).press("Enter");
    await expect(currentFolder(page)).toHaveText(folder);
  }
  await page.getByRole("button", { name: "Contents & details" }).click();
  await inspector(page).getByRole("tab", { name: "Details", exact: true }).click();
  await expect(folderDetails(page)).toContainText(source.path);
}

async function openComparison(page: Page, source = defaultSource) {
  await inspectSource(page, source);
  await similarFoldersButton(page).press("Enter");
  const dialog = page.getByRole("dialog", { name: "Similar folders", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("region", { name: "Matching folder", exact: true })).toContainText(mirrorPath);
  return dialog;
}

test("compare directional folder coverage, open a match, and return to the source", async ({ page }) => {
  const dialog = await openComparison(page);
  const source = dialog.getByRole("region", { name: "Selected folder", exact: true });
  const match = dialog.getByRole("region", { name: "Matching folder", exact: true });
  const overlap = dialog.getByRole("region", { name: "Folder comparison details", exact: true });
  const selectedCoverage = source.getByText("Size also in match", { exact: true }).locator("..");
  const matchingCoverage = match.getByText("Size also in selected folder", { exact: true }).locator("..");
  const backup = dialog.getByRole("button", { name: /Studio archive.*Backup campaign|Backup campaign.*Studio archive/i });
  const mirror = dialog.getByRole("button", { name: /Team share.*Campaign mirror|Campaign mirror.*Team share/i });
  await expect(mirror).toHaveAttribute("aria-pressed", "true");
  await expect(source).toContainText(sourcePath);
  await expect(selectedCoverage).toContainText("89%");
  await expect(selectedCoverage.getByRole("img", { name: "Full coverage" })).toHaveCount(0);
  await expect(matchingCoverage).toContainText("100%");
  await expect(matchingCoverage.getByRole("img", { name: "Full coverage" })).toBeVisible();
  await expect(overlap.getByText("Shared content", { exact: true }).locator("..")).toContainText("2 · 159 GB");
  await expect(overlap.getByText("Only in selected folder", { exact: true }).locator("..")).toContainText("1 · 19 GB");
  await expect(overlap.getByText("Only in match", { exact: true }).locator("..")).toContainText("0 · 0 B");

  await backup.click();
  await expect(backup).toHaveAttribute("aria-pressed", "true");
  await expect(mirror).toHaveAttribute("aria-pressed", "false");
  await expect(match).toContainText(backupPath);
  await expect(selectedCoverage).toContainText("62%");
  await expect(matchingCoverage).toContainText("100%");
  await expect(currentFolder(page)).toHaveText("Brand campaign");

  await mirror.click();
  await expect(match).toContainText(mirrorPath);
  await dialog.getByRole("button", { name: "Show in Atlas", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(currentFolder(page)).toHaveText("Campaign mirror");
  await expect(folderDetails(page)).toContainText(mirrorPath);
  await expect(folderDetails(page)).toBeFocused();

  await folderPath(page).getByRole("button", { name: "Previous location", exact: true }).click();
  await expect(currentFolder(page)).toHaveText("Brand campaign");
  await expect(folderDetails(page)).toContainText(sourcePath);
});

test("partial verification marks 100% coverage as approximate without a full-coverage check", async ({ page }) => {
  const dialog = await openComparison(page, {
    url: "/mock/?scenario=partial", folders: ["Projects"], path: "/demo/Studio Archive/Projects",
  });
  const source = dialog.getByRole("region", { name: "Selected folder", exact: true });
  const match = dialog.getByRole("region", { name: "Matching folder", exact: true });
  await expect(source).toContainText("≈64%");
  await expect(match).toContainText("≈100%");
  await expect(dialog.getByRole("img", { name: "Full coverage" })).toHaveCount(0);
  await expect(dialog.getByRole("status").filter({ hasText: "verified portions" })).toBeVisible();
});

test("Atlas history keeps the source and matching folder’s inspector tabs independent", async ({ page }) => {
  const dialog = await openComparison(page);
  await dialog.getByRole("button", { name: /Studio archive.*Backup campaign/ }).press("Enter");
  await dialog.getByRole("button", { name: "Show in Atlas", exact: true }).press("Enter");
  await expect(dialog).toBeHidden();
  await expect(currentFolder(page)).toHaveText("Backup campaign");
  await expect(folderDetails(page)).toContainText(backupPath);

  const contents = inspector(page).getByRole("tab", { name: "Contents", exact: true });
  const details = inspector(page).getByRole("tab", { name: "Details", exact: true });
  await contents.press("Enter");
  await expect(contents).toHaveAttribute("aria-selected", "true");
  await folderPath(page).getByRole("button", { name: "Previous location", exact: true }).press("Enter");
  await expect(currentFolder(page)).toHaveText("Brand campaign");
  await expect(details).toHaveAttribute("aria-selected", "true");
  await expect(folderDetails(page)).toContainText(sourcePath);

  await folderPath(page).getByRole("button", { name: "Next location", exact: true }).press("Enter");
  await expect(currentFolder(page)).toHaveText("Backup campaign");
  await expect(contents).toHaveAttribute("aria-selected", "true");
  await expect(inspector(page).getByRole("tabpanel", { name: "Contents", exact: true })
    .getByRole("button", { name: /^Trailer master\.mov/ })).toBeVisible();
  await details.press("Enter");
  await expect(folderDetails(page).getByRole("button", { name: "Back to comparison", exact: true })).toBeVisible();
});

test("switching folders shows the match and both coverage directions on a short screen", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 480 });
  const dialog = await openComparison(page, {
    url: "/mock/?scenario=partial", folders: ["Projects"], path: "/demo/Studio Archive/Projects",
  });
  const picker = dialog.getByRole("combobox", { name: "Compare with", exact: true });
  const match = dialog.getByRole("region", { name: "Matching folder", exact: true });
  const source = dialog.getByRole("region", { name: "Selected folder", exact: true });
  const matchCoverage = match.getByText("Size also in selected folder", { exact: true }).locator("..");
  const sourceCoverage = match.getByText("Selected folder size in match", { exact: true }).locator("..");

  await expect(matchCoverage).toContainText("≈100%");
  await picker.selectOption({ label: "Studio · Team share · ≈55%" });
  await expect(match.getByRole("heading", { name: "Studio", exact: true })).toBeInViewport({ ratio: 0.99 });
  await expect(match.getByText("Team share", { exact: true })).toBeInViewport({ ratio: 0.99 });
  await expect(matchCoverage).toContainText("≈80%");
  await expect(sourceCoverage).toContainText("≈64%");
  for (const evidence of [matchCoverage, sourceCoverage]) {
    await expect(evidence).toBeInViewport({ ratio: 0.99 });
  }
  await expect(dialog.getByRole("img", { name: "Full coverage" })).toHaveCount(0);
  expect((await match.boundingBox())!.y).toBeLessThan((await source.boundingBox())!.y);
  expect(await dialog.locator(".atlas-analysis-body").evaluate((body) => body.scrollTop)).toBe(0);
});

test("the compact comparison restores the chosen folder and scroll position after inspection", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 580 });
  const dialog = await openComparison(page);
  const picker = dialog.getByRole("combobox", { name: "Compare with", exact: true });
  await expect(picker).toBeInViewport();
  await expect(picker.locator("option:checked")).toContainText("Campaign mirror");
  await expect(dialog.getByRole("list", { name: "Matching folders" })).toBeHidden();

  await picker.selectOption({ label: "Backup campaign · Studio archive · 62%" });
  await expect(dialog.getByRole("region", { name: "Matching folder", exact: true })).toContainText(backupPath);
  await expect(dialog.getByRole("region", { name: "Selected folder", exact: true })).toContainText("62%");
  await expect(picker).toBeInViewport();

  const comparisonReads = await page.evaluateHandle(() => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
    };
    const reads: string[] = [];
    const invoke = bridge.invoke.bind(bridge);
    bridge.invoke = (command, args) => {
      if (command === "find_similar_folders") reads.push(command);
      return invoke(command, args);
    };
    return reads;
  });
  const body = dialog.locator(".atlas-analysis-body");
  await body.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const scrollTop = await body.evaluate((element) => element.scrollTop);
  expect(scrollTop).toBeGreaterThan(0);

  const show = dialog.getByRole("button", { name: "Show in Atlas", exact: true });
  await show.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(currentFolder(page)).toHaveText("Backup campaign");
  await expect(folderDetails(page)).toContainText(backupPath);

  const back = folderDetails(page).getByRole("button", { name: "Back to comparison", exact: true });
  await back.press("Enter");
  await expect(dialog.getByRole("region", { name: "Selected folder", exact: true })).toContainText(sourcePath);
  await expect(dialog.getByRole("region", { name: "Matching folder", exact: true })).toContainText(backupPath);
  await expect(picker.locator("option:checked")).toContainText("Backup campaign");
  await expect(show).toBeFocused();
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeCloseTo(scrollTop, 0);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(back).toBeFocused();

  await back.press("Enter");
  await expect(picker.locator("option:checked")).toContainText("Backup campaign");
  await expect(show).toBeFocused();
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeCloseTo(scrollTop, 0);
  await dialog.getByRole("button", { name: "Close similar folders", exact: true }).press("Enter");
  await expect(dialog).toBeHidden();
  await expect(back).toBeFocused();
  expect(await comparisonReads.jsonValue()).toEqual([]);
});

test("the focused Similar folders match follows the responsive picker", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const dialog = await openComparison(page);
  const backup = dialog.getByRole("button", { name: /Studio archive.*Backup campaign/ });
  const mirror = dialog.getByRole("button", { name: /Team share.*Campaign mirror/ });
  const picker = dialog.getByRole("combobox", { name: "Compare with", exact: true });
  const match = dialog.getByRole("region", { name: "Matching folder", exact: true });

  await backup.press("Enter");
  await expect(backup).toBeFocused();
  await expect(match).toContainText(backupPath);
  await page.setViewportSize({ width: 320, height: 580 });
  await expect(picker).toBeFocused();
  await expect(picker).toBeInViewport({ ratio: 0.99 });
  await expect(picker.locator("option:checked")).toContainText("Backup campaign");

  await picker.selectOption({ label: "Campaign mirror · Team share · 89%" });
  await expect(match).toContainText(mirrorPath);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(mirror).toBeFocused();
  await expect(mirror).toBeInViewport({ ratio: 0.99 });
  await expect(mirror).toHaveAttribute("aria-pressed", "true");

  const show = dialog.getByRole("button", { name: "Show in Atlas", exact: true });
  await show.focus();
  await page.setViewportSize({ width: 320, height: 580 });
  await expect(show).toBeFocused();
  await expect(match).toContainText(mirrorPath);
});

test("a delayed comparison refresh yields to newer scrolling after returning from Atlas", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 350 });
  const dialog = await openComparison(page);
  const picker = dialog.getByRole("combobox", { name: "Compare with", exact: true });
  await picker.selectOption({ label: "Backup campaign · Studio archive · 62%" });
  const body = dialog.locator(".atlas-analysis-body");
  const saved = await body.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return element.scrollTop;
  });
  const show = dialog.getByRole("button", { name: "Show in Atlas", exact: true });
  await show.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(folderDetails(page)).toContainText(backupPath);

  const refresh = await page.evaluateHandle(() => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
    };
    const invoke = bridge.invoke.bind(bridge);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = { scanFinished: false, pending: false, release };
    bridge.invoke = async (command, args) => {
      const response = await invoke(command, args);
      if (command === "plugin:event|emit" && args.event === "task://scan/events") {
        const event = args.payload as { site_id: string | null; kind: string };
        if (event.site_id === "field-drive" && event.kind === "completed") read.scanFinished = true;
      }
      if (command === "find_similar_folders" && !read.pending) {
        read.pending = true;
        await gate;
      }
      return response;
    };
    return read;
  });
  const back = folderDetails(page).getByRole("button", { name: "Back to comparison", exact: true });
  const close = dialog.getByRole("button", { name: "Close similar folders", exact: true });

  try {
    await page.getByRole("button", { name: "Sites", exact: true }).press("Enter");
    const sites = page.getByRole("complementary", { name: "Sites", exact: true });
    await sites.getByRole("button", { name: "Scan Field drive", exact: true }).press("Enter");
    await expect.poll(() => refresh.evaluate((read) => read.scanFinished), { timeout: 15_000 }).toBe(true);
    await sites.getByRole("button", { name: "Close sites", exact: true }).press("Enter");
    await back.press("Enter");
    await expect.poll(() => refresh.evaluate((read) => read.pending)).toBe(true);
    await expect(close).toBeFocused();

    const initial = await body.evaluate((element) => element.scrollTop);
    const bounds = (await body.boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.wheel(0, initial > 24 ? -24 : 24);
    await expect.poll(() => body.evaluate((element) => element.scrollTop)).not.toBe(initial);
    expect(saved - await body.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
  } finally {
    await refresh.evaluate((read) => read.release());
  }

  await expect(show).toBeEnabled();
  await expect(close).toBeFocused();
  expect(saved - await body.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
  await expect(picker.locator("option:checked")).toContainText("Backup campaign");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(back).toBeFocused();
});

test("Atlas history keeps each inspected match’s own comparison position", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 580 });
  const dialog = await openComparison(page);
  const picker = dialog.getByRole("combobox", { name: "Compare with", exact: true });
  const match = dialog.getByRole("region", { name: "Matching folder", exact: true });
  const show = dialog.getByRole("button", { name: "Show in Atlas", exact: true });
  const back = folderDetails(page).getByRole("button", { name: "Back to comparison", exact: true });
  const body = dialog.locator(".atlas-analysis-body");

  await picker.selectOption({ label: "Backup campaign · Studio archive · 62%" });
  await expect(match).toContainText(backupPath);
  const backupScroll = await body.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return element.scrollTop;
  });
  expect(backupScroll).toBeGreaterThan(0);
  await show.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(folderDetails(page)).toContainText(backupPath);
  await back.press("Enter");
  await expect(match).toContainText(backupPath);

  await picker.selectOption({ label: "Campaign mirror · Team share · 89%" });
  await expect(match).toContainText(mirrorPath);
  await body.evaluate((element) => { element.scrollTop = 0; });
  await show.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(folderDetails(page)).toContainText(mirrorPath);
  await expect(back).toBeVisible();

  const previous = folderPath(page).getByRole("button", { name: "Previous location", exact: true });
  await previous.press("Enter");
  await expect(folderDetails(page)).toContainText(backupPath);
  await expect(back).toBeVisible();
  await expect(previous).toBeFocused();
  await page.keyboard.press("Alt+ArrowRight");
  await expect(folderDetails(page)).toContainText(mirrorPath);
  await expect(back).toBeVisible();
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(folderDetails(page)).toContainText(backupPath);
  await back.press("Enter");
  await expect(match).toContainText(backupPath);
  await expect(picker.locator("option:checked")).toContainText("Backup campaign");
  await expect(show).toBeFocused();
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeCloseTo(backupScroll, 0);
});

test("refresh keeps the comparison on its chosen folder when a match disappears or returns", async ({ page }) => {
  const dialog = await openComparison(page);
  const match = dialog.getByRole("region", { name: "Matching folder", exact: true });
  const backup = dialog.getByRole("button", { name: /Studio archive.*Backup campaign/ });
  const mirror = dialog.getByRole("button", { name: /Team share.*Campaign mirror/ });
  const refresh = dialog.getByRole("button", { name: "Refresh results", exact: true });
  const show = dialog.getByRole("button", { name: "Show in Atlas", exact: true });
  const unavailable = dialog.getByRole("status").filter({ hasText: "The selected folder is unavailable in the current results." });
  const refreshes = await page.evaluateHandle((backupPath) => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
    };
    const invoke = bridge.invoke.bind(bridge);
    const state = { count: 0, remove_backup: false };
    bridge.invoke = async (command, args) => {
      const response = await invoke(command, args);
      if (command !== "find_similar_folders") return response;
      state.count += 1;
      if (!state.remove_backup) return response;
      const result = response as FolderSimilarityPage;
      const matches = result.matches.filter(({ folder }) => folder.path !== backupPath);
      return { ...result, matches, total_matches: matches.length };
    };
    return state;
  }, backupPath);

  await backup.press("Enter");
  await expect(match).toContainText(backupPath);
  await refresh.press("Enter");
  await expect.poll(() => refreshes.evaluate((state) => state.count)).toBe(1);
  await expect(refresh).toBeEnabled();
  await expect(refresh).toBeFocused();
  await expect(backup).toHaveAttribute("aria-pressed", "true");
  await expect(match).toContainText(backupPath);

  await refreshes.evaluate((state) => { state.remove_backup = true; });
  await refresh.press("Enter");
  await expect(backup).toHaveCount(0);
  await expect(mirror).toHaveAttribute("aria-pressed", "false");
  await expect(match).toContainText(backupPath);
  await expect(unavailable).toBeVisible();
  await expect(show).toBeDisabled();
  await expect(refresh).toBeFocused();

  await refreshes.evaluate((state) => { state.remove_backup = false; });
  await refresh.press("Enter");
  await expect(backup).toHaveAttribute("aria-pressed", "true");
  await expect(match).toContainText(backupPath);
  await expect(unavailable).toBeHidden();
  await expect(show).toBeEnabled();
});

test("a compact folder jump keeps its match when an index refresh removes it from Similar folders", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 580 });
  await inspectSource(page);
  await page.clock.install({ time: new Date("2025-11-04T12:00:00Z") });
  await page.clock.pauseAt(new Date("2025-11-04T12:10:00Z"));
  const reads = await page.evaluateHandle((backupPath) => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: { nodeId?: string }) => Promise<unknown> };
    };
    const invoke = bridge.invoke.bind(bridge);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = { held: false, refreshes: 0, release };
    bridge.invoke = async (command, args) => {
      const response = await invoke(command, args);
      if (command === "get_storage_view_snapshot" && args.nodeId?.endsWith("/Backup campaign") && !read.held) {
        read.held = true;
        await gate;
      }
      if (command !== "find_similar_folders" || !read.held) return response;
      read.refreshes += 1;
      const result = response as FolderSimilarityPage;
      const matches = result.matches.filter(({ folder }) => folder.path !== backupPath);
      return { ...result, matches, total_matches: matches.length };
    };
    return read;
  }, backupPath);

  await page.getByRole("button", { name: "Sites", exact: true }).press("Enter");
  const sites = page.getByRole("complementary", { name: "Sites", exact: true });
  await sites.getByRole("button", { name: "Scan Field drive", exact: true }).press("Enter");
  await expect(sites.getByRole("button", { name: "Stop scan of Field drive", exact: true })).toBeEnabled();
  await sites.getByRole("button", { name: "Close sites", exact: true }).press("Enter");
  await similarFoldersButton(page).press("Enter");
  await page.clock.runFor(10);
  const dialog = page.getByRole("dialog", { name: "Similar folders", exact: true });
  const picker = dialog.getByRole("combobox", { name: "Compare with", exact: true });
  const match = dialog.getByRole("region", { name: "Matching folder", exact: true });
  const show = dialog.getByRole("button", { name: "Show in Atlas", exact: true });
  const opening = dialog.getByRole("button", { name: "Opening folder…", exact: true });
  const unavailable = dialog.getByRole("status").filter({ hasText: "The selected folder is unavailable in the current results." });
  const backupOption = picker.locator("option:checked");
  await picker.selectOption({ label: "Backup campaign · Studio archive · 62%" });
  await expect(match).toContainText(backupPath);

  try {
    await show.press("Enter");
    await expect.poll(() => reads.evaluate((read) => read.held)).toBe(true);
    await expect(opening).toBeFocused();
    await page.clock.runFor(5_700);
    await expect.poll(() => reads.evaluate((read) => read.refreshes)).toBeGreaterThan(0);
    await expect(unavailable).toBeVisible();
    await expect(opening).toBeFocused();
    await expect(match).toContainText(backupPath);
    await expect(backupOption).toContainText("Backup campaign · Studio archive · Unavailable");
    await expect(backupOption).toBeDisabled();
  } finally {
    await reads.evaluate((read) => read.release());
  }

  await expect(dialog).toBeHidden();
  await expect(currentFolder(page)).toHaveText("Backup campaign");
  await expect(folderDetails(page)).toContainText(backupPath);
  await folderDetails(page).getByRole("button", { name: "Back to comparison", exact: true }).press("Enter");
  await page.clock.runFor(10);
  await expect(unavailable).toBeVisible();
  await expect(match).toContainText(backupPath);
  await expect(show).toBeDisabled();
  await picker.selectOption({ label: "Campaign mirror · Team share · 89%" });
  await expect(match).toContainText(mirrorPath);
  await expect(unavailable).toBeHidden();
  await expect(show).toBeEnabled();
});

test("Back to comparison follows the matching folder onto its new page after a scan", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 680 });
  await inspectSource(page, { ...defaultSource, url: "/mock/?scenario=large" });
  const reads = await page.evaluateHandle((mirrorPath) => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: { request?: FolderSimilarityRequest }) => Promise<unknown> };
    };
    const invoke = bridge.invoke.bind(bridge);
    type Anchor = NonNullable<FolderSimilarityRequest["anchor"]>;
    const state = { selected: null as Anchor | null, calls: [] as Array<{ offset: number; anchor: Anchor | null; delivered: number }> };
    bridge.invoke = async (command, args) => {
      const response = await invoke(command, args);
      if (command === "find_similar_folders" && args.request) {
        const page = response as FolderSimilarityPage;
        const selected = page.matches.find(({ folder }) => folder.path === mirrorPath)?.folder;
        if (selected && !state.selected) state.selected = { site_id: selected.site_id, node_id: selected.node_id };
        state.calls.push({ offset: args.request.offset, anchor: args.request.anchor ?? null, delivered: page.offset });
      }
      return response;
    };
    return state;
  }, mirrorPath);

  await similarFoldersButton(page).press("Enter");
  const dialog = page.getByRole("dialog", { name: "Similar folders", exact: true });
  const mirror = dialog.getByRole("button", { description: mirrorPath });
  const match = dialog.getByRole("region", { name: "Matching folder", exact: true });
  const show = dialog.getByRole("button", { name: "Show in Atlas", exact: true });
  await expect(mirror).toHaveAttribute("aria-pressed", "true");
  const selected = await reads.evaluate((state) => state.selected);
  expect(selected).toBeTruthy();
  await show.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(currentFolder(page)).toHaveText("Campaign mirror");
  await expect(folderDetails(page)).toContainText(mirrorPath);

  await page.clock.install({ time: new Date("2025-11-04T12:00:00Z") });
  await page.clock.pauseAt(new Date("2025-11-04T12:10:00Z"));
  await page.evaluate(async () => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
    };
    for (let number = 1; number <= 11; number += 1) {
      await bridge.invoke("add_site_folder", {
        siteId: "team-share", workspaceName: "Studio workspace",
        path: `smb://media.example.test/Studio/Archive ${String(number).padStart(2, "0")}`,
      });
    }
  });
  await page.getByRole("button", { name: "Sites", exact: true }).press("Enter");
  const sites = page.getByRole("complementary", { name: "Sites", exact: true });
  const scan = sites.getByRole("button", { name: "Scan Team share", exact: true });
  await scan.press("Enter");
  await expect(sites.getByRole("button", { name: "Stop scan of Team share", exact: true })).toBeEnabled();
  await page.clock.runFor(6_200);
  await expect(scan).toBeEnabled();

  await folderDetails(page).getByRole("button", { name: "Back to comparison", exact: true }).press("Enter");
  await page.clock.runFor(20);
  const pages = dialog.getByRole("group", { name: "Result pages", exact: true });
  await expect(pages).toContainText("11–20 of 25");
  await expect(mirror).toHaveAttribute("aria-pressed", "true");
  await expect(match).toContainText(mirrorPath);
  await expect(show).toBeEnabled();
  await expect(show).toBeFocused();
  expect(await reads.evaluate((state) => state.calls)).toEqual([
    { offset: 0, anchor: null, delivered: 0 },
    { offset: 0, anchor: selected, delivered: 10 },
  ]);

  const refresh = dialog.getByRole("button", { name: "Refresh results", exact: true });
  await refresh.press("Enter");
  await page.clock.runFor(20);
  await expect(refresh).toBeEnabled();
  await expect(mirror).toHaveAttribute("aria-pressed", "true");
  await pages.getByRole("button", { name: "Previous", exact: true }).press("Enter");
  await page.clock.runFor(20);
  await expect(pages).toContainText("1–10 of 25");
  await pages.getByRole("button", { name: "Next", exact: true }).press("Enter");
  await page.clock.runFor(20);
  await expect(pages).toContainText("11–20 of 25");
  await expect(mirror).toHaveAttribute("aria-pressed", "false");
  await expect(match).toContainText("smb://media.example.test/Studio/Archive%2011/Campaign mirror");
  expect(await reads.evaluate((state) => state.calls.slice(2))).toEqual([
    { offset: 10, anchor: selected, delivered: 10 },
    { offset: 0, anchor: null, delivered: 0 },
    { offset: 10, anchor: null, delivered: 10 },
  ]);
});

test("refreshing and reopening a comparison keep the same result page", async ({ page }) => {
  await inspectSource(page);
  const comparisonReads = await page.evaluateHandle((paths) => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: { request?: FolderSimilarityRequest }) => Promise<unknown> };
    };
    const offsets: number[] = [];
    const invoke = bridge.invoke.bind(bridge);
    bridge.invoke = async (command, args) => {
      if (command !== "find_similar_folders" || !args.request) return invoke(command, args);
      const offset = args.request.offset;
      offsets.push(offset);
      // Give the two real matches a page each, so both destinations still open in the Atlas.
      const result = await invoke(command, { request: { ...args.request, offset: 0 } }) as FolderSimilarityPage;
      const matches = result.matches.filter(({ folder }) => paths.includes(folder.path));
      return { ...result, offset, limit: 1, total_matches: matches.length, matches: matches.slice(offset, offset + 1) };
    };
    return offsets;
  }, [mirrorPath, backupPath]);

  await similarFoldersButton(page).press("Enter");
  const dialog = page.getByRole("dialog", { name: "Similar folders", exact: true });
  const match = dialog.getByRole("region", { name: "Matching folder", exact: true });
  const pages = dialog.getByRole("group", { name: "Result pages", exact: true });
  await expect(match).toContainText(mirrorPath);
  await pages.getByRole("button", { name: "Next", exact: true }).click();
  await expect(match).toContainText(backupPath);

  const refresh = dialog.getByRole("button", { name: "Refresh results", exact: true });
  await refresh.press("Enter");
  await expect.poll(() => comparisonReads.jsonValue()).toEqual([0, 1, 1]);
  await expect(refresh).toBeEnabled();
  await expect(match).toContainText(backupPath);
  await expect(pages.getByRole("button", { name: "Previous", exact: true })).toBeEnabled();

  await dialog.getByRole("button", { name: "Show in Atlas", exact: true }).press("Enter");
  await expect(dialog).toBeHidden();
  await expect(currentFolder(page)).toHaveText("Backup campaign");
  await folderDetails(page).getByRole("button", { name: "Back to comparison", exact: true }).press("Enter");
  await expect(match).toContainText(backupPath);
  await expect(pages.getByRole("button", { name: "Previous", exact: true })).toBeEnabled();
  await expect(pages.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
  expect(await comparisonReads.jsonValue()).toEqual([0, 1, 1]);
});

test("retrying a failed folder comparison refresh preserves focus and the selected match", async ({ page }) => {
  const dialog = await openComparison(page);
  const backup = dialog.getByRole("button", { name: /Studio archive.*Backup campaign/ });
  const refresh = dialog.getByRole("button", { name: "Refresh results", exact: true });
  await backup.press("Enter");
  await expect(backup).toHaveAttribute("aria-pressed", "true");

  const reads = await page.evaluateHandle(() => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
    };
    const invoke = bridge.invoke.bind(bridge);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = { count: 0, pending: false, release };
    bridge.invoke = async (command, args) => {
      if (command !== "find_similar_folders") return invoke(command, args);
      if (++read.count === 1) throw new Error("Couldn’t refresh matching folders.");
      const result = await invoke(command, args);
      read.pending = true;
      await gate;
      return result;
    };
    return read;
  });

  try {
    await refresh.press("Enter");
    const error = dialog.getByRole("alert").filter({ hasText: "Couldn’t refresh matching folders." });
    await error.getByRole("button", { name: "Retry", exact: true }).press("Enter");
    await expect.poll(() => reads.evaluate((read) => read.pending)).toBe(true);
    await expect(dialog.getByText("Refreshing similar folders…", { exact: true })).toBeVisible();
    await expect(refresh).toBeFocused();
    await expect(refresh).toBeDisabled();
    await expect(backup).toHaveAttribute("aria-pressed", "true");
  } finally {
    await reads.evaluate((read) => read.release());
  }

  await expect(refresh).toBeEnabled();
  await expect(refresh).toBeFocused();
  await expect(backup).toHaveAttribute("aria-pressed", "true");
});

test("a failed Similar folders page keeps Retry within reach of the focused paginator", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 380 });
  await inspectSource(page);
  const reads = await page.evaluateHandle((paths) => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: { request?: FolderSimilarityRequest }) => Promise<unknown> };
    };
    const invoke = bridge.invoke.bind(bridge);
    const offsets: number[] = [];
    let failed = false;
    bridge.invoke = async (command, args) => {
      if (command !== "find_similar_folders" || !args.request) return invoke(command, args);
      const offset = args.request.offset;
      offsets.push(offset);
      const result = await invoke(command, { request: { ...args.request, offset: 0 } }) as FolderSimilarityPage;
      if (offset === 1 && !failed) {
        failed = true;
        throw new Error("Could not read the next folder page.");
      }
      // Paginate the real matches so the retried folder remains openable in Atlas.
      const matches = result.matches.filter(({ folder }) => paths.includes(folder.path));
      return { ...result, offset, limit: 1, total_matches: matches.length, matches: matches.slice(offset, offset + 1) };
    };
    return offsets;
  }, [mirrorPath, backupPath]);

  await similarFoldersButton(page).press("Enter");
  const dialog = page.getByRole("dialog", { name: "Similar folders", exact: true });
  const match = dialog.getByRole("region", { name: "Matching folder", exact: true });
  const pages = dialog.getByRole("group", { name: "Result pages", exact: true });
  const next = pages.getByRole("button", { name: "Next", exact: true });
  const previous = pages.getByRole("button", { name: "Previous", exact: true });
  const alert = pages.getByRole("alert").filter({ hasText: "Could not read the next folder page." });
  const retry = alert.getByRole("button", { name: "Retry", exact: true });
  await expect(match).toContainText(mirrorPath);
  await next.press("Enter");
  await expect(retry).toBeFocused();
  await expect(retry).toBeInViewport({ ratio: 0.99 });
  await expect(match).toContainText(mirrorPath);
  await page.keyboard.press("Enter");
  await expect(alert).toBeHidden();
  await expect(match).toContainText(backupPath);
  await expect(next).toBeDisabled();
  await expect(previous).toBeFocused();
  await expect(previous).toBeInViewport({ ratio: 0.99 });

  const show = dialog.getByRole("button", { name: "Show in Atlas", exact: true });
  await show.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(currentFolder(page)).toHaveText("Backup campaign");
  await folderDetails(page).getByRole("button", { name: "Back to comparison", exact: true }).press("Enter");
  await expect(match).toContainText(backupPath);
  await expect(pages).toContainText("2–2 of 2");
  await expect(show).toBeFocused();
  expect(await reads.jsonValue()).toEqual([0, 1, 1]);
});

test("a failed folder jump keeps the chosen comparison open for retry", async ({ page }) => {
  const dialog = await openComparison(page);
  await page.evaluate((message) => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: { nodeId?: string }) => Promise<unknown> };
    };
    const invoke = bridge.invoke.bind(bridge);
    let shouldFail = true;
    bridge.invoke = async (command, args) => {
      if (command === "get_storage_view_snapshot" && args.nodeId?.endsWith("/Campaign mirror") && shouldFail) {
        shouldFail = false;
        throw new Error(message);
      }
      return invoke(command, args);
    };
  }, openError);

  const show = dialog.getByRole("button", { name: "Show in Atlas", exact: true });
  await show.click();
  await expect(dialog.getByRole("alert")).toContainText(openError);
  await expect(dialog.getByRole("region", { name: "Matching folder", exact: true })).toContainText(mirrorPath);
  await expect(currentFolder(page)).toHaveText("Brand campaign");

  await show.click();
  await expect(dialog).toBeHidden();
  await expect(currentFolder(page)).toHaveText("Campaign mirror");
  await expect(folderDetails(page)).toContainText(mirrorPath);
});

for (const action of ["Escape", "Cancel opening"] as const) {
  const name = action === "Escape" ? "closing Similar folders cancels an in-flight navigation"
    : "cancelling a folder opening keeps the selected comparison";
  test(name, async ({ page }) => {
    const dialog = await openComparison(page);
    const request = await page.evaluateHandle(() => {
      const { __TAURI_INTERNALS__: bridge } = window as unknown as {
        __TAURI_INTERNALS__: { invoke: (command: string, args: { nodeId?: string }) => Promise<unknown> };
      };
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const read = { pending: false, replied: false, release };
      const invoke = bridge.invoke.bind(bridge);
      bridge.invoke = async (command, args) => {
        const response = await invoke(command, args);
        if (command === "get_storage_view_snapshot" && args.nodeId?.endsWith("/Campaign mirror")) {
          read.pending = true;
          await gate;
          read.replied = true;
        }
        return response;
      };
      return read;
    });

    const show = dialog.getByRole("button", { name: "Show in Atlas", exact: true });
    const match = dialog.getByRole("region", { name: "Matching folder", exact: true });
    try {
      await show.press("Enter");
      await expect.poll(() => request.evaluate((read) => read.pending)).toBe(true);
      if (action === "Escape") {
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
      } else {
        const cancel = dialog.getByRole("button", { name: action, exact: true });
        await expect(cancel).toBeInViewport();
        await cancel.press("Enter");
        await expect(show).toBeEnabled();
        await expect(show).toBeFocused();
        await expect(match.getByRole("heading")).toHaveText("Campaign mirror");
      }
    } finally {
      await request.evaluate((read) => read.release());
    }
    await expect.poll(() => request.evaluate((read) => read.replied)).toBe(true);
    await expect(currentFolder(page)).toHaveText("Brand campaign");
    await expect(folderDetails(page)).toContainText(sourcePath);
    if (action === "Cancel opening") {
      await expect(dialog).toBeVisible();
      await page.keyboard.press("Escape");
    }
    await expect(similarFoldersButton(page)).toBeFocused();
    await folderPath(page).getByRole("button", { name: "Previous location", exact: true }).click();
    await expect(currentFolder(page)).toHaveText("Projects");
  });
}
