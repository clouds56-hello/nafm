import { expect, test, type Page } from "@playwright/test";

function addDialog(page: Page) {
  return page.getByRole("dialog", { name: "Add site", exact: true });
}

async function openSources(page: Page) {
  await page.getByRole("button", { name: "Workspace actions" }).click();
  await page.getByRole("button", { name: /^Sources\b/ }).click();
  return page.getByRole("dialog", { name: "Sources", exact: true });
}

test("adding or dismissing a site leaves the atlas on the folder being explored", async ({ page }) => {
  await page.goto("/mock/");
  const map = page.getByRole("region", { name: "Circular storage map" });
  await map.getByRole("button", { name: /^Projects,/ }).press("Enter");
  const folder = page.getByRole("navigation", { name: "Folder path" }).locator('[aria-current="location"]');
  await expect(folder).toHaveText("Projects");
  await page.getByRole("button", { name: "Sites", exact: true }).click();
  const rail = page.getByRole("complementary", { name: "Sites" });
  const launch = rail.getByRole("button", { name: "Add site" });
  await launch.press("Enter");

  const dialog = addDialog(page);
  await expect(dialog).toBeVisible();
  await expect(page.locator("dialog:modal")).toHaveCount(1);
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox!.width).toBeLessThan(page.viewportSize()!.width * 0.75);
  const name = dialog.getByRole("textbox", { name: "Site name" });
  await expect(name).toBeFocused();
  await name.fill("Unfinished draft");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(launch).toBeFocused();
  await expect(folder).toHaveText("Projects");

  await launch.press("Enter");
  await expect(name).toHaveValue("");
  await dialog.getByRole("button", { name: "Close add site" }).click();
  await expect(launch).toBeFocused();

  await launch.press("Enter");
  await name.fill("Print masters");
  await dialog.getByRole("textbox", { name: "Folder path" }).fill("/demo/Prints");
  await dialog.getByRole("button", { name: "Add site", exact: true }).click();
  await expect(rail.getByRole("button", { name: "Open Print masters in Atlas" })).toBeVisible();
  await expect(folder).toHaveText("Projects");
});

test("the source library stays open while a site is cancelled or created", async ({ page }) => {
  await page.goto("/mock/");
  const sources = await openSources(page);
  const launch = sources.getByRole("button", { name: "Add site", exact: true });
  await launch.click();
  const dialog = addDialog(page);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(launch).toBeFocused();

  await launch.click();
  const save = dialog.getByRole("button", { name: "Add site", exact: true });
  await expect(save).toBeDisabled();
  const name = dialog.getByRole("textbox", { name: "Site name" });
  await name.fill("Studio archive");
  await dialog.getByRole("button", { name: "Browse…" }).click();
  await save.click();
  await expect(dialog.getByRole("alert")).toContainText("already exists");
  await name.fill("Print masters");
  await save.click();

  await expect(dialog).toBeHidden();
  await expect(sources.getByRole("button", { name: "Open Print masters in Atlas" })).toBeVisible();
});

test("Settings selects the new site after adding an SMB root", async ({ page }) => {
  await page.goto("/mock/");
  await page.getByRole("button", { name: "Workspace actions" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Sites", exact: true }).click();
  const launch = settings.getByRole("button", { name: "Add site", exact: true });
  await launch.click();
  const dialog = addDialog(page);
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(launch).toBeFocused();

  await launch.click();
  await dialog.getByRole("textbox", { name: "Site name" }).fill("Print shop");
  await dialog.getByRole("radio", { name: "SMB share" }).check();
  await dialog.getByRole("textbox", { name: "SMB URL" }).fill("smb://media.example.test/Studio/Prints");
  await dialog.getByRole("checkbox", { name: "Include hidden files" }).uncheck();
  await dialog.getByRole("button", { name: "Add site", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(settings.getByRole("heading", { name: "Print shop" })).toBeVisible();
  await expect(settings.getByText("SMB · Hidden skipped")).toBeVisible();
});

test("an empty atlas opens Add site within a short viewport", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 320 });
  await page.goto("/mock/?scenario=empty");
  const launch = page.getByRole("button", { name: "Add site", exact: true });
  await launch.click();
  const dialog = addDialog(page);
  await dialog.getByRole("radio", { name: "SMB share" }).press("Space");
  await dialog.getByRole("textbox", { name: "SMB URL" }).fill("smb://media.example.test/Prints");
  await dialog.getByRole("textbox", { name: "Username" }).scrollIntoViewIfNeeded();
  await expect(dialog).toBeInViewport({ ratio: 1 });
  await expect(dialog.getByRole("button", { name: "Close add site" })).toBeInViewport({ ratio: 1 });
  await expect(dialog.getByRole("button", { name: "Add site", exact: true })).toBeInViewport({ ratio: 1 });
  const box = await dialog.boundingBox();
  expect(box!.width).toBeLessThan(640);
  expect(box!.height).toBeLessThan(320);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(launch).toBeFocused();

  await launch.press("Enter");
  await dialog.getByRole("textbox", { name: "Site name" }).fill("First archive");
  await dialog.getByRole("textbox", { name: "Folder path" }).fill("/demo/Archive");
  await dialog.getByRole("button", { name: "Add site", exact: true }).click();
  const sites = page.getByRole("button", { name: "Sites", exact: true });
  await expect(sites).toBeFocused();
  await sites.press("Enter");
  const selected = page.getByRole("button", { name: "Open First archive in Atlas" });
  await expect(selected).toHaveAttribute("aria-current", "true");
});
