import { expect, test, type Locator, type Page } from "@playwright/test";

const fileName = "Trailer master.mov";
const sourcePath = "/demo/Studio Archive/Projects/Brand campaign/Trailer master.mov";
const backupPath = "/demo/Studio Archive/Projects/Backup campaign/Trailer master.mov";
const sharedPath = "smb://media.example.test/Studio/Campaign mirror/Trailer master.mov";
const backupChoice = "Backup campaign · Studio archive";
const sharedChoice = "Campaign mirror · Team share";

function folderPath(page: Page) {
  return page.getByRole("navigation", { name: "Folder path" });
}

function currentFolder(page: Page) {
  return page.locator('.atlas-toolbar-navigation [aria-current="location"]');
}

function inspector(page: Page) {
  return page.getByRole("complementary", { name: "Inspector" });
}

function compareWith(dialog: Locator) {
  return dialog.getByRole("combobox", { name: "Compare with", exact: true });
}

async function openBrandCampaign(page: Page) {
  const map = page.getByRole("region", { name: "Circular storage map" });
  await map.getByRole("button", { name: /^Projects,/ }).press("Enter");
  await expect(currentFolder(page)).toHaveText("Projects");
  await map.getByRole("button", { name: /^Brand campaign,/ }).press("Enter");
  await expect(currentFolder(page)).toHaveText("Brand campaign");
  return map;
}

async function inspectOriginalFile(page: Page) {
  const map = await openBrandCampaign(page);
  await map.getByRole("button", { name: /^Trailer master\.mov,/ }).press("Enter");
  await expect(inspector(page).getByRole("heading", { name: fileName, exact: true })).toBeVisible();
}

async function openExactCopies(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Exact copies", exact: true });
  await inspector(page).getByRole("button", { name: "Exact copies", exact: true }).click();
  await expect(dialog).toBeVisible();
  return dialog;
}

test.beforeEach(async ({ page }) => {
  await page.goto("/mock/");
  await expect(currentFolder(page)).toHaveText("Studio archive");
});

test("compare exact copies in place, then inspect their destination and return", async ({ page }) => {
  await page.getByRole("button", { name: "Sites", exact: true }).click();
  const sites = page.getByRole("complementary", { name: "Sites" });
  await sites.getByRole("button", { name: "Open Team share in Atlas" }).click();
  await expect(currentFolder(page)).toHaveText("Team share");
  await page.getByRole("button", { name: "Contents & details" }).click();
  await expect(inspector(page).getByRole("tab", { name: "Contents", selected: true })).toBeVisible();
  await sites.getByRole("button", { name: "Open Studio archive in Atlas" }).click();
  await expect(currentFolder(page)).toHaveText("Studio archive");
  await sites.getByRole("button", { name: "Close sites" }).click();

  await inspectOriginalFile(page);
  const reads = await page.evaluateHandle(() => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: { offset?: number }) => Promise<unknown> };
    };
    const invoke = bridge.invoke.bind(bridge);
    const offsets: number[] = [];
    bridge.invoke = (command, args) => {
      if (command === "get_file_content_matches") offsets.push(args.offset ?? 0);
      return invoke(command, args);
    };
    return offsets;
  });
  const dialog = await openExactCopies(page);
  const backup = dialog.getByRole("button", { name: /Studio archive.*Backup campaign|Backup campaign.*Studio archive/i });
  const shared = dialog.getByRole("button", { name: /Team share.*Campaign mirror|Campaign mirror.*Team share/i });
  const original = dialog.getByRole("region", { name: "Selected file", exact: true });
  const match = dialog.getByRole("region", { name: "Matching copy", exact: true });
  await expect(backup).toHaveAttribute("aria-pressed", "true");
  await expect(original).toContainText(sourcePath);
  await expect(match).toContainText(backupPath);

  await shared.click();
  await expect(shared).toHaveAttribute("aria-pressed", "true");
  await expect(backup).toHaveAttribute("aria-pressed", "false");
  await expect(original).toContainText(sourcePath);
  await expect(match).toContainText(sharedPath);
  await expect(currentFolder(page)).toHaveText("Brand campaign");

  await page.setViewportSize({ width: 500, height: 430 });
  const picker = compareWith(dialog);
  await expect(picker.locator("option:checked")).toHaveText(sharedChoice);
  await expect(shared).toBeHidden();
  const body = dialog.locator(".atlas-analysis-body");
  const scrollTop = await body.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return element.scrollTop;
  });
  expect(scrollTop).toBeGreaterThan(0);

  const show = dialog.getByRole("button", { name: "Show in Atlas", exact: true });
  await show.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(currentFolder(page)).toHaveText("Campaign mirror");
  await expect(inspector(page).getByRole("heading", { name: fileName, exact: true })).toBeVisible();
  await expect(inspector(page)).toContainText(sharedPath);

  const details = inspector(page).getByRole("region", { name: "Storage details", exact: true });
  const back = details.getByRole("button", { name: "Back to comparison", exact: true });
  await back.press("Enter");
  await expect(dialog).toBeVisible();
  await expect(original).toContainText(sourcePath);
  await expect(match).toContainText(sharedPath);
  await expect(picker.locator("option:checked")).toHaveText(sharedChoice);
  await expect(show).toBeFocused();
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeCloseTo(scrollTop, 0);
  expect(await reads.jsonValue()).toEqual([0]);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(back).toBeFocused();
  await expect(details).toContainText(sharedPath);
  await back.press("Enter");
  await expect(original).toContainText(sourcePath);
  await expect(match).toContainText(sharedPath);
  await expect(picker.locator("option:checked")).toHaveText(sharedChoice);
  await expect(show).toBeFocused();
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeCloseTo(scrollTop, 0);
  expect(await reads.jsonValue()).toEqual([0]);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await folderPath(page).getByRole("button", { name: "Previous location", exact: true }).click();
  await expect(currentFolder(page)).toHaveText("Brand campaign");
  await expect(inspector(page).getByRole("heading", { name: fileName, exact: true })).toBeVisible();
  await expect(inspector(page)).toContainText(sourcePath);
});

