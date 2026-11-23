import { expect, test, type Locator } from "@playwright/test";

function labelsOutsideSector(labels: Locator) {
  return labels.evaluateAll((elements) => elements.flatMap((element) => {
    const text = element as SVGTextElement;
    const target = text.closest("[data-node-id]")?.querySelector<SVGPathElement>(".radial-atlas__target");
    if (!target) return [text.textContent];
    const toSector = target.getScreenCTM()!.inverse().multiply(text.getScreenCTM()!);
    for (let i = 0; i < text.getNumberOfChars(); i++) {
      if (!text.textContent?.[i]?.trim()) continue;
      const box = text.getExtentOfChar(i);
      const center = new DOMPoint(box.x + box.width / 2, box.y + box.height / 2).matrixTransform(toSector);
      if (box.width === 0 || !target.isPointInFill(center)) return [text.textContent];
    }
    return [];
  }));
}

test("ring labels fit their sectors when resized and open the item under the text", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/mock/");
  const map = page.getByRole("region", { name: "Circular storage map" });
  const labels = map.locator(".radial-atlas__label text:visible");
  const projects = map.getByRole("button", { name: /^Projects,/ }).locator(".radial-atlas__label text:visible");
  const photos = map.getByRole("button", { name: /^Photo Library,/ }).locator(".radial-atlas__label text:visible");
  const campaign = map.getByRole("button", { name: /^Brand campaign,/ }).locator(".radial-atlas__label text:visible");
  await expect(projects).toContainText("Projects");
  await expect(photos).toHaveText(/^Photo Library.*GB$/);
  await expect(campaign).toContainText("Brand campaign");
  await expect.poll(() => labelsOutsideSector(labels)).toEqual([]);

  await page.setViewportSize({ width: 390, height: 760 });
  await expect(photos).toHaveText("Photo Library");
  await expect.poll(() => labelsOutsideSector(labels)).toEqual([]);

  // Click a painted character: the center of a curved label's bounding box can be on another ring.
  const point = await photos.evaluate((element) => {
    const text = element as SVGTextElement;
    const box = text.getExtentOfChar(0);
    const point = new DOMPoint(box.x + box.width / 2, box.y + box.height / 2).matrixTransform(text.getScreenCTM()!);
    return { x: point.x, y: point.y };
  });
  await page.mouse.click(point.x, point.y);
  await expect(page.getByRole("navigation", { name: "Folder path" }).locator('[aria-current="location"]'))
    .toHaveText("Photo Library");
});
