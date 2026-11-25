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
  await expect(back).toBeHidden();
  await expect(folderDetails(page)).toBeFocused();
  expect(await comparisonReads.jsonValue()).toEqual([]);
});

test("refresh keeps the chosen folder while it remains a match", async ({ page }) => {
  const dialog = await openComparison(page);
  const match = dialog.getByRole("region", { name: "Matching folder", exact: true });
  const backup = dialog.getByRole("button", { name: /Studio archive.*Backup campaign/ });
  const mirror = dialog.getByRole("button", { name: /Team share.*Campaign mirror/ });
  const refresh = dialog.getByRole("button", { name: "Refresh results", exact: true });
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
  await expect(mirror).toHaveAttribute("aria-pressed", "true");
  await expect(match).toContainText(mirrorPath);
  await expect(dialog.getByRole("status").filter({ hasText: /^The comparison results changed\.$/ })).toBeVisible();
  await expect(refresh).toBeFocused();
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

test("closing Similar folders cancels an in-flight navigation", async ({ page }) => {
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

  await dialog.getByRole("button", { name: "Show in Atlas", exact: true }).click();
  try {
    await expect.poll(() => request.evaluate((read) => read.pending)).toBe(true);
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  } finally {
    await request.evaluate((read) => read.release());
  }
  await expect.poll(() => request.evaluate((read) => read.replied)).toBe(true);
  await expect(currentFolder(page)).toHaveText("Brand campaign");
  await expect(folderDetails(page)).toContainText(sourcePath);
  await expect(similarFoldersButton(page)).toBeFocused();
  await folderPath(page).getByRole("button", { name: "Previous location", exact: true }).click();
  await expect(currentFolder(page)).toHaveText("Projects");
});