test.describe("compact Exact copies", () => {
  test.use({ viewport: { width: 390, height: 580 }, hasTouch: true });

  test("each Atlas visit keeps its comparison when choosing copies from the touch picker", async ({ page }) => {
    await inspectOriginalFile(page);
    const details = inspector(page).getByRole("region", { name: "Storage details", exact: true });
    const open = details.getByRole("button", { name: "Exact copies", exact: true });
    const back = details.getByRole("button", { name: "Back to comparison", exact: true });
    const dialog = page.getByRole("dialog", { name: "Exact copies", exact: true });
    const original = dialog.getByRole("region", { name: "Selected file", exact: true });
    const match = dialog.getByRole("region", { name: "Matching copy", exact: true });
    const picker = compareWith(dialog);
    const show = dialog.getByRole("button", { name: "Show in Atlas", exact: true });
    const close = dialog.getByRole("button", { name: "Close exact copies", exact: true });

    await open.tap();
    await expect(picker).toBeInViewport({ ratio: 0.99 });
    await expect(picker.locator("option:checked")).toHaveText(backupChoice);
    const target = (await picker.boundingBox())!;
    expect(target.height).toBeGreaterThanOrEqual(44);
    await picker.tap();
    await picker.selectOption({ label: sharedChoice });
    await expect(match).toContainText(sharedPath);
    await show.tap();
    await expect(dialog).toBeHidden();
    await expect(currentFolder(page)).toHaveText("Campaign mirror");
    await expect(details).toContainText(sharedPath);

    await open.tap();
    await expect(original).toContainText(sharedPath);
    await picker.selectOption({ label: backupChoice });
    await expect(match).toContainText(backupPath);
    await show.tap();
    await expect(dialog).toBeHidden();
    await expect(currentFolder(page)).toHaveText("Backup campaign");

    await folderPath(page).getByRole("button", { name: "Previous location", exact: true }).press("Enter");
    await expect(currentFolder(page)).toHaveText("Campaign mirror");
    await back.tap();
    await expect(original).toContainText(sourcePath);
    await expect(picker.locator("option:checked")).toHaveText(sharedChoice);
    await expect(show).toBeFocused();
    await close.tap();
    await expect(dialog).toBeHidden();
    await expect(back).toBeFocused();

    await page.keyboard.press("Alt+ArrowRight");
    await expect(currentFolder(page)).toHaveText("Backup campaign");
    await back.tap();
    await expect(original).toContainText(sharedPath);
    await expect(picker.locator("option:checked")).toHaveText(backupChoice);
    await expect(match).toContainText(backupPath);
  });
});

