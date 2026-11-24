import { expect, test, type Locator, type Page } from "@playwright/test";

function arc(page: Page, name: RegExp) {
  return page.getByRole("region", { name: "Circular storage map" }).getByRole("button", { name });
}

function currentFolder(page: Page) {
  return page.getByRole("navigation", { name: "Folder path" }).locator('[aria-current="location"]');
}

async function scrollProjectsToEnd(page: Page) {
  const contents = page.getByRole("tabpanel", { name: "Contents" });
  const rows = contents.getByRole("row");
  await expect(async () => {
    await contents.hover();
    await page.mouse.wheel(0, 600);
    await expect(rows).toHaveCount(19, { timeout: 500 });
    await expect(contents.getByRole("button", { name: /^2024 January/ })).toBeInViewport({ timeout: 500 });
  }).toPass({ timeout: 7000 });
  // Record the settled position after the wheel finishes scrolling.
  await expect.poll(() => contents.evaluate((pane) => pane.scrollHeight - pane.clientHeight - pane.scrollTop))
    .toBeLessThanOrEqual(1);
  const scrollTop = await contents.evaluate((pane) => pane.scrollTop);
  expect(scrollTop).toBeGreaterThan(0);
  return scrollTop;
}

// A curved SVG sector's bounding box can put its center inside a different ring.
async function arcPoint(sector: Locator) {
  const ring = sector.locator(".radial-atlas__ring");
  return ring.evaluate((element) => {
    const path = element as SVGPathElement;
    const middle = path.getPointAtLength(path.getTotalLength() / 2);
    const point = middle.matrixTransform(path.getScreenCTM()!);
    return { x: point.x, y: point.y };
  });
}

async function clickArc(page: Page, name: RegExp) {
  const { x, y } = await arcPoint(arc(page, name));
  await page.mouse.click(x, y);
}

async function tapArc(page: Page, name: RegExp) {
  const { x, y } = await arcPoint(arc(page, name));
  await page.touchscreen.tap(x, y);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/mock/");
  await expect(currentFolder(page)).toHaveText("Studio archive");
});

test("keyboard exploration takes over a stationary pointer and returns to the same branch", async ({ page }) => {
  const projects = arc(page, /^Projects,/);
  const { x, y } = await arcPoint(projects);
  await page.mouse.move(x, y);
  const preview = page.locator(".atlas-sector-preview");
  await expect(preview).toContainText("Projects");

  await projects.focus();
  await page.keyboard.press("ArrowRight");
  await expect(arc(page, /^Photo Library,/)).toBeFocused();
  await expect(preview).toContainText("Photo Library");
  await expect(page.locator(".radial-atlas__name")).toHaveText("Studio archive");

  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowDown");
  await expect(arc(page, /^Brand campaign,/)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(projects).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(currentFolder(page)).toHaveText("Projects");
  await expect(arc(page, /^Brand campaign,/)).toBeFocused();
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(currentFolder(page)).toHaveText("Studio archive");
  await expect(projects).toBeFocused();
});

test.describe("touch exploration", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 750 } });

  test("preview can be replaced, dismissed, or opened from the map", async ({ page }) => {
    const preview = page.locator(".atlas-sector-preview");
    await tapArc(page, /^Projects,/);
    await expect(preview).toContainText("Projects");
    await expect(preview).toContainText(/% of Studio archive/);
    await expect(currentFolder(page)).toHaveText("Studio archive");
    await tapArc(page, /^Photo Library,/);
    await expect(preview).toContainText("Photo Library");
    await preview.getByRole("button", { name: "Dismiss preview" }).tap();
    await expect(preview).toBeHidden();

    await tapArc(page, /^Projects,/);
    await preview.getByRole("button", { name: "Open folder" }).tap();
    await expect(currentFolder(page)).toHaveText("Projects");
    await tapArc(page, /^Brand campaign,/);
    await tapArc(page, /^Brand campaign,/);
    await expect(currentFolder(page)).toHaveText("Brand campaign");
    await tapArc(page, /^Trailer master\.mov,/);
    const inspector = page.getByRole("complementary", { name: "Inspector" });
    await expect(inspector).toBeHidden();
    await preview.getByRole("button", { name: "View details" }).tap();
    await expect(inspector.getByRole("heading", { name: "Trailer master.mov" })).toBeVisible();
  });

  test("returning from a file in a later batch restores the scrolled Contents sheet", async ({ page }) => {
    await page.setViewportSize({ width: 680, height: 320 });
    await page.getByRole("button", { name: "Contents & details" }).tap();
    const inspector = page.getByRole("complementary", { name: "Inspector" });
    const grid = inspector.getByRole("grid");
    await grid.getByRole("button", { name: /^Photo Library/ }).tap();
    await expect(currentFolder(page)).toHaveText("Photo Library");
    const file = grid.getByRole("button", { name: /^Proof 093\.jpg/ });
    const contents = inspector.getByRole("tabpanel", { name: "Contents" });
    await expect(file).toHaveCount(0);
    await expect.poll(async () => {
      await contents.evaluate((pane) => { pane.scrollTop = pane.scrollHeight; });
      return file.count();
    }).toBe(1);
    await file.scrollIntoViewIfNeeded();
    const scrollTop = await contents.evaluate((pane) => pane.scrollTop);
    expect(scrollTop).toBeGreaterThan(0);
    await file.tap();
    await expect(inspector.getByRole("heading", { name: "Proof 093.jpg" })).toBeVisible();
    await inspector.getByRole("button", { name: "Back to Contents" }).tap();
    await expect(file).toBeFocused();
    await expect.poll(() => contents.evaluate((pane) => pane.scrollTop)).toBeCloseTo(scrollTop, 0);
    await expect(file).toBeInViewport();
    await page.keyboard.press("ArrowDown");
    await expect(grid.getByRole("button", { name: /^Proof 094\.jpg/ })).toBeFocused();
  });
});

