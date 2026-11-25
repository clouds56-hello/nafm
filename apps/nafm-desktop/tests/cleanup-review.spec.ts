import { expect, test, type Locator, type Page } from "@playwright/test";
import type { CleanupPreview } from "../src/lib/types";

const fileName = "Trailer master.mov";
const sourcePath = "/demo/Studio Archive/Projects/Brand campaign/Trailer master.mov";
const backupPath = "/demo/Studio Archive/Projects/Backup campaign/Trailer master.mov";
const sharedPath = "smb://media.example.test/Studio/Campaign mirror/Trailer master.mov";

function folderPath(page: Page) {
  return page.getByRole("navigation", { name: "Folder path" });
}

function currentFolder(page: Page) {
  return folderPath(page).locator('[aria-current="location"]');
}

function inspector(page: Page) {
  return page.getByRole("complementary", { name: "Inspector" });
}

function review(page: Page) {
  return page.getByRole("dialog", { name: "Cleanup review", exact: true });
}

function inspectCopy(dialog: Locator, list: string, path: string) {
  return dialog.getByRole("list", { name: list, exact: true }).getByRole("listitem")
    .filter({ hasText: path }).getByRole("button", { name: `Inspect ${fileName} in Atlas`, exact: true });
}

async function stageCopy(page: Page, folder: string) {
  const map = page.getByRole("region", { name: "Circular storage map" });
  await map.getByRole("button", { name: new RegExp(`^${folder},`) }).press("Enter");
  await expect(currentFolder(page)).toHaveText(folder);
  await map.getByRole("button", { name: /^Trailer master\.mov,/ }).press("Enter");
  const details = inspector(page);
  await expect(details.getByRole("heading", { name: fileName, exact: true })).toBeVisible();
  await details.getByRole("button", { name: "Stage for review", exact: true }).click();
  await expect(details.getByRole("button", { name: "Remove from review", exact: true })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/mock/");
  await expect(currentFolder(page)).toHaveText("Studio archive");
  await page.getByRole("region", { name: "Circular storage map" })
    .getByRole("button", { name: /^Projects,/ }).press("Enter");
  await expect(currentFolder(page)).toHaveText("Projects");
});

test("Atlas Back restores the scrolled filtered Contents list after inspecting a staged copy", async ({ page }) => {
  await stageCopy(page, "Backup campaign");
  await folderPath(page).getByRole("button", { name: "Studio archive", exact: true }).press("Enter");
  await page.getByRole("region", { name: "Circular storage map" })
    .getByRole("button", { name: /^Photo Library,/ }).press("Enter");
  await expect(currentFolder(page)).toHaveText("Photo Library");

  await inspector(page).getByRole("tab", { name: "Contents", exact: true }).press("Enter");
  const contents = inspector(page).getByRole("tabpanel", { name: "Contents", exact: true });
  const grid = contents.getByRole("grid");
  const lastProof = grid.getByRole("button", { name: /^Proof 096\.jpg/ });
  await contents.getByRole("button", { name: "Search this folder", exact: true }).press("Enter");
  const filter = contents.getByRole("searchbox", { name: "Find in folder", exact: true })
    .or(contents.getByRole("textbox", { name: "Find in folder", exact: true }));
  const query = "  pRoOf  ";
  await filter.fill(query);
  await expect(grid).toHaveAttribute("aria-rowcount", "96");
  await contents.evaluate((pane) => { pane.scrollTop = pane.scrollHeight; });
  await expect(lastProof).toBeInViewport({ ratio: 0.99 });
  const scrollTop = await contents.evaluate((pane) => pane.scrollTop);
  expect(scrollTop).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Workspace actions", exact: true }).press("Enter");
  await page.getByRole("button", { name: /^Review\b/ }).press("Enter");
  const dialog = review(page);
  await inspectCopy(dialog, "Staged copies", backupPath).press("Enter");
  await expect(dialog).toBeHidden();
  await expect(currentFolder(page)).toHaveText("Backup campaign");
  await expect(inspector(page)).toContainText(backupPath);

  const back = folderPath(page).getByRole("button", { name: "Previous location", exact: true });
  await back.press("Enter");
  await expect(currentFolder(page)).toHaveText("Photo Library");
  await expect(filter).toHaveValue(query);
  await expect(lastProof).toBeInViewport({ ratio: 0.99 });
  await expect.poll(() => contents.evaluate((pane) => pane.scrollTop)).toBeCloseTo(scrollTop, 0);
  await expect(back).toBeFocused();

  await folderPath(page).getByRole("button", { name: "Next location", exact: true }).press("Enter");
  await expect(currentFolder(page)).toHaveText("Backup campaign");
  await expect(inspector(page)).toContainText(backupPath);
  await expect(inspector(page).getByRole("button", { name: "Back to review", exact: true })).toBeVisible();
});

