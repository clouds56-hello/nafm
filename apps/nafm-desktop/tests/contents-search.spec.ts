import { expect, test, type Locator, type Page } from "@playwright/test";

function currentFolder(page: Page) {
  return page.getByRole("navigation", { name: "Folder path" }).locator('[aria-current="location"]');
}

function entry(contents: Locator, name: RegExp) {
  return contents.getByRole("grid").getByRole("button", { name });
}

function firstEntry(contents: Locator) {
  return contents.locator('[aria-rowindex="1"] [data-entry-id]');
}

function searchButton(contents: Locator) {
  return contents.getByRole("button", { name: "Search this folder", exact: true });
}

function searchInput(contents: Locator) {
  return contents.getByRole("searchbox", { name: "Find in folder", exact: true })
    .or(contents.getByRole("textbox", { name: "Find in folder", exact: true }));
}

async function openPhotoLibrary(page: Page, scenario: "populated" | "large" = "populated") {
  await page.goto(scenario === "large" ? "/mock/?scenario=large" : "/mock/");
  await page.getByRole("region", { name: "Circular storage map" })
    .getByRole("button", { name: /^Photo Library,/ }).press("Enter");
  await expect(currentFolder(page)).toHaveText("Photo Library");
  await page.getByRole("button", { name: "Contents & details" }).click();
  const contents = page.getByRole("tabpanel", { name: "Contents" });
  await expect(contents.getByRole("grid")).toHaveAttribute("aria-rowcount", scenario === "large" ? "4096" : "100");
  return contents;
}

async function sortByName(page: Page, contents: Locator, direction: "Ascending" | "Descending") {
  const sort = contents.getByRole("button", { name: "Sort contents", exact: true });
  await sort.click();
  await page.getByRole("radio", { name: "Name", exact: true }).click();
  await page.getByRole("radio", { name: direction, exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(sort).toHaveAttribute("title", `Name, ${direction.toLowerCase()}`);
}

async function showFoundProofInContents(page: Page) {
  await page.getByRole("button", { name: "Find files", exact: true }).press("Enter");
  const finder = page.getByRole("dialog", { name: "Find files", exact: true });
  await finder.getByRole("searchbox", { name: "File name", exact: true }).fill("Proof 096");
  await finder.getByRole("button", { name: /^Proof 096\.jpg/ }).press("Enter");

  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await expect(finder).toBeHidden();
  await expect(currentFolder(page)).toHaveText("Photo Library");
  await expect(inspector.getByRole("heading", { name: "Proof 096.jpg", exact: true })).toBeVisible();
  await inspector.getByRole("button", { name: "Show in Contents", exact: true }).press("Enter");
}

test("Contents finds distant entries and returns from Details to the same filtered row", async ({ page }) => {
  const contents = await openPhotoLibrary(page);
  const grid = contents.getByRole("grid");
  const distantFile = entry(contents, /^Proof 096\.jpg/);
  const first = firstEntry(contents);
  await expect(distantFile).toHaveCount(0);
  const readOffsets = await page.evaluateHandle(() => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: { offset: number; query?: string }) => Promise<unknown> };
    };
    const offsets: number[] = [];
    const invoke = bridge.invoke.bind(bridge);
    bridge.invoke = (command, args) => {
      if (command === "get_storage_children" && args.query === "proof") offsets.push(args.offset);
      return invoke(command, args);
    };
    return offsets;
  });

  await searchButton(contents).press("Enter");
  const search = searchInput(contents);
  await expect(search).toBeFocused();
  await search.fill("proof");
  await expect(grid).toHaveAttribute("aria-rowcount", "96");
  await expect(first).toHaveAccessibleName(/^Proof 001\.jpg/);
  await contents.evaluate((pane) => { pane.scrollTop = pane.scrollHeight; });
  await expect(distantFile).toBeInViewport();
  await expect(contents.locator('[aria-rowindex="96"] [data-entry-id]')).toHaveAccessibleName(/^Proof 096\.jpg/);
  expect(await readOffsets.evaluate((offsets) => offsets.some((offset) => offset > 0))).toBe(true);

  await search.fill("  pRoOf 09  ");
  await expect(grid).toHaveAttribute("aria-rowcount", "7");
  await expect(first).toHaveAccessibleName(/^Proof 090\.jpg/);
  await expect(distantFile).toBeVisible();

  const sort = contents.getByRole("button", { name: "Sort contents", exact: true });
  await sort.click();
  await page.getByRole("radio", { name: "Name", exact: true }).click();
  await expect(page.getByRole("radio", { name: "Descending", exact: true })).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(first).toHaveAccessibleName(/^Proof 096\.jpg/);
  await expect(grid).toHaveAttribute("aria-rowcount", "7");

  await distantFile.click();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await expect(inspector.getByRole("heading", { name: "Proof 096.jpg", exact: true })).toBeVisible();
  await inspector.getByRole("button", { name: "Back to Contents", exact: true }).click();
  await expect(search).toHaveValue("  pRoOf 09  ");
  await expect(grid).toHaveAttribute("aria-rowcount", "7");
  await expect(distantFile).toBeFocused();
  await expect(currentFolder(page)).toHaveText("Photo Library");

  await search.press("Escape");
  await expect(search).toBeHidden();
  await expect(contents).toBeVisible();
  await expect(searchButton(contents)).toBeFocused();
  await expect(grid).toHaveAttribute("aria-rowcount", "100");
  await expect(first).toHaveAccessibleName(/^Studio portraits/);
});

