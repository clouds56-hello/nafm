import { expect, test, type Page } from "@playwright/test";

const fileName = "Trailer master.mov";
const sourcePath = "/demo/Studio Archive/Projects/Brand campaign/Trailer master.mov";
const backupPath = "/demo/Studio Archive/Projects/Backup campaign/Trailer master.mov";
const sharedPath = "smb://media.example.test/Studio/Campaign mirror/Trailer master.mov";

function folderPath(page: Page) {
  return page.getByRole("navigation", { name: "Folder path" });
}

function currentFolder(page: Page) {
  return page.locator('.atlas-toolbar-navigation [aria-current="location"]');
}

function inspector(page: Page) {
  return page.getByRole("complementary", { name: "Inspector" });
}

async function inspectOriginalFile(page: Page) {
  const map = page.getByRole("region", { name: "Circular storage map" });
  await map.getByRole("button", { name: /^Projects,/ }).press("Enter");
  await expect(currentFolder(page)).toHaveText("Projects");
  await map.getByRole("button", { name: /^Brand campaign,/ }).press("Enter");
  await expect(currentFolder(page)).toHaveText("Brand campaign");
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
  await details.getByRole("button", { name: "Back to comparison", exact: true }).press("Enter");
  await expect(dialog).toBeVisible();
  await expect(original).toContainText(sourcePath);
  await expect(match).toContainText(sharedPath);
  await expect(shared).toHaveAttribute("aria-pressed", "true");
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
