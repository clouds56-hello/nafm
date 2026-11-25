import { expect, test, type Page } from "@playwright/test";

const sourcePath = "/demo/Studio Archive/Projects/Brand campaign";
const backupPath = "/demo/Studio Archive/Projects/Backup campaign";
const mirrorPath = "smb://media.example.test/Studio/Campaign mirror";
const openError = "The matching folder is temporarily unavailable.";

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

async function openComparison(page: Page, source = {
  url: "/mock/", folders: ["Projects", "Brand campaign"], path: sourcePath,
}) {
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

test("the compact comparison can switch matches from above the folder cards", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  const dialog = await openComparison(page);
  const picker = dialog.getByRole("combobox", { name: "Compare with", exact: true });
  await expect(picker).toBeInViewport();
  await expect(picker.locator("option:checked")).toContainText("Campaign mirror");
  await expect(dialog.getByRole("list", { name: "Matching folders" })).toBeHidden();

  await picker.selectOption({ label: "Backup campaign · Studio archive · 62%" });
  await expect(dialog.getByRole("region", { name: "Matching folder", exact: true })).toContainText(backupPath);
  await expect(dialog.getByRole("region", { name: "Selected folder", exact: true })).toContainText("62%");
  await expect(picker).toBeInViewport();
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