for (const route of ["Sites", "Atlas history"] as const) {
  test(`returning through ${route} restores distant filtered file Details and Contents`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 820 });
    const contents = await openPhotoLibrary(page, "large");
    await page.getByRole("button", { name: "Sites", exact: true }).press("Enter");
    const sites = page.getByRole("complementary", { name: "Sites", exact: true });
    const openField = sites.getByRole("button", { name: "Open Field drive in Atlas", exact: true });
    const openStudio = sites.getByRole("button", { name: "Open Studio archive in Atlas", exact: true });
    const path = page.getByRole("navigation", { name: "Folder path" });
    const previous = path.getByRole("button", { name: "Previous location", exact: true });
    const next = path.getByRole("button", { name: "Next location", exact: true });
    const inspector = page.getByRole("complementary", { name: "Inspector", exact: true });
    const backToContents = inspector.getByRole("button", { name: "Back to Contents", exact: true });

    const filter = searchInput(contents);
    const query = "  hArBoR SuRvEy  ";
    const rank = 440;
    const fileName = "Harbor survey 2431.jpg";
    const file = entry(contents, /^Harbor survey 2431\.jpg/);
    const heading = inspector.getByRole("heading", { name: fileName, exact: true });
    const grid = contents.getByRole("grid");
    await searchButton(contents).press("Enter");
    await filter.fill(query);
    await expect(grid).toHaveAttribute("aria-rowcount", "666");
    await expect(file).toHaveCount(0);
    const height = await grid.evaluate((list) =>
      Number.parseFloat(getComputedStyle(list).getPropertyValue("--directory-row-height")));
    await contents.evaluate((pane, top) => { pane.scrollTop = top; }, (rank - 4) * height);
    await expect(file).toBeInViewport({ ratio: 0.99 });
    const scrollTop = await contents.evaluate((pane) => pane.scrollTop);
    expect(scrollTop).toBeGreaterThan(0);

    await file.press("Enter");
    await expect(heading).toBeVisible();
    await expect(backToContents).toBeVisible();
    await openField.press("Enter");
    await expect(currentFolder(page)).toHaveText("Field drive");

    if (route === "Sites") {
      await page.getByRole("region", { name: "Circular storage map" })
        .getByRole("button", { name: /^Drone imagery,/ }).press("Enter");
      await expect(currentFolder(page)).toHaveText("Drone imagery");
      await searchButton(contents).press("Enter");
      await filter.fill("survey");
      await expect(grid).toHaveAttribute("aria-rowcount", "1");
      await expect(entry(contents, /^Headland survey\.dng/)).toBeVisible();
    }

    const returnToStudio = route === "Sites" ? openStudio : previous;
    await returnToStudio.press("Enter");
    await expect(currentFolder(page)).toHaveText("Photo Library");
    await expect(heading).toBeVisible();
    await expect(backToContents).toBeVisible();
    await expect(returnToStudio).toBeFocused();

    if (route === "Atlas history") {
      await next.press("Enter");
      await expect(currentFolder(page)).toHaveText("Field drive");
      await previous.press("Enter");
      await expect(currentFolder(page)).toHaveText("Photo Library");
      await expect(heading).toBeVisible();
      await expect(backToContents).toBeVisible();
    }

    await backToContents.press("Enter");
    await expect(sites).toBeVisible();
    await expect(filter).toHaveValue(query);
    await expect(grid).toHaveAttribute("aria-rowcount", "666");
    await expect.poll(() => contents.evaluate((pane) => pane.scrollTop)).toBe(scrollTop);
    await expect(file).toBeInViewport({ ratio: 0.99 });
    await expect(file).toBeFocused();
  });
}

