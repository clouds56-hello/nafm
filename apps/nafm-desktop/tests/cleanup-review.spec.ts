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

test("cleanup review shows the one remaining copy and refreshes after a removal", async ({ page }) => {
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
    .getByRole("button", { name: `Remove ${fileName} from review`, exact: true }).click();
  await expect(preview).toBeHidden();
  await expect(dialog.getByText(sourcePath, { exact: true })).toHaveCount(0);
  await expect(dialog.getByText(backupPath, { exact: true })).toBeVisible();
  await previewButton.click();
  await expect(preview).toContainText("92 GB");
  await expect(retained.getByRole("listitem")).toHaveCount(2);
  await expect(retained).toContainText(sourcePath);
  await expect(retained).toContainText(sharedPath);
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
      return {
        ...report,
        cleanup_ready: false,
        hashes_pending: 1,
        warnings: [{ path, reason: "not_duplicate" }],
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
  await expect(dialog).toContainText(sourcePath);
  await expect(dialog.getByText("Estimated space reclaimed", { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("list", { name: "Would remain", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Preview cleanup", exact: true })).toBeDisabled();
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
