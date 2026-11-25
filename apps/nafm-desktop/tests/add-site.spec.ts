import { expect, test, type Page } from "@playwright/test";

function addDialog(page: Page) {
  return page.getByRole("dialog", { name: "Add site", exact: true });
}

async function openSources(page: Page) {
  await page.getByRole("button", { name: "Workspace actions" }).click();
  await page.getByRole("button", { name: /^Sources\b/ }).click();
  return page.getByRole("dialog", { name: "Sources", exact: true });
}

function holdNextDashboardRefresh(page: Page) {
  return page.evaluateHandle(() => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, ...args: unknown[]) => Promise<unknown> };
    };
    const invoke = bridge.invoke.bind(bridge);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = { pending: false, release };
    bridge.invoke = async (command, ...args) => {
      const response = await invoke(command, ...args);
      if (command === "load_dashboard" && !read.pending) {
        read.pending = true;
        await gate;
      }
      return response;
    };
    return read;
  });
}

test("adding or dismissing a site leaves the atlas on the folder being explored", async ({ page }) => {
  await page.goto("/mock/");
  const map = page.getByRole("region", { name: "Circular storage map" });
  await map.getByRole("button", { name: /^Projects,/ }).press("Enter");
  const folder = page.getByRole("navigation", { name: "Folder path" }).locator('[aria-current="location"]');
  await expect(folder).toHaveText("Projects");
  await page.getByRole("button", { name: "Sites", exact: true }).click();
  const rail = page.getByRole("complementary", { name: "Sites" });
  const launch = rail.getByRole("button", { name: "Add site" });
  await launch.press("Enter");

  const dialog = addDialog(page);
  await expect(dialog).toBeVisible();
  await expect(page.locator("dialog:modal")).toHaveCount(1);
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox!.width).toBeLessThan(page.viewportSize()!.width * 0.75);
  const name = dialog.getByRole("textbox", { name: "Site name" });
  await expect(name).toBeFocused();
  await name.fill("Unfinished draft");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(launch).toBeFocused();
  await expect(folder).toHaveText("Projects");

  await launch.press("Enter");
  await expect(name).toHaveValue("");
  await dialog.getByRole("button", { name: "Close add site" }).click();
  await expect(launch).toBeFocused();

  await launch.press("Enter");
  await name.fill("Print masters");
  await dialog.getByRole("textbox", { name: "Folder path" }).fill("/demo/Prints");
  await dialog.getByRole("button", { name: "Add site", exact: true }).click();
  await expect(rail.getByRole("button", { name: "Open Print masters in Atlas" })).toBeVisible();
  await expect(folder).toHaveText("Projects");
});

test("adding a site from the compact rail reveals its row after inventory refresh", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 640 });
  await page.goto("/mock/");
  const map = page.getByRole("region", { name: "Circular storage map" });
  const folder = page.getByRole("navigation", { name: "Folder path" }).locator('[aria-current="location"]');
  await map.getByRole("button", { name: /^Projects,/ }).press("Enter");
  await expect(folder).toHaveText("Projects");
  await page.getByRole("button", { name: "Contents & details", exact: true }).click();
  const contents = page.getByRole("tabpanel", { name: "Contents", exact: true });
  await expect(contents.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sites", exact: true }).click();
  const rail = page.getByRole("complementary", { name: "Sites" });
  const launch = rail.getByRole("button", { name: "Add site" });

  const refresh = await holdNextDashboardRefresh(page);

  await launch.click();
  const dialog = addDialog(page);
  await dialog.getByRole("textbox", { name: "Site name" }).fill("Print masters");
  await dialog.getByRole("textbox", { name: "Folder path" }).fill("/demo/Prints");
  await dialog.getByRole("button", { name: "Add site", exact: true }).click();
  const row = rail.getByRole("listitem").filter({ has: page.getByRole("button", { name: "Open Print masters in Atlas" }) });
  try {
    await expect.poll(() => refresh.evaluate((read) => read.pending)).toBe(true);
    await expect(dialog).toBeHidden();
    await expect(row).toHaveCount(0);
  } finally {
    await refresh.evaluate((read) => read.release());
  }

  const created = row.getByRole("button", { name: "Open Print masters in Atlas" });
  await expect(created).toBeFocused();
  await expect(row).toBeInViewport({ ratio: 0.98 });
  await expect(row.getByRole("status")).toHaveText("Site added");
  await expect(created).not.toHaveAttribute("aria-current", "true");
  await expect(folder).toHaveText("Projects");
  await expect(contents).toBeVisible();

  await page.keyboard.press("Enter");
  await expect(created).toHaveAttribute("aria-current", "true");
  await expect(folder).toHaveText("Print masters");
  await expect(rail).toBeVisible();
  await expect(contents).toBeVisible();
  await expect(map.getByRole("button", { name: "Scan this site", exact: true })).toBeEnabled();
});

