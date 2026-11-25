import { expect, test, type Page } from "@playwright/test";

const ancestors = ["Studio archive", "Production Archive", "2025 Campaigns", "Spring Launch", "Camera Originals", "Second Unit"];
const current = "Interview Selects";

function folderPath(page: Page) {
  return page.getByRole("navigation", { name: "Folder path" });
}

function currentFolder(page: Page) {
  return folderPath(page).locator(".atlas-toolbar-current");
}

async function openDeepFolder(page: Page) {
  await page.goto("/mock/?scenario=deep");
  await expect(currentFolder(page)).toHaveText(ancestors[0]);
  const map = page.getByRole("region", { name: "Circular storage map" });
  for (const name of [...ancestors.slice(1), current]) {
    await map.getByRole("button", { name: new RegExp(`^${name},`) }).press("Enter");
    await expect(currentFolder(page)).toHaveText(name);
  }
}

test("the toolbar reveals intermediate folders and a jump preserves Back history", async ({ page }) => {
  await openDeepFolder(page);
  const path = folderPath(page);
  const pathButton = path.getByRole("button", { name: "Show folder path", exact: true });
  const hierarchy = page.getByRole("group", { name: "Folder hierarchy", exact: true });
  await expect(path.getByRole("button", { name: ancestors[0], exact: true })).toBeVisible();
  await expect(path.getByRole("button", { name: "Second Unit", exact: true })).toBeVisible();
  await expect(path.getByRole("button", { name: "Spring Launch", exact: true })).toHaveCount(0);
  await expect(currentFolder(page)).toBeInViewport({ ratio: 1 });

  await pathButton.press("Enter");
  await expect(hierarchy).toBeVisible();
  const folders = hierarchy.getByRole("button");
  await expect(folders).toHaveCount(ancestors.length);
  for (const [index, name] of ancestors.entries()) {
    await expect(folders.nth(index)).toHaveAccessibleName(name);
  }
  await expect(hierarchy.getByText(current, { exact: true })).toBeVisible();

  await hierarchy.getByRole("button", { name: "Spring Launch", exact: true }).click();
  await expect(hierarchy).toBeHidden();
  await expect(currentFolder(page)).toHaveText("Spring Launch");
  await path.getByRole("button", { name: "Previous location", exact: true }).click();
  await expect(currentFolder(page)).toHaveText(current);

  await pathButton.press("ArrowDown");
  await hierarchy.getByRole("button", { name: ancestors[0], exact: true }).press("Enter");
  await expect(path.getByRole("heading", { name: ancestors[0], exact: true })).toBeFocused();
  await expect(hierarchy).toBeHidden();
});

test.describe("compact touch toolbar", () => {
  test.use({ viewport: { width: 320, height: 640 }, hasTouch: true });

  test("the current location and full hierarchy stay reachable", async ({ page }) => {
    await openDeepFolder(page);
    const path = folderPath(page);
    const pathButton = path.getByRole("button", { name: "Show folder path", exact: true });
    const hierarchy = page.getByRole("group", { name: "Folder hierarchy", exact: true });
    await expect(currentFolder(page)).toBeInViewport({ ratio: 1 });
    await expect(pathButton).toBeInViewport({ ratio: 1 });
    await expect(path.getByRole("button", { name: "Second Unit", exact: true })).toBeHidden();

    await pathButton.press("Enter");
    await expect(hierarchy).toBeInViewport({ ratio: 1 });
    await expect(hierarchy.getByRole("button").first()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(hierarchy).toBeHidden();
    await expect(pathButton).toBeFocused();
    await expect(currentFolder(page)).toHaveText(current);

    await pathButton.tap();
    await hierarchy.getByRole("button", { name: "Production Archive", exact: true }).tap();
    await expect(currentFolder(page)).toHaveText("Production Archive");
    await expect(hierarchy).toBeHidden();
  });
});