test("cleanup review can undo and redo a removal before running a fresh preview", async ({ page }) => {
  await stageCopy(page, "Backup campaign");
  await folderPath(page).getByRole("button", { name: "Projects", exact: true }).click();
  await expect(currentFolder(page)).toHaveText("Projects");
  await stageCopy(page, "Brand campaign");

  const dialog = review(page);
  const openReview = inspector(page).getByRole("button", { name: "Open review", exact: true });
  await openReview.click();
  await expect(dialog).toBeVisible();
  const preview = dialog.getByRole("region", { name: "Cleanup preview", exact: true });
  const previewButton = dialog.getByRole("button", { name: "Preview cleanup", exact: true });
  const undo = dialog.getByRole("button", { name: "Undo staging change", exact: true });
  const redo = dialog.getByRole("button", { name: "Redo staging change", exact: true });
  await expect(undo).toBeEnabled();
  await expect(redo).toBeDisabled();

  const calls = await page.evaluateHandle(() => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: { request?: { direction: string } }) => Promise<unknown> };
    };
    const watched = new Set(["preview_cleanup", "stage_path", "unstage_path", "move_stage_history"]);
    const requests: string[] = [];
    const invoke = bridge.invoke.bind(bridge);
    bridge.invoke = (command, args) => {
      if (watched.has(command)) {
        requests.push(command === "move_stage_history" ? `${command} ${args.request?.direction}` : command);
      }
      return invoke(command, args);
    };
    return requests;
  });
  await previewButton.click();

  await expect(preview).toBeFocused();
  await expect(preview.getByRole("heading", { name: "Preview passed", exact: true })).toBeVisible();
  await expect(preview).toContainText("Estimated space reclaimed");
  await expect(preview).toContainText("184 GB");
  const staged = dialog.getByRole("list", { name: "Staged for cleanup", exact: true });
  const retained = dialog.getByRole("list", { name: "Would remain", exact: true });
  await expect(staged).toContainText(sourcePath);
  await expect(staged).toContainText(backupPath);
  await expect(retained.getByRole("listitem")).toHaveCount(1);
  await expect(retained).toContainText("Team share");
  await expect(retained).toContainText(sharedPath);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(openReview).toBeFocused();
  await openReview.press("Enter");
  await expect(retained).toContainText(sharedPath);

  await staged.getByRole("listitem").filter({ hasText: sourcePath })
    .getByRole("button", { name: `Remove ${fileName} from review`, exact: true }).press("Enter");
  await expect(preview).toBeHidden();
  await expect(dialog.getByText(sourcePath, { exact: true })).toHaveCount(0);
  await expect(dialog.getByText(backupPath, { exact: true })).toBeVisible();
  await expect(undo).toBeFocused();
  await expect(undo).toBeEnabled();
  await expect(redo).toBeDisabled();
  expect(await calls.jsonValue()).toEqual(["preview_cleanup", "unstage_path"]);

  await page.keyboard.press("Enter");
  const stagedCopies = dialog.getByRole("list", { name: "Staged copies", exact: true });
  await expect(stagedCopies).toContainText(sourcePath);
  await expect(stagedCopies).toContainText(backupPath);
  await expect(redo).toBeEnabled();
  await expect(preview).toBeHidden();
  await expect(currentFolder(page)).toHaveText("Brand campaign");
  expect(await calls.jsonValue()).toEqual(["preview_cleanup", "unstage_path", "move_stage_history undo"]);

  await previewButton.click();
  await expect(preview).toContainText("184 GB");
  await expect(retained.getByRole("listitem")).toHaveCount(1);
  await expect(retained).toContainText(sharedPath);

  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(redo).toBeFocused();
  await expect(redo).toBeDisabled();
  await expect(preview).toBeHidden();
  await expect(stagedCopies).toContainText(backupPath);
  await expect(dialog.getByText(sourcePath, { exact: true })).toHaveCount(0);
  await expect(currentFolder(page)).toHaveText("Brand campaign");
  expect(await calls.jsonValue()).toEqual([
    "preview_cleanup", "unstage_path", "move_stage_history undo", "preview_cleanup", "move_stage_history redo",
  ]);

  await previewButton.click();
  await expect(preview).toContainText("92 GB");
  await expect(retained.getByRole("listitem")).toHaveCount(2);
  await expect(retained).toContainText(sourcePath);
  await expect(retained).toContainText(sharedPath);
});

