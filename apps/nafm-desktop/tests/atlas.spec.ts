import { expect, test, type Locator, type Page } from "@playwright/test";
import type { StorageChildrenPage, StorageViewSnapshot } from "../src/lib/types";

function arc(page: Page, name: RegExp) {
  return page.getByRole("region", { name: "Circular storage map" }).getByRole("button", { name });
}

function currentFolder(page: Page) {
  return page.getByRole("navigation", { name: "Folder path" }).locator('[aria-current="location"]');
}

async function scrollProjectsToEnd(page: Page) {
  const contents = page.getByRole("tabpanel", { name: "Contents" });
  await expect(contents.getByRole("grid")).toHaveAttribute("aria-rowcount", "19");
  // Set the starting scroll position directly so a hover card cannot intercept the wheel.
  await contents.evaluate((pane) => { pane.scrollTop = pane.scrollHeight; });
  await expect(contents.getByRole("button", { name: /^2024 January/ })).toBeInViewport();
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

  test("touch preview dismisses and opens without closing Sites or Contents", async ({ page }) => {
    const rail = page.getByRole("complementary", { name: "Sites" });
    const inspector = page.getByRole("complementary", { name: "Inspector" });
    const projects = arc(page, /^Projects,/);
    const preview = page.getByRole("group", { name: "Preview of Projects" });
    const open = preview.getByRole("button", { name: "Open folder" });

    await page.getByRole("button", { name: "Sites", exact: true }).tap();
    await page.getByRole("button", { name: "Contents & details", exact: true }).tap();
    await page.locator(".radial-atlas").scrollIntoViewIfNeeded();

    await tapArc(page, /^Projects,/);
    await open.focus();
    await expect(open).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(preview).toBeHidden();
    await expect(projects).toBeFocused();
    await expect(rail).toBeVisible();
    await expect(inspector).toBeVisible();

    await tapArc(page, /^Projects,/);
    await expect(preview).toBeVisible();
    await currentFolder(page).tap();
    await expect(preview).toBeHidden();
    await expect(currentFolder(page)).toHaveText("Studio archive");
    await expect(rail).toBeVisible();
    await expect(inspector).toBeVisible();

    await tapArc(page, /^Projects,/);
    await open.tap();
    await expect(preview).toBeHidden();
    await expect(currentFolder(page)).toHaveText("Projects");
    await expect(rail).toBeVisible();
    await expect(inspector.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  });

  test("returning from a file near the end restores the scrolled Contents sheet", async ({ page }) => {
    await page.setViewportSize({ width: 680, height: 320 });
    await page.getByRole("button", { name: "Contents & details" }).tap();
    const inspector = page.getByRole("complementary", { name: "Inspector" });
    const grid = inspector.getByRole("grid");
    await grid.getByRole("button", { name: /^Photo Library/ }).tap();
    await expect(currentFolder(page)).toHaveText("Photo Library");
    const file = grid.getByRole("button", { name: /^Proof 093\.jpg/ });
    const contents = inspector.getByRole("tabpanel", { name: "Contents" });
    await expect(file).toHaveCount(0);
    await contents.evaluate((pane) => { pane.scrollTop = pane.scrollHeight; });
    await expect(file).toBeAttached();
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

  test("Back from a nested file arc resumes a distant Contents list with Sites open", async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 760 });
    await page.goto("/mock/?scenario=large");
    const preview = page.locator(".atlas-sector-preview");
    await tapArc(page, /^Photo Library,/);
    await preview.getByRole("button", { name: "Open folder", exact: true }).tap();
    await expect(currentFolder(page)).toHaveText("Photo Library");
    await page.getByRole("button", { name: "Sites", exact: true }).tap();
    await page.getByRole("button", { name: "Contents & details", exact: true }).tap();
    const sites = page.getByRole("complementary", { name: "Sites" });
    const inspector = page.getByRole("complementary", { name: "Inspector" });
    const contents = inspector.getByRole("tabpanel", { name: "Contents", exact: true });
    const grid = contents.getByRole("grid");
    await expect(grid).toHaveAttribute("aria-rowcount", "4096");
    await contents.evaluate((pane) => { pane.scrollTop = pane.scrollHeight; });
    const last = grid.locator('[aria-rowindex="4096"]');
    await expect(last).toBeInViewport();
    const savedScroll = await contents.evaluate((pane) => pane.scrollTop);
    expect(savedScroll).toBeGreaterThan(0);

    await page.locator(".radial-atlas").scrollIntoViewIfNeeded();
    await tapArc(page, /^Surfaces\.tif,/);
    await preview.getByRole("button", { name: "View details", exact: true }).tap();
    const back = inspector.getByRole("button", { name: "Back to Contents", exact: true });
    await expect(inspector.getByRole("heading", { name: "Surfaces.tif", exact: true })).toBeInViewport();
    await expect(back).toBeFocused();
    await expect(sites).toBeVisible();
    await back.tap();

    await expect(currentFolder(page)).toHaveText("Photo Library");
    await expect(sites).toBeVisible();
    await expect(last).toBeInViewport();
    await expect.poll(() => contents.evaluate((pane) => pane.scrollTop)).toBe(savedScroll);
    const focusedRow = grid.locator(":focus[data-entry-id]");
    await expect(focusedRow).toBeInViewport({ ratio: 0.99 });
    const index = await focusedRow.evaluate((button) => Number(button.closest("[aria-rowindex]")?.getAttribute("aria-rowindex")));
    await page.keyboard.press("ArrowDown");
    await expect(grid.locator(`[aria-rowindex="${index + 1}"] [data-entry-id]`)).toBeFocused();
  });

  test("opening and closing Contents leaves the Sites panel available", async ({ page }) => {
    const rail = page.getByRole("complementary", { name: "Sites" });
    const inspector = page.getByRole("complementary", { name: "Inspector" });
    const openSites = page.getByRole("button", { name: "Sites", exact: true });
    const openContents = page.getByRole("button", { name: "Contents & details" });
    await openSites.tap();
    await openContents.tap();
    await expect(rail.getByRole("button", { name: "Close sites" })).toBeInViewport();
    await inspector.getByRole("button", { name: /^Projects/ }).tap();
    await expect(currentFolder(page)).toHaveText("Projects");
    await inspector.getByRole("button", { name: "Close inspector" }).tap();
    await expect(inspector).toBeHidden();
    await expect(rail).toBeVisible();
    await openContents.tap();
    await rail.getByRole("button", { name: "Close sites" }).tap();
    await expect(rail).toBeHidden();
    await expect(inspector.getByRole("heading", { name: "Projects" })).toBeInViewport();
  });
});