test("the same file returns to the comparison or review that opened its Atlas visit", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 580 });
  await inspectOriginalFile(page);
  const details = inspector(page).getByRole("region", { name: "Storage details", exact: true });
  await details.getByRole("button", { name: "Exact copies", exact: true }).press("Enter");
  const comparison = page.getByRole("dialog", { name: "Exact copies", exact: true });
  await compareWith(comparison).selectOption({ label: backupChoice });
  await comparison.getByRole("button", { name: "Show in Atlas", exact: true }).press("Enter");
  await expect(comparison).toBeHidden();
  await expect(currentFolder(page)).toHaveText("Backup campaign");
  await expect(details).toContainText(backupPath);
  const backToComparison = details.getByRole("button", { name: "Back to comparison", exact: true });
  const backToReview = details.getByRole("button", { name: "Back to review", exact: true });
  await expect(backToComparison).toBeVisible();

  await details.getByRole("button", { name: "Stage for review", exact: true }).press("Enter");
  await details.getByRole("button", { name: "Open review", exact: true }).press("Enter");
  const review = page.getByRole("dialog", { name: "Cleanup review", exact: true });
  await review.getByRole("button", { name: "Preview cleanup", exact: true }).press("Enter");
  const preview = review.getByRole("heading", { name: "Preview passed", exact: true });
  await expect(preview).toBeVisible();
  const staged = review.getByRole("list", { name: "Staged for cleanup", exact: true })
    .getByRole("button", { name: `Inspect ${fileName} in Atlas`, exact: true });
  await staged.scrollIntoViewIfNeeded();
  const body = review.locator(".atlas-analysis-body");
  const scrollPosition = await body.evaluate((element) => element.scrollTop);
  await staged.press("Enter");
  await expect(review).toBeHidden();
  await expect(details).toContainText(backupPath);
  await expect(backToReview).toBeVisible();
  await expect(backToComparison).toBeHidden();

  const previous = folderPath(page).getByRole("button", { name: "Previous location", exact: true });
  await previous.press("Enter");
  await expect(backToComparison).toBeVisible();
  await expect(backToReview).toBeHidden();
  await expect(details).toContainText(backupPath);
  await page.keyboard.press("Alt+ArrowRight");
  await expect(backToReview).toBeVisible();
  await expect(backToComparison).toBeHidden();
  await expect(currentFolder(page)).toHaveText("Backup campaign");

  await backToReview.press("Enter");
  await expect(preview).toBeVisible();
  await expect(staged).toBeFocused();
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBe(scrollPosition);
  await page.keyboard.press("Escape");
  await expect(review).toBeHidden();
  await expect(details).toContainText(backupPath);
  await expect(backToReview).toBeFocused();
});

