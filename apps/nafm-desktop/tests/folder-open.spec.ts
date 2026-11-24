import { expect, test, type Page } from "@playwright/test";

async function recordFolderLaunches(page: Page) {
  return page.evaluateHandle(() => {
    const bridge = (window as unknown as {
      __TAURI_INTERNALS__: { invoke(command: string, args?: unknown): Promise<unknown> };
    }).__TAURI_INTERNALS__;
    const invoke = bridge.invoke.bind(bridge);
    const launches: unknown[] = [];
    bridge.invoke = (command, args) => {
      if (command === "open_folder_in") launches.push(args);
      return invoke(command, args);
    };
    return launches;
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/mock/");
});

async function openContents(page: Page) {
  await page.getByRole("button", { name: "Contents & details" }).click();
  await expect(page.getByRole("grid", { name: "Studio archive entries" })).toBeVisible();
}

test("a folder opened from the atlas can launch from the toolbar with the panels closed", async ({ page }) => {
  const path = page.getByRole("navigation", { name: "Folder path" });
  const map = page.getByRole("region", { name: "Circular storage map" });
  await map.getByRole("button", { name: /^Photo Library,/ }).press("Enter");
  const launcher = path.getByRole("button", { name: "Open Photo Library in…" });
  await launcher.click();
  await page.getByRole("menuitem", { name: "File manager", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: /file manager/i })).toContainText("Photo Library");
  await expect(path.locator('[aria-current="location"]')).toHaveText("Photo Library");
  await expect(page.getByRole("complementary", { name: "Inspector" })).toBeHidden();
  await expect(page.getByRole("complementary", { name: "Sites" })).toBeHidden();
});

test("opening a folder externally from Contents keeps the atlas on the current folder", async ({ page }) => {
  await openContents(page);
  const launches = await recordFolderLaunches(page);
  const contents = page.getByRole("tabpanel", { name: "Contents" });
  const projects = contents.getByRole("button", { name: /^Projects/ });
  const folder = { workspace_name: "Studio workspace", site_id: "studio-archive", node_id: await projects.getAttribute("data-entry-id") };
  const launcher = contents.getByRole("button", { name: "Open Projects in…" });
  const menu = page.getByRole("menu");
  await expect(contents.getByRole("button", { name: "Open Studio archive in…" })).toHaveCount(0);

  await projects.focus();
  await page.keyboard.press("Tab");
  await expect(launcher).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu.getByRole("menuitem", { name: "File manager", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(launcher).toBeFocused();
  expect(await launches.jsonValue()).toEqual([]);

  await launcher.click();
  await menu.getByRole("menuitem", { name: "File manager", exact: true }).click();
  await expect(menu).toBeHidden();
  await expect(page.getByRole("status").filter({ hasText: /file manager/i })).toContainText("Projects");
  await expect(contents.getByRole("heading", { name: "Studio archive" })).toBeVisible();
  expect(await launches.jsonValue()).toEqual([{ request: { ...folder, destination: "file_manager" } }]);

  await projects.click();
  await expect(contents.getByRole("heading", { name: "Projects" })).toBeVisible();
  await contents.getByRole("button", { name: "Open Projects in…" }).press("Enter");
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "Terminal", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: /terminal/i })).toContainText("Projects");
  expect(await launches.jsonValue()).toEqual([
    { request: { ...folder, destination: "file_manager" } },
    { request: { ...folder, destination: "terminal" } },
  ]);
});

test("Details opens external folders and leaves file browsing intact", async ({ page }) => {
  await openContents(page);
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const contents = inspector.getByRole("tabpanel", { name: "Contents" });
  const details = inspector.getByRole("region", { name: "Storage details" });
  await contents.getByRole("button", { name: /^Documents/ }).click();
  await inspector.getByRole("tab", { name: "Details" }).click();
  await details.getByRole("button", { name: "Open Documents in…" }).click();
  await page.getByRole("menuitem", { name: "Terminal", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: /terminal/i })).toContainText("Documents");
  await expect(details.getByRole("heading", { name: "Documents" })).toBeVisible();

  await inspector.getByRole("tab", { name: "Contents" }).click();
  const file = contents.getByRole("button", { name: /^Brand guidelines\.pdf/ });
  await expect(contents.getByRole("button", { name: "Open Brand guidelines.pdf in…" })).toHaveCount(0);
  await file.click();
  await expect(details.getByRole("heading", { name: "Brand guidelines.pdf" })).toBeVisible();
  await expect(details.getByRole("button", { name: / in…$/ })).toHaveCount(0);
  await inspector.getByRole("button", { name: "Back to Contents" }).click();
  await expect(file).toBeFocused();
});

test("network folders open in the file manager and explain terminal availability", async ({ page }) => {
  await openContents(page);
  const launches = await recordFolderLaunches(page);
  await page.getByRole("button", { name: "Sites", exact: true }).click();
  await page.getByRole("button", { name: "Open Team share in Atlas" }).click();
  const contents = page.getByRole("tabpanel", { name: "Contents" });
  await contents.getByRole("button", { name: /^Studio\b/ }).click();
  const nodeId = await contents.getByRole("button", { name: /^Incoming/ }).getAttribute("data-entry-id");
  await contents.getByRole("button", { name: "Open Incoming in…" }).click();
  const terminal = page.getByRole("menuitem", { name: "Terminal", exact: true });
  await expect(terminal).toBeDisabled();
  await expect(terminal).toHaveAccessibleDescription(/local|mount/i);
  await page.getByRole("menuitem", { name: "File manager", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: /file manager/i })).toContainText("Incoming");
  expect(await launches.jsonValue()).toEqual([{
    request: { workspace_name: "Studio workspace", site_id: "team-share", node_id: nodeId, destination: "file_manager" },
  }]);
  await expect(contents.getByRole("heading", { name: "Studio", exact: true })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Sites" })).toBeVisible();
});

test("a failed launch leaves the folder available for another choice", async ({ page }) => {
  await openContents(page);
  await page.evaluate(() => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke(command: string, args?: unknown): Promise<unknown> };
    };
    const invoke = bridge.invoke.bind(bridge);
    bridge.invoke = async (command, args) => {
      if (command === "open_folder_in") {
        bridge.invoke = invoke;
        throw new Error("The folder is unavailable.");
      }
      return invoke(command, args);
    };
  });
  const contents = page.getByRole("tabpanel", { name: "Contents" });
  const launcher = contents.getByRole("button", { name: "Open Projects in…" });
  await launcher.click();
  await page.getByRole("menuitem", { name: "Terminal", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "The folder is unavailable." })).toBeVisible();
  await expect(launcher).toBeFocused();
  await launcher.press("Enter");
  await page.getByRole("menuitem", { name: "File manager", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: /file manager/i })).toContainText("Projects");
});
