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

test.describe("compact Atlas readout", () => {
  test.use({ viewport: { width: 320, height: 640 }, hasTouch: true });

  test("the complete folder name stays visible in Size and health modes", async ({ page }) => {
    await page.goto("/mock/?scenario=partial");
    const map = page.getByRole("region", { name: "Circular storage map" }).getByRole("figure");
    const reading = map.locator(".radial-atlas__reading");
    const title = reading.locator(".radial-atlas__name");
    const value = reading.locator(".radial-atlas__size");
    const options = page.getByRole("button", { name: "Map options", exact: true });
    const modes = page.getByRole("group", { name: "Map options", exact: true });

    async function expectReadoutFits() {
      await expect(title).toHaveText("Brand campaign");
      const layout = await title.evaluate(async (element) => {
        await document.fonts.ready;
        const bounds = element.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(element);
        const lines = Array.from(range.getClientRects());
        const name = element.firstChild!;
        const wordsStayTogether = Array.from(name.textContent!.matchAll(/\S+/g)).every((word) => {
          range.setStart(name, word.index);
          range.setEnd(name, word.index + word[0].length);
          return range.getClientRects().length === 1;
        });
        const dial = element.closest("figure")!.querySelector(".radial-atlas__dial")!.getBoundingClientRect();
        const centerX = dial.left + dial.width / 2;
        const centerY = dial.top + dial.height / 2;
        const insideDial = Array.from(element.parentElement!.children).filter((item) => item.matches("span, strong"))
          .every((item) => {
            range.selectNodeContents(item);
            return Array.from(range.getClientRects()).every((rect) => {
              const x = Math.max(Math.abs(rect.left - centerX), Math.abs(rect.right - centerX));
              const y = Math.max(Math.abs(rect.top - centerY), Math.abs(rect.bottom - centerY));
              return Math.hypot(x, y) <= dial.width / 2 + 2;
            });
          });
        return {
          lineCount: new Set(lines.map((line) => line.top)).size,
          wordsStayTogether,
          insideDial,
          unclipped: lines.every((line) => line.left >= bounds.left - 1 && line.right <= bounds.right + 1
            && line.top >= bounds.top - 1 && line.bottom <= bounds.bottom + 1),
        };
      });
      expect(layout.lineCount).toBeGreaterThan(0);
      expect(layout.lineCount).toBeLessThanOrEqual(2);
      expect(layout.unclipped).toBe(true);
      expect(layout.wordsStayTogether).toBe(true);
      expect(layout.insideDial).toBe(true);
    }

    await map.getByRole("button", { name: /^Projects,/ }).press("Enter");
    await map.getByRole("button", { name: /^Brand campaign,/ }).press("Enter");
    await expectReadoutFits();
    await expect(value).toHaveText(/178\s*GB/);
    await expect(value).toBeInViewport();
    await expect(reading.getByText("3 files", { exact: true })).toBeVisible();

    await options.tap();
    await modes.getByRole("button", { name: "Space health", exact: true }).tap();
    await expect(value).toHaveText(/^≈\d+(?:\.\d+)?\/100$/);
    await expect(value).toBeInViewport();
    await expectReadoutFits();

    await options.tap();
    await modes.getByRole("button", { name: "Coverage", exact: true }).tap();
    await expect(value).toHaveText(/^≈\d+(?:\.\d+)?\/100$/);
    await expect(value).toBeInViewport();
    await expect(reading.getByText("Verified only", { exact: true })).toBeVisible();
    await expect(map).toHaveAccessibleDescription(/estimated .*coverage health, verified content only/i);
    await expectReadoutFits();

    await page.keyboard.press("Escape");
    const up = map.getByRole("button", { name: "Up to Projects", exact: true });
    await expect(up).toBeInViewport();
    await up.tap();
    await expect(title).toHaveText("Projects");
  });
});
