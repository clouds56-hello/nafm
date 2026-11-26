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

for (const surface of ["toolbar", "Details"] as const) {
  test(`Atlas history from Open in keeps focus in the ${surface}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 620 });
    const map = page.getByRole("region", { name: "Circular storage map" });
    const path = page.getByRole("navigation", { name: "Folder path" });
    const current = path.locator('[aria-current="location"]');
    await expect(current).toHaveText("Studio archive");
    for (const folder of ["Projects", "Brand campaign"]) {
      await map.getByRole("button", { name: new RegExp(`^${folder},`) }).press("Enter");
      await expect(current).toHaveText(folder);
    }
    await page.getByRole("button", { name: "Sites", exact: true }).press("Enter");
    await page.getByRole("button", { name: "Contents & details", exact: true }).press("Enter");
    const inspector = page.getByRole("complementary", { name: "Inspector", exact: true });
    const details = inspector.getByRole("region", { name: "Storage details", exact: true });
    if (surface === "Details") await inspector.getByRole("tab", { name: "Details", exact: true }).press("Enter");

    const area = surface === "toolbar" ? path : details;
    const brand = area.getByRole("button", { name: "Open Brand campaign in…", exact: true });
    const projects = area.getByRole("button", { name: "Open Projects in…", exact: true });
    const menu = page.getByRole("menu");
    if (surface === "toolbar") {
      await brand.press("Alt+ArrowUp");
      await expect(current).toHaveText("Projects");
      await expect(projects).toBeFocused();
      await expect(menu).toBeHidden();
      await page.keyboard.press("Alt+ArrowLeft");
      await expect(current).toHaveText("Brand campaign");
      await expect(brand).toBeFocused();
    }

    await brand.press("ArrowDown");
    await expect(menu.getByRole("menuitem", { name: "File manager", exact: true })).toBeFocused();
    await page.keyboard.press("Alt+ArrowLeft");
    await expect(current).toHaveText("Projects");
    await expect(menu).toBeHidden();
    await expect(projects).toBeFocused();
    await expect(projects).toBeInViewport();

    await projects.press("ArrowDown");
    await page.keyboard.press("Alt+ArrowRight");
    await expect(current).toHaveText("Brand campaign");
    await expect(menu).toBeHidden();
    await expect(brand).toBeFocused();

    await brand.press("ArrowUp");
    await expect(menu.getByRole("menuitem", { name: "Terminal", exact: true })).toBeFocused();
    await page.keyboard.press("Alt+ArrowUp");
    await expect(current).toHaveText("Projects");
    await expect(projects).toBeFocused();
    await projects.press("ArrowUp");
    await page.keyboard.press("Alt+ArrowUp");
    await expect(current).toHaveText("Studio archive");
    await expect(menu).toBeHidden();
    await expect(surface === "toolbar" ? path.getByRole("heading", { name: "Studio archive", exact: true }) : details).toBeFocused();
    await expect(page.getByRole("complementary", { name: "Sites", exact: true })).toBeVisible();
    await expect(inspector).toBeVisible();
  });
}

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
  await expect(page.getByRole("status").filter({ hasText: "The folder is unavailable." }))
    .toContainText("Couldn’t open Projects in Terminal.");
  await expect(launcher).toBeFocused();
  await launcher.press("Enter");
  await page.getByRole("menuitem", { name: "File manager", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: /file manager/i })).toContainText("Projects");
});

test("launch feedback stays with compact Contents and Dismiss returns to the opener", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 480 });
  await page.goto("/mock/?scenario=large");
  await page.getByRole("button", { name: /^Photo Library,/ }).press("Enter");
  await page.getByRole("button", { name: "Sites", exact: true }).press("Enter");
  await page.getByRole("button", { name: "Contents & details", exact: true }).press("Enter");
  const inspector = page.getByRole("complementary", { name: "Inspector", exact: true });
  const contents = inspector.getByRole("tabpanel", { name: "Contents", exact: true });
  const opener = contents.getByRole("button", { name: "Open Photo Library in…", exact: true });
  await opener.press("Enter");
  await page.getByRole("menuitem", { name: "File manager", exact: true }).press("Enter");

  const feedback = inspector.getByRole("status").filter({ hasText: /would open Photo Library in the file manager/i });
  await expect(feedback).toBeInViewport({ ratio: 0.99 });
  await expect(opener).toBeFocused();
  const paneTop = await contents.evaluate((pane) => pane.getBoundingClientRect().top);
  const bounds = (await feedback.boundingBox())!;
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(paneTop + 1);
  await expect(page.getByRole("complementary", { name: "Sites", exact: true })).toBeVisible();

  await feedback.getByRole("button", { name: "Dismiss", exact: true }).press("Enter");
  await expect(feedback).toBeHidden();
  await expect(opener).toBeFocused();
  await expect(opener).toBeInViewport({ ratio: 0.99 });
  await page.keyboard.press("Space");
  await expect(page.getByRole("menuitem", { name: "File manager", exact: true })).toBeFocused();
});

test("Open in reports the newest folder launch from request through completion", async ({ page }) => {
  await openContents(page);
  const contents = page.getByRole("tabpanel", { name: "Contents" });
  const projects = contents.getByRole("button", { name: "Open Projects in…", exact: true });
  const library = contents.getByRole("button", { name: "Open Photo Library in…", exact: true });
  const feedback = page.locator(".atlas-alert[role=status]");
  const launches = await page.evaluateHandle(() => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke(command: string, args?: unknown): Promise<unknown> };
    };
    const invoke = bridge.invoke.bind(bridge);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let count = 0;
    bridge.invoke = async (command, args) => {
      if (command !== "open_folder_in") return invoke(command, args);
      if (++count === 1) {
        await gate;
        throw new Error("The Projects drive is no longer available.");
      }
      return null; // The native command returns no payload on success.
    };
    return { release };
  });

  try {
    await projects.press("Enter");
    await page.getByRole("menuitem", { name: "Terminal", exact: true }).press("Enter");
    await expect(feedback).toContainText("Opening Projects in Terminal…");
    await expect(projects).toBeDisabled();
    await expect(projects).toBeFocused();

    await library.press("Enter");
    await page.getByRole("menuitem", { name: "File manager", exact: true }).press("Enter");
    await expect(feedback).toContainText("Opened Photo Library in the file manager.");
  } finally {
    await launches.evaluate(({ release }) => release());
  }

  await expect(projects).toBeEnabled();
  await expect(feedback).toContainText("Opened Photo Library in the file manager.");
  await expect(library).toBeFocused();
  await expect(contents.getByRole("heading", { name: "Studio archive", exact: true })).toBeVisible();
});

test("a folder launch stays pending across surfaces and workspace switches", async ({ page }) => {
  const map = page.getByRole("region", { name: "Circular storage map" });
  const path = page.getByRole("navigation", { name: "Folder path" });
  await map.getByRole("button", { name: /^Photo Library,/ }).press("Enter");
  const toolbarOpener = path.getByRole("button", { name: "Open Photo Library in…", exact: true });
  await expect(toolbarOpener).toBeEnabled();
  const launches = await page.evaluateHandle(() => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke(command: string, args?: unknown): Promise<unknown> };
    };
    const invoke = bridge.invoke.bind(bridge);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const requests: unknown[] = [];
    bridge.invoke = async (command, args) => {
      if (command !== "open_folder_in") return invoke(command, args);
      requests.push(args);
      await gate;
      return invoke(command, args);
    };
    return { release, requests };
  });
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const contents = inspector.getByRole("tabpanel", { name: "Contents" });
  const contentsOpener = contents.getByRole("button", { name: "Open Photo Library in…", exact: true });
  const manager = page.getByRole("menuitem", { name: "File manager", exact: true });

  try {
    await toolbarOpener.press("Enter");
    await manager.press("Enter");
    await expect(toolbarOpener).toBeDisabled();
    await page.getByRole("button", { name: "Contents & details", exact: true }).press("Enter");
    await expect(contentsOpener).toBeDisabled();
    await contentsOpener.press("Enter");
    await expect(manager).toBeHidden();

    await inspector.getByRole("tab", { name: "Details", exact: true }).press("Enter");
    await expect(inspector.getByRole("button", { name: "Open Photo Library in…", exact: true })).toBeDisabled();
    await path.getByRole("button", { name: "Up to Studio archive", exact: true }).press("Enter");
    const rootContents = inspector.getByRole("tab", { name: "Contents", exact: true });
    await rootContents.press("Enter");
    await expect(contentsOpener).toBeDisabled();
    await expect(contents.getByRole("button", { name: "Open Projects in…", exact: true })).toBeEnabled();

    const workspace = page.getByRole("combobox", { name: "Workspace", exact: true });
    await workspace.selectOption({ label: "Field notes" });
    await expect(map.getByText("No source selected")).toBeVisible();
    await workspace.selectOption({ label: "Studio workspace" });
    await expect(path.locator('[aria-current="location"]')).toHaveText("Studio archive");
    await expect(contentsOpener).toBeDisabled();
    expect(await launches.evaluate(({ requests }) => requests.length)).toBe(1);
  } finally {
    await launches.evaluate(({ release }) => release());
  }
  await expect(contentsOpener).toBeEnabled();
});

test("scrolling past an open row menu keeps keyboard focus in visible Contents", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 620 });
  await page.goto("/mock/?scenario=large");
  const map = page.getByRole("region", { name: "Circular storage map" });
  await map.getByRole("button", { name: /^Photo Library,/ }).press("Enter");
  await page.getByRole("button", { name: "Contents & details" }).press("Enter");
  const contents = page.getByRole("tabpanel", { name: "Contents", exact: true });
  const grid = contents.getByRole("grid", { name: "Photo Library entries" });
  await expect(grid).toHaveAttribute("aria-rowcount", "4096");
  const row = grid.getByRole("button", { name: /^Studio portraits/ });
  const opener = grid.getByRole("button", { name: "Open Studio portraits in…", exact: true });
  const menu = page.getByRole("menu", { name: "Open Studio portraits in…", exact: true });
  await row.focus();
  await page.keyboard.press("Tab");
  await expect(opener).toBeFocused();
  await page.keyboard.press("Space");
  await expect(menu.getByRole("menuitem", { name: "File manager", exact: true })).toBeFocused();

  const firstVisible = grid.getByRole("button", { name: /^Reference images/ });
  const rowHeight = await grid.evaluate((list) =>
    Number.parseFloat(getComputedStyle(list).getPropertyValue("--directory-row-height")));
  const pane = (await contents.boundingBox())!;
  const pageTop = await page.evaluate(() => window.scrollY);
  await page.mouse.move(pane.x + 55, pane.y + pane.height - 34);
  await page.mouse.wheel(0, 3 * rowHeight);

  await expect(menu).toBeHidden();
  await expect.poll(() => contents.evaluate((el) => el.scrollTop)).toBe(3 * rowHeight);
  await expect(opener).toHaveCount(1); // The clipped row is still in the virtual buffer.
  await expect(firstVisible).toBeFocused();
  await expect(firstVisible).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => window.scrollY)).toBe(pageTop);
  await page.keyboard.press("ArrowDown");
  await expect(grid.locator('[aria-rowindex="5"] [data-entry-id]')).toBeFocused();
});

test("scrolling past the Details open menu keeps keyboard focus on the pane", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 480 });
  const map = page.getByRole("region", { name: "Circular storage map" });
  await map.getByRole("button", { name: /^Photo Library,/ }).press("Enter");
  await page.getByRole("button", { name: "Contents & details" }).press("Enter");
  const inspector = page.getByRole("complementary", { name: "Inspector", exact: true });
  await inspector.getByRole("tab", { name: "Details", exact: true }).press("Enter");
  const details = inspector.getByRole("tabpanel", { name: "Details", exact: true });
  const opener = details.getByRole("button", { name: "Open Photo Library in…", exact: true });
  const menu = page.getByRole("menu", { name: "Open Photo Library in…", exact: true });
  await expect(opener).toBeInViewport({ ratio: 1 });
  await opener.evaluate((button) => button.focus({ preventScroll: true }));
  await page.keyboard.press("Space");
  await expect(menu.getByRole("menuitem", { name: "File manager", exact: true })).toBeFocused();

  const pageTop = await page.evaluate(() => window.scrollY);
  const end = await details.evaluate((pane) => {
    pane.scrollTop = pane.scrollHeight;
    return pane.scrollTop;
  });
  expect(end).toBeGreaterThan(0);
  await expect(menu).toBeHidden();
  await expect(details).toBeFocused();
  expect(await details.evaluate((pane) => pane.scrollTop)).toBe(end);
  expect(await page.evaluate(() => window.scrollY)).toBe(pageTop);
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();
});

test.describe("touch folder launch", () => {
  test.use({ viewport: { width: 390, height: 420 }, hasTouch: true });

  test("sticky openers keep their menu during a scroll and moving rows dismiss it", async ({ page }) => {
    const path = page.getByRole("navigation", { name: "Folder path" });
    await page.getByRole("button", { name: /^Photo Library,/ }).press("Enter");
    await expect(path.locator('[aria-current="location"]')).toHaveText("Photo Library");
    await page.getByRole("button", { name: "Contents & details" }).tap();
    const pane = page.getByRole("tabpanel", { name: "Contents" });
    const menu = page.getByRole("menu", { name: "Open Photo Library in…" });
    const manager = menu.getByRole("menuitem", { name: "File manager" });

    const headingOpener = pane.getByRole("button", { name: "Open Photo Library in…" });
    await headingOpener.tap();
    await expect(manager).toBeFocused();
    await pane.evaluate((el) => { el.scrollTop = 50; });
    await expect.poll(() => pane.evaluate((el) => el.scrollTop)).toBe(50);
    await expect(manager).toBeInViewport({ ratio: 0.99 });
    await expect(manager).toBeFocused();
    await page.keyboard.press("Escape");

    await pane.evaluate((el) => { el.scrollTop = 0; });
    const rowOpener = pane.getByRole("button", { name: "Open Editorial in…" });
    await rowOpener.tap();
    const rowMenu = page.getByRole("menu", { name: "Open Editorial in…" });
    await expect(rowMenu).toBeVisible();
    await pane.evaluate((el) => { el.scrollTop = 50; });
    await expect(rowMenu).toBeHidden();
    await expect(rowOpener).toBeFocused();

    await path.getByRole("button", { name: "Open Photo Library in…" }).tap();
    await expect(manager).toBeFocused();
    const before = await page.evaluate(() => window.scrollY);
    await page.evaluate(() => window.scrollBy(0, window.scrollY > 50 ? -50 : 50));
    await expect.poll(() => page.evaluate(() => window.scrollY)).not.toBe(before);
    await manager.tap();
    await expect(page.getByRole("status").filter({ hasText: /file manager/i })).toContainText("Photo Library");
  });
});
