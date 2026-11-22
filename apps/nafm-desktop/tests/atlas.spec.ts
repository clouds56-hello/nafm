import { expect, test, type Locator, type Page } from "@playwright/test";

function arc(page: Page, name: RegExp) {
  return page.getByRole("region", { name: "Circular storage map" }).getByRole("button", { name });
}

function currentFolder(page: Page) {
  return page.getByRole("navigation", { name: "Folder path" }).locator('[aria-current="location"]');
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

test("source history restores the directory page used before switching sites", async ({ page }) => {
  await clickArc(page, /^Projects,/);
  await page.getByRole("button", { name: "Contents & details" }).click();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await inspector.getByRole("button", { name: "Next directory page" }).click();
  const range = inspector.getByText("7–12 of 19", { exact: true });
  await expect(range).toBeVisible();
  await page.getByRole("button", { name: "Sites", exact: true }).click();
  await page.getByRole("button", { name: "Open Field drive in Atlas" }).click();
  await expect(currentFolder(page)).toHaveText("Field drive");
  await page.getByRole("button", { name: "Previous location", exact: true }).click();
  await expect(currentFolder(page)).toHaveText("Projects");
  await page.getByRole("button", { name: "Contents & details" }).click();
  await expect(range).toBeVisible();
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
