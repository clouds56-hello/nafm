import { expect, test, type Page } from "@playwright/test";
import type { DirectorySort, StorageChildrenPage, StorageNode } from "../src/lib/types";

const orders: DirectorySort[] = [
  { field: "size", direction: "desc" }, { field: "size", direction: "asc" },
  { field: "name", direction: "asc" }, { field: "name", direction: "desc" },
  { field: "date", direction: "desc" }, { field: "date", direction: "asc" },
];
const fields = { size: "Size", name: "Name", date: "Date modified" };
const directions = { asc: "Ascending", desc: "Descending" };

async function delaySortRead(page: Page, sort: DirectorySort) {
  return page.evaluateHandle((sort) => {
    const bridge = (window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: { sort?: DirectorySort }) => Promise<unknown> };
    }).__TAURI_INTERNALS__;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = { pending: false, replied: false, release };
    const invoke = bridge.invoke.bind(bridge);
    bridge.invoke = async (command, args) => {
      const response = await invoke(command, args);
      if (command === "get_storage_view_snapshot" && args.sort?.field === sort.field && args.sort.direction === sort.direction) {
        read.pending = true;
        await gate;
        read.replied = true;
      }
      return response;
    };
    return read;
  }, sort);
}

function orderedEntries(nodes: StorageNode[], { field, direction }: DirectorySort) {
  const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
  return [...nodes].sort((a, b) => {
    const tie = compare(a.name, b.name) || compare(a.id, b.id);
    let comparison = a.total_bytes - b.total_bytes;
    if (field === "name") comparison = compare(a.name.toLowerCase(), b.name.toLowerCase());
    if (field === "date") {
      if (a.modified_unix_millis === null || b.modified_unix_millis === null) {
        return Number(a.modified_unix_millis === null) - Number(b.modified_unix_millis === null) || tie;
      }
      comparison = a.modified_unix_millis - b.modified_unix_millis;
    }
    return (direction === "asc" ? comparison : -comparison) || tie;
  });
}

