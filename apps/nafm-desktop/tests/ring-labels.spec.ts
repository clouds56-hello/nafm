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

function arcMidpoint(sector: Locator) {
  return sector.locator(".radial-atlas__ring").evaluate((element) => {
    const path = element as SVGPathElement;
    const point = path.getPointAtLength(path.getTotalLength() / 2).matrixTransform(path.getScreenCTM()!);
    const hittable = document.elementFromPoint(point.x, point.y)?.closest(".radial-atlas__sector") === path.parentElement;
    return { x: point.x, y: point.y, hittable };
  });
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

test("nested arcs identify the folders containing identical file copies", async ({ page }) => {
  await page.goto("/mock/");
  const map = page.getByRole("region", { name: "Circular storage map" });
  const projects = map.getByRole("button", { name: /^Projects,/ });
  const copies = map.getByRole("button", { name: /^Trailer master\.mov,/ });
  const preview = map.locator(".atlas-sector-preview");
  await expect(copies).toHaveCount(2);
  const original = copies.nth(0);
  const backup = copies.nth(1);
  await expect(original).toHaveAccessibleDescription("In Projects / Brand campaign");
  await expect(backup).toHaveAccessibleDescription("In Projects / Backup campaign");

  await projects.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(original).toBeFocused();
  await expect(preview.getByText("Projects / Brand campaign", { exact: true })).toBeVisible();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await expect(backup).toBeFocused();
  await expect(preview.getByText("Projects / Backup campaign", { exact: true })).toBeVisible();
  await page.keyboard.press("Enter");

  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await expect(inspector.getByRole("heading", { name: "Trailer master.mov", exact: true })).toBeVisible();
  await expect(inspector.getByText(/Backup campaign\/Trailer master\.mov/)).toBeVisible();
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

test.describe("touch Atlas previews", () => {
  test.use({ hasTouch: true });

  for (const viewport of [{ width: 390, height: 750 }, { width: 1060, height: 620 }]) {
    test(`preview leaves other arcs tappable at ${viewport.width}×${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto("/mock/");
      const map = page.getByRole("region", { name: "Circular storage map" });
      const figure = map.getByRole("figure");
      const frame = map.locator(".atlas-chart-well");
      const folder = page.getByRole("navigation", { name: "Folder path" }).locator('[aria-current="location"]');
      await expect(folder).toHaveText("Studio archive");

      const sites = map.getByRole("complementary", { name: "Sites", exact: true });
      const inspector = map.getByRole("complementary", { name: "Inspector", exact: true });
      if (viewport.width < 880) {
        await map.getByRole("button", { name: "Sites", exact: true }).tap();
        await map.getByRole("button", { name: "Contents & details", exact: true }).tap();
        await figure.scrollIntoViewIfNeeded();
      }

      const launchFilm = figure.getByRole("button", { name: /^Launch film\.mov,/ });
      const initialRing = (await figure.boundingBox())!;
      const initialFilm = await arcMidpoint(launchFilm);
      const projects = await arcMidpoint(figure.getByRole("button", { name: /^Projects,/ }));
      await page.touchscreen.tap(projects.x, projects.y);
      const projectPreview = map.getByRole("group", { name: "Preview of Projects", exact: true });
      await expect(projectPreview.getByRole("button", { name: "Open folder", exact: true })).toBeInViewport({ ratio: 0.99 });
      await expect(projectPreview.getByRole("button", { name: "Dismiss preview", exact: true })).toBeInViewport({ ratio: 0.99 });

      const ring = (await figure.boundingBox())!;
      const card = (await projectPreview.boundingBox())!;
      const bounds = (await frame.boundingBox())!;
      expect(ring.y).toBeGreaterThanOrEqual(bounds.y);
      expect(card.y).toBeGreaterThanOrEqual(ring.y + ring.height);
      expect(card.y + card.height).toBeLessThanOrEqual(bounds.y + bounds.height);
      const film = await arcMidpoint(launchFilm);
      expect(film.hittable).toBe(true);
      if (viewport.width < 880) {
        expect(ring.width).toBeCloseTo(initialRing.width, 1);
        expect(film.x).toBeCloseTo(initialFilm.x, 1);
        expect(film.y).toBeCloseTo(initialFilm.y, 1);
      }

      await page.touchscreen.tap(film.x, film.y);
      await expect(projectPreview).toBeHidden();
      const filmPreview = map.getByRole("group", { name: "Preview of Launch film.mov", exact: true });
      await expect(filmPreview).toBeVisible();
      await expect(folder).toHaveText("Studio archive");
      await filmPreview.getByRole("button", { name: "View details", exact: true }).tap();
      await expect(inspector.getByRole("heading", { name: "Launch film.mov", exact: true })).toBeVisible();
      if (viewport.width < 880) await expect(sites).toBeVisible();
    });
  }

  test("dismissing a touch preview brings the focused arc back into view", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 320 });
    await page.goto("/mock/");
    const map = page.getByRole("region", { name: "Circular storage map" });
    const arc = map.getByRole("button", { name: /^Distant rain\.wav,/ });
    const preview = map.getByRole("group", { name: "Preview of Distant rain.wav", exact: true });
    const dismiss = preview.getByRole("button", { name: "Dismiss preview", exact: true });
    await map.getByRole("button", { name: "Sites", exact: true }).tap();
    await expect(map.getByRole("complementary", { name: "Sites", exact: true })).toBeVisible();
    await map.getByRole("button", { name: "Contents & details", exact: true }).tap();
    await expect(map.getByRole("tab", { name: "Contents", exact: true })).toBeFocused();
    await expect(async () => {
      await arc.evaluate((element) => element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
      expect((await arcMidpoint(arc)).hittable).toBe(true);
    }).toPass({ timeout: 5_000 });

    for (const action of ["Dismiss", "Escape"] as const) {
      const point = await arcMidpoint(arc);
      expect(point.hittable).toBe(true);
      await page.touchscreen.tap(point.x, point.y);
      await expect(dismiss).toBeInViewport({ ratio: 0.99 });
      await expect.poll(async () => (await arcMidpoint(arc)).hittable).toBe(false);

      if (action === "Dismiss") await dismiss.tap();
      else await page.keyboard.press("Escape");
      await expect(preview).toBeHidden();
      await expect(arc).toBeFocused();
      await expect.poll(async () => (await arcMidpoint(arc)).hittable).toBe(true);
    }
  });
});