test("a slow folder reply cannot replace a newer destination or add a history entry", async ({ page }) => {
  let releaseFirst!: () => void;
  const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstPending = false;
  let firstReplied = false;
  await page.exposeFunction("holdFirstFolder", async () => {
    firstPending = true;
    await gate;
  });
  await page.exposeFunction("firstFolderReplied", () => { firstReplied = true; });
  // Delay one response at the same IPC boundary the desktop app uses.
  await page.evaluate(() => {
    const preview = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, ...args: unknown[]) => Promise<unknown> };
      holdFirstFolder: () => Promise<void>;
      firstFolderReplied: () => Promise<void>;
    };
    const bridge = preview.__TAURI_INTERNALS__;
    const invoke = bridge.invoke.bind(bridge);
    let held = false;
    bridge.invoke = async (command, ...args) => {
      if (held || command !== "get_storage_view_snapshot") return invoke(command, ...args);
      held = true;
      const response = await invoke(command, ...args);
      await preview.holdFirstFolder();
      await preview.firstFolderReplied();
      return response;
    };
  });

  try {
    await clickArc(page, /^Projects,/);
    await expect.poll(() => firstPending).toBe(true);
    await clickArc(page, /^Photo Library,/);
    await expect(currentFolder(page)).toHaveText("Photo Library");
  } finally {
    releaseFirst();
  }
  await expect.poll(() => firstReplied).toBe(true);
  await expect(currentFolder(page)).toHaveText("Photo Library");
  const back = page.getByRole("button", { name: "Previous location", exact: true });
  await back.click();
  await expect(currentFolder(page)).toHaveText("Studio archive");
  await expect(back).toBeDisabled();
});

test("source history restores the scrolled directory after switching sites", async ({ page }) => {
  await page.setViewportSize({ width: 680, height: 370 });
  await arc(page, /^Projects,/).press("Enter");
  await page.getByRole("button", { name: "Contents & details" }).click();
  const contents = page.getByRole("tabpanel", { name: "Contents" });
  await expect(contents.getByRole("button", { name: /^2024 January/ })).toHaveCount(0);
  const scrollTop = await scrollProjectsToEnd(page);
  await page.getByRole("button", { name: "Sites", exact: true }).click();
  await page.getByRole("button", { name: "Open Field drive in Atlas" }).click();
  await expect(currentFolder(page)).toHaveText("Field drive");
  await page.getByRole("button", { name: "Close sites" }).click();
  await page.getByRole("button", { name: "Previous location", exact: true }).click();
  await expect(currentFolder(page)).toHaveText("Projects");
  await page.getByRole("button", { name: "Contents & details" }).click();
  await expect(contents.getByRole("row")).toHaveCount(19);
  await expect.poll(() => contents.evaluate((pane) => pane.scrollTop)).toBeCloseTo(scrollTop, 0);
});

