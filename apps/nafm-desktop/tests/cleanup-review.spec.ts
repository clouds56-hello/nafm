import { expect, test, type Locator, type Page } from "@playwright/test";
import type { CleanupPreview, CleanupProgress, CleanupProgressEvent, CleanupReport } from "../src/lib/types";

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
  await expect(preview.getByRole("heading", { name: "Move to Trash unavailable", exact: true })).toBeVisible();
  await expect(preview).toContainText("Staged file size");
  await expect(preview).toContainText("184 GB");
  const staged = dialog.getByRole("list", { name: "Staged for cleanup", exact: true });
  const retained = dialog.getByRole("list", { name: "Would remain", exact: true });
  await expect(staged).toContainText(sourcePath);
  await expect(staged).toContainText(backupPath);
  await expect(retained.getByRole("listitem")).toHaveCount(1);
  await expect(retained).toContainText("Team share");
  await expect(retained).toContainText(sharedPath);
  await expect(staged.getByText("Keep at least one verified local copy.")).toHaveCount(2);
  await expect(dialog.getByRole("button", { name: "Move to Trash…", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(openReview).toBeFocused();
  await openReview.press("Enter");
  await expect(retained).toContainText(sharedPath);

  await staged.getByRole("listitem").filter({ hasText: sourcePath })
    .getByRole("button", { name: `Remove ${fileName} from review`, exact: true }).press("Enter");
  await expect(preview).toBeHidden();
  await expect(previewButton).toHaveAccessibleDescription("Staging was updated. Run a new preview to check this selection.");
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

test("a delayed cleanup preview keeps focus on the control reached while waiting", async ({ page }) => {
  await stageCopy(page, "Brand campaign");
  await inspector(page).getByRole("button", { name: "Open review", exact: true }).press("Enter");
  const dialog = review(page);
  const pending = await page.evaluateHandle(() => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: unknown) => Promise<unknown> };
    };
    const invoke = bridge.invoke.bind(bridge);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const state = { received: false, release };
    bridge.invoke = async (command, args) => {
      const result = await invoke(command, args);
      if (command === "preview_cleanup") {
        state.received = true;
        await gate;
      }
      return result;
    };
    return state;
  });

  try {
    await dialog.getByRole("button", { name: "Preview cleanup", exact: true }).press("Enter");
    await expect.poll(() => pending.evaluate((state) => state.received)).toBe(true);
    await expect(dialog.getByRole("button", { name: "Checking…", exact: true })).toBeFocused();
    const close = dialog.getByRole("button", { name: "Close cleanup review", exact: true });
    await close.focus();
    await expect(close).toBeFocused();
    await pending.evaluate((state) => state.release());
    const preview = dialog.getByRole("region", { name: "Cleanup preview", exact: true });
    await expect(preview).toContainText("92 GB");
    await expect(close).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
  } finally {
    await pending.evaluate((state) => state.release());
  }
});