test("Show in Contents keeps the folder search and reveals a late match", async ({ page }) => {
  const contents = await openPhotoLibrary(page);
  const search = searchInput(contents);
  const grid = contents.getByRole("grid");
  const proof = entry(contents, /^Proof 096\.jpg/);
  const query = "  pRoOf  ";

  await searchButton(contents).click();
  await search.fill(query);
  await expect(grid).toHaveAttribute("aria-rowcount", "96");
  await expect(proof).toHaveCount(0);

  await showFoundProofInContents(page);
  await expect(search).toHaveValue(query);
  await expect(grid).toHaveAttribute("aria-rowcount", "96");
  await expect(proof).toBeInViewport({ ratio: 0.99 });
  await expect(proof).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(entry(contents, /^Proof 095\.jpg/)).toBeFocused();
});

test("Show in Contents can restore an excluding search and keeps the Finder jump in history", async ({ page }) => {
  const contents = await openPhotoLibrary(page);
  const search = searchInput(contents);
  const grid = contents.getByRole("grid");
  const proof = entry(contents, /^Proof 096\.jpg/);
  const query = "  prOoF 01  ";
  const path = page.getByRole("navigation", { name: "Folder path" });

  await searchButton(contents).click();
  await search.fill(query);
  await expect(grid).toHaveAttribute("aria-rowcount", "10");
  await path.getByRole("button", { name: "Studio archive", exact: true }).press("Enter");
  await expect(currentFolder(page)).toHaveText("Studio archive");

  await showFoundProofInContents(page);
  await expect(grid).toHaveAttribute("aria-rowcount", "100");
  await expect(proof).toBeInViewport({ ratio: 0.99 });
  await expect(proof).toBeFocused();
  await expect(search).toBeHidden();
  const paused = contents.getByRole("status").filter({ hasText: "Search paused" });
  await expect(paused).toBeVisible();
  await contents.getByRole("button", { name: "Restore search", exact: true }).press("Enter");
  await expect(paused).toBeHidden();
  await expect(search).toHaveValue(query);
  await expect(search).toBeFocused();
  await expect(grid).toHaveAttribute("aria-rowcount", "10");
  await expect(proof).toHaveCount(0);

  await path.getByRole("button", { name: "Previous location", exact: true }).press("Enter");
  await expect(currentFolder(page)).toHaveText("Studio archive");
});

const portraitsQuery = "  Studio portraits  ";

async function openPortraitSearch(page: Page) {
  const contents = await openPhotoLibrary(page, "large");
  await sortByName(page, contents, "Ascending");
  await searchButton(contents).press("Enter");
  await searchInput(contents).fill(portraitsQuery);
  await expect(contents.getByRole("grid")).toHaveAttribute("aria-rowcount", "1");
  await expect(entry(contents, /^Studio portraits/)).toBeVisible();
  return contents;
}