test("a delayed site refresh leaves focus in Contents when browsing resumes", async ({ page }) => {
  await page.goto("/mock/");
  const folder = page.getByRole("navigation", { name: "Folder path" }).locator('[aria-current="location"]');
  await expect(folder).toHaveText("Studio archive");
  await page.getByRole("button", { name: "Sites", exact: true }).click();
  const rail = page.getByRole("complementary", { name: "Sites" });
  await expect(rail.getByRole("button", { name: "Open Studio archive in Atlas" })).toBeFocused();
  const refresh = await holdNextDashboardRefresh(page);

  await rail.getByRole("button", { name: "Add site" }).click();
  const dialog = addDialog(page);
  await dialog.getByRole("textbox", { name: "Site name" }).fill("Print masters");
  await dialog.getByRole("textbox", { name: "Folder path" }).fill("/demo/Prints");
  await dialog.getByRole("button", { name: "Add site", exact: true }).click();
  const contents = page.getByRole("tab", { name: "Contents", exact: true });
  try {
    await expect.poll(() => refresh.evaluate((read) => read.pending)).toBe(true);
    await expect(dialog).toBeHidden();
    await page.getByRole("button", { name: "Contents & details", exact: true }).click();
    await expect(contents).toBeFocused();
  } finally {
    await refresh.evaluate((read) => read.release());
  }

  const created = rail.getByRole("button", { name: "Open Print masters in Atlas" });
  await expect(created).toBeVisible();
  await expect(contents).toBeFocused();
  const pane = page.getByRole("tabpanel", { name: "Contents", exact: true });
  await expect(pane.getByRole("heading", { name: "Studio archive", exact: true })).toBeVisible();
});

test("the source library stays open while a site is cancelled or created", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 640 });
  await page.goto("/mock/");
  const sources = await openSources(page);
  const launch = sources.getByRole("button", { name: "Add site", exact: true });
  await launch.click();
  const dialog = addDialog(page);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(launch).toBeFocused();

  await launch.click();
  const save = dialog.getByRole("button", { name: "Add site", exact: true });
  await expect(save).toBeDisabled();
  const name = dialog.getByRole("textbox", { name: "Site name" });
  await name.fill("Studio archive");
  await dialog.getByRole("button", { name: "Browse…" }).click();
  await save.click();
  await expect(dialog.getByRole("alert")).toContainText("already exists");
  await name.fill("Print masters");
  await save.click();

  await expect(dialog).toBeHidden();
  const created = sources.getByRole("button", { name: "Open Print masters in Atlas" });
  await expect(created).toBeFocused();
  await expect(created).toBeInViewport({ ratio: 0.98 });
  await expect(sources.getByRole("status").filter({ hasText: /^Site added$/ })).toBeVisible();
  await expect(created).not.toHaveAttribute("aria-current", "true");
  await expect(sources).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sources).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Folder path" }).locator('[aria-current="location"]')).toHaveText("Studio archive");
});