for (const action of ["Inspect", "Remove"] as const) {
  test(`a fresh cleanup preview keeps the staged ${action} action focused after regrouping`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 580 });
    await stageCopy(page, "Backup campaign");
    await folderPath(page).getByRole("button", { name: "Previous location", exact: true }).press("Enter");
    await expect(currentFolder(page)).toHaveText("Projects");
    await stageCopy(page, "Brand campaign");

    await page.clock.install({ time: new Date("2025-11-04T12:00:00Z") });
    await page.clock.pauseAt(new Date("2025-11-04T12:10:00Z"));
    await page.getByRole("button", { name: "Sites", exact: true }).press("Enter");
    const sites = page.getByRole("complementary", { name: "Sites", exact: true });
    await sites.getByRole("button", { name: "Scan Field drive", exact: true }).press("Enter");
    await expect(sites.getByRole("button", { name: "Stop scan of Field drive", exact: true })).toBeEnabled();
    await sites.getByRole("button", { name: "Close sites", exact: true }).press("Enter");
    await inspector(page).getByRole("button", { name: "Open review", exact: true }).press("Enter");

    const dialog = review(page);
    const preview = dialog.getByRole("region", { name: "Cleanup preview", exact: true });
    const previewButton = dialog.getByRole("button", { name: "Preview cleanup", exact: true });
    await previewButton.press("Enter");
    await expect(preview).toContainText("184 GB");
    await page.clock.runFor(5_700);
    await expect(preview).toHaveCount(0);
    await expect(dialog.getByText("Workspace inventory was refreshed. Run a new preview.", { exact: true })).toBeVisible();

    const reply = await page.evaluateHandle(() => {
      const { __TAURI_INTERNALS__: bridge } = window as unknown as {
        __TAURI_INTERNALS__: { invoke: (command: string, args: unknown) => Promise<unknown> };
      };
      const invoke = bridge.invoke.bind(bridge);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const state = { pending: false, release };
      bridge.invoke = async (command, args) => {
        const response = await invoke(command, args);
        if (command === "preview_cleanup") {
          state.pending = true;
          await gate;
        }
        return response;
      };
      return state;
    });
    const label = action === "Inspect" ? `Inspect ${fileName} in Atlas` : `Remove ${fileName} from review`;
    const identity = action === "Inspect" ? "data-review-inspect" : "data-review-remove";
    function actionIn(list: string) {
      return dialog.getByRole("list", { name: list, exact: true }).getByRole("listitem").filter({ hasText: sourcePath })
        .getByRole("button", { name: label, exact: true });
    }

    try {
      await previewButton.press("Enter");
      await expect.poll(() => reply.evaluate((state) => state.pending)).toBe(true);
      const staged = actionIn("Staged copies");
      const fileId = (await staged.getAttribute(identity))!;
      await staged.focus();
      await expect(staged).toBeFocused();
      await reply.evaluate((state) => state.release());

      await expect(preview).toContainText("184 GB");
      await expect(staged).toHaveCount(0);
      const regrouped = actionIn("Staged for cleanup");
      await expect(regrouped).toHaveAttribute(identity, fileId);
      await expect(regrouped).toBeFocused();
      await expect(regrouped).toBeInViewport({ ratio: 0.99 });
      await expect(regrouped).toBeEnabled();
    } finally {
      await reply.evaluate((state) => state.release());
    }
  });
}