test("the full scrollbar seeks directly to a distant file and restores it after inspection", async ({ page }) => {
  const total = 4096;
  const reads = await page.evaluateHandle((total) => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: { offset?: number; limit?: number }) => Promise<unknown> };
    };
    const offsets: number[] = [];
    const invoke = bridge.invoke.bind(bridge);
    bridge.invoke = async (command, args) => {
      const response = await invoke(command, args);
      if (command !== "get_storage_view_snapshot" && command !== "get_storage_children") return response;
      const snapshot = command === "get_storage_view_snapshot" ? response as StorageViewSnapshot : null;
      const page = snapshot?.page ?? response as StorageChildrenPage;
      if (page.parent.name !== "Photo Library") return response;
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 6;
      offsets.push(offset);
      const template = page.children.find((entry) => entry.kind === "file")!;
      const children = Array.from({ length: Math.min(limit, total - offset) }, (_, index) => {
        const name = `Frame ${String(offset + index + 1).padStart(4, "0")}.jpg`;
        return { ...template, id: name, name, path: `Photos/${name}` };
      });
      const result = { ...page, offset, limit, children, total_children: total };
      return snapshot ? { ...snapshot, page: result } : result;
    };
    return offsets;
  }, total);

  await arc(page, /^Photo Library,/).press("Enter");
  await page.getByRole("button", { name: "Contents & details" }).click();
  const contents = page.getByRole("tabpanel", { name: "Contents" });
  const grid = contents.getByRole("grid");
  await expect(grid).toHaveAttribute("aria-rowcount", String(total));
  const height = (await grid.getByRole("row").first().boundingBox())!.height;
  const fullHeight = await contents.evaluate((pane) => pane.scrollHeight);
  expect(fullHeight).toBeGreaterThan(total * height * 0.95);
  await contents.evaluate((pane) => { pane.scrollTop = pane.scrollHeight; });
  const file = grid.getByRole("button", { name: /^Frame 4095\.jpg/ });
  await expect(file).toBeInViewport();
  const offsets = await reads.jsonValue();
  expect(offsets.some((offset) => offset >= total - 400)).toBe(true);
  expect(offsets.filter((offset) => offset > 250 && offset < total - 400)).toEqual([]);
  expect(await grid.getByRole("row").count()).toBeLessThan(250);
  expect(await contents.evaluate((pane) => pane.scrollHeight)).toBe(fullHeight);

  const top = await contents.evaluate((pane) => pane.scrollTop);
  await file.click();
  await expect(page.getByRole("heading", { name: "Frame 4095.jpg" })).toBeVisible();
  await page.getByRole("button", { name: "Back to Contents" }).click();
  await expect(file).toBeFocused();
  await expect.poll(() => contents.evaluate((pane) => pane.scrollTop)).toBeCloseTo(top, 0);
  await page.keyboard.press("ArrowDown");
  const last = grid.getByRole("button", { name: /^Frame 4096\.jpg/ });
  await expect(last).toBeFocused();
  const finalTop = await contents.evaluate((pane) => pane.scrollTop);
  await page.getByRole("button", { name: "Sites", exact: true }).click();
  await page.getByRole("button", { name: "Open Field drive in Atlas" }).click();
  await expect(currentFolder(page)).toHaveText("Field drive");
  await page.getByRole("button", { name: "Open Studio archive in Atlas" }).click();
  await expect(last).toBeInViewport();
  await expect.poll(() => contents.evaluate((pane) => pane.scrollTop)).toBeCloseTo(finalTop, 0);
  await last.press("Home");
  await expect(grid.getByRole("button", { name: /^Frame 0001\.jpg/ })).toBeFocused();
  await page.keyboard.press("End");
  await expect(last).toBeFocused();
});

