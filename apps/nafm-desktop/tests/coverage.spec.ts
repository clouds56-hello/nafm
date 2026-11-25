import { expect, test, type Page } from "@playwright/test";

function folderPath(page: Page) {
  return page.getByRole("navigation", { name: "Folder path" });
}

function currentFolder(page: Page) {
  return folderPath(page).locator(".atlas-toolbar-current");
}

function coverage(page: Page) {
  return page.getByRole("region", { name: "Coverage comparison" });
}

function target(page: Page) {
  return coverage(page).getByRole("combobox", { name: "Comparison target" });
}

async function showCoverage(page: Page) {
  const mapOptions = page.getByRole("button", { name: "Map options" });
  await mapOptions.click();
  await page.getByRole("button", { name: "Coverage", exact: true }).click();
  if ((await mapOptions.getAttribute("aria-expanded")) === "true") {
    await page.keyboard.press("Escape");
  }
  await expect(coverage(page)).toBeVisible();
}

test("changing the target keeps the folder, and Back restores the direction after a swap", async ({ page }) => {
  await page.goto("/mock/");
  await expect(currentFolder(page)).toHaveText("Studio archive");
  const map = page.getByRole("figure");
  await map.getByRole("button", { name: /^Projects,/ }).press("Enter");
  await expect(currentFolder(page)).toHaveText("Projects");
  await map.getByRole("button", { name: /^Brand campaign,/ }).press("Enter");
  await expect(currentFolder(page)).toHaveText("Brand campaign");
  await showCoverage(page);

  await expect(coverage(page).getByText("Studio archive", { exact: true })).toBeVisible();
  await expect(target(page)).toHaveValue("field-drive");
  await expect(map.locator(".radial-atlas__size")).toContainText("0/100");
  await target(page).selectOption("team-share");
  await expect(currentFolder(page)).toHaveText("Brand campaign");
  await expect(target(page)).toHaveValue("team-share");
  await expect(map.locator(".radial-atlas__size")).toContainText("89/100");
  await expect(coverage(page).getByText("Coverage ready", { exact: true })).toBeVisible();

  await coverage(page).getByRole("button", { name: "Swap source and target" }).click();
  await expect(currentFolder(page)).toHaveText("Team share");
  await expect(coverage(page).getByText("Team share", { exact: true })).toBeVisible();
  await expect(target(page)).toHaveValue("studio-archive");

  await folderPath(page).getByRole("button", { name: "Previous location", exact: true }).click();
  await expect(currentFolder(page)).toHaveText("Brand campaign");
  await expect(coverage(page).getByText("Studio archive", { exact: true })).toBeVisible();
  await expect(target(page)).toHaveValue("team-share");
  await expect(map.locator(".radial-atlas__size")).toContainText("89/100");
});

test("a pending target reports estimated coverage and can finish verification", async ({ page }) => {
  await page.goto("/mock/?scenario=partial");
  await showCoverage(page);
  await target(page).selectOption("team-share");
  await expect(target(page)).toHaveValue("team-share");
  await coverage(page).getByRole("button", { name: "Swap source and target" }).click();
  await expect(currentFolder(page)).toHaveText("Team share");
  await expect(target(page)).toHaveValue("studio-archive");
  await expect(coverage(page).getByText("Estimated coverage", { exact: true })).toBeVisible();
  await expect(target(page)).toHaveAccessibleDescription("39 hashes pending");
  await expect(page.getByRole("figure").locator(".radial-atlas__size")).toContainText("≈");
  await expect(page.getByRole("figure").locator(".radial-atlas__detail")).toHaveText("Verified content only");

  const resume = coverage(page).getByRole("button", { name: "Resume target scan", exact: true });
  await resume.click();
  await expect(resume).toBeHidden();
  await expect(coverage(page).getByText("Coverage ready", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("figure").locator(".radial-atlas__size")).not.toContainText("≈");
  await expect(currentFolder(page)).toHaveText("Team share");
  await expect(target(page)).toHaveValue("studio-archive");
});

test("a workspace with one site can add a comparison target from Coverage", async ({ page }) => {
  await page.goto("/mock/?scenario=empty");
  const addDialog = page.getByRole("dialog", { name: "Add site", exact: true });
  await page.getByRole("button", { name: "Add site", exact: true }).click();
  await addDialog.getByRole("textbox", { name: "Site name" }).fill("First archive");
  await addDialog.getByRole("textbox", { name: "Folder path" }).fill("/demo/Archive");
  await addDialog.getByRole("button", { name: "Add site", exact: true }).click();
  await expect(addDialog).toBeHidden();
  await expect(currentFolder(page)).toHaveText("First archive");

  await showCoverage(page);
  await expect(coverage(page).getByText("Coverage unavailable", { exact: true })).toBeVisible();
  const addTarget = coverage(page).getByRole("button", { name: /Add (another )?site/ });
  await addTarget.click();
  await expect(addDialog).toBeVisible();
  await addDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(addTarget).toBeFocused();
});

test.describe("compact Coverage options", () => {
  test.use({ viewport: { width: 320, height: 640 }, hasTouch: true });

  test("Map options still changes the target while Contents is open", async ({ page }) => {
    await page.goto("/mock/");
    await showCoverage(page);
    await page.getByRole("button", { name: "Contents & details" }).tap();
    const contents = page.getByRole("tabpanel", { name: "Contents" });
    await expect(contents).toBeVisible();

    await page.getByRole("button", { name: "Map options" }).tap();
    const mapOptions = page.getByRole("group", { name: "Map options", exact: true });
    const picker = mapOptions.getByRole("combobox", { name: "Compare with" });
    await expect(picker).toBeInViewport();
    await picker.selectOption("team-share");
    await expect(picker).toHaveValue("team-share");
    await page.keyboard.press("Escape");
    await expect(mapOptions).toBeHidden();
    await expect(contents).toBeVisible();
    await expect(currentFolder(page)).toHaveText("Studio archive");
    await expect(target(page)).toHaveValue("team-share");
  });
});