test("an inventory refresh interrupts an in-progress cleanup check and allows a new preview", async ({ page }) => {
  await stageCopy(page, "Backup campaign");
  await page.clock.install({ time: new Date("2025-11-04T12:00:00Z") });
  await page.clock.pauseAt(new Date("2025-11-04T12:10:00Z"));
  await page.getByRole("button", { name: "Sites", exact: true }).press("Enter");
  const sites = page.getByRole("complementary", { name: "Sites", exact: true });
  await sites.getByRole("button", { name: "Scan Field drive", exact: true }).press("Enter");
  await expect(sites.getByRole("button", { name: "Stop scan of Field drive", exact: true })).toBeEnabled();
  await inspector(page).getByRole("button", { name: "Open review", exact: true }).press("Enter");
  const dialog = review(page);
  const preview = dialog.getByRole("region", { name: "Cleanup preview", exact: true });
  const check = dialog.getByRole("button", { name: "Preview cleanup", exact: true });

  const pending = await page.evaluateHandle(() => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
    };
    const invoke = bridge.invoke.bind(bridge);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = { count: 0, held: false, returned: false, release };
    bridge.invoke = async (command, args) => {
      if (command !== "preview_cleanup" || ++read.count !== 1) return invoke(command, args);
      const report = await invoke(command, args);
      read.held = true;
      await gate;
      requestAnimationFrame(() => { read.returned = true; });
      return report;
    };
    return read;
  });

  try {
    await check.press("Enter");
    await expect.poll(() => pending.evaluate((read) => read.held)).toBe(true);
    await expect(dialog.getByRole("button", { name: "Checking…", exact: true })).toBeFocused();
    await page.clock.runFor(3_100);
    await expect(check).toBeEnabled();
    await expect(check).toHaveAccessibleDescription("Workspace inventory was refreshed. Run a new preview.");
    await expect(check).toBeFocused();

    await pending.evaluate((read) => read.release());
    await page.clock.runFor(50);
    await expect.poll(() => pending.evaluate((read) => read.returned)).toBe(true);
    await expect(preview).toBeHidden();
    await expect(check).toHaveAccessibleDescription("Workspace inventory was refreshed. Run a new preview.");

    await check.press("Enter");
    await expect(preview.getByRole("heading", { name: "Preview passed", exact: true })).toBeVisible();
    await expect(dialog.getByText("Workspace inventory was refreshed. Run a new preview.", { exact: true })).toHaveCount(0);
    expect(await pending.evaluate((read) => read.count)).toBe(2);
  } finally {
    await pending.evaluate((read) => read.release());
  }
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
  await expect(preview.getByText("Staged file size", { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Move to Trash…", exact: true })).toHaveCount(0);
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
  await expect(sites.getByRole("button", { name: "Resume verification of Team share", exact: true })).toBeEnabled();
  await sites.getByRole("button", { name: "Close sites", exact: true }).click();

  const openReview = inspector(page).getByRole("button", { name: "Open review", exact: true });
  await openReview.press("Enter");
  const dialog = review(page);
  const previewButton = dialog.getByRole("button", { name: "Preview cleanup", exact: true });
  await expect(previewButton).toBeDisabled();
  const blockedCopies = dialog.getByRole("list", { name: "Staged copies", exact: true });
  await expect(blockedCopies.getByRole("listitem")).toHaveCount(2);
  for (const path of [sourcePath, backupPath]) {
    const row = blockedCopies.getByRole("listitem").filter({ hasText: path });
    await expect(row.getByText("Retained copy needs verification", { exact: true })).toBeVisible();
  }
  await expect(blockedCopies.getByText("Would remove the last copy", { exact: true })).toHaveCount(0);
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
  await expect(dialog.getByRole("heading", { name: "Move to Trash unavailable", exact: true })).toBeVisible();
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

  test("moving to Trash requires confirmation, reports progress, and shows the result", async ({ page }) => {
    await stageCopy(page, "Backup campaign");
    const request = await page.evaluateHandle(() => {
      type MoveRequest = { expectedWorkspace: string; planId: string };
      const { __TAURI_INTERNALS__: bridge } = window as unknown as {
        __TAURI_INTERNALS__: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
      };
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => { release = resolve; });
      const calls: MoveRequest[] = [];
      const emitted: CleanupProgressEvent[] = [];
      const invoke = bridge.invoke.bind(bridge);
      bridge.invoke = async (command, args) => {
        if (command === "move_cleanup_to_trash") {
          calls.push({ expectedWorkspace: String(args.expectedWorkspace), planId: String(args.planId) });
          await waiting;
        }
        if (command === "plugin:event|emit" && args.event === "task://cleanup/progress") {
          emitted.push(args.payload as CleanupProgressEvent);
        }
        return invoke(command, args);
      };
      return {
        calls,
        emitted,
        release,
        emitProgress(progress: CleanupProgress, target?: Partial<MoveRequest>) {
          const { expectedWorkspace, planId } = { ...calls[0], ...target };
          return invoke("plugin:event|emit", {
            event: "task://cleanup/progress", payload: { workspace_name: expectedWorkspace, plan_id: planId, progress },
          });
        },
      };
    });

    await inspector(page).getByRole("button", { name: "Open review", exact: true }).tap();
    const dialog = review(page);
    const action = dialog.getByRole("button", { name: "Move to Trash…", exact: true });
    await expect(action).toHaveCount(0);
    await dialog.getByRole("button", { name: "Preview cleanup", exact: true }).tap();
    const preview = dialog.getByRole("region", { name: "Cleanup preview", exact: true });
    await expect(preview).toContainText("Preview passed");
    await expect(dialog.getByRole("list", { name: "Would remain", exact: true })).toContainText(sourcePath);
    await expect(action).toBeEnabled();

    await action.press("Enter");
    const confirmation = dialog.getByRole("region", { name: "Move 1 copy to Trash?", exact: true });
    const cancel = confirmation.getByRole("button", { name: "Cancel", exact: true });
    await expect(cancel).toBeFocused();
    await expect(cancel).toBeInViewport();
    await expect(confirmation).toContainText("92 GB");
    await expect(confirmation).toContainText("The retained copies will stay in place.");
    await expect(inspectCopy(dialog, "Would remain", sourcePath)).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(confirmation).toBeHidden();
    await expect(action).toBeFocused();
    expect(await request.evaluate(({ calls }) => calls)).toEqual([]);
    await expect(preview).toContainText("Preview passed");

    await action.tap();
    const confirm = confirmation.getByRole("button", { name: "Move to Trash", exact: true });
    await confirm.tap();
    const moving = confirmation.getByRole("button", { name: "Moving to Trash…", exact: true });
    await expect(moving).toBeDisabled();
    await expect(moving).toBeFocused();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    expect(await request.evaluate(({ calls }) => calls)).toEqual([{
      expectedWorkspace: "Studio workspace", planId: expect.any(String),
    }]);

    await expect(confirmation.getByText("Checking file contents", { exact: true })).toBeVisible();
    await request.evaluate(({ emitProgress }, progress) => emitProgress(progress), {
      phase: "verifying", processed_files: 1, total_files: 2, current_file: backupPath,
      bytes_checked: 46 * 1024 ** 3, file_size_bytes: 92 * 1024 ** 3,
    });
    await expect(confirmation.getByText("1 of 2 copies checked", { exact: true })).toBeVisible();
    await expect(confirmation.getByText(fileName, { exact: true })).toBeVisible();
    const verifying = confirmation.getByRole("progressbar", { name: "Current file verification" });
    await expect(verifying).toHaveAttribute("aria-valuetext", "46 GB of 92 GB");
    const movingProgress = {
      phase: "moving", processed_files: 0, total_files: 1, current_file: backupPath, bytes_checked: null, file_size_bytes: null,
    } satisfies CleanupProgress;
    await request.evaluate(async ({ emitProgress }, progress) => {
      await emitProgress(progress, { planId: "different-plan" });
      await emitProgress(progress, { expectedWorkspace: "Other workspace" });
    }, movingProgress);
    await expect(verifying).toBeVisible();
    await request.evaluate(({ emitProgress }, progress) => emitProgress(progress), movingProgress);
    await expect(confirmation.getByText("Moving verified copies", { exact: true })).toBeVisible();
    await expect(confirmation.getByRole("progressbar", { name: "Cleanup progress" })).toBeInViewport();
    await expect(moving).toBeFocused();
    await request.evaluate(({ release }) => release());

    const receipt = dialog.getByRole("region", { name: "Cleanup result", exact: true });
    await expect(receipt).toBeFocused();
    const emitted = await request.evaluate(({ emitted }) => emitted);
    expect(emitted.map(({ progress }) => progress.phase)).toEqual(["verifying", "moving"]);
    for (const event of emitted) {
      expect(event).toMatchObject({ workspace_name: "Studio workspace", plan_id: expect.any(String) });
    }
    expect(emitted[0].progress).toMatchObject({ current_file: backupPath, total_files: 1, bytes_checked: 46 * 1024 ** 3 });
    await expect(receipt.getByText("Moved to Trash", { exact: true }).locator("..").locator("dd")).toHaveText("1");
    await expect(receipt.getByText("Skipped", { exact: true }).locator("..").locator("dd")).toHaveText("0");
    await expect(receipt).toContainText("restore them from the system Trash or Recycle Bin");
    await receipt.getByText("Moved files", { exact: true }).tap();
    await expect(receipt.getByRole("list", { name: "Moved files", exact: true })).toContainText(backupPath);
    await expect(dialog).toContainText("No copies staged.");
    await expect(action).toHaveCount(0);
    await dialog.getByRole("button", { name: "Close cleanup review", exact: true }).tap();
    await page.getByRole("button", { name: "Workspace actions", exact: true }).press("Enter");
    await page.getByRole("button", { name: "Review", exact: true }).press("Enter");
    await expect(receipt).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(currentFolder(page)).toHaveText("Backup campaign");
    const map = page.getByRole("region", { name: "Circular storage map" });
    await expect(map.getByRole("button", { name: /^Trailer master\.mov,/ })).toHaveCount(0);
    await expect(map.getByRole("button", { name: /^Campaign assembly\.mov,/ })).toBeVisible();
    await page.keyboard.press("ControlOrMeta+f");
    const finder = page.getByRole("dialog", { name: "Find files", exact: true });
    await finder.getByRole("searchbox", { name: "File name", exact: true }).fill(fileName);
    await expect(finder.getByText(sourcePath, { exact: true })).toBeVisible();
    await expect(finder.getByText(backupPath, { exact: true })).toHaveCount(0);
  });

  test("a changed staging set requires a new cleanup preview", async ({ page }) => {
    await stageCopy(page, "Backup campaign");
    await inspector(page).getByRole("button", { name: "Open review", exact: true }).tap();
    const dialog = review(page);
    const preview = dialog.getByRole("button", { name: "Preview cleanup", exact: true });
    await preview.tap();
    const action = dialog.getByRole("button", { name: "Move to Trash…", exact: true });
    await action.press("Enter");

    await page.evaluate(async (path) => {
      const { __TAURI_INTERNALS__: bridge } = window as unknown as {
        __TAURI_INTERNALS__: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
      };
      await bridge.invoke("unstage_path", { expectedWorkspace: "Studio workspace", path });
    }, backupPath);

    await dialog.getByRole("button", { name: "Move to Trash", exact: true }).press("Enter");
    await expect(dialog.getByRole("alert")).toContainText(/staged|preview/i);
    await expect(dialog.getByRole("region", { name: "Move 1 copy to Trash?", exact: true })).toHaveCount(0);
    await expect(action).toHaveCount(0);
    await expect(preview).toBeFocused();
    await expect(dialog.getByRole("region", { name: "Cleanup result", exact: true })).toHaveCount(0);
    await expect(dialog).toContainText("No copies staged.");
  });

  test("cleanup result explains a skipped copy that remains staged", async ({ page }) => {
    await stageCopy(page, "Backup campaign");
    await page.evaluate(() => {
      const { __TAURI_INTERNALS__: bridge } = window as unknown as {
        __TAURI_INTERNALS__: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
      };
      let ready: CleanupPreview | null = null;
      const invoke = bridge.invoke.bind(bridge);
      bridge.invoke = async (command, args) => {
        if (command === "move_cleanup_to_trash" && ready) {
          return {
            operation_id: "sample-skipped-cleanup",
            moved_files: [],
            skipped_files: [{ file: ready.staged_files[0], message: "The file changed on disk." }],
          } satisfies CleanupReport;
        }
        const response = await invoke(command, args);
        if (command === "preview_cleanup") ready = response as CleanupPreview;
        return response;
      };
    });

    await inspector(page).getByRole("button", { name: "Open review", exact: true }).tap();
    const dialog = review(page);
    await dialog.getByRole("button", { name: "Preview cleanup", exact: true }).tap();
    await dialog.getByRole("button", { name: "Move to Trash…", exact: true }).press("Enter");
    await dialog.getByRole("button", { name: "Move to Trash", exact: true }).press("Enter");

    const receipt = dialog.getByRole("region", { name: "Cleanup result", exact: true });
    await expect(receipt.getByText("Moved to Trash", { exact: true }).locator("..").locator("dd")).toHaveText("0");
    const skipped = receipt.getByRole("list", { name: "Skipped files", exact: true });
    await expect(skipped).toContainText(backupPath);
    await expect(skipped).toContainText("The file changed on disk.");
    await expect(dialog.getByRole("list", { name: "Staged copies", exact: true })).toContainText(backupPath);
    await expect(dialog.getByRole("button", { name: "Preview cleanup", exact: true })).toBeEnabled();
  });

  test("inspecting retained and staged copies returns to the same preview and row", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 350 });
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
    await expect(preview.getByText("Copies that would remain", { exact: true }).locator("..").locator("dd")).toHaveText("1");
    await expect(dialog.getByRole("region", { name: "Exact copy group", exact: true })
      .getByRole("heading").first()).toHaveText("Would remain");

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
    await expect(preview.getByRole("heading", { name: "Move to Trash unavailable", exact: true })).toBeVisible();
    expect(await requests.jsonValue()).toEqual(["preview_cleanup", "get_storage_file_reveal", "get_storage_file_reveal"]);
  });

  for (const newer of ["none", "focus", "scroll"] as const) {
    test(`a pending cleanup preview ${newer === "none" ? "restores the inspected row" : `yields to newer ${newer}`}`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 350 });
      await stageCopy(page, "Backup campaign");
      await folderPath(page).getByRole("button", { name: "Previous location", exact: true }).press("Enter");
      await expect(currentFolder(page)).toHaveText("Projects");
      await stageCopy(page, "Brand campaign");
      await inspector(page).getByRole("button", { name: "Open review", exact: true }).press("Enter");

      const dialog = review(page);
      const body = dialog.locator(".atlas-analysis-body");
      const preview = dialog.getByRole("button", { name: "Preview cleanup", exact: true });
      const checking = dialog.getByRole("button", { name: "Checking…", exact: true });
      const close = dialog.getByRole("button", { name: "Close cleanup review", exact: true });
      const unavailable = dialog.getByRole("heading", { name: "Move to Trash unavailable", exact: true });
      const retained = inspectCopy(dialog, "Would remain", sharedPath);
      await preview.press("Enter");
      await expect(unavailable).toBeVisible();
      await retained.scrollIntoViewIfNeeded();
      await retained.focus();
      const savedScroll = await body.evaluate((element) => element.scrollTop);
      expect(savedScroll).toBeGreaterThan(0);
      await page.keyboard.press("Enter");
      await expect(dialog).toBeHidden();
      const details = inspector(page).getByRole("region", { name: "Storage details", exact: true });
      await expect(details).toContainText(sharedPath);
      const back = details.getByRole("button", { name: "Back to review", exact: true });
      await back.press("Enter");
      await expect(retained).toBeFocused();

      const hold = await page.evaluateHandle(() => {
        const { __TAURI_INTERNALS__: bridge } = window as unknown as {
          __TAURI_INTERNALS__: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
        };
        const invoke = bridge.invoke.bind(bridge);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const read = { pending: false, release };
        bridge.invoke = async (command, args) => {
          const response = await invoke(command, args);
          if (command === "preview_cleanup") {
            read.pending = true;
            await gate;
          }
          return response;
        };
        return read;
      });

      try {
        await preview.press("Enter");
        await expect.poll(() => hold.evaluate((read) => read.pending)).toBe(true);
        await expect(checking).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
        await expect(back).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(checking).toBeFocused();
        if (newer === "focus") await close.focus();
        if (newer === "scroll") {
          const initial = await body.evaluate((element) => element.scrollTop);
          const bounds = (await body.boundingBox())!;
          await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
          await page.mouse.wheel(0, initial > 24 ? -24 : 24);
          await expect.poll(() => body.evaluate((element) => element.scrollTop)).not.toBe(initial);
        }
      } finally {
        await hold.evaluate((read) => read.release());
      }

      await expect(unavailable).toBeVisible();
      if (newer === "none") {
        await expect(retained).toBeFocused();
        await expect(retained).toBeInViewport({ ratio: 0.99 });
        await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeCloseTo(savedScroll, 0);
      } else {
        await expect(newer === "focus" ? close : preview).toBeFocused();
        if (newer === "scroll") expect(await body.evaluate((element) => element.scrollTop)).not.toBeCloseTo(savedScroll, 0);
      }
    });
  }

  test("Atlas history restores the review row for each inspected copy", async ({ page }) => {
    await page.keyboard.press("ControlOrMeta+f");
    const finder = page.getByRole("dialog", { name: "Find files", exact: true });
    await finder.getByRole("searchbox", { name: "File name", exact: true }).fill("  TrAiLeR master  ");
    await finder.getByRole("button", { name: /^Trailer master\.mov/ }).first().press("Enter");
    await expect(finder).toBeHidden();

    const details = inspector(page).getByRole("region", { name: "Storage details", exact: true });
    const stage = details.getByRole("button", { name: "Stage for review", exact: true });
    await expect(details).toContainText(backupPath);
    await stage.press("Enter");
    await expect(details.getByRole("button", { name: "Remove from review", exact: true })).toBeVisible();
    await inspector(page).getByRole("button", { name: "Next result", exact: true }).press("Enter");
    await expect(details).toContainText(sourcePath);
    await stage.press("Enter");
    await details.getByRole("button", { name: "Open review", exact: true }).press("Enter");

    const dialog = review(page);
    const body = dialog.locator(".atlas-analysis-body");
    const preview = dialog.getByRole("region", { name: "Cleanup preview", exact: true });
    const close = dialog.getByRole("button", { name: "Close cleanup review", exact: true });
    const backToReview = details.getByRole("button", { name: "Back to review", exact: true });
    const previous = folderPath(page).getByRole("button", { name: "Previous location", exact: true });
    await dialog.getByRole("button", { name: "Preview cleanup", exact: true }).press("Enter");
    await expect(preview).toContainText("184 GB");

    async function inspectAtCurrentRow(row: Locator, folder: string, path: string) {
      await row.scrollIntoViewIfNeeded();
      const scroll = await body.evaluate((element) => element.scrollTop);
      await row.press("Enter");
      await expect(dialog).toBeHidden();
      await expect(currentFolder(page)).toHaveText(folder);
      await expect(details).toContainText(path);
      return scroll;
    }

    async function returnToRow(row: Locator, scroll: number) {
      await backToReview.press("Enter");
      await expect(preview).toContainText("184 GB");
      await expect(row).toBeFocused();
      await expect(row).toBeInViewport({ ratio: 0.99 });
      await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeCloseTo(scroll, 0);
    }

    const retained = inspectCopy(dialog, "Would remain", sharedPath);
    const backup = inspectCopy(dialog, "Staged for cleanup", backupPath);
    const retainedScroll = await inspectAtCurrentRow(retained, "Campaign mirror", sharedPath);
    await returnToRow(retained, retainedScroll);
    await body.evaluate((element) => { element.scrollTop = 0; });
    const backupScroll = await inspectAtCurrentRow(backup, "Backup campaign", backupPath);
    expect(backupScroll).not.toBe(retainedScroll);

    await previous.press("Enter");
    await expect(details).toContainText(sharedPath);
    await returnToRow(retained, retainedScroll);
    await close.press("Enter");
    await expect(dialog).toBeHidden();

    await page.getByRole("button", { name: "Workspace actions", exact: true }).press("Enter");
    await page.getByRole("button", { name: /^Review\b/ }).press("Enter");
    await expect(preview).toContainText("184 GB");
    await close.press("Enter");

    await page.keyboard.press("Alt+ArrowRight");
    await expect(details).toContainText(backupPath);
    await returnToRow(backup, backupScroll);
    await close.press("Enter");
    await previous.press("Enter");
    await expect(details).toContainText(sharedPath);
    await returnToRow(retained, retainedScroll);
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

for (const action of ["staged Inspect", "staged Remove", "retained Inspect", "preview summary", "Close"] as const) {
  test(`cleanup review restores focus after an inventory refresh with ${action} focused`, async ({ page }) => {
    await stageCopy(page, "Brand campaign");
    await page.clock.install({ time: new Date("2025-11-04T12:00:00Z") });
    await page.clock.pauseAt(new Date("2025-11-04T12:10:00Z"));
    await page.getByRole("button", { name: "Sites", exact: true }).press("Enter");
    const sites = page.getByRole("complementary", { name: "Sites", exact: true });
    await sites.getByRole("button", { name: "Scan Field drive", exact: true }).press("Enter");
    await expect(sites.getByRole("button", { name: "Stop scan of Field drive", exact: true })).toBeEnabled();
    await sites.getByRole("button", { name: "Close sites", exact: true }).press("Enter");
    await inspector(page).getByRole("button", { name: "Open review", exact: true }).press("Enter");
    const dialog = review(page);
    const previewButton = dialog.getByRole("button", { name: "Preview cleanup", exact: true });
    const preview = dialog.getByRole("region", { name: "Cleanup preview", exact: true });
    const close = dialog.getByRole("button", { name: "Close cleanup review", exact: true });
    const removeCopy = (list: string) => dialog.getByRole("list", { name: list, exact: true })
      .getByRole("button", { name: `Remove ${fileName} from review`, exact: true });
    await previewButton.press("Enter");
    await expect(preview.getByRole("heading", { name: "Preview passed" })).toBeVisible();
    const move = dialog.getByRole("button", { name: "Move to Trash…", exact: true });
    await expect(move).toBeDisabled();
    await expect(move).toHaveAccessibleDescription("Wait for scans to finish before moving files to Trash.");
    const targets = {
      "staged Inspect": [inspectCopy(dialog, "Staged for cleanup", sourcePath), inspectCopy(dialog, "Staged copies", sourcePath)],
      "staged Remove": [removeCopy("Staged for cleanup"), removeCopy("Staged copies")],
      "retained Inspect": [inspectCopy(dialog, "Would remain", sharedPath), previewButton],
      "preview summary": [preview, previewButton],
      Close: [close, close],
    };
    const [before, after] = targets[action];
    await before.focus();
    await expect(before).toBeFocused();

    await page.clock.runFor(5_700);
    await expect(preview).toHaveCount(0);
    await expect(dialog.getByRole("list", { name: "Staged copies", exact: true })).toContainText(sourcePath);
    await expect(after).toBeFocused();
    await expect(after).toBeInViewport();
  });
}