test("Settings selects the new site after adding an SMB root", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 480 });
  await page.goto("/mock/");
  await page.getByRole("button", { name: "Workspace actions" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Sites", exact: true }).click();
  const launch = settings.getByRole("button", { name: "Add site", exact: true });
  await launch.click();
  const dialog = addDialog(page);
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(launch).toBeFocused();

  await launch.click();
  await dialog.getByRole("textbox", { name: "Site name" }).fill("Print shop");
  await dialog.getByRole("radio", { name: "SMB share" }).check();
  await dialog.getByRole("textbox", { name: "SMB URL" }).fill("smb://media.example.test/Studio/Prints");
  await dialog.getByRole("checkbox", { name: "Include hidden files" }).uncheck();
  await dialog.getByRole("button", { name: "Add site", exact: true }).click();
  await expect(dialog).toBeHidden();
  const created = settings.getByRole("button", { name: /^Print shop\b/ });
  await expect(created).toBeFocused();
  await expect(created).toBeInViewport({ ratio: 0.98 });
  await expect(created).toHaveAttribute("aria-current", "true");
  await expect(settings.getByRole("heading", { name: "Print shop" })).toBeVisible();
  await expect(settings.getByText("SMB · Hidden skipped")).toBeVisible();
});

test("an empty atlas opens Add site within a short viewport", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 320 });
  await page.goto("/mock/?scenario=empty");
  const launch = page.getByRole("button", { name: "Add site", exact: true });
  await launch.click();
  const dialog = addDialog(page);
  await dialog.getByRole("radio", { name: "SMB share" }).press("Space");
  await dialog.getByRole("textbox", { name: "SMB URL" }).fill("smb://media.example.test/Prints");
  await dialog.getByRole("textbox", { name: "Username" }).scrollIntoViewIfNeeded();
  await expect(dialog).toBeInViewport({ ratio: 1 });
  await expect(dialog.getByRole("button", { name: "Close add site" })).toBeInViewport({ ratio: 1 });
  await expect(dialog.getByRole("button", { name: "Add site", exact: true })).toBeInViewport({ ratio: 1 });
  const box = await dialog.boundingBox();
  expect(box!.width).toBeLessThan(640);
  expect(box!.height).toBeLessThan(320);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(launch).toBeFocused();

  await launch.press("Enter");
  await dialog.getByRole("textbox", { name: "Site name" }).fill("First archive");
  await dialog.getByRole("textbox", { name: "Folder path" }).fill("/demo/Archive");
  await dialog.getByRole("button", { name: "Add site", exact: true }).click();
  const sites = page.getByRole("button", { name: "Sites", exact: true });
  await expect(page.getByRole("button", { name: "Scan this site", exact: true })).toBeFocused();
  await sites.press("Enter");
  const selected = page.getByRole("button", { name: "Open First archive in Atlas" });
  await expect(selected).toHaveAttribute("aria-current", "true");
});

test("the first scan can be started, stopped and restarted from the atlas", async ({ page }) => {
  await page.goto("/mock/?scenario=empty");
  await page.getByRole("button", { name: "Add site", exact: true }).click();
  const dialog = addDialog(page);
  await dialog.getByRole("textbox", { name: "Site name" }).fill("Field survey");
  await dialog.getByRole("button", { name: "Browse…" }).click();
  await dialog.getByRole("button", { name: "Add site", exact: true }).click();

  const map = page.getByRole("region", { name: "Circular storage map" });
  const scan = map.getByRole("button", { name: "Scan this site", exact: true });
  await expect(map.getByText("Ready to scan", { exact: true })).toBeVisible();
  await scan.press("Enter");
  await expect(map.getByText("Finding files", { exact: true })).toBeVisible();
  await map.getByRole("button", { name: "Stop scan", exact: true }).click();
  const restart = map.getByRole("button", { name: /^Restart scan\b/ });
  await expect(restart).toBeEnabled();

  await restart.press("Enter");
  await expect(map.getByRole("button", { name: /^Sample Folder,/ })).toBeFocused({ timeout: 15_000 });
  const folder = map.getByRole("button", { name: /^Drone imagery,/ });
  await expect(folder).toBeVisible();
  await expect(scan).toBeHidden();
  await folder.press("Enter");
  await expect(page.getByRole("navigation", { name: "Folder path" }).locator('[aria-current="location"]'))
    .toHaveText("Drone imagery");
});