test("Home returns focus to the first row during a pending End jump", async ({ page }) => {
  await page.goto("/mock/?scenario=large");
  await arc(page, /^Photo Library,/).press("Enter");
  await expect(currentFolder(page)).toHaveText("Photo Library");
  await page.getByRole("button", { name: "Contents & details" }).click();
  const contents = page.getByRole("tabpanel", { name: "Contents" });
  const entries = contents.getByRole("region", { name: "Directory entries" });
  const first = entries.locator('[aria-rowindex="1"] [data-entry-id]');
  const second = entries.locator('[aria-rowindex="2"] [data-entry-id]');
  await expect(entries.getByRole("grid")).toHaveAttribute("aria-rowcount", "4096");
  await expect(entries.locator('[aria-rowindex="7"] [data-entry-id]')).toBeAttached();
  await expect(entries).not.toHaveAttribute("aria-busy", "true");
  await first.focus();

  const distantRead = await page.evaluateHandle(() => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: { offset?: number }) => Promise<unknown> };
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = { pending: false, replied: false, release };
    const invoke = bridge.invoke.bind(bridge);
    bridge.invoke = async (command, args) => {
      if (read.pending || command !== "get_storage_children" || !(Number(args.offset) > 0)) {
        return invoke(command, args);
      }
      read.pending = true;
      const result = await invoke(command, args);
      await gate;
      requestAnimationFrame(() => { read.replied = true; });
      return result;
    };
    return read;
  });

  try {
    await page.keyboard.press("End");
    await expect.poll(() => distantRead.evaluate((read) => read.pending)).toBe(true);
    await expect(entries).toHaveAttribute("aria-busy", "true");
    await page.keyboard.press("Home");
    await expect(first).toBeFocused();
    await expect(first).toBeInViewport();
    await page.keyboard.press("ArrowDown");
    await expect(second).toBeFocused();
  } finally {
    await distantRead.evaluate((read) => read.release());
  }
  await expect.poll(() => distantRead.evaluate((read) => read.replied)).toBe(true);
  await expect(second).toBeFocused();
  await expect(second).toBeInViewport();
});