test("Smaller items opens inside the list and earlier entries can be reached by scrolling up", async ({ page }) => {
  await page.setViewportSize({ width: 680, height: 370 });
  await arc(page, /^Projects,/).press("Enter");
  await arc(page, /^Smaller items,/).press("Enter");
  const contents = page.getByRole("tabpanel", { name: "Contents" });
  const august = contents.getByRole("button", { name: /^2024 August/ });
  await expect(august).toBeInViewport();
  const first = contents.getByRole("button", { name: /^Brand campaign/ });
  await contents.hover();
  await expect(async () => {
    await page.mouse.wheel(0, -600);
    await expect(first).toBeInViewport({ timeout: 500 });
  }).toPass({ timeout: 7000 });
  await expect(august).toHaveCount(1);
});

test("a failed scroll read keeps the loaded rows and Retry appends more", async ({ page }) => {
  await page.setViewportSize({ width: 680, height: 320 });
  await arc(page, /^Projects,/).press("Enter");
  await expect(currentFolder(page)).toHaveText("Projects");
  await page.evaluate(() => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, ...args: unknown[]) => Promise<unknown> };
    };
    const invoke = bridge.invoke.bind(bridge);
    let fail = true;
    bridge.invoke = async (command, ...args) => {
      if (command === "get_storage_children" && fail) {
        fail = false;
        throw new Error("Directory read interrupted");
      }
      return invoke(command, ...args);
    };
  });
  await page.getByRole("button", { name: "Contents & details" }).click();
  const contents = page.getByRole("tabpanel", { name: "Contents" });
  const rows = contents.getByRole("row");
  await expect(rows.first()).toBeVisible();
  const count = await rows.count();
  await contents.hover();
  await page.mouse.wheel(0, 500);
  const error = contents.getByRole("alert");
  await expect(error).toContainText("Directory read interrupted");
  await expect(rows).toHaveCount(count);
  await expect(contents.getByRole("button", { name: /^Brand campaign/ })).toHaveCount(1);
  await error.getByRole("button", { name: "Retry" }).click();
  await expect(error).toBeHidden();
  await expect.poll(() => rows.count()).toBeGreaterThan(count);
  await expect(contents.getByRole("button", { name: /^Brand campaign/ })).toHaveCount(1);
});

test("Sites stays open across switches and closing it resumes the selected site's view", async ({ page }) => {
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const contents = inspector.getByRole("tabpanel", { name: "Contents" });
  const sites = page.getByRole("button", { name: "Sites", exact: true });
  const rail = page.getByRole("complementary", { name: "Sites" });
  const studioArchive = rail.getByRole("button", { name: "Open Studio archive in Atlas" });
  const fieldDrive = rail.getByRole("button", { name: "Open Field drive in Atlas" });
  const close = rail.getByRole("button", { name: "Close sites" });

  await clickArc(page, /^Projects,/);
  await page.getByRole("button", { name: "Contents & details" }).click();
  const scrollTop = await scrollProjectsToEnd(page);
  await sites.press("Enter");
  await expect(studioArchive).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(fieldDrive).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(currentFolder(page)).toHaveText("Field drive");
  await expect(fieldDrive).toHaveAttribute("aria-current", "true");
  await expect(fieldDrive).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(currentFolder(page)).toHaveText("Projects");
  await expect(studioArchive).toHaveAttribute("aria-current", "true");
  await expect(inspector).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(rail).toBeHidden();
  await expect(contents.getByRole("row")).toHaveCount(19);
  await expect.poll(() => contents.evaluate((pane) => pane.scrollTop)).toBeCloseTo(scrollTop, 0);

  await sites.click();
  await fieldDrive.click();
  await expect(currentFolder(page)).toHaveText("Field drive");
  await expect(fieldDrive).toBeFocused();
  await close.click();
  await expect(inspector).toBeHidden();
  await arc(page, /^Drone imagery,/).press("Enter");
  await expect(currentFolder(page)).toHaveText("Drone imagery");

  await page.getByRole("button", { name: "Workspace actions" }).click();
  await page.getByRole("button", { name: /^Sources\b/ }).click();
  await page.getByRole("button", { name: "Open Studio archive in Atlas" }).click();
  await expect(currentFolder(page)).toHaveText("Projects");
  await expect(contents.getByRole("button", { name: /^2024 January/ })).toBeInViewport();
  await expect.poll(() => contents.evaluate((pane) => pane.scrollTop)).toBeCloseTo(scrollTop, 0);

  await sites.click();
  await fieldDrive.click();
  await expect(currentFolder(page)).toHaveText("Drone imagery");
  await close.click();
  await expect(inspector).toBeHidden();
});

