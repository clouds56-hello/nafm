import { expect, test } from "@playwright/test";
import type { DirectorySort, StorageChildrenPage, StorageNode } from "../src/lib/types";

const orders: DirectorySort[] = [
  { field: "size", direction: "desc" }, { field: "size", direction: "asc" },
  { field: "name", direction: "asc" }, { field: "name", direction: "desc" },
  { field: "date", direction: "desc" }, { field: "date", direction: "asc" },
];
const fields = { size: "Size", name: "Name", date: "Date modified" };
const directions = { asc: "Ascending", desc: "Descending" };

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

  const firstRead = await page.evaluateHandle(() => {
    const bridge = (window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: { sort?: DirectorySort }) => Promise<unknown> };
    }).__TAURI_INTERNALS__;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = { pending: false, replied: false, release };
    const invoke = bridge.invoke.bind(bridge);
    bridge.invoke = async (command, args) => {
      const response = await invoke(command, args);
      if (command === "get_storage_view_snapshot" && args.sort?.field === "name" && args.sort.direction === "desc") {
        read.pending = true;
        await gate;
        read.replied = true;
      }
      return response;
    };
    return read;
  });

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