test("Smaller items opens its group and preserves the folder search across the visit", async ({ page }) => {
  const contents = await openPortraitSearch(page);
  await page.getByRole("button", { name: "Sites", exact: true }).click();
  const sites = page.getByRole("complementary", { name: "Sites", exact: true });
  const grid = contents.getByRole("grid");
  const sort = contents.getByRole("button", { name: "Sort contents", exact: true });
  const search = searchInput(contents);

  const map = page.getByRole("region", { name: "Circular storage map" }).getByRole("figure");
  const paused = contents.getByRole("status").filter({ hasText: "Search paused" });
  const restore = contents.getByRole("button", { name: "Restore search", exact: true });
  const firstGroupedRow = grid.locator('[aria-rowindex="12"] [data-entry-id]');
  await map.getByRole("button", { name: /^Smaller items,/ }).press("Enter");

  await expect(grid).toHaveAttribute("aria-rowcount", "4096");
  await expect(paused).toBeVisible();
  await expect(restore).toBeVisible();
  await expect(search).toBeHidden();
  await expect(sort).toHaveAttribute("title", "Size, descending");
  await expect(firstGroupedRow).toHaveAccessibleName(/^Rooftop portraits 1428\.tif/);
  await expect(firstGroupedRow).toBeFocused();
  await expect(firstGroupedRow).toBeInViewport({ ratio: 0.99 });
  await page.keyboard.press("ArrowDown");
  await expect(grid.locator('[aria-rowindex="13"] [data-entry-id]')).toBeFocused();

  const path = page.getByRole("navigation", { name: "Folder path" });
  await path.getByRole("button", { name: "Previous location", exact: true }).press("Enter");
  await expect(currentFolder(page)).toHaveText("Photo Library");
  await expect(search).toHaveValue(portraitsQuery);
  await expect(sort).toHaveAttribute("title", "Name, ascending");
  await expect(grid).toHaveAttribute("aria-rowcount", "1");
  await expect(entry(contents, /^Studio portraits/)).toBeVisible();

  await path.getByRole("button", { name: "Next location", exact: true }).press("Enter");
  await expect(grid).toHaveAttribute("aria-rowcount", "4096");
  await expect(paused).toBeVisible();
  await expect(sort).toHaveAttribute("title", "Size, descending");
  await expect(firstGroupedRow).toBeInViewport({ ratio: 0.99 });
  await restore.press("Enter");

  await expect(paused).toBeHidden();
  await expect(search).toHaveValue(portraitsQuery);
  await expect(search).toBeFocused();
  await expect(sort).toHaveAttribute("title", "Name, ascending");
  await expect(grid).toHaveAttribute("aria-rowcount", "1");
  await expect(entry(contents, /^Studio portraits/)).toBeVisible();
  await expect(sites).toBeVisible();
});

test("a nested Smaller items arc focuses the first grouped row in its containing folder", async ({ page }) => {
  const contents = await openPortraitSearch(page);
  const path = page.getByRole("navigation", { name: "Folder path" });
  await path.getByRole("button", { name: "Studio archive", exact: true }).press("Enter");
  await expect(currentFolder(page)).toHaveText("Studio archive");
  const map = page.getByRole("region", { name: "Circular storage map" }).getByRole("figure");
  const photoId = await map.getByRole("button", { name: /^Photo Library,/ }).getAttribute("data-node-id");
  const nestedGroup = map.getByRole("button", { name: /^Smaller items,/ })
    .and(map.locator(`[data-tier="1"][data-node-id$=":${photoId}"]`));
  await nestedGroup.press("Enter");

  await expect(currentFolder(page)).toHaveText("Photo Library");
  const grid = contents.getByRole("grid");
  await expect(grid).toHaveAttribute("aria-rowcount", "4096");
  await expect(contents.getByRole("status").filter({ hasText: "Search paused" })).toBeVisible();
  const grouped = grid.locator('[aria-rowindex="12"] [data-entry-id]');
  await expect(grouped).toHaveAccessibleName(/^Rooftop portraits 1428\.tif/);
  await expect(grouped).toBeFocused();
  await expect(grouped).toBeInViewport({ ratio: 0.99 });
});

