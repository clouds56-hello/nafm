import { expect, test, type Page } from "@playwright/test";

const ancestors = ["Studio archive", "Production Archive", "2025 Campaigns", "Spring Launch", "Camera Originals", "Second Unit"];
const current = "Interview Selects";

function folderPath(page: Page) {
  return page.getByRole("navigation", { name: "Folder path" });
}

function currentFolder(page: Page) {
  return folderPath(page).locator(".atlas-toolbar-current");
}

async function expectUnclippedFolderName(page: Page, maxLines: number) {
  const location = currentFolder(page);
  await expect(location).toBeInViewport({ ratio: 0.99 });
  const layout = await location.evaluate(async (element) => {
    await document.fonts.ready;
    const bounds = element.getBoundingClientRect();
    const text = document.createRange();
    text.selectNodeContents(element);
    const lines = Array.from(text.getClientRects());
    const tolerance = 1;
    return {
      lineCount: new Set(lines.map((line) => line.top)).size,
      unclipped: lines.every((line) => line.left >= bounds.left - tolerance
        && line.right <= bounds.right + tolerance && line.top >= bounds.top - tolerance
        && line.bottom <= bounds.bottom + tolerance),
    };
  });
  expect(layout.lineCount).toBeGreaterThan(0);
  expect(layout.lineCount).toBeLessThanOrEqual(maxLines);
  expect(layout.unclipped).toBe(true);
}