test("cleanup review refreshes staging when a newer change invalidates an undo", async ({ page }) => {
  await stageCopy(page, "Backup campaign");
  await folderPath(page).getByRole("button", { name: "Projects", exact: true }).click();
  await expect(currentFolder(page)).toHaveText("Projects");
  await stageCopy(page, "Brand campaign");

  const dialog = review(page);
  await inspector(page).getByRole("button", { name: "Open review", exact: true }).click();
  const undo = dialog.getByRole("button", { name: "Undo staging change", exact: true });
  const redo = dialog.getByRole("button", { name: "Redo staging change", exact: true });
  const previewButton = dialog.getByRole("button", { name: "Preview cleanup", exact: true });
  const preview = dialog.getByRole("region", { name: "Cleanup preview", exact: true });
  await expect(undo).toBeEnabled();
  await previewButton.click();
  await expect(preview).toContainText("184 GB");

  await page.evaluate((path) => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
    };
    const invoke = bridge.invoke.bind(bridge);
    let pendingExternalChange = true;
    bridge.invoke = async (command, args) => {
      if (command === "move_stage_history" && pendingExternalChange) {
        pendingExternalChange = false;
        await invoke("unstage_path", { path, expectedWorkspace: args.expectedWorkspace });
      }
      return invoke(command, args);
    };
  }, backupPath);

  await undo.press("Enter");
  await expect(dialog.getByRole("alert")).toContainText(/(?:stag|history).*chang/i);
  await expect(preview).toBeHidden();
  const staged = dialog.getByRole("list", { name: "Staged copies", exact: true });
  await expect(staged.getByRole("listitem")).toHaveCount(1);
  await expect(staged).toContainText(sourcePath);
  await expect(staged).not.toContainText(backupPath);
  await expect(undo).toBeFocused();
  await expect(undo).toBeEnabled();
  await expect(redo).toBeDisabled();
  await expect(currentFolder(page)).toHaveText("Brand campaign");

  await page.keyboard.press("Enter");
  await expect(staged).toContainText(sourcePath);
  await expect(staged).toContainText(backupPath);
  await expect(redo).toBeEnabled();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(preview).toBeHidden();
});