test("an indexed empty folder is distinguishable from a site awaiting its first scan", async ({ page }) => {
  await page.getByRole("button", { name: "Contents & details" }).click();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await inspector.getByRole("button", { name: /^Sandbox/ }).click();
  await inspector.getByRole("button", { name: "Close inspector" }).click();
  await expect(currentFolder(page)).toHaveText("Sandbox");
  const map = page.getByRole("region", { name: "Circular storage map" });
  await expect(map.getByText("Folder is empty", { exact: true })).toBeVisible();
  await expect(map.getByRole("button", { name: "Scan this site", exact: true })).toBeHidden();
});

test("the slow-read scenario keeps the current map interactive until navigation finishes", async ({ page }) => {
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.getByLabel("Scenario").selectOption("slow");
  await expect(currentFolder(page)).toHaveText("Studio archive");
  await clickArc(page, /^Projects,/);
  await expect(page.getByRole("status").filter({ hasText: "Reading inventory" })).toBeVisible();
  await expect(currentFolder(page)).toHaveText("Studio archive");
  await clickArc(page, /^Photo Library,/);
  await expect(currentFolder(page)).toHaveText("Photo Library");
  await expect(page.locator(".atlas-location-progress")).toBeHidden();
});

test("browsing beyond the first batch with the keyboard returns to the same entry", async ({ page }) => {
  await clickArc(page, /^Projects,/);
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const entries = inspector.getByRole("grid");
  const row = (name: RegExp) => entries.getByRole("button", { name });
  const december = row(/^2024 December/);
  const notes = row(/^Production notes\.txt/);
  const sheet = row(/^Contact sheet\.pdf/);

  await page.getByRole("button", { name: "Contents & details" }).press("Enter");
  await expect(row(/^Brand campaign/)).toBeFocused();
  await expect(inspector.getByRole("button", { name: /directory page/i })).toHaveCount(0);
  await row(/^Design references/).press("ArrowDown");
  await expect(row(/^Typography study/)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(december).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(sheet).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(notes).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(inspector.getByRole("heading", { name: "Production notes.txt" })).toBeVisible();

  await inspector.getByRole("button", { name: "Back to Contents" }).click();
  await expect(currentFolder(page)).toHaveText("2024 December");
  await expect(notes).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(sheet).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(inspector.getByRole("heading", { name: "Contact sheet.pdf" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeFocused();

  await page.keyboard.press("ArrowLeft");
  await expect(currentFolder(page)).toHaveText("Projects");
  await expect(december).toBeFocused();
  await expect(row(/^Brand campaign/)).toHaveCount(1);
});

test("Back and Forward retrace a file inspection before changing folders", async ({ page }) => {
  await clickArc(page, /^Projects,/);
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const launcher = page.getByRole("button", { name: "Contents & details" });
  const back = page.getByRole("button", { name: "Previous location", exact: true });
  const forward = page.getByRole("button", { name: "Next location", exact: true });
  const file = inspector.getByRole("grid").getByRole("button", { name: /^Camera originals\.mxf/ });
  const details = inspector.getByRole("heading", { name: "Camera originals.mxf" });

  await launcher.click();
  await inspector.getByRole("button", { name: /^Brand campaign/ }).click();
  await file.click();
  await expect(details).toBeVisible();
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(currentFolder(page)).toHaveText("Brand campaign");
  await expect(file).toBeFocused();
  await forward.click();
  await expect(details).toBeVisible();
  await back.click();
  await expect(currentFolder(page)).toHaveText("Brand campaign");
  await expect(file).toBeFocused();

  await page.keyboard.press("ArrowRight");
  await expect(details).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(file).toBeFocused();

  await file.press("Enter");
  await inspector.getByRole("button", { name: "Close inspector" }).click();
  await expect(inspector).toBeHidden();
  await expect(launcher).toBeFocused();
});

test("Escape from a file opened directly on the atlas returns to its arc", async ({ page }) => {
  await clickArc(page, /^Projects,/);
  await clickArc(page, /^Brand campaign,/);
  const file = arc(page, /^Trailer master\.mov,/);
  await file.press("Enter");
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await expect(inspector.getByRole("heading", { name: "Trailer master.mov" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(inspector).toBeHidden();
  await expect(file).toBeFocused();
});