test("all six orders apply to the whole virtual directory and preserve file return", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 450 });
  await page.goto("/mock/");
  const photos = page.getByRole("button", { name: /^Photo Library,/ }).first();
  const nodeId = await photos.getAttribute("data-node-id");
  const entries = await page.evaluate(async (nodeId) => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: Record<string, unknown>) => Promise<StorageChildrenPage> };
    };
    return (await bridge.invoke("get_storage_children", {
      siteId: "studio-archive", targetSiteId: null, nodeId, offset: 0, limit: 200,
    })).children;
  }, nodeId);
  expect(entries).toHaveLength(100);
  await photos.press("Enter");
  await page.getByRole("button", { name: "Contents & details" }).click();
  const contents = page.getByRole("tabpanel", { name: "Contents" });
  const sort = contents.getByRole("button", { name: "Sort contents", exact: true });
  const method = page.getByRole("radiogroup", { name: "Sort by" });
  const direction = page.getByRole("radiogroup", { name: "Direction" });
  const row = (n: number) => contents.locator(`[aria-rowindex="${n}"] [data-entry-id]`);

  let previous = orders[0];
  for (const order of orders) {
    const sorted = orderedEntries(entries, order);
    await sort.click();
    const selectedField = method.getByRole("radio", { name: fields[order.field], exact: true });
    const selectedDirection = direction.getByRole("radio", { name: directions[order.direction], exact: true });
    if (previous.field !== order.field) await selectedField.click();
    if (previous.direction !== order.direction) await selectedDirection.click();
    await expect(selectedField).toBeChecked();
    await expect(selectedDirection).toBeChecked();
    await page.keyboard.press("Escape");
    await expect(sort).toBeFocused();
    await expect(row(1)).toHaveAttribute("data-entry-id", sorted[0].id);
    if (order.field === "date") {
      await expect(row(1).locator("time")).toHaveAttribute("datetime", new Date(sorted[0].modified_unix_millis!).toISOString());
    }
    await expect.poll(() => contents.evaluate((pane) => pane.scrollTop)).toBe(0);
    await contents.evaluate((pane) => { pane.scrollTop = pane.scrollHeight; });
    await expect(row(entries.length)).toHaveAttribute("data-entry-id", sorted.at(-1)!.id);
    previous = order;
  }

  const sorted = orderedEntries(entries, orders.at(-1)!);
  const lastFile = [...sorted].reverse().find((node) => node.kind === "file")!;
  const file = row(sorted.indexOf(lastFile) + 1);
  await file.scrollIntoViewIfNeeded();
  const top = await contents.evaluate((pane) => pane.scrollTop);
  await file.click();
  await expect(page.getByRole("heading", { name: lastFile.name, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to Contents" }).click();
  await expect(file).toBeFocused();
  await expect.poll(() => contents.evaluate((pane) => pane.scrollTop)).toBeCloseTo(top, 0);
  await sort.click();
  await expect(method.getByRole("radio", { name: "Date modified", exact: true })).toBeChecked();
  await expect(direction.getByRole("radio", { name: "Ascending", exact: true })).toBeChecked();
});

test("compact file Details follow the current row in descending Contents and its search matches", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 480 });
  await page.goto("/mock/");
  await page.getByRole("button", { name: /^Photo Library,/ }).press("Enter");
  await page.getByRole("button", { name: "Contents & details" }).click();

  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const contents = inspector.getByRole("tabpanel", { name: "Contents" });
  const grid = contents.getByRole("grid", { name: "Photo Library entries" });
  const thirdRow = grid.locator('[aria-rowindex="3"] [data-entry-id]');
  const details = inspector.getByRole("region", { name: "Storage details" });
  const next = inspector.getByRole("button", { name: "Next file", exact: true });
  const previous = inspector.getByRole("button", { name: "Previous file", exact: true });
  const back = inspector.getByRole("button", { name: "Back to Contents", exact: true });
  const sort = contents.getByRole("button", { name: "Sort contents", exact: true });

  await sort.click();
  await page.getByRole("radio", { name: "Name", exact: true }).click();
  await expect(page.getByRole("radio", { name: "Descending", exact: true })).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(grid).toHaveAttribute("aria-rowcount", "100");
  await expect(thirdRow).toHaveAccessibleName(/^Proof 096\.jpg/);
  await thirdRow.press("Enter");
  await expect(details.getByText("Item 3 of 100", { exact: true })).toBeInViewport();
  await expect(previous).toBeDisabled(); // The two preceding entries are folders.
  await back.press("Enter");
  await expect(thirdRow).toBeFocused();

  const query = "  pRoOf  ";
  await contents.getByRole("button", { name: "Search this folder" }).press("Enter");
  const search = contents.getByLabel("Find in folder", { exact: true });
  await search.fill(query);
  await expect(grid).toHaveAttribute("aria-rowcount", "96");
  await expect(thirdRow).toHaveAccessibleName(/^Proof 094\.jpg/);
  await thirdRow.press("Enter");
  const title = details.locator('header[aria-live="polite"][aria-atomic="true"]');
  await expect(title.getByText("Match 3 of 96", { exact: true })).toBeInViewport();
  await expect(title.getByRole("heading", { name: "Proof 094.jpg" })).toBeVisible();
  await next.press("Enter");
  await expect(next).toBeFocused();
  await expect(title.getByText("Match 4 of 96", { exact: true })).toBeInViewport();
  await expect(title.getByRole("heading", { name: "Proof 093.jpg" })).toBeVisible();
  await expect(details.getByText("Verification", { exact: true })).toBeInViewport({ ratio: 1 });
  await previous.press("Enter");
  await expect(previous).toBeFocused();
  await expect(title.getByText("Match 3 of 96", { exact: true })).toBeInViewport();
  await expect(title.getByRole("heading", { name: "Proof 094.jpg" })).toBeVisible();
  await back.press("Enter");
  await expect(thirdRow).toBeFocused();
  await expect(search).toHaveValue(query);
  await expect(sort).toHaveAttribute("title", "Name, descending");
});