test("pending hashes block a previously eligible cleanup preview", async ({ page }) => {
  await stageCopy(page, "Brand campaign");
  await page.getByRole("button", { name: "Workspace actions", exact: true }).click();
  await page.getByRole("button", { name: /^Review\b/ }).click();
  const dialog = review(page);
  await expect(dialog).toBeVisible();

  await page.evaluate((path) => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
    };
    const invoke = bridge.invoke.bind(bridge);
    bridge.invoke = async (command, args) => {
      const result = await invoke(command, args);
      if (command !== "preview_cleanup") return result;
      const report = result as CleanupPreview;
      const staged = report.staged_files.find((file) => file.path === path);
      if (!staged) throw new Error("The selected file is missing from the mock preview.");
      return {
        ...report,
        cleanup_ready: false,
        hashes_pending: 1,
        warnings: [{ path, reason: "not_duplicate" }],
        verification_blockers: [{ site_id: staged.site_id, staged_file_ids: [staged.file_id] }],
        tracked_file_count_after: report.tracked_file_count_before,
        duplicate_group_count_after: report.duplicate_group_count_before,
        duplicate_file_count_after: report.duplicate_file_count_before,
        review_groups: [],
      };
    };
  }, sourcePath);

  await dialog.getByRole("button", { name: "Preview cleanup", exact: true }).click();
  const preview = dialog.getByRole("region", { name: "Cleanup preview", exact: true });
  await expect(preview.getByRole("heading", { name: "Preview blocked", exact: true })).toBeVisible();
  await expect(dialog).toContainText("1 staged hash is pending");
  const recovery = dialog.getByRole("region", { name: "Verification needed", exact: true });
  await expect(recovery.getByText("Studio archive", { exact: true })).toBeVisible();
  await expect(recovery.getByRole("button", { name: /Studio archive/ })).toBeEnabled();
  await expect(dialog).toContainText(sourcePath);
  await expect(dialog.getByText("Estimated space reclaimed", { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("list", { name: "Would remain", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Preview cleanup", exact: true })).toBeDisabled();
});

test("cleanup review verifies the potential retained copy in place before a fresh dry run", async ({ page }) => {
  await stageCopy(page, "Backup campaign");
  await folderPath(page).getByRole("button", { name: "Projects", exact: true }).click();
  await expect(currentFolder(page)).toHaveText("Projects");
  await stageCopy(page, "Brand campaign");

  await page.clock.install({ time: new Date("2025-11-04T12:00:00Z") });
  await page.clock.pauseAt(new Date("2025-11-04T12:10:00Z"));
  await page.getByRole("button", { name: "Sites", exact: true }).click();
  const sites = page.getByRole("complementary", { name: "Sites", exact: true });
  const scanTeam = sites.getByRole("button", { name: "Scan Team share", exact: true });
  const stopTeam = sites.getByRole("button", { name: "Stop scan of Team share", exact: true });
  await scanTeam.press("Enter");
  await expect(stopTeam).toBeEnabled();
  await page.clock.runFor(2_800);
  await expect(sites.getByText("Verifying files", { exact: true })).toBeVisible();
  await stopTeam.press("Enter");
  await page.clock.runFor(550);
  await expect(scanTeam).toBeEnabled();
  await sites.getByRole("button", { name: "Close sites", exact: true }).click();

  const openReview = inspector(page).getByRole("button", { name: "Open review", exact: true });
  await openReview.press("Enter");
  const dialog = review(page);
  const previewButton = dialog.getByRole("button", { name: "Preview cleanup", exact: true });
  await expect(previewButton).toBeDisabled();
  await expect(dialog.getByText("Would remove the last copy", { exact: true })).toBeVisible();
  const recovery = dialog.getByRole("region", { name: "Verification needed", exact: true });
  await expect(recovery.getByText("Team share", { exact: true })).toBeVisible();
  await expect(recovery.getByRole("button")).toHaveCount(1);
  const resume = recovery.getByRole("button", { name: "Resume verification for Team share", exact: true });
  await expect(resume).toBeEnabled();
  const originalDialog = await dialog.elementHandle();

  const failure = "Team share is temporarily unavailable.";
  const calls = await page.evaluateHandle((message) => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: { selector?: { site_id?: string } }) => Promise<unknown> };
    };
    const requests: string[] = [];
    const invoke = bridge.invoke.bind(bridge);
    let failFirstStart = true;
    bridge.invoke = async (command, args) => {
      if (command === "start_scan") {
        requests.push(`${command} ${args.selector?.site_id}`);
        if (failFirstStart) {
          failFirstStart = false;
          throw new Error(message);
        }
      } else if (["preview_cleanup", "stage_path", "unstage_path"].includes(command)) {
        requests.push(command);
      }
      return invoke(command, args);
    };
    return requests;
  }, failure);

  await resume.press("Enter");
  await expect(dialog.getByRole("alert")).toHaveText(failure);
  await expect(resume).toBeFocused();
  await expect(resume).toBeEnabled();
  await resume.press("Enter");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(recovery.getByRole("button")).toBeDisabled();
  await expect(recovery.getByRole("button")).toBeFocused();
  await page.clock.runFor(2_800);
  await expect(recovery.getByText(/Verifying files/)).toBeVisible();
  await expect(previewButton).toBeDisabled();
  await expect(currentFolder(page)).toHaveText("Brand campaign");

  await page.clock.runFor(3_000);
  await expect(previewButton).toBeEnabled();
  await expect(previewButton).toBeFocused();
  await expect(recovery).toHaveCount(0);
  expect(await dialog.evaluate((element, original) => element === original, originalDialog)).toBe(true);
  expect(await calls.jsonValue()).toEqual(["start_scan team-share", "start_scan team-share"]);
  await expect(dialog.getByRole("region", { name: "Cleanup preview", exact: true })).toHaveCount(0);

  await previewButton.press("Enter");
  await expect(dialog.getByRole("heading", { name: "Preview passed", exact: true })).toBeVisible();
  const staged = dialog.getByRole("list", { name: "Staged for cleanup", exact: true });
  await expect(staged).toContainText(sourcePath);
  await expect(staged).toContainText(backupPath);
  const retained = dialog.getByRole("list", { name: "Would remain", exact: true });
  await expect(retained.getByRole("listitem")).toHaveCount(1);
  await expect(retained).toContainText(sharedPath);
  await expect(currentFolder(page)).toHaveText("Brand campaign");
  expect(await calls.jsonValue()).toEqual(["start_scan team-share", "start_scan team-share", "preview_cleanup"]);
});