test("a nested file arc returns to the source search or reveals in its containing search", async ({ page }) => {
  await page.goto("/mock/");
  const map = page.getByRole("region", { name: "Circular storage map" });
  const path = page.getByRole("navigation", { name: "Folder path" });
  for (const folder of ["Projects", "Brand campaign"]) {
    await map.getByRole("button", { name: new RegExp(`^${folder},`) }).press("Enter");
    await expect(currentFolder(page)).toHaveText(folder);
  }
  await page.getByRole("button", { name: "Contents & details", exact: true }).press("Enter");
  const contents = page.getByRole("tabpanel", { name: "Contents", exact: true });
  const grid = contents.getByRole("grid");
  const search = searchInput(contents);
  const trailer = entry(contents, /^Trailer master\.mov/);
  await searchButton(contents).press("Enter");
  await search.fill("Trailer master");
  await expect(grid).toHaveAttribute("aria-rowcount", "1");

  await path.getByRole("button", { name: "Studio archive", exact: true }).press("Enter");
  await expect(currentFolder(page)).toHaveText("Studio archive");
  const sourceQuery = "  o  ";
  const sourceRow = entry(contents, /^Photo Library/);
  await searchButton(contents).press("Enter");
  await search.fill(sourceQuery);
  await expect(firstEntry(contents)).toHaveAccessibleName(/^Projects/);
  await sourceRow.focus();

  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const details = inspector.getByRole("heading", { name: "Trailer master.mov", exact: true });
  const back = inspector.getByRole("button", { name: "Back to Contents", exact: true });
  const expectSourceContents = async () => {
    await expect(currentFolder(page)).toHaveText("Studio archive");
    await expect(search).toHaveValue(sourceQuery);
    await expect(sourceRow).toBeFocused();
    await expect(sourceRow).toBeInViewport();
  };

  await map.getByRole("button", { name: /^Trailer master\.mov,/ })
    .and(page.locator('[data-node-id*="/Brand campaign/"]')).press("Enter");
  await expect(details).toBeVisible();
  await expect(currentFolder(page)).toHaveText("Studio archive");
  await back.press("Enter");
  await expectSourceContents();

  await page.keyboard.press("Alt+ArrowRight");
  await expect(details).toBeVisible();
  await page.keyboard.press("Alt+ArrowLeft");
  await expectSourceContents();

  await page.keyboard.press("Alt+ArrowRight");
  await expect(details).toBeVisible();
  await page.keyboard.press("Escape");
  await expectSourceContents();

  await page.keyboard.press("Alt+ArrowRight");
  await expect(details).toBeVisible();
  await inspector.getByRole("button", { name: "Show in Contents", exact: true }).press("Enter");

  await expect(currentFolder(page)).toHaveText("Brand campaign");
  await expect(search).toHaveValue("Trailer master");
  await expect(grid).toHaveAttribute("aria-rowcount", "1");
  await expect(trailer).toBeFocused();
});