test("keyboard selections in both groups survive an earlier sort finishing late", async ({ page }) => {
  await page.goto("/mock/");
  await page.getByRole("button", { name: "Contents & details" }).click();
  const contents = page.getByRole("tabpanel", { name: "Contents" });
  const sort = contents.getByRole("button", { name: "Sort contents", exact: true });
  const firstRow = contents.locator('[aria-rowindex="1"] [data-entry-id]');
  await expect(firstRow).toHaveAccessibleName(/^Projects/);

  const firstRead = await delaySortRead(page, { field: "name", direction: "desc" });

  try {
    await sort.press("Enter");
    await expect(page.getByRole("radio", { name: "Size", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("radio", { name: "Name", exact: true })).toBeChecked();
    await expect.poll(() => firstRead.evaluate((read) => read.pending)).toBe(true);
    await page.keyboard.press("Tab");
    await expect(page.getByRole("radio", { name: "Descending", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(page.getByRole("radio", { name: "Ascending", exact: true })).toBeChecked();
    await expect(firstRow).toHaveAccessibleName(/^Deliverables/);
  } finally {
    await firstRead.evaluate((read) => read.release());
  }
  await expect.poll(() => firstRead.evaluate((read) => read.replied)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(sort).toBeFocused();
  await expect(sort).toHaveAttribute("aria-expanded", "false");
  await expect(firstRow).toHaveAccessibleName(/^Deliverables/);
  await sort.click();
  await expect(page.getByRole("radio", { name: "Name", exact: true })).toBeChecked();
  await expect(page.getByRole("radio", { name: "Ascending", exact: true })).toBeChecked();
});

test("keyboard Tab moves between sort groups and can leave the compact menu", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 310 });
  await page.goto("/mock/");
  await page.getByRole("button", { name: "Contents & details" }).click();
  const contents = page.getByRole("tabpanel", { name: "Contents" });
  const sort = contents.getByRole("button", { name: "Sort contents", exact: true });
  const menu = page.getByRole("dialog", { name: "Sort contents" });
  const method = menu.getByRole("radio", { name: "Size", exact: true });
  const direction = menu.getByRole("radio", { name: "Descending", exact: true });

  await sort.press("Tab");
  await expect(sort).not.toBeFocused();
  const nextControl = await page.evaluateHandle(() => document.activeElement);

  await sort.press("Enter");
  await expect(method).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(direction).toBeFocused();
  await expect(direction).toBeInViewport({ ratio: 1 });
  await page.keyboard.press("Shift+Tab");
  await expect(method).toBeFocused();
  await expect(method).toBeInViewport({ ratio: 1 });
  await page.keyboard.press("Shift+Tab");
  await expect(menu).toBeHidden();
  await expect(sort).toBeFocused();

  await sort.press("Enter");
  await expect(method).toBeChecked();
  await page.keyboard.press("Tab");
  await expect(direction).toBeChecked();
  await page.keyboard.press("Tab");
  await expect(menu).toBeHidden();
  await expect.poll(() => nextControl.evaluate((control) => control === document.activeElement)).toBe(true);
  await expect(contents.locator('[aria-rowindex="1"] [data-entry-id]')).toHaveAccessibleName(/^Projects/);
});

test("each site restores its own Contents order after switching and reopening", async ({ page, context }) => {
  test.setTimeout(90_000);
  const contents = (view: Page) => view.getByRole("tabpanel", { name: "Contents" });
  const sortButton = (view: Page) => contents(view).getByRole("button", { name: "Sort contents", exact: true });
  const openSite = (view: Page, name: string) => view.getByRole("button", { name: `Open ${name} in Atlas` }).click();
  const fieldFolder = (view: Page) => contents(view).getByRole("button", { name: /^Field Drive\b/ }).click();

  async function expectOrder(view: Page, sort: DirectorySort, first: RegExp) {
    await expect(contents(view).locator('[aria-rowindex="1"] [data-entry-id]')).toHaveAccessibleName(first);
    await sortButton(view).click();
    await expect(view.getByRole("radio", { name: fields[sort.field], exact: true })).toBeChecked();
    await expect(view.getByRole("radio", { name: directions[sort.direction], exact: true })).toBeChecked();
    await view.keyboard.press("Escape");
  }

  const studioOrder: DirectorySort = { field: "name", direction: "asc" };
  const fieldOrder: DirectorySort = { field: "date", direction: "desc" };
  await page.goto("/mock/");
  await page.getByRole("button", { name: "Contents & details" }).click();
  await contents(page).getByRole("button", { name: /^Projects/ }).click();
  await sortButton(page).click();
  await page.getByRole("radio", { name: "Name", exact: true }).click();
  await page.getByRole("radio", { name: "Ascending", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(contents(page).locator('[aria-rowindex="1"] [data-entry-id]')).toHaveAccessibleName(/^2024 April/);
  await page.getByRole("button", { name: "Previous location", exact: true }).click();
  await expect(contents(page).locator('[aria-rowindex="1"] [data-entry-id]')).toHaveAccessibleName(/^Deliverables/);

  await page.getByRole("button", { name: "Sites", exact: true }).click();
  await openSite(page, "Field drive");
  await fieldFolder(page);
  await expectOrder(page, { field: "size", direction: "desc" }, /^Drone imagery/);
  await sortButton(page).click();
  await page.getByRole("radio", { name: "Date modified", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(contents(page).locator('[aria-rowindex="1"] [data-entry-id]')).toHaveAccessibleName(/^Survey log\.pdf/);

  await openSite(page, "Studio archive");
  await expectOrder(page, studioOrder, /^Deliverables/);
  await openSite(page, "Field drive");
  await expectOrder(page, fieldOrder, /^Survey log\.pdf/);

  await page.close();
  const reopened = await context.newPage();
  await reopened.goto("/mock/");
  await reopened.getByRole("button", { name: "Contents & details" }).click();
  await expectOrder(reopened, fieldOrder, /^Survey log\.pdf/);
  await reopened.getByRole("button", { name: "Sites", exact: true }).click();
  await openSite(reopened, "Studio archive");
  await expectOrder(reopened, studioOrder, /^Deliverables/);
});

test("closing while Contents is still sorting saves the latest choice", async ({ page, context }) => {
  await page.goto("/mock/");
  await page.getByRole("button", { name: "Contents & details" }).click();
  const pending = await delaySortRead(page, { field: "date", direction: "asc" });
  await page.getByRole("button", { name: "Sort contents" }).click();
  await page.getByRole("radio", { name: "Ascending", exact: true }).click();
  await page.getByRole("radio", { name: "Date modified", exact: true }).click();
  await expect.poll(() => pending.evaluate((read) => read.pending)).toBe(true);
  await page.close();

  const reopened = await context.newPage();
  await reopened.goto("/mock/");
  await reopened.getByRole("button", { name: "Contents & details" }).click();
  const contents = reopened.getByRole("tabpanel", { name: "Contents" });
  await expect(contents.locator('[aria-rowindex="1"] [data-entry-id]')).toHaveAccessibleName(/^Documents/);
  await contents.getByRole("button", { name: "Sort contents" }).click();
  await expect(reopened.getByRole("radio", { name: "Date modified", exact: true })).toBeChecked();
  await expect(reopened.getByRole("radio", { name: "Ascending", exact: true })).toBeChecked();
});

test("Contents previews match the atlas colors across ordering and health modes", async ({ page }) => {
  await page.goto("/mock/");
  await page.getByRole("button", { name: "Contents & details" }).click();
  const contents = page.getByRole("tabpanel", { name: "Contents" });
  const row = contents.getByRole("button", { name: /^Projects/ });
  const sector = page.getByRole("button", { name: /^Projects,/ }).first();
  const icon = row.locator(".atlas-directory-icon");
  const color = () => sector.evaluate((node) => getComputedStyle(node).color);
  const tip = page.getByRole("tooltip");
  await expect(icon).toHaveCSS("color", await color());
  await row.hover();
  await expect(tip).toContainText("Projects");
  await expect(tip).toContainText("of Studio archive");
  await expect(tip.locator("time")).toHaveAttribute("datetime", /T/);
  await page.keyboard.press("Escape");
  await expect(tip).toBeHidden();
  await expect(contents).toBeVisible();

  const sort = contents.getByRole("button", { name: "Sort contents", exact: true });
  await sort.press("Enter");
  await page.getByRole("radio", { name: "Name", exact: true }).click();
  await expect(page.getByRole("radio", { name: "Descending", exact: true })).toBeChecked();
  await expect(icon).toHaveCSS("color", await color());
  await page.getByRole("button", { name: "Map options" }).click();
  await expect(sort).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "Space health", exact: true }).click();
  await expect(icon).toHaveCSS("color", await color());
  await row.press("Home");
  await page.keyboard.press("ArrowDown");
  await expect(tip).toBeVisible();
  await expect(tip).toContainText(/space health/i);
});

test("compact Contents previews leave nearby rows readable and scrollable", async ({ page }) => {
  const viewport = { width: 390, height: 750 };
  await page.setViewportSize(viewport);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/mock/?scenario=large");
  await page.getByRole("button", { name: "Contents & details" }).click();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const contents = inspector.getByRole("tabpanel", { name: "Contents" });
  await contents.getByRole("button", { name: /^Photo Library/ }).click();
  await expect(contents.getByRole("grid", { name: "Photo Library entries" })).toHaveAttribute("aria-rowcount", "4096");

  const portraits = contents.getByRole("button", { name: /^Studio portraits/ });
  const editorial = contents.getByRole("button", { name: /^Editorial/ });
  const tooltip = page.getByRole("tooltip");
  const scrollPosition = () => contents.evaluate((pane) => ({ pane: pane.scrollTop, page: window.scrollY }));
  const expectClearInspector = () => expect.poll(async () => {
    const [card, drawer] = await Promise.all([tooltip.boundingBox(), inspector.boundingBox()]);
    if (!card || !drawer) return false;
    const right = card.x + card.width;
    const bottom = card.y + card.height;
    const withinViewport = card.x >= 0 && card.y >= 0 && right <= viewport.width && bottom <= viewport.height;
    const outsideInspector = right <= drawer.x || card.x >= drawer.x + drawer.width
      || bottom <= drawer.y || card.y >= drawer.y + drawer.height;
    return withinViewport && outsideInspector;
  }, { message: "The Contents preview fits on screen without covering the inspector" }).toBe(true);

  await portraits.hover();
  await expect(tooltip).toContainText("Studio portraits");
  await expect(portraits).toHaveAccessibleDescription(/Studio portraits/);
  await expectClearInspector();

  await editorial.hover();
  await expect(tooltip).toContainText("Editorial");
  const before = await scrollPosition();
  await page.mouse.wheel(0, 180);
  await expect.poll(async () => (await scrollPosition()).pane).toBeGreaterThan(before.pane);
  await expect(tooltip).toBeHidden();
  expect((await scrollPosition()).page).toBeCloseTo(before.page, 0);

  await contents.evaluate((pane) => { pane.scrollTop = 0; });
  await portraits.press("ArrowDown");
  await expect(editorial).toBeFocused();
  await expect(tooltip).toContainText("Editorial");
  await expect(editorial).toHaveAccessibleDescription(/Editorial/);
  await expectClearInspector();
});

test("scrolling back to the atlas dismisses an offscreen Contents preview and keeps its cursor", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 520 });
  await page.goto("/mock/");
  await page.getByRole("button", { name: /^Photo Library,/ }).press("Enter");
  await page.getByRole("button", { name: "Sites", exact: true }).press("Enter");
  await page.getByRole("button", { name: "Contents & details", exact: true }).press("Enter");

  const contents = page.getByRole("tabpanel", { name: "Contents", exact: true });
  const editorial = contents.getByRole("button", { name: /^Editorial/ });
  const preview = page.getByRole("tooltip");
  await contents.getByRole("button", { name: /^Studio portraits/ }).press("ArrowDown");
  await expect(editorial).toBeFocused();
  await expect(preview).toContainText("Editorial");
  await expect(editorial).toBeInViewport();
  const toolbar = await page.locator(".atlas-toolbar").boundingBox();
  expect((await preview.boundingBox())!.y).toBeGreaterThanOrEqual(toolbar!.y + toolbar!.height);

  // Wheel over the page gutter so the document moves while the directory keeps its own position.
  await page.mouse.move(5, 84);
  await page.mouse.wheel(0, -1500);
  await expect(contents).not.toBeInViewport();
  await expect(preview).toBeHidden();
  await expect(editorial).toBeFocused();
  await expect(editorial).not.toHaveAttribute("aria-describedby");

  await page.mouse.wheel(0, 1500);
  await expect(editorial).toBeInViewport();
  await page.keyboard.press("ArrowDown");
  await expect(contents.getByRole("button", { name: /^Location scouting/ })).toBeFocused();
  await expect(preview).toContainText("Location scouting");
  await page.keyboard.press("Enter");
  await expect(contents.getByRole("heading", { name: "Location scouting", exact: true })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Sites", exact: true })).toBeVisible();
});

test("a tablet Contents preview leaves both panels clear for a site switch", async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 650 });
  await page.goto("/mock/");
  await page.getByRole("button", { name: /^Photo Library,/ }).press("Enter");
  await page.getByRole("button", { name: "Sites", exact: true }).click();
  await page.getByRole("button", { name: "Contents & details", exact: true }).click();

  const sites = page.getByRole("complementary", { name: "Sites", exact: true });
  const inspector = page.getByRole("complementary", { name: "Inspector", exact: true });
  const contents = inspector.getByRole("tabpanel", { name: "Contents", exact: true });
  const preview = page.getByRole("tooltip");
  const field = sites.getByRole("button", { name: "Open Field drive in Atlas", exact: true });
  await expect(field).toBeInViewport();
  await contents.getByRole("button", { name: /^Studio portraits/ }).hover();
  await expect(preview).toContainText("Studio portraits");
  const card = (await preview.boundingBox())!;
  for (const panel of [sites, inspector]) {
    const box = (await panel.boundingBox())!;
    const overlapWidth = Math.min(card.x + card.width, box.x + box.width) - Math.max(card.x, box.x);
    const overlapHeight = Math.min(card.y + card.height, box.y + box.height) - Math.max(card.y, box.y);
    expect(Math.min(overlapWidth, overlapHeight)).toBeLessThanOrEqual(0);
  }

  await field.click();
  await expect(contents.getByRole("heading", { name: "Field drive", exact: true })).toBeVisible();
  await expect(preview).toBeHidden();
});