test.describe("compact cleanup review inspection", () => {
  test.use({ viewport: { width: 390, height: 580 }, hasTouch: true });

  test("inspecting retained and staged copies returns to the same preview and row", async ({ page }) => {
    await stageCopy(page, "Backup campaign");
    await folderPath(page).getByRole("button", { name: "Previous location", exact: true }).press("Enter");
    await expect(currentFolder(page)).toHaveText("Projects");
    await stageCopy(page, "Brand campaign");

    const requests = await page.evaluateHandle(() => {
      const { __TAURI_INTERNALS__: bridge } = window as unknown as {
        __TAURI_INTERNALS__: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
      };
      const watched = new Set(["preview_cleanup", "get_storage_file_reveal", "stage_path", "unstage_path"]);
      const calls: string[] = [];
      const invoke = bridge.invoke.bind(bridge);
      bridge.invoke = (command, args) => {
        if (watched.has(command)) calls.push(command);
        return invoke(command, args);
      };
      return calls;
    });

    const dialog = review(page);
    await inspector(page).getByRole("button", { name: "Open review", exact: true }).tap();
    await dialog.getByRole("button", { name: "Preview cleanup", exact: true }).tap();
    const preview = dialog.getByRole("region", { name: "Cleanup preview", exact: true });
    await expect(preview).toContainText("184 GB");

    const retained = inspectCopy(dialog, "Would remain", sharedPath);
    const body = dialog.locator(".atlas-analysis-body");
    await retained.scrollIntoViewIfNeeded();
    const scrollTop = await body.evaluate((element) => element.scrollTop);
    expect(scrollTop).toBeGreaterThan(0);
    await retained.tap();
    await expect(dialog).toBeHidden();
    await expect(currentFolder(page)).toHaveText("Campaign mirror");
    const details = inspector(page).getByRole("region", { name: "Storage details", exact: true });
    await expect(details.getByText(sharedPath, { exact: true })).toBeVisible();

    const backToReview = details.getByRole("button", { name: "Back to review", exact: true });
    await backToReview.tap();
    await expect(dialog).toBeVisible();
    await expect(preview).toContainText("184 GB");
    await expect(retained).toBeFocused();
    await expect(retained).toBeInViewport();
    await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeCloseTo(scrollTop, 0);

    const staged = inspectCopy(dialog, "Staged for cleanup", backupPath);
    await staged.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(currentFolder(page)).toHaveText("Backup campaign");
    await expect(details.getByText(backupPath, { exact: true })).toBeVisible();
    await backToReview.press("Enter");
    await expect(staged).toBeFocused();
    await expect(preview.getByRole("heading", { name: "Preview passed", exact: true })).toBeVisible();
    expect(await requests.jsonValue()).toEqual(["preview_cleanup", "get_storage_file_reveal", "get_storage_file_reveal"]);
  });
});

test("closing cleanup review cancels a pending inspection and allows reopening", async ({ page }) => {
  await stageCopy(page, "Brand campaign");
  const dialog = review(page);
  const openReview = inspector(page).getByRole("button", { name: "Open review", exact: true });
  await openReview.click();
  await dialog.getByRole("button", { name: "Preview cleanup", exact: true }).click();
  const retained = inspectCopy(dialog, "Would remain", sharedPath);

  const request = await page.evaluateHandle(() => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = { pending: false, replied: false, release };
    const invoke = bridge.invoke.bind(bridge);
    bridge.invoke = async (command, args) => {
      const response = await invoke(command, args);
      if (command === "get_storage_file_reveal" && !read.pending) {
        read.pending = true;
        await gate;
        read.replied = true;
      }
      return response;
    };
    return read;
  });

  await retained.click();
  await expect.poll(() => request.evaluate((read) => read.pending)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await request.evaluate((read) => read.release());
  await expect.poll(() => request.evaluate((read) => read.replied)).toBe(true);
  await expect(currentFolder(page)).toHaveText("Brand campaign");
  await expect(inspector(page).getByText(sourcePath, { exact: true })).toBeVisible();
  await expect(openReview).toBeFocused();

  await openReview.press("Enter");
  await retained.click();
  await expect(dialog).toBeHidden();
  await expect(currentFolder(page)).toHaveText("Campaign mirror");
  await expect(inspector(page).getByText(sharedPath, { exact: true })).toBeVisible();
});