test("retrying unavailable exact copies keeps keyboard focus in the dialog", async ({ page }) => {
  await inspectOriginalFile(page);
  await page.evaluate(() => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
    };
    const invoke = bridge.invoke.bind(bridge);
    let failFirst = true;
    bridge.invoke = async (command, args) => {
      if (command === "get_file_content_matches" && failFirst) {
        failFirst = false;
        throw new Error("Couldn’t read matching files.");
      }
      return invoke(command, args);
    };
  });

  const dialog = await openExactCopies(page);
  const error = dialog.getByRole("alert").filter({ hasText: "Couldn’t read matching files." });
  await error.getByRole("button", { name: "Retry", exact: true }).press("Enter");
  await expect(dialog.getByRole("list", { name: "Matching files" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close exact copies" })).toBeFocused();
});

test("an exact-copy jump that fails keeps the comparison available to retry", async ({ page }) => {
  await inspectOriginalFile(page);
  const dialog = await openExactCopies(page);
  await expect(dialog).toContainText(backupPath);

  await page.evaluate(() => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
    };
    const invoke = bridge.invoke.bind(bridge);
    let shouldFail = true;
    bridge.invoke = async (command, args) => {
      if (command === "get_storage_file_reveal" && shouldFail) {
        shouldFail = false;
        throw new Error("The copy’s folder is temporarily unavailable.");
      }
      return invoke(command, args);
    };
  });

  const reveal = dialog.getByRole("button", { name: "Show in Atlas", exact: true });
  await reveal.click();
  await expect(dialog.getByRole("alert")).toContainText("The copy’s folder is temporarily unavailable.");
  await expect(dialog).toContainText(backupPath);
  await expect(currentFolder(page)).toHaveText("Brand campaign");

  await reveal.click();
  await expect(dialog).toBeHidden();
  await expect(currentFolder(page)).toHaveText("Backup campaign");
  await expect(inspector(page)).toContainText(backupPath);
});

test("Atlas history retains the original filtered Contents visit across an exact-copy inspection", async ({ page }) => {
  await openBrandCampaign(page);
  await page.getByRole("button", { name: "Contents & details", exact: true }).press("Enter");
  const contents = inspector(page).getByRole("tabpanel", { name: "Contents", exact: true });
  await contents.getByRole("button", { name: "Search this folder", exact: true }).press("Enter");
  const filter = contents.getByRole("searchbox", { name: "Find in folder", exact: true })
    .or(contents.getByRole("textbox", { name: "Find in folder", exact: true }));
  const query = "  tRaIlEr  ";
  await filter.fill(query);
  const grid = contents.getByRole("grid");
  await expect(grid).toHaveAttribute("aria-rowcount", "1");
  const trailer = grid.getByRole("button", { name: /^Trailer master\.mov/ });
  await trailer.press("Enter");
  const backToContents = inspector(page).getByRole("button", { name: "Back to Contents", exact: true });
  await expect(backToContents).toBeVisible();

  const dialog = await openExactCopies(page);
  await expect(dialog.getByRole("region", { name: "Matching copy", exact: true })).toContainText(backupPath);
  await dialog.getByRole("button", { name: "Show in Atlas", exact: true }).press("Enter");
  await expect(dialog).toBeHidden();
  await expect(currentFolder(page)).toHaveText("Backup campaign");

  const back = folderPath(page).getByRole("button", { name: "Previous location", exact: true });
  await back.press("Enter");
  await expect(currentFolder(page)).toHaveText("Brand campaign");
  await expect(inspector(page)).toContainText(sourcePath);
  await expect(backToContents).toBeVisible();
  await back.press("Enter");
  await expect(currentFolder(page)).toHaveText("Brand campaign");
  await expect(filter).toHaveValue(query);
  await expect(trailer).toBeFocused();

  const forward = folderPath(page).getByRole("button", { name: "Next location", exact: true });
  await forward.press("Enter");
  await expect(backToContents).toBeVisible();
  await forward.press("Enter");
  await expect(currentFolder(page)).toHaveText("Backup campaign");
  await expect(inspector(page)).toContainText(backupPath);
  await expect(inspector(page).getByRole("button", { name: "Back to comparison", exact: true })).toBeVisible();
});