test("Contents restores each folder's search and the selected row across history", async ({ page }) => {
  const contents = await openPhotoLibrary(page);
  const grid = contents.getByRole("grid");
  await searchButton(contents).click();
  const search = searchInput(contents);
  await search.fill("Surfaces.tif");
  await expect(contents.getByText(/no matches|0 matches/i).first()).toBeVisible();
  await expect(grid).toBeHidden();
  await expect(currentFolder(page)).toHaveText("Photo Library");

  const parentQuery = "  R  ";
  await search.fill(parentQuery);
  await expect(grid).toHaveAttribute("aria-rowcount", "99");
  // Name order puts the matching subfolder near the end of the virtual list.
  await contents.getByRole("button", { name: "Sort contents", exact: true }).click();
  await page.getByRole("radio", { name: "Name", exact: true }).click();
  await page.getByRole("radio", { name: "Ascending", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(firstEntry(contents)).toHaveAccessibleName(/^Editorial/);
  const folder = entry(contents, /^Reference images/);
  await expect(folder).toHaveCount(0);
  await contents.evaluate((pane) => { pane.scrollTop = pane.scrollHeight; });
  await expect(folder).toBeInViewport({ ratio: 1 });
  const parentScroll = await contents.evaluate((pane) => pane.scrollTop);
  expect(parentScroll).toBeGreaterThan(0);

  await folder.press("Enter");
  await expect(currentFolder(page)).toHaveText("Reference images");
  await expect(search).toBeHidden();
  await expect(grid).toHaveAttribute("aria-rowcount", "2");

  await searchButton(contents).click();
  await search.fill("Surfaces");
  await expect(grid).toHaveAttribute("aria-rowcount", "1");
  const childFile = entry(contents, /^Surfaces\.tif/);
  await childFile.press("Alt+ArrowLeft");
  await expect(currentFolder(page)).toHaveText("Photo Library");
  await expect(search).toHaveValue(parentQuery);
  await expect(folder).toBeFocused();
  await expect(folder).toBeInViewport({ ratio: 1 });
  await expect.poll(() => contents.evaluate((pane) => pane.scrollTop)).toBeCloseTo(parentScroll, 0);

  await folder.press("Alt+ArrowRight");
  await expect(currentFolder(page)).toHaveText("Reference images");
  await expect(search).toHaveValue("Surfaces");
  await expect(grid).toHaveAttribute("aria-rowcount", "1");

  await childFile.press("Alt+ArrowLeft");
  await expect(currentFolder(page)).toHaveText("Photo Library");
  await expect(search).toHaveValue(parentQuery);
  await contents.getByRole("button", { name: "Close search", exact: true }).click();
  await expect(searchButton(contents)).toBeFocused();
  await expect(grid).toHaveAttribute("aria-rowcount", "100");
  await searchButton(contents).press("Alt+ArrowRight");
  await expect(currentFolder(page)).toHaveText("Reference images");
  await expect(search).toHaveValue("Surfaces");
  await childFile.press("Alt+ArrowLeft");
  await expect(currentFolder(page)).toHaveText("Photo Library");
  await expect(search).toBeHidden();
  await expect(grid).toHaveAttribute("aria-rowcount", "100");
});

test("Alt+Up returns to the departed folder in a large parent after changing sort", async ({ page }) => {
  await page.goto("/mock/?scenario=large");
  await page.getByRole("region", { name: "Circular storage map" })
    .getByRole("button", { name: /^Reference images,/ }).press("Enter");
  await expect(currentFolder(page)).toHaveText("Reference images");
  await page.getByRole("button", { name: "Contents & details" }).click();
  const contents = page.getByRole("tabpanel", { name: "Contents" });
  await sortByName(page, contents, "Ascending");
  const childFile = firstEntry(contents);
  await expect(childFile).toHaveAccessibleName(/^Brand guidelines\.pdf/);

  await childFile.press("Alt+ArrowUp");
  await expect(currentFolder(page)).toHaveText("Photo Library");
  const grid = contents.getByRole("grid");
  await expect(grid).toHaveAttribute("aria-rowcount", "4096");
  const departed = entry(contents, /^Reference images/);
  await expect(departed).toBeFocused();
  await expect(departed).toBeInViewport({ ratio: 0.99 });
  await expect(grid.locator('[aria-rowindex="2763"]')).toContainText("Reference images");
});

test("Contents Up preserves the parent's search and seeks the folder in the new sort order", async ({ page }) => {
  const contents = await openPhotoLibrary(page, "large");
  const grid = contents.getByRole("grid");
  const search = searchInput(contents);
  const departed = entry(contents, /^Reference images/);
  const query = "  R  ";
  await sortByName(page, contents, "Ascending");
  await searchButton(contents).press("Enter");
  await search.fill(query);
  await expect(grid).toHaveAttribute("aria-rowcount", "2097");
  await expect(firstEntry(contents)).toHaveAccessibleName(/^Editorial/);

  const height = await grid.evaluate((list) => Number.parseFloat(getComputedStyle(list).getPropertyValue("--directory-row-height")));
  await contents.evaluate((pane, top) => { pane.scrollTop = top; }, (1430 - 4) * height);
  await expect(departed).toBeInViewport({ ratio: 0.99 });
  const parentScroll = await contents.evaluate((pane) => pane.scrollTop);
  await departed.press("Enter");
  await expect(currentFolder(page)).toHaveText("Reference images");
  await expect(search).toBeHidden();
  await expect(firstEntry(contents)).toHaveAccessibleName(/^Brand guidelines\.pdf/);
  await firstEntry(contents).press("ArrowLeft");
  await expect(currentFolder(page)).toHaveText("Photo Library");
  await expect(departed).toBeFocused();
  await expect.poll(() => contents.evaluate((pane) => pane.scrollTop)).toBeCloseTo(parentScroll, 0);

  await departed.press("Enter");
  await expect(currentFolder(page)).toHaveText("Reference images");
  await sortByName(page, contents, "Descending");
  await expect(firstEntry(contents)).toHaveAccessibleName(/^Surfaces\.tif/);
  await firstEntry(contents).press("ArrowLeft");

  await expect(currentFolder(page)).toHaveText("Photo Library");
  await expect(search).toHaveValue(query);
  await expect(grid).toHaveAttribute("aria-rowcount", "2097");
  await expect(departed).toBeFocused();
  await expect(departed).toBeInViewport({ ratio: 0.99 });
  await expect(grid.locator('[aria-rowindex="668"]')).toContainText("Reference images");
});

test("an index refresh keeps focus and scroll in filtered Contents", async ({ page }) => {
  const contents = await openPhotoLibrary(page, "large");
  const refresh = await page.evaluateHandle(() => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
    };
    const invoke = bridge.invoke.bind(bridge);
    let publish!: () => void;
    const publishing = new Promise<void>((resolve) => { publish = resolve; });
    const state = { publish, published: false, reply_offsets: [] as number[] };
    bridge.invoke = async (command, args) => {
      if (command === "plugin:event|emit" && args.event === "task://scan/events") {
        const event = args.payload as { site_id: string | null; kind: string; phase: string | null };
        if (event.site_id === "field-drive" && event.kind === "progress"
          && (event.phase === "hashing" || event.phase === "finalizing")) {
          await publishing;
          state.published = true;
        }
      }
      if (!state.published || command !== "get_storage_children" || String(args.query).toLowerCase() !== "harbor survey") {
        return invoke(command, args);
      }
      const response = await invoke(command, args);
      state.reply_offsets.push((response as { offset: number }).offset);
      return response;
    };
    return state;
  });
  await page.getByRole("button", { name: "Sites", exact: true }).click();
  const sites = page.getByRole("complementary", { name: "Sites", exact: true });
  const results = contents.getByRole("region", { name: "Directory entries" });
  const grid = contents.getByRole("grid");
  const search = searchInput(contents);
  const searchText = "  hArBoR SuRvEy  ";
  await searchButton(contents).press("Enter");
  await search.fill(searchText);
  await expect(grid).toHaveAttribute("aria-rowcount", "666");
  await contents.evaluate((pane) => { pane.scrollTop = pane.scrollHeight; });
  const last = grid.locator('[aria-rowindex="666"] [data-entry-id]');
  await expect(last).toBeInViewport({ ratio: 0.99 });
  const fileId = await last.getAttribute("data-entry-id");

  await sites.getByRole("button", { name: "Scan Field drive", exact: true }).click();
  try {
    await last.focus();
    await expect(last).toBeFocused();
    const savedScroll = await contents.evaluate((pane) => pane.scrollTop);
    expect(savedScroll).toBeGreaterThan(0);
    await refresh.evaluate((state) => state.publish());
    await expect.poll(() => refresh.evaluate((state) => state.published && state.reply_offsets.length > 0)).toBe(true);
    await expect(results).not.toHaveAttribute("aria-busy", "true");
    await expect(last).toHaveAttribute("data-entry-id", fileId!);
    await expect(last).toBeFocused();
    await expect(last).toBeInViewport({ ratio: 0.99 });
    await expect(search).toHaveValue(searchText);
    expect(await contents.evaluate((pane) => pane.scrollTop)).toBe(savedScroll);
    const offsets = await refresh.evaluate((state) => state.reply_offsets);
    expect(offsets.every((offset) => offset >= 600)).toBe(true);
    await page.keyboard.press("ArrowUp");
    await expect(grid.locator('[aria-rowindex="665"] [data-entry-id]')).toBeFocused();
  } finally {
    await refresh.evaluate((state) => state.publish());
  }
});

