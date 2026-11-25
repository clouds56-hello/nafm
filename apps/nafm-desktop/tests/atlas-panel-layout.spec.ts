import { expect, test, type Locator, type Page } from "@playwright/test";

function atlas(page: Page) {
  return page.getByRole("region", { name: "Circular storage map" });
}

function chart(page: Page) {
  return atlas(page).locator("figure.radial-atlas");
}

function sites(page: Page) {
  return page.getByRole("complementary", { name: "Sites", exact: true });
}

function inspector(page: Page) {
  return page.getByRole("complementary", { name: "Inspector", exact: true });
}

function currentFolder(page: Page) {
  return page.getByRole("navigation", { name: "Folder path" }).locator('[aria-current="location"]');
}

function bounds(locator: Locator) {
  return locator.evaluate((element) => {
    const { top, right, bottom, left, width, height } = element.getBoundingClientRect();
    return { top, right, bottom, left, width, height };
  });
}

async function expectFullCompactChart(page: Page) {
  const plot = await bounds(chart(page));
  expect(plot.width).toBeGreaterThanOrEqual(280);
  expect(plot.height).toBeCloseTo(plot.width, 0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  return plot;
}

test.describe("compact Atlas panels", () => {
  test.use({ hasTouch: true, viewport: { width: 320, height: 640 } });

  test("Sites and Contents leave the Atlas full width and stay independently open", async ({ page }) => {
    await page.goto("/mock/");
    await expect(currentFolder(page)).toHaveText("Studio archive");
    const initial = await expectFullCompactChart(page);
    const rail = sites(page);
    const details = inspector(page);

    await page.getByRole("button", { name: "Sites", exact: true }).tap();
    const studio = rail.getByRole("button", { name: "Open Studio archive in Atlas" });
    await expect(studio).toBeFocused();
    await expect(studio).toBeInViewport();
    const onePanel = await expectFullCompactChart(page);
    expect(onePanel.width).toBeCloseTo(initial.width, 0);
    expect((await bounds(rail)).top).toBeGreaterThanOrEqual(onePanel.bottom - 1);

    await page.getByRole("button", { name: "Contents & details", exact: true }).tap();
    const contentsTab = details.getByRole("tab", { name: "Contents" });
    await expect(contentsTab).toBeFocused();
    await expect(contentsTab).toBeInViewport();
    await expect(currentFolder(page)).toBeInViewport();
    const bothPanels = await expectFullCompactChart(page);
    expect(bothPanels.width).toBeCloseTo(initial.width, 0);
    expect((await bounds(rail)).top).toBeGreaterThanOrEqual(bothPanels.bottom - 1);
    expect((await bounds(details)).top).toBeGreaterThanOrEqual((await bounds(rail)).bottom - 1);

    const field = rail.getByRole("button", { name: "Open Field drive in Atlas" });
    await field.tap();
    await expect(field).toBeFocused();
    await expect(currentFolder(page)).toHaveText("Field drive");
    await expect(details.getByRole("heading", { name: "Field drive", exact: true })).toBeVisible();

    await rail.getByRole("button", { name: "Close sites" }).tap();
    await expect(rail).toBeHidden();
    await expect(details).toBeVisible();
    await expect(contentsTab).toBeFocused();
    await expect(details.getByRole("heading", { name: "Field drive", exact: true })).toBeInViewport();
    const remaining = await expectFullCompactChart(page);
    expect((await bounds(details)).top).toBeGreaterThanOrEqual(remaining.bottom - 1);
  });

  test("a retry stays between the full-size Atlas and both open panels", async ({ page }) => {
    await page.goto("/mock/?scenario=recovery");
    await expect(currentFolder(page)).toHaveText("Studio archive");
    await page.getByRole("button", { name: "Sites", exact: true }).tap();
    await page.getByRole("button", { name: "Contents & details", exact: true }).tap();
    const rail = sites(page);
    const details = inspector(page);

    await details.getByRole("grid").getByRole("button", { name: /^Projects\b/ }).tap();
    const failure = atlas(page).getByRole("alert").filter({ hasText: /Couldn[’']t open Projects/ });
    await expect(failure).toBeVisible();
    await expect(currentFolder(page)).toHaveText("Studio archive");
    const plot = await expectFullCompactChart(page);
    const error = await bounds(failure);
    expect(error.top).toBeGreaterThanOrEqual(plot.bottom - 1);
    expect(error.bottom).toBeLessThanOrEqual((await bounds(rail)).top + 1);

    const retry = atlas(page).getByRole("button", { name: "Retry", exact: true });
    await expect(retry).toBeInViewport({ ratio: 1 });
    await retry.tap();
    await expect(currentFolder(page)).toHaveText("Projects");
    await expect(failure).toBeHidden();
    await expect(rail).toBeVisible();
    await expect(details.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
    await expectFullCompactChart(page);

    await details.getByRole("button", { name: "Close inspector" }).tap();
    await expect(details).toBeHidden();
    const selectedSite = rail.getByRole("button", { name: "Open Studio archive in Atlas" });
    await expect(selectedSite).toBeFocused();
    await expect(selectedSite).toBeInViewport();
  });
});

test.describe("desktop Atlas panels", () => {
  test.use({ viewport: { width: 1080, height: 700 } });

  test("each panel docks beside the Atlas and leaves the arcs clickable", async ({ page }) => {
    await page.goto("/mock/");
    await expect(currentFolder(page)).toHaveText("Studio archive");
    const rail = sites(page);
    const details = inspector(page);
    await page.getByRole("button", { name: "Sites", exact: true }).click();
    const sitesOnly = await bounds(chart(page));
    expect((await bounds(rail)).right).toBeLessThanOrEqual(sitesOnly.left + 1);

    await page.getByRole("button", { name: "Contents & details", exact: true }).click();
    const plot = await bounds(chart(page));
    expect(plot.width).toBeGreaterThanOrEqual(470);
    expect(plot.height).toBeCloseTo(plot.width, 0);
    expect((await bounds(rail)).right).toBeLessThanOrEqual(plot.left + 1);
    expect((await bounds(details)).left).toBeGreaterThanOrEqual(plot.right - 1);

    // The center of a curved SVG sector's bounding box can be outside the sector.
    const projects = atlas(page).getByRole("button", { name: /^Projects,/ });
    const point = await projects.locator(".radial-atlas__ring").evaluate((element) => {
      const ring = element as SVGPathElement;
      const middle = ring.getPointAtLength(ring.getTotalLength() / 2);
      const { x, y } = middle.matrixTransform(ring.getScreenCTM()!);
      return { x, y };
    });
    await page.mouse.click(point.x, point.y);
    await expect(currentFolder(page)).toHaveText("Projects");
    await expect(rail).toBeVisible();
    await expect(details.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();

    await rail.getByRole("button", { name: "Close sites" }).click();
    await expect(rail).toBeHidden();
    const contentsOnly = await bounds(chart(page));
    expect(contentsOnly.width).toBeGreaterThanOrEqual(plot.width - 1);
    expect((await bounds(details)).left).toBeGreaterThanOrEqual(contentsOnly.right - 1);
  });
});