for (const scanSite of ["Field drive", "Studio archive"]) {
  test(`opening an exact copy survives a scan of ${scanSite}`, async ({ page }) => {
    await inspectOriginalFile(page);
    await page.clock.install({ time: new Date("2025-11-04T12:00:00Z") });
    await page.clock.pauseAt(new Date("2025-11-04T12:10:00Z"));

    const reads = await page.evaluateHandle(() => {
      const { __TAURI_INTERNALS__: bridge } = window as unknown as {
        __TAURI_INTERNALS__: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
      };
      const invoke = bridge.invoke.bind(bridge);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const read = { release, reveal_pending: false, reveal_reads: 0, match_reads: 0 };
      bridge.invoke = async (command, args) => {
        const response = await invoke(command, args);
        if (command === "get_file_content_matches") read.match_reads += 1;
        if (command !== "get_storage_file_reveal") return response;
        read.reveal_reads += 1;
        if (read.reveal_reads === 1) {
          read.reveal_pending = true;
          await gate;
        }
        return response;
      };
      return read;
    });

    await page.getByRole("button", { name: "Sites", exact: true }).press("Enter");
    const sites = page.getByRole("complementary", { name: "Sites", exact: true });
    await sites.getByRole("button", { name: `Scan ${scanSite}`, exact: true }).press("Enter");
    await expect(sites.getByRole("button", { name: `Stop scan of ${scanSite}`, exact: true })).toBeEnabled();
    await sites.getByRole("button", { name: "Close sites", exact: true }).press("Enter");
    await inspector(page).getByRole("button", { name: "Exact copies", exact: true }).press("Enter");
    const dialog = page.getByRole("dialog", { name: "Exact copies", exact: true });
    const shared = dialog.getByRole("button", { name: /Team share.*Campaign mirror/ });
    const show = dialog.getByRole("button", { name: "Show in Atlas", exact: true });
    const opening = dialog.getByRole("button", { name: "Opening copy…", exact: true });
    await page.clock.runFor(10);
    await shared.press("Enter");
    await expect(shared).toHaveAttribute("aria-pressed", "true");
    await show.press("Enter");

    try {
      await expect.poll(() => reads.evaluate((read) => read.reveal_pending)).toBe(true);
      await expect(opening).toBeFocused();
      await page.clock.runFor(5_700);
      await expect.poll(() => reads.evaluate((read) => read.match_reads)).toBeGreaterThan(1);
      await expect(dialog.locator(".atlas-analysis-results")).toHaveAttribute("aria-busy", "false");
      await expect(opening).toBeFocused();
      await expect(shared).toHaveAttribute("aria-pressed", "true");
    } finally {
      await reads.evaluate((read) => read.release());
    }

    await expect(dialog).toBeHidden();
    await expect(currentFolder(page)).toHaveText("Campaign mirror");
    const details = inspector(page).getByRole("region", { name: "Storage details", exact: true });
    await expect(details).toContainText(sharedPath);
    expect(await reads.evaluate((read) => read.reveal_reads)).toBe(1);

    await details.getByRole("button", { name: "Back to comparison", exact: true }).press("Enter");
    await page.clock.runFor(10);
    await expect(dialog.getByRole("region", { name: "Selected file", exact: true })).toContainText(sourcePath);
    await expect(dialog.getByRole("region", { name: "Matching copy", exact: true })).toContainText(sharedPath);
    await expect(shared).toHaveAttribute("aria-pressed", "true");
    await expect(show).toBeFocused();
  });
}