async function openDeepFolder(page: Page, url = "/mock/?scenario=deep") {
  await page.goto(url);
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

for (const origin of ["toolbar Up", "Atlas center Up", "folder hierarchy"] as const) {
  test(`${origin} keeps the departed folder visible in Contents after changing sort`, async ({ page }) => {
    await page.goto("/mock/?scenario=large");
    const map = page.getByRole("region", { name: "Circular storage map" }).getByRole("figure");
    const path = folderPath(page);
    const referenceArc = map.getByRole("button", { name: /^Reference images,/ });
    await referenceArc.press("Enter");
    await expect(currentFolder(page)).toHaveText("Reference images");
    await page.getByRole("button", { name: "Contents & details", exact: true }).click();
    const contents = page.getByRole("tabpanel", { name: "Contents", exact: true });
    const sort = contents.getByRole("button", { name: "Sort contents", exact: true });
    await sort.click();
    await page.getByRole("radio", { name: "Name", exact: true }).click();
    await page.getByRole("radio", { name: "Ascending", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(contents.locator('[aria-rowindex="1"] [data-entry-id]')).toHaveAccessibleName(/^Brand guidelines\.pdf/);

    const up = { name: "Up to Photo Library", exact: true };
    const hierarchy = page.getByRole("group", { name: "Folder hierarchy", exact: true });
    const pathButton = path.getByRole("button", { name: "Show folder path", exact: true });
    if (origin === "toolbar Up") {
      await path.getByRole("button", up).press("Enter");
    } else if (origin === "Atlas center Up") {
      await map.getByRole("button", up).press("Enter");
    } else {
      await pathButton.press("Enter");
      await hierarchy.getByRole("button", { name: "Photo Library", exact: true }).press("Enter");
      await expect(hierarchy).toBeHidden();
    }

    await expect(currentFolder(page)).toHaveText("Photo Library");
    const grid = contents.getByRole("grid");
    await expect(grid).toHaveAttribute("aria-rowcount", "4096");
    const folder = grid.getByRole("button", { name: /^Reference images/ });
    await expect(folder).toBeInViewport({ ratio: 0.99 });
    await expect(grid.locator('[aria-rowindex="2763"]')).toContainText("Reference images");
    const focusAfter = {
      "toolbar Up": path.getByRole("button", { name: "Up to Studio archive", exact: true }),
      "Atlas center Up": referenceArc,
      "folder hierarchy": pathButton,
    }[origin];
    await expect(focusAfter).toBeFocused();
  });
}

test("toolbar Up and Alt+Up keep keyboard focus in the path when they reach the root", async ({ page }) => {
  await page.goto("/mock/?scenario=large");
  const path = folderPath(page);
  const heading = path.getByRole("heading", { name: "Studio archive", exact: true });
  const pathButton = path.getByRole("button", { name: "Show folder path", exact: true });
  const hierarchy = page.getByRole("group", { name: "Folder hierarchy", exact: true });
  const map = page.getByRole("region", { name: "Circular storage map" });
  const photos = map.getByRole("button", { name: /^Photo Library,/ });

  await photos.press("Enter");
  await expect(currentFolder(page)).toHaveText("Photo Library");
  await path.getByRole("button", { name: "Up to Studio archive", exact: true }).press("Enter");
  await expect(heading).toBeFocused();

  await photos.press("Enter");
  await expect(currentFolder(page)).toHaveText("Photo Library");
  await pathButton.press("Alt+ArrowUp");
  await expect(heading).toBeFocused();

  await photos.press("Enter");
  await expect(currentFolder(page)).toHaveText("Photo Library");
  await pathButton.press("Enter");
  await hierarchy.getByRole("button", { name: "Studio archive", exact: true }).press("Alt+ArrowUp");
  await expect(hierarchy).toBeHidden();
  await expect(heading).toBeFocused();

  await page.keyboard.press("Alt+ArrowUp");
  await expect(heading).toBeFocused();
  await expect(currentFolder(page)).toHaveText("Studio archive");
});

test.describe("minimum desktop toolbar", () => {
  test.use({ viewport: { width: 1080, height: 700 } });

  test("the current folder is readable at the macOS window minimum with Coverage and a scan active", async ({ page }) => {
    // Hold the mock scan active while measuring the toolbar.
    await page.clock.install({ time: new Date("2025-11-04T12:00:00Z") });
    await page.clock.pauseAt(new Date("2025-11-04T12:10:00Z"));
    await openDeepFolder(page, "/mock/atlas.html?scenario=deep");

    const options = page.getByRole("button", { name: "Map options", exact: true });
    await options.click();
    const modes = page.getByRole("group", { name: "Map options", exact: true });
    await modes.getByRole("button", { name: "Coverage", exact: true }).click();
    await expect(modes.getByRole("combobox", { name: "Compare with", exact: true })).toHaveValue("field-drive");
    await page.keyboard.press("Escape");
    await expect(options).toContainText("Coverage");

    await page.getByRole("button", { name: "Workspace actions", exact: true }).click();
    await page.getByRole("group", { name: "Workspace actions", exact: true }).getByRole("button", { name: "Scan all", exact: true }).click();
    await expect(page.getByRole("button", { name: "Scan activity", exact: true })).toHaveAccessibleDescription("Scanning");

    // Apply the title-bar inset that the macOS app host adds to this shared toolbar.
    await page.locator(".atlas-toolbar").evaluate((toolbar) => toolbar.setAttribute("data-native-inset", "true"));
    await expect(currentFolder(page)).toHaveText(current);
    await expectUnclippedFolderName(page, 1);
    const path = folderPath(page);
    await expect(path.getByRole("button", { name: "Second Unit", exact: true })).toBeHidden();
    const pathButton = path.getByRole("button", { name: "Show folder path", exact: true });
    await pathButton.press("Enter");
    const hierarchy = page.getByRole("group", { name: "Folder hierarchy", exact: true });
    await expect(hierarchy.getByRole("button")).toHaveCount(ancestors.length);
    await expect(hierarchy.getByText(current, { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(pathButton).toBeFocused();
  });
});

test.describe("compact touch toolbar", () => {
  test.use({ viewport: { width: 320, height: 640 }, hasTouch: true });

  test("history shortcuts leave focus in the folder path when an ancestor disappears", async ({ page }) => {
    await page.goto("/mock/");
    await page.getByRole("button", { name: "Sites", exact: true }).press("Enter");
    await page.getByRole("button", { name: "Contents & details", exact: true }).press("Enter");
    const map = page.getByRole("region", { name: "Circular storage map" });
    for (const name of ["Projects", "Brand campaign"]) {
      await map.getByRole("button", { name: new RegExp(`^${name},`) }).press("Enter");
      await expect(currentFolder(page)).toHaveText(name);
    }

    const path = folderPath(page);
    const pathButton = path.getByRole("button", { name: "Show folder path", exact: true });
    const hierarchy = page.getByRole("group", { name: "Folder hierarchy", exact: true });
    const ancestor = (name: string) => hierarchy.getByRole("button", { name, exact: true });
    const goFromHierarchy = async (name: string, shortcut: string) => {
      await pathButton.press("ArrowDown");
      await ancestor(name).press(shortcut);
      await expect(hierarchy).toBeHidden();
    };

    await pathButton.press("ArrowDown");
    await ancestor("Projects").press("Alt+ArrowRight");
    await expect(hierarchy).toBeVisible();
    await expect(ancestor("Projects")).toBeFocused();
    await ancestor("Projects").press("Alt+ArrowLeft");
    await expect(currentFolder(page)).toHaveText("Projects");
    await expect(hierarchy).toBeHidden();
    await expect(pathButton).toBeFocused();

    await goFromHierarchy("Studio archive", "Alt+ArrowRight");
    await expect(currentFolder(page)).toHaveText("Brand campaign");
    await expect(pathButton).toBeFocused();
    await goFromHierarchy("Projects", "Alt+ArrowLeft");
    await expect(currentFolder(page)).toHaveText("Projects");
    await expect(pathButton).toBeFocused();

    await goFromHierarchy("Studio archive", "Alt+ArrowLeft");
    const root = path.getByRole("heading", { name: "Studio archive", exact: true });
    await expect(root).toBeFocused();
    await expect(root).toBeInViewport();
    await expect(page.getByRole("complementary", { name: "Sites", exact: true })).toBeVisible();
    await expect(page.getByRole("tabpanel", { name: "Contents", exact: true })).toBeVisible();
  });

  test("the folder name stays readable with scan and folder actions available", async ({ page }) => {
    await page.goto("/mock/?scenario=partial");
    const map = page.getByRole("region", { name: "Circular storage map" });
    const location = currentFolder(page);
    for (const name of ["Projects", "Brand campaign"]) {
      await map.getByRole("button", { name: new RegExp(`^${name},`) }).press("Enter");
      await expect(location).toHaveText(name);
    }

    await expectUnclippedFolderName(page, 2);

    const actions = page.getByRole("button", { name: "Workspace actions", exact: true });
    const controls = ["Previous location", "Show folder path", "Open Brand campaign in…", "Map options", "Scan activity", "Workspace actions"];
    for (const control of controls) {
      const button = page.getByRole("button", { name: control, exact: true });
      await expect(button).toBeInViewport({ ratio: 0.99 });
      await button.click({ trial: true });
    }
    await expect(page.getByRole("button", { name: "Preview", exact: true })).toBeHidden();
    await expect(page.getByRole("combobox", { name: "Workspace", exact: true })).toBeHidden();

    const menu = page.getByRole("group", { name: "Workspace actions", exact: true });
    const workspace = menu.getByRole("combobox", { name: "Workspace", exact: true });
    await actions.tap();
    await expect(workspace).toHaveValue("Studio workspace");
    await menu.getByText("Preview", { exact: true }).tap();
    const scenario = menu.getByRole("combobox", { name: "Scenario", exact: true });
    await expect(scenario).toBeVisible();
    await expect(scenario).toHaveValue("partial");
    await expect(scenario.locator("option:checked")).toHaveText("Partial verification");
    await expect(menu.getByRole("button", { name: "Reset", exact: true })).toBeVisible();
    await expect(menu.getByRole("link", { name: "App only", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(actions).toBeFocused();
    await expect(location).toHaveText("Brand campaign");

    await actions.tap();
    await workspace.selectOption("Field notes");
    await expect(menu).toBeHidden();
    await expect(map.getByText("No source selected", { exact: true })).toBeVisible();
    await actions.tap();
    await expect(workspace).toHaveValue("Field notes");
  });

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
