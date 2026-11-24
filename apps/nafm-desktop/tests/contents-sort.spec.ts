import { expect, test } from "@playwright/test";
import type { DirectorySort, StorageChildrenPage, StorageNode } from "../src/lib/types";

const orders: DirectorySort[] = [
  { field: "size", direction: "desc" }, { field: "size", direction: "asc" },
  { field: "name", direction: "asc" }, { field: "name", direction: "desc" },
  { field: "date", direction: "desc" }, { field: "date", direction: "asc" },
];

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
  const sort = contents.getByRole("combobox", { name: "Sort contents" });
  const row = (n: number) => contents.locator(`[aria-rowindex="${n}"] button`);

  for (const order of orders) {
    const sorted = orderedEntries(entries, order);
    const value = `${order.field}-${order.direction}`;
    await sort.selectOption(value);
    await expect(sort).toHaveValue(value);
    await expect(row(1)).toHaveAttribute("data-entry-id", sorted[0].id);
    if (order.field === "date") {
      await expect(row(1).locator("time")).toHaveAttribute("datetime", new Date(sorted[0].modified_unix_millis!).toISOString());
    }
    await expect.poll(() => contents.evaluate((pane) => pane.scrollTop)).toBe(0);
    await contents.evaluate((pane) => { pane.scrollTop = pane.scrollHeight; });
    await expect(row(entries.length)).toHaveAttribute("data-entry-id", sorted.at(-1)!.id);
  }

  const sorted = orderedEntries(entries, orders.at(-1)!);
  const lastFile = [...sorted].reverse().find((node) => node.kind === "file")!;
  const file = row(sorted.indexOf(lastFile) + 1);
  await file.scrollIntoViewIfNeeded();
  const top = await contents.evaluate((pane) => pane.scrollTop);
  await file.click();
  await expect(page.getByRole("heading", { name: lastFile.name, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to Contents" }).click();
  await expect(sort).toHaveValue("date-asc");
  await expect(file).toBeFocused();
  await expect.poll(() => contents.evaluate((pane) => pane.scrollTop)).toBeCloseTo(top, 0);
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

  await contents.getByRole("combobox", { name: "Sort contents" }).selectOption("name-asc");
  await expect(icon).toHaveCSS("color", await color());
  await page.getByRole("button", { name: "Map options" }).click();
  await page.getByRole("button", { name: "Space health", exact: true }).click();
  await expect(icon).toHaveCSS("color", await color());
  await row.press("Home");
  await page.keyboard.press("ArrowDown");
  await expect(tip).toBeVisible();
  await expect(tip).toContainText(/space health/i);
});