test("Arrow Down resumes keyboard browsing at the first visible row after a scrollbar jump", async ({ page }) => {
  await arc(page, /^Photo Library,/).press("Enter");
  await expect(currentFolder(page)).toHaveText("Photo Library");
  await page.getByRole("button", { name: "Contents & details" }).click();
  const contents = page.getByRole("tabpanel", { name: "Contents" });
  const grid = contents.getByRole("grid");
  await expect(grid).toHaveAttribute("aria-rowcount", "100");
  const row = (index: number) => grid.locator(`[aria-rowindex="${index}"] [data-entry-id]`);
  await row(1).focus();

  const firstVisible = 74;
  const rowHeight = (await grid.getByRole("row").first().boundingBox())!.height;
  await contents.evaluate((pane, top) => { pane.scrollTop = top; }, (firstVisible - 1) * rowHeight);
  await expect(row(firstVisible)).toBeInViewport();
  await expect(row(1)).toHaveCount(0);
  await page.keyboard.press("ArrowDown");
  await expect(row(firstVisible)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(row(firstVisible + 1)).toBeFocused();
  await expect(row(firstVisible + 1)).toBeInViewport();
});

async function prepareContentsRescan(page: Page) {
  await page.goto("/mock/?scenario=large");
  await expect(currentFolder(page)).toHaveText("Studio archive");
  await page.getByRole("button", { name: "Contents & details", exact: true }).press("Enter");
  const contents = page.getByRole("tabpanel", { name: "Contents", exact: true });
  const grid = contents.getByRole("grid");
  const sort = contents.getByRole("button", { name: "Sort contents", exact: true });
  await sort.click();
  await page.getByRole("radio", { name: "Name", exact: true }).click();
  await page.getByRole("radio", { name: "Ascending", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(grid).toHaveAttribute("aria-rowcount", "6");
  const photos = grid.getByRole("button", { name: /^Photo Library/ });
  await expect(grid.locator('[aria-rowindex="3"] [data-entry-id]')).toHaveAccessibleName(/^Photo Library/);
  await photos.focus();
  await expect(photos).toBeFocused();
  const photoId = (await photos.getAttribute("data-entry-id"))!;

  const scan = await page.evaluateHandle(async (photoId) => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
    };
    // Update the preview index independently of the UI, then publish it through a normal scan.
    for (let index = 1; index <= 48; index += 1) {
      await bridge.invoke("add_site_folder", {
        workspaceName: "Studio workspace", siteId: "studio-archive",
        path: "/demo/A import " + String(index).padStart(2, "0"),
      });
    }
    const directory = await bridge.invoke("get_storage_children", {
      siteId: "studio-archive", nodeId: "site:studio-archive", targetSiteId: "field-drive",
      offset: 0, limit: 64, sort: { field: "name", direction: "asc" },
    }) as StorageChildrenPage;
    return {
      rank: directory.children.findIndex((entry) => entry.id === photoId) + 1,
      start: () => bridge.invoke("start_scan", {
        expectedWorkspace: "Studio workspace", selector: { site_id: "studio-archive" },
      }),
    };
  }, photoId);
  expect(await scan.evaluate((state) => state.rank)).toBe(51);
  return { grid, sort, photos, photoId, scan };
}

test.describe("Contents during a rescan", () => {
  test.use({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });

  test("a rescan follows a focused folder that moves beyond the current Contents viewport", async ({ page }) => {
    const { grid, sort, photos, photoId, scan } = await prepareContentsRescan(page);
    await scan.evaluate((state) => state.start());

    await expect(grid).toHaveAttribute("aria-rowcount", "54", { timeout: 12_000 });
    await expect(currentFolder(page)).toHaveText("Studio archive");
    await expect(sort).toHaveAttribute("title", "Name, ascending");
    await expect(photos).toBeFocused();
    await expect(photos).toBeInViewport({ ratio: 0.99 });
    await expect(grid.locator('[aria-rowindex="51"] [data-entry-id]')).toHaveAttribute("data-entry-id", photoId);
    await page.keyboard.press("ArrowDown");
    await expect(grid.getByRole("button", { name: /^Projects/ })).toBeFocused();
  });

  test("a pending rescan snapshot follows the newer Contents focus", async ({ page }) => {
    const { grid, photos, photoId, scan } = await prepareContentsRescan(page);
    const projects = grid.getByRole("button", { name: /^Projects/ });
    const projectsId = (await projects.getAttribute("data-entry-id"))!;
    const snapshot = await page.evaluateHandle(() => {
      const { __TAURI_INTERNALS__: bridge } = window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (command: string, args: { nodeId?: string; anchor?: { child_id: string } }) => Promise<unknown>;
        };
      };
      const invoke = bridge.invoke.bind(bridge);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const read = { pending: false, anchor: null as string | null, release };
      bridge.invoke = async (command, args) => {
        const response = await invoke(command, args);
        if (!read.pending && command === "get_storage_view_snapshot" && args.nodeId === "site:studio-archive") {
          read.pending = true;
          read.anchor = args.anchor?.child_id ?? null;
          await gate;
        }
        return response;
      };
      return read;
    });

    try {
      await scan.evaluate((state) => state.start());
      await expect.poll(() => snapshot.evaluate((read) => read.pending), { timeout: 12_000 }).toBe(true);
      expect(await snapshot.evaluate((read) => read.anchor)).toBe(photoId);
      await expect(grid).toHaveAttribute("aria-rowcount", "6");
      await expect(photos).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(projects).toBeFocused();
    } finally {
      await snapshot.evaluate((read) => read.release());
    }

    await expect(grid).toHaveAttribute("aria-rowcount", "54", { timeout: 12_000 });
    await expect(projects).toBeFocused();
    await expect(projects).toBeInViewport({ ratio: 0.99 });
    await expect(grid.locator('[aria-rowindex="52"] [data-entry-id]')).toHaveAttribute("data-entry-id", projectsId);
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
  const scrollTop = await scrollProjectsToEnd(page);
  await page.getByRole("button", { name: "Sites", exact: true }).click();
  await page.getByRole("button", { name: "Open Field drive in Atlas" }).click();
  await expect(currentFolder(page)).toHaveText("Field drive");
  await page.getByRole("button", { name: "Close sites" }).click();
  await page.getByRole("button", { name: "Previous location", exact: true }).click();
  await expect(currentFolder(page)).toHaveText("Projects");
  await expect(contents.getByRole("button", { name: /^2024 January/ })).toBeInViewport();
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
});

test("Retry reads the visible virtual rows after a scroll request fails", async ({ page }) => {
  await page.setViewportSize({ width: 680, height: 320 });
  await arc(page, /^Photo Library,/).press("Enter");
  await page.getByRole("button", { name: "Contents & details" }).click();
  const contents = page.getByRole("tabpanel", { name: "Contents" });
  await expect(contents.getByRole("button", { name: /^Studio portraits/ })).toBeVisible();
  await page.evaluate(() => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
    };
    const invoke = bridge.invoke.bind(bridge);
    let fail = true;
    bridge.invoke = async (command, args) => {
      if (command === "get_storage_children" && fail && Number(args.offset) > 0) {
        fail = false;
        throw new Error("Directory read interrupted");
      }
      return invoke(command, args);
    };
  });
  await contents.evaluate((pane) => { pane.scrollTop = pane.scrollHeight; });
  const error = contents.getByRole("alert");
  await expect(error).toContainText("Directory read interrupted");
  await error.getByRole("button", { name: "Retry" }).click();
  await expect(error).toBeHidden();
  await expect(contents.getByRole("button", { name: /^Proof 096\.jpg/ })).toBeInViewport();
  await contents.evaluate((pane) => { pane.scrollTop = 0; });
  await expect(contents.getByRole("button", { name: /^Studio portraits/ })).toBeInViewport();
});