test("a late folder search cannot replace the results of a newer query", async ({ page }) => {
  const contents = await openPhotoLibrary(page);
  const delayed = await page.evaluateHandle(() => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: { query?: string }) => Promise<unknown> };
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const request = { pending: false, replied: false, release };
    const invoke = bridge.invoke.bind(bridge);
    bridge.invoke = async (command, args) => {
      const result = await invoke(command, args);
      if (command === "get_storage_children" && args.query === "Proof 09") {
        request.pending = true;
        await gate;
        request.replied = true;
      }
      return result;
    };
    return request;
  });

  const search = searchInput(contents);
  const grid = contents.getByRole("grid");
  const first = firstEntry(contents);
  try {
    await searchButton(contents).click();
    await search.fill("Proof 09");
    await expect.poll(() => delayed.evaluate((request) => request.pending)).toBe(true);
    await search.fill("Proof 01");
    await expect(grid).toHaveAttribute("aria-rowcount", "10");
    await expect(first).toHaveAccessibleName(/^Proof 010\.jpg/);
  } finally {
    await delayed.evaluate((request) => request.release());
  }

  await expect.poll(() => delayed.evaluate((request) => request.replied)).toBe(true);
  await expect(grid).toHaveAttribute("aria-rowcount", "10");
  await expect(first).toHaveAccessibleName(/^Proof 010\.jpg/);
  await expect(entry(contents, /^Proof 090\.jpg/)).toHaveCount(0);
});
