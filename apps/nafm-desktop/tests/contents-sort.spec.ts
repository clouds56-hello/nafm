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
  const row = (n: number) => contents.locator(`[aria-rowindex="${n}"] button`);

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

test("keyboard selections in both groups survive an earlier sort finishing late", async ({ page }) => {
  await page.goto("/mock/");
  await page.getByRole("button", { name: "Contents & details" }).click();
  const contents = page.getByRole("tabpanel", { name: "Contents" });
  const sort = contents.getByRole("button", { name: "Sort contents", exact: true });
  const firstRow = contents.locator('[aria-rowindex="1"] button');
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

test("each site restores its own Contents order after switching and reopening", async ({ page, context }) => {
  test.setTimeout(90_000);
  const contents = (view: Page) => view.getByRole("tabpanel", { name: "Contents" });
  const sortButton = (view: Page) => contents(view).getByRole("button", { name: "Sort contents", exact: true });
  const openSite = (view: Page, name: string) => view.getByRole("button", { name: `Open ${name} in Atlas` }).click();
  const fieldFolder = (view: Page) => contents(view).getByRole("button", { name: /^Field Drive\b/ }).click();

  async function expectOrder(view: Page, sort: DirectorySort, first: RegExp) {
    await expect(contents(view).locator('[aria-rowindex="1"] button')).toHaveAccessibleName(first);
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
  await expect(contents(page).locator('[aria-rowindex="1"] button')).toHaveAccessibleName(/^2024 April/);
  await page.getByRole("button", { name: "Previous location", exact: true }).click();
  await expect(contents(page).locator('[aria-rowindex="1"] button')).toHaveAccessibleName(/^Deliverables/);

  await page.getByRole("button", { name: "Sites", exact: true }).click();
  await openSite(page, "Field drive");
  await fieldFolder(page);
  await expectOrder(page, { field: "size", direction: "desc" }, /^Drone imagery/);
  await sortButton(page).click();
  await page.getByRole("radio", { name: "Date modified", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(contents(page).locator('[aria-rowindex="1"] button')).toHaveAccessibleName(/^Survey log\.pdf/);

  await openSite(page, "Studio archive");
  await expectOrder(page, studioOrder, /^Deliverables/);
  await openSite(page, "Field drive");
  await expectOrder(page, fieldOrder, /^Survey log\.pdf/);

  await page.close();
  const reopened = await context.newPage();
  await reopened.goto("/mock/");
  await reopened.getByRole("button", { name: "Contents & details" }).click();
  await expectOrder(reopened, studioOrder, /^Deliverables/);
  await reopened.getByRole("button", { name: "Sites", exact: true }).click();
  await openSite(reopened, "Field drive");
  await fieldFolder(reopened);
  await expectOrder(reopened, fieldOrder, /^Survey log\.pdf/);
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
  await expect(contents.locator('[aria-rowindex="1"] button')).toHaveAccessibleName(/^Documents/);
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