for (const chooseBackup of [false, true]) {
  const result = chooseBackup ? "keeps the replacement the user chose" : "restores the intended copy after verification";
  test(`Exact copies ${result}`, async ({ page }) => {
    await inspectOriginalFile(page);
    if (chooseBackup) await page.setViewportSize({ width: 320, height: 480 });
    await page.clock.install({ time: new Date("2025-11-04T12:00:00Z") });
    await page.clock.pauseAt(new Date("2025-11-04T12:10:00Z"));

    const reveals = await page.evaluateHandle(() => {
      const { __TAURI_INTERNALS__: bridge } = window as unknown as {
        __TAURI_INTERNALS__: { invoke: (command: string, args: { fileId?: string }) => Promise<unknown> };
      };
      const invoke = bridge.invoke.bind(bridge);
      const files: string[] = [];
      bridge.invoke = (command, args) => {
        if (command === "get_storage_file_reveal" && args.fileId) files.push(args.fileId);
        return invoke(command, args);
      };
      return files;
    });

    await page.getByRole("button", { name: "Sites", exact: true }).press("Enter");
    const sites = page.getByRole("complementary", { name: "Sites", exact: true });
    await sites.getByRole("button", { name: "Scan Team share", exact: true }).press("Enter");
    await expect(sites.getByRole("button", { name: "Stop scan of Team share", exact: true })).toBeEnabled();
    await sites.getByRole("button", { name: "Close sites", exact: true }).press("Enter");
    await inspector(page).getByRole("button", { name: "Exact copies", exact: true }).press("Enter");

    const dialog = page.getByRole("dialog", { name: "Exact copies", exact: true });
    const shared = dialog.getByRole("button", { name: /^Team share.*Campaign mirror/ });
    const backup = dialog.getByRole("button", { name: /^Studio archive.*Backup campaign/ });
    const picker = compareWith(dialog);
    const choice = picker.locator("option:checked");
    const match = dialog.getByRole("region", { name: "Matching copy", exact: true });
    const show = dialog.getByRole("button", { name: "Show in Atlas", exact: true });
    const unavailable = dialog.getByRole("status").filter({ hasText: /selected copy is (?:temporarily )?unavailable/i });
    await page.clock.runFor(20);
    if (chooseBackup) {
      await picker.focus();
      await picker.selectOption({ label: sharedChoice });
      await expect(picker).toBeFocused();
      await expect(choice).toHaveText(sharedChoice);
    } else {
      await shared.press("Enter");
      await expect(shared).toBeFocused();
      await expect(shared).toHaveAttribute("aria-pressed", "true");
    }
    await expect(match).toContainText(sharedPath);

    // Let the retained copy become unavailable while the mock publishes Team share's inventory.
    await page.clock.runFor(3_800);
    await expect(unavailable).toBeVisible();
    await expect(match).toContainText(sharedPath);
    if (chooseBackup) {
      await expect(picker).toBeFocused();
      await expect(picker).toBeInViewport({ ratio: 0.98 });
      await expect(choice).toHaveText(`${sharedChoice} · Unavailable`);
      await expect(choice).toHaveJSProperty("disabled", true);
    } else {
      await expect(backup).toBeFocused();
      await expect(backup).toBeInViewport({ ratio: 0.98 });
      await expect(backup).toHaveAttribute("aria-pressed", "false");
    }
    await expect(show).toBeDisabled();
    await expect(show).toHaveAccessibleDescription("The selected copy is unavailable in the current results.");
    await show.press("Enter");
    await expect(dialog).toBeVisible();
    await expect(currentFolder(page)).toHaveText("Brand campaign");
    expect(await reveals.jsonValue()).toEqual([]);

    if (chooseBackup) {
      await picker.focus();
      await picker.selectOption({ label: backupChoice });
      await expect(match).toContainText(backupPath);
      await expect(show).toBeEnabled();
    } else {
      await backup.focus();
    }
    await page.clock.runFor(2_500);
    await expect(unavailable).toBeHidden();
    if (chooseBackup) {
      await expect(choice).toHaveText(backupChoice);
      await expect(picker).toBeFocused();
    } else {
      await expect(shared).toHaveAttribute("aria-pressed", "true");
      await expect(backup).toBeFocused();
      await expect(backup).toHaveAttribute("aria-pressed", "false");
    }
    await expect(match).toContainText(chooseBackup ? backupPath : sharedPath);
    await expect(show).toBeEnabled();

    await show.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(currentFolder(page)).toHaveText(chooseBackup ? "Backup campaign" : "Campaign mirror");
    await expect(inspector(page)).toContainText(chooseBackup ? backupPath : sharedPath);
    expect(await reveals.jsonValue()).toHaveLength(1);
  });
}

test("dismissing an exact-copy comparison cancels its pending navigation", async ({ page }) => {
  await inspectOriginalFile(page);
  const dialog = await openExactCopies(page);
  await expect(dialog).toContainText(backupPath);

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
      if (command === "get_storage_file_reveal") {
        read.pending = true;
        await gate;
        read.replied = true;
      }
      return response;
    };
    return read;
  });

  await dialog.getByRole("button", { name: "Show in Atlas", exact: true }).click();
  await expect.poll(() => request.evaluate((read) => read.pending)).toBe(true);
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await request.evaluate((read) => read.release());
  await expect.poll(() => request.evaluate((read) => read.replied)).toBe(true);
  await expect(currentFolder(page)).toHaveText("Brand campaign");
  await expect(inspector(page)).toContainText(sourcePath);
});