test("Sites and Contents stay independently open across switches", async ({ page }) => {
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
  await expect(contents).toBeVisible();
  await expect(studioArchive).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(fieldDrive).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(currentFolder(page)).toHaveText("Field drive");
  await expect(fieldDrive).toHaveAttribute("aria-current", "true");
  await expect(fieldDrive).toBeFocused();
  await expect(contents.getByRole("heading", { name: "Field drive" })).toBeVisible();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(currentFolder(page)).toHaveText("Projects");
  await expect(studioArchive).toHaveAttribute("aria-current", "true");
  const readout = (await page.locator(".radial-atlas__size").boundingBox())!;
  await page.mouse.click(readout.x + readout.width / 2, readout.y + readout.height / 2);
  await expect(rail).toBeVisible();
  await expect(contents).toBeVisible();
  await studioArchive.press("Escape");
  await expect(rail).toBeHidden();
  await expect(contents.getByRole("button", { name: /^2024 January/ })).toBeInViewport();
  await expect.poll(() => contents.evaluate((pane) => pane.scrollTop)).toBeCloseTo(scrollTop, 0);

  await sites.click();
  await fieldDrive.click();
  await expect(currentFolder(page)).toHaveText("Field drive");
  await expect(fieldDrive).toBeFocused();
  await close.click();
  await expect(inspector).toBeVisible();
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
  await expect(inspector).toBeVisible();
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

test("Show in Contents takes a file arc to its exact row in the containing folder", async ({ page }) => {
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const sites = page.getByRole("complementary", { name: "Sites" });
  const trailer = arc(page, /^Trailer master\.mov,/).and(page.locator('[data-node-id*="/Brand campaign/"]'));
  const fileId = await trailer.getAttribute("data-node-id");
  const contents = inspector.getByRole("tabpanel", { name: "Contents" });
  const file = contents.getByRole("button", { name: /^Trailer master\.mov/ });

  await page.getByRole("button", { name: "Sites", exact: true }).click();
  await trailer.press("Enter");
  await expect(inspector.getByRole("heading", { name: "Trailer master.mov" })).toBeVisible();
  await expect(currentFolder(page)).toHaveText("Studio archive");
  await inspector.getByRole("button", { name: "Show in Contents", exact: true }).press("Enter");

  await expect(currentFolder(page)).toHaveText("Brand campaign");
  await expect(sites.getByRole("button", { name: "Close sites" })).toBeVisible();
  await expect(file).toHaveAttribute("data-entry-id", fileId!);
  await expect(file).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(contents.getByRole("button", { name: /^Camera originals\.mxf/ })).toBeFocused();
});

test("Show in Contents scrolls to a distant file using the site's saved order", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 450 });
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const contents = inspector.getByRole("tabpanel", { name: "Contents" });
  const proof = arc(page, /^Proof 001\.jpg,/);

  await arc(page, /^Photo Library,/).press("Enter");
  await page.getByRole("button", { name: "Contents & details" }).click();
  await contents.getByRole("button", { name: "Sort contents", exact: true }).click();
  await page.getByRole("radio", { name: "Name", exact: true }).click();
  await page.getByRole("radio", { name: "Descending", exact: true }).click();
  await page.keyboard.press("Escape");
  const file = contents.getByRole("button", { name: /^Proof 001\.jpg/ });
  await expect(file).toHaveCount(0);
  await inspector.getByRole("button", { name: "Close inspector" }).click();

  await proof.press("Enter");
  await inspector.getByRole("button", { name: "Show in Contents", exact: true }).click();
  await expect(currentFolder(page)).toHaveText("Photo Library");
  await expect(file).toBeFocused();
  await expect(contents.getByRole("row").filter({
    has: page.getByRole("button", { name: /^Proof 001\.jpg/ }),
  })).toHaveAttribute("aria-rowindex", "98");
  await expect(file).toBeInViewport();
  await page.keyboard.press("Enter");
  await expect(inspector.getByRole("heading", { name: "Proof 001.jpg" })).toBeVisible();
  await inspector.getByRole("button", { name: "Back to Contents", exact: true }).click();
  await expect(file).toBeFocused();
  await expect(file).toBeInViewport();
});

test("an older Show in Contents response leaves a newly inspected atlas file in place", async ({ page }) => {
  const request = await page.evaluateHandle(() => {
    const bridge = (window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
    }).__TAURI_INTERNALS__;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = { pending: false, replied: false, release };
    const invoke = bridge.invoke.bind(bridge);
    bridge.invoke = async (command, args) => {
      const response = await invoke(command, args);
      if (command === "get_storage_node_reveal") {
        read.pending = true;
        await gate;
        read.replied = true;
      }
      return response;
    };
    return read;
  });

  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const camera = arc(page, /^Camera originals\.mxf,/);
  await camera.press("Enter");
  await inspector.getByRole("button", { name: "Show in Contents", exact: true }).press("Enter");
  await expect.poll(() => request.evaluate((read) => read.pending)).toBe(true);
  await arc(page, /^Launch film\.mov,/).press("Enter");
  await expect(inspector.getByRole("heading", { name: "Launch film.mov" })).toBeVisible();
  await request.evaluate((read) => read.release());
  await expect.poll(() => request.evaluate((read) => read.replied)).toBe(true);
  await expect(currentFolder(page)).toHaveText("Studio archive");
  await expect(inspector.getByRole("heading", { name: "Launch film.mov" })).toBeVisible();
});
