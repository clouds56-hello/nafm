import { expect, test, type Locator, type Page } from "@playwright/test";
import type { IndexedFileSearchPage } from "../src/lib/types";

const mirroredTrailer = "smb://media.example.test/Studio/Campaign mirror/Trailer master.mov";
const studioTrailer = "/demo/Studio Archive/Projects/Brand campaign/Trailer master.mov";
const searchError = "Could not read the workspace index.";

function folderPath(page: Page) {
  return page.getByRole("navigation", { name: "Folder path" });
}

function currentFolder(page: Page) {
  return folderPath(page).locator('[aria-current="location"]');
}

function finder(page: Page) {
  return page.getByRole("dialog", { name: "Find files", exact: true });
}

function query(dialog: Locator) {
  return dialog.getByRole("searchbox", { name: "File name", exact: true });
}

function details(page: Page) {
  return page.getByRole("complementary", { name: "Inspector" })
    .getByRole("region", { name: "Storage details" });
}

function backToResults(page: Page) {
  return details(page).getByRole("button", { name: "Back to results", exact: true });
}

function result(dialog: Locator, fileName: RegExp) {
  return dialog.getByRole("list", { name: "Matching files", exact: true }).getByRole("button", { name: fileName });
}

function holdFinderStep(page: Page, phase: "lookup" | "reveal") {
  return page.evaluateHandle((phase) => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: { anchor_direction?: string }) => Promise<unknown> };
    };
    const invoke = bridge.invoke.bind(bridge);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = { pending: false, replied: false, release };
    bridge.invoke = async (command, args) => {
      const response = await invoke(command, args);
      const matches = phase === "reveal" ? command === "get_storage_file_reveal"
        : command === "search_indexed_files" && args.anchor_direction === "next";
      if (matches && !read.pending) {
        read.pending = true;
        await gate;
        requestAnimationFrame(() => { read.replied = true; });
      }
      return response;
    };
    return read;
  }, phase);
}

test("Find files distinguishes same names across sites and Back restores the starting folder", async ({ page }) => {
  await page.goto("/mock/");
  const map = page.getByRole("region", { name: "Circular storage map" });
  await map.getByRole("button", { name: /^Projects,/ }).press("Enter");
  await expect(currentFolder(page)).toHaveText("Projects");

  await page.keyboard.press("ControlOrMeta+f");
  const dialog = finder(page);
  const input = query(dialog);
  await expect(input).toBeFocused();
  await input.fill("  TrAiLeR master  ");

  const trailers = result(dialog, /Trailer master\.mov/i);
  const mirrored = trailers.filter({ hasText: mirroredTrailer });
  await expect(trailers).toHaveCount(3);
  await expect(trailers.filter({ hasText: studioTrailer })).toContainText("Studio archive");
  await expect(mirrored).toContainText("Team share");
  await expect(mirrored).toContainText(/verified/i);
  await input.press("ArrowDown");
  await expect(trailers.first()).toBeFocused();
  const mirrorIndex = await trailers.evaluateAll(
    (rows, path) => rows.findIndex((row) => row.textContent?.includes(path)),
    mirroredTrailer,
  );
  for (let index = 0; index < mirrorIndex; index += 1) await page.keyboard.press("ArrowDown");
  await expect(mirrored).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(dialog).toBeHidden();
  await expect(currentFolder(page)).toHaveText("Campaign mirror");
  await expect(details(page)).toContainText(mirroredTrailer);
  await expect(details(page)).toBeFocused();

  await folderPath(page).getByRole("button", { name: "Previous location", exact: true }).click();
  await expect(currentFolder(page)).toHaveText("Projects");
});

test("Details steps through same-named Finder results without adding Atlas history entries", async ({ page }) => {
  await page.goto("/mock/");
  await page.getByRole("region", { name: "Circular storage map" })
    .getByRole("button", { name: /^Projects,/ }).press("Enter");
  await expect(currentFolder(page)).toHaveText("Projects");
  await page.keyboard.press("ControlOrMeta+f");

  const dialog = finder(page);
  const input = query(dialog);
  const rawQuery = "  TrAiLeR master  ";
  const trailers = result(dialog, /^Trailer master\.mov/);
  await input.fill(rawQuery);
  await expect(trailers).toHaveCount(3);
  const paths = await Promise.all([0, 1, 2].map((index) =>
    trailers.nth(index).locator("small[title]").getAttribute("title")));
  expect(new Set(paths).size).toBe(3);
  expect(paths).toContain(studioTrailer);
  expect(paths).toContain(mirroredTrailer);

  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const previousResult = inspector.getByRole("button", { name: "Previous result", exact: true });
  const nextResult = inspector.getByRole("button", { name: "Next result", exact: true });
  const back = folderPath(page).getByRole("button", { name: "Previous location", exact: true });
  const forward = folderPath(page).getByRole("button", { name: "Next location", exact: true });
  async function expectResult(index: number) {
    await expect(details(page)).toContainText(paths[index]!);
    await expect(details(page).getByText(`Result ${index + 1} of 3`, { exact: true })).toBeInViewport();
  }

  await trailers.first().press("Enter");
  await expect(dialog).toBeHidden();
  await expectResult(0);
  await expect(previousResult).toBeDisabled();
  await expect(inspector.getByRole("tab", { name: "Contents", exact: true })).toBeVisible();
  await expect(details(page).getByRole("button", { name: "Show in Contents", exact: true })).toBeVisible();
  await expect(inspector.getByRole("button", { name: "Next file", exact: true })).toHaveCount(0);

  await nextResult.press("Enter");
  await expectResult(1);
  await expect(nextResult).toBeFocused();
  await previousResult.press("Enter");
  await expectResult(0);
  await expect(previousResult).toBeFocused();
  await nextResult.press("Enter");
  await expectResult(1);
  await nextResult.press("Enter");
  await expectResult(2);
  await expect(nextResult).toBeDisabled();
  await expect(nextResult).toBeFocused();

  await backToResults(page).press("Enter");
  await expect(input).toHaveValue(rawQuery);
  await expect(trailers.last()).toBeFocused();
  await trailers.nth(1).press("Enter");
  await expect(dialog).toBeHidden();
  await expectResult(1);
  await back.press("Enter");
  await expectResult(2);
  await back.press("Enter");
  await expect(currentFolder(page)).toHaveText("Projects");
  await forward.press("Enter");
  await expectResult(2);
  await forward.press("Enter");
  await expectResult(1);
});

test("compact Finder result steps across a page boundary and reveals the returned row", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 620 });
  await page.goto("/mock/?scenario=large");
  await expect(currentFolder(page)).toHaveText("Studio archive");
  await page.keyboard.press("ControlOrMeta+f");

  const dialog = finder(page);
  const pane = dialog.locator(".atlas-analysis-body");
  const input = query(dialog);
  const rawQuery = "  PrOoF  ";
  const proof = (rank: number) => result(dialog, new RegExp(`^Proof ${String(rank).padStart(3, "0")}\\.jpg`));
  await input.fill(rawQuery);
  await expect(proof(1)).toBeInViewport();
  const rowHeight = (await proof(1).boundingBox())!.height;
  const initialRank = 48;
  const finalRank = 56;
  await pane.evaluate((body, { rowHeight, initialRank }) => {
    body.scrollTop = (initialRank + 0.5) * rowHeight - body.clientHeight;
  }, { rowHeight, initialRank });
  await expect(proof(initialRank)).toBeVisible();
  await expect(proof(initialRank).locator("..")).toHaveAttribute("aria-posinset", String(initialRank));
  await proof(initialRank).evaluate((button) => {
    const body = button.closest<HTMLElement>(".atlas-analysis-body")!;
    const paneBottom = body.getBoundingClientRect().top + body.clientTop + body.clientHeight;
    body.scrollTop += button.getBoundingClientRect().bottom - paneBottom + 12;
  });
  await expect(proof(initialRank)).toBeInViewport({ ratio: 0.99 });
  await expect(proof(finalRank)).toHaveCount(0);
  const initialScroll = await pane.evaluate((body) => body.scrollTop);
  await proof(initialRank).press("Enter");
  await expect(dialog).toBeHidden();

  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const next = inspector.getByRole("button", { name: "Next result", exact: true });
  for (let rank = initialRank; rank <= finalRank; rank += 1) {
    if (rank > initialRank) await next.press("Enter");
    await expect(details(page).getByRole("heading", {
      name: `Proof ${String(rank).padStart(3, "0")}.jpg`, exact: true,
    })).toBeVisible();
  }
  await expect(next).toBeFocused();
  await backToResults(page).press("Enter");
  await expect(input).toHaveValue(rawQuery);
  await expect(proof(finalRank)).toBeFocused();
  await expect(proof(finalRank)).toBeInViewport({ ratio: 0.99 });
  expect(await pane.evaluate((body) => body.scrollTop)).toBeGreaterThan(initialScroll);
  await page.keyboard.press("ArrowDown");
  await expect(proof(finalRank + 1)).toBeFocused();
});

test("closing Details cancels a pending Finder result reveal", async ({ page }) => {
  await page.goto("/mock/");
  await expect(currentFolder(page)).toHaveText("Studio archive");
  await page.keyboard.press("ControlOrMeta+f");

  const dialog = finder(page);
  const search = "  TrAiLeR master  ";
  const trailers = result(dialog, /^Trailer master\.mov/);
  await query(dialog).fill(search);
  await expect(trailers).toHaveCount(3);
  await trailers.first().press("Enter");
  await expect(dialog).toBeHidden();
  await expect(details(page).getByText("Result 1 of 3", { exact: true })).toBeVisible();
  const firstFolder = await currentFolder(page).textContent();

  const reveal = await holdFinderStep(page, "reveal");
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const next = inspector.getByRole("button", { name: "Next result", exact: true });
  try {
    await next.press("Enter");
    await expect.poll(() => reveal.evaluate((read) => read.pending)).toBe(true);
    await expect(next).toBeDisabled();
    await inspector.getByRole("button", { name: "Close inspector", exact: true }).press("Enter");
    await expect(inspector).toBeHidden();
  } finally {
    await reveal.evaluate((read) => read.release());
  }
  await expect.poll(() => reveal.evaluate((read) => read.replied)).toBe(true);
  await expect(inspector).toBeHidden();
  await expect(currentFolder(page)).toHaveText(firstFolder!);

  await page.keyboard.press("ControlOrMeta+f");
  await expect(query(dialog)).toHaveValue(search);
  await expect(trailers.first()).toBeFocused();
});

for (const phase of ["lookup", "reveal"] as const) {
  test(`Show in Contents supersedes a pending Finder result ${phase}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 620 });
    await page.goto("/mock/");
    await expect(currentFolder(page)).toHaveText("Studio archive");
    await page.keyboard.press("ControlOrMeta+f");

    const dialog = finder(page);
    const rawQuery = "  TrAiLeR master  ";
    const trailers = result(dialog, /^Trailer master\.mov/);
    await query(dialog).fill(rawQuery);
    await expect(trailers).toHaveCount(3);
    await trailers.first().press("Enter");
    await expect(dialog).toBeHidden();
    await expect(currentFolder(page)).toHaveText("Backup campaign");

    const hold = await holdFinderStep(page, phase);
    const inspector = page.getByRole("complementary", { name: "Inspector" });
    const next = inspector.getByRole("button", { name: "Next result", exact: true });
    const contents = inspector.getByRole("tabpanel", { name: "Contents", exact: true });
    const shown = contents.getByRole("grid").getByRole("button", { name: /^Trailer master\.mov/ });
    try {
      await next.press("Enter");
      await expect.poll(() => hold.evaluate((read) => read.pending)).toBe(true);
      await details(page).getByRole("button", { name: "Show in Contents", exact: true }).press("Enter");
      await expect(shown).toBeFocused();
      await expect(shown).toBeInViewport();
    } finally {
      await hold.evaluate((read) => read.release());
    }
    await expect.poll(() => hold.evaluate((read) => read.replied)).toBe(true);
    await expect(currentFolder(page)).toHaveText("Backup campaign");
    await expect(shown).toBeFocused();

    await page.keyboard.press("ControlOrMeta+f");
    await expect(query(dialog)).toHaveValue(rawQuery);
    await expect(trailers.first()).toBeFocused();
  });
}

test("Atlas Back restores the filtered Contents list after opening a Finder result on another site", async ({ page }) => {
  await page.goto("/mock/");
  const map = page.getByRole("region", { name: "Circular storage map" });
  await map.getByRole("button", { name: /^Photo Library,/ }).press("Enter");
  await expect(currentFolder(page)).toHaveText("Photo Library");
  await page.getByRole("button", { name: "Contents & details", exact: true }).click();

  const contents = page.getByRole("tabpanel", { name: "Contents", exact: true });
  const grid = contents.getByRole("grid");
  const filter = contents.getByRole("searchbox", { name: "Find in folder", exact: true })
    .or(contents.getByRole("textbox", { name: "Find in folder", exact: true }));
  const lateProof = grid.getByRole("button", { name: /^Proof 096\.jpg/ });
  const filterText = "  pRoOf  ";
  await contents.getByRole("button", { name: "Search this folder", exact: true }).press("Enter");
  await filter.fill(filterText);
  await expect(grid).toHaveAttribute("aria-rowcount", "96");
  await expect(lateProof).toHaveCount(0);
  await contents.evaluate((pane) => { pane.scrollTop = pane.scrollHeight; });
  await expect(lateProof).toBeInViewport({ ratio: 0.99 });
  const scrollPosition = await contents.evaluate((pane) => pane.scrollTop);
  expect(scrollPosition).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Find files", exact: true }).click();
  const dialog = finder(page);
  await query(dialog).fill("trailer master");
  await result(dialog, /Trailer master\.mov/i).filter({ hasText: mirroredTrailer }).click();
  await expect(dialog).toBeHidden();
  await expect(currentFolder(page)).toHaveText("Campaign mirror");
  await expect(details(page)).toContainText(mirroredTrailer);

  const back = folderPath(page).getByRole("button", { name: "Previous location", exact: true });
  await back.press("Enter");
  await expect(currentFolder(page)).toHaveText("Photo Library");
  await expect(filter).toHaveValue(filterText);
  await expect(grid).toHaveAttribute("aria-rowcount", "96");
  await expect(lateProof).toBeInViewport({ ratio: 0.99 });
  await expect.poll(() => contents.evaluate((pane) => pane.scrollTop)).toBeCloseTo(scrollPosition, 0);
  await expect(back).toBeFocused();

  await folderPath(page).getByRole("button", { name: "Next location", exact: true }).press("Enter");
  await expect(details(page)).toContainText(mirroredTrailer);
  await page.getByRole("tab", { name: "Contents", exact: true }).click();
  await expect(contents).toBeVisible();
  await expect(filter).toHaveCount(0);
  await expect(grid.getByRole("button", { name: /^Trailer master\.mov/ })).toBeVisible();
});

test("Find files restores a late result and its scroll position while Atlas Back follows inspected files", async ({ page }) => {
  await page.goto("/mock/");
  const opener = page.getByRole("button", { name: "Find files", exact: true });
  await expect(opener).toBeEnabled();
  const offsets = await page.evaluateHandle(() => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: { query?: string; offset?: number }) => Promise<unknown> };
    };
    const reads: number[] = [];
    const invoke = bridge.invoke.bind(bridge);
    bridge.invoke = (command, args) => {
      if (command === "search_indexed_files" && args.query?.toLowerCase() === "proof") reads.push(Number(args.offset ?? 0));
      return invoke(command, args);
    };
    return reads;
  });

  await opener.click();
  const dialog = finder(page);
  const input = query(dialog);
  const searchText = "  PrOoF  ";
  await input.fill(searchText);
  await expect(result(dialog, /Proof 001\.jpg/i)).toBeVisible();
  const last = result(dialog, /Proof 096\.jpg/i);
  const finalMatch = result(dialog, /^Proofs\.pdf/i);
  await expect(last).toHaveCount(0);

  const scroller = dialog.locator(".atlas-analysis-body");
  await expect(async () => {
    await scroller.evaluate((pane) => { pane.scrollTop = pane.scrollHeight; });
    await expect(last).toBeInViewport({ ratio: 1, timeout: 1_000 });
    await expect(finalMatch).toBeAttached({ timeout: 1_000 });
  }).toPass({ timeout: 12_000 });
  const loadedOffsets = await offsets.evaluate((reads) => [...reads]);
  expect(loadedOffsets.some((offset) => offset > 0)).toBe(true);
  const scrollPosition = await scroller.evaluate((pane) => pane.scrollTop);

  await last.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(currentFolder(page)).toHaveText("Photo Library");
  await expect(details(page).getByRole("heading", { name: "Proof 096.jpg", exact: true })).toBeVisible();
  await backToResults(page).click();
  await expect(input).toHaveValue(searchText);
  await expect(last).toBeFocused();
  await expect(last).toBeInViewport({ ratio: 1 });
  expect(await scroller.evaluate((pane) => pane.scrollTop)).toBeCloseTo(scrollPosition, 0);

  const previous = result(dialog, /Proof 095\.jpg/i);
  await page.keyboard.press("ArrowUp");
  await expect(previous).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(details(page).getByRole("heading", { name: "Proof 095.jpg", exact: true })).toBeVisible();
  await folderPath(page).getByRole("button", { name: "Previous location", exact: true }).click();
  await expect(details(page).getByRole("heading", { name: "Proof 096.jpg", exact: true })).toBeVisible();

  await page.keyboard.press("ControlOrMeta+f");
  await expect(input).toHaveValue(searchText);
  await expect(previous).toBeFocused();
  expect(await offsets.evaluate((reads) => [...reads])).toEqual(loadedOffsets);
  await previous.press("Enter");
  await expect(dialog).toBeHidden();
  await folderPath(page).getByRole("button", { name: "Previous location", exact: true }).click();
  await expect(details(page).getByRole("heading", { name: "Proof 096.jpg", exact: true })).toBeVisible();
  const back = backToResults(page);
  const previousResult = page.getByRole("complementary", { name: "Inspector" })
    .getByRole("button", { name: "Previous result", exact: true });
  await back.press("Enter");
  await expect(input).toHaveValue(searchText);
  await expect(last).toBeFocused();
  await expect(last).toBeInViewport({ ratio: 1 });
  expect(await scroller.evaluate((pane) => pane.scrollTop)).toBeCloseTo(scrollPosition, 0);
  expect(await offsets.evaluate((reads) => [...reads])).toEqual(loadedOffsets);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(back).toBeFocused();
  await expect(previousResult).toBeEnabled();

  await opener.click();
  await expect(input).toHaveValue(searchText);
  await expect(previous).toBeFocused();
  await input.fill("Uncommitted locator draft");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  await expect(details(page).getByRole("heading", { name: "Proof 096.jpg", exact: true })).toBeVisible();
  await expect(previousResult).toBeEnabled();

  await back.press("Enter");
  await expect(input).toHaveValue(searchText);
  await expect(last).toBeFocused();
  await expect(last).toBeInViewport({ ratio: 1 });
  expect(await scroller.evaluate((pane) => pane.scrollTop)).toBeCloseTo(scrollPosition, 0);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(back).toBeFocused();
  await previousResult.press("Enter");
  await expect(details(page).getByRole("heading", { name: "Proof 095.jpg", exact: true })).toBeVisible();
});

test("Find files can seek across hundreds of matches and return to the inspected result", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 750 });
  await page.goto("/mock/?scenario=large");
  const offsets = await page.evaluateHandle(() => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: { query?: string; offset?: number }) => Promise<unknown> };
    };
    const reads: number[] = [];
    const invoke = bridge.invoke.bind(bridge);
    bridge.invoke = (command, args) => {
      if (command === "search_indexed_files" && args.query?.toLowerCase() === ".tif") {
        reads.push(Number(args.offset ?? 0));
      }
      return invoke(command, args);
    };
    return reads;
  });

  await expect(currentFolder(page)).toHaveText("Studio archive");
  await page.keyboard.press("ControlOrMeta+f");
  const dialog = finder(page);
  const input = query(dialog);
  const search = "  .tIf  ";
  const first = result(dialog, /^Botanical study 0016\.tif/);
  const last = result(dialog, /^Print masters\.tif/);
  const previous = result(dialog, /^Studio session 3977\.tif/);
  const pane = dialog.locator(".atlas-analysis-body");
  const matches = dialog.getByRole("list", { name: "Matching files", exact: true });
  await input.fill(search);
  await expect(dialog.getByRole("status").filter({ hasText: "802 matches" })).toBeVisible();
  await expect(first).toBeInViewport();
  await expect(last).toHaveCount(0);
  const rowHeight = (await first.boundingBox())!.height;
  const trackHeight = await pane.evaluate((body) => body.scrollHeight);
  expect(trackHeight).toBeGreaterThan(802 * rowHeight * 0.95);

  await pane.evaluate((body) => { body.scrollTop = body.scrollHeight; });
  await expect(last).toBeInViewport({ ratio: 0.99 });
  const soughtOffsets = await offsets.jsonValue();
  expect(soughtOffsets[0]).toBe(0);
  expect(soughtOffsets.some((offset) => offset >= 700)).toBe(true);
  expect(soughtOffsets.filter((offset) => offset > 100 && offset < 700)).toEqual([]);
  expect(await matches.getByRole("button").count()).toBeLessThan(100);
  expect(await pane.evaluate((body) => body.scrollHeight)).toBe(trackHeight);

  await last.focus();
  await page.keyboard.press("Home");
  await expect(first).toBeFocused();
  await page.keyboard.press("End");
  await expect(last).toBeFocused();
  await expect(last).toBeInViewport({ ratio: 0.99 });
  const savedScroll = await pane.evaluate((body) => body.scrollTop);
  await last.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(details(page).getByRole("heading", { name: "Print masters.tif", exact: true })).toBeVisible();
  await backToResults(page).press("Enter");
  await expect(input).toHaveValue(search);
  await expect(last).toBeFocused();
  await expect(last).toBeInViewport({ ratio: 0.99 });
  expect(await pane.evaluate((body) => body.scrollTop)).toBeCloseTo(savedScroll, 0);

  await last.evaluate((button) => {
    const body = button.closest<HTMLElement>(".atlas-analysis-body")!;
    body.scrollTop -= body.getBoundingClientRect().bottom - button.getBoundingClientRect().top - 12;
  });
  await expect(last).toBeInViewport();
  await expect(last).not.toBeInViewport({ ratio: 0.25 });
  await expect(last).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await backToResults(page).press("Enter");
  await expect(last).toBeFocused();
  await expect(last).toBeInViewport({ ratio: 0.99 });
  await page.keyboard.press("ArrowUp");
  await expect(previous).toBeFocused();
});

test("Home supersedes a pending Finder End jump without losing focus", async ({ page }) => {
  await page.goto("/mock/?scenario=large");
  const distantRead = await page.evaluateHandle(() => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: { query?: string; offset?: number }) => Promise<unknown> };
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = { pending: false, replied: false, release };
    const invoke = bridge.invoke.bind(bridge);
    bridge.invoke = async (command, args) => {
      if (read.pending || command !== "search_indexed_files" || args.query !== ".tif" || Number(args.offset) < 700) {
        return invoke(command, args);
      }
      read.pending = true;
      const page = await invoke(command, args);
      await gate;
      requestAnimationFrame(() => { read.replied = true; });
      return page;
    };
    return read;
  });

  await page.getByRole("button", { name: "Find files", exact: true }).click();
  const dialog = finder(page);
  const input = query(dialog);
  const first = result(dialog, /^Botanical study 0016\.tif/);
  const second = result(dialog, /^Botanical study 0046\.tif/);
  await input.fill(".tif");
  await expect(first).toBeInViewport();
  await input.press("ArrowDown");
  await expect(first).toBeFocused();

  try {
    await page.keyboard.press("End");
    await expect.poll(() => distantRead.evaluate((read) => read.pending)).toBe(true);
    await page.keyboard.press("Home");
    await expect(first).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(second).toBeFocused();
  } finally {
    await distantRead.evaluate((read) => read.release());
  }
  await expect.poll(() => distantRead.evaluate((read) => read.replied)).toBe(true);
  await expect(second).toBeFocused();
  await expect(second).toBeInViewport();
});

test("Back to results follows the same file after its search rank changes", async ({ page }) => {
  await page.goto("/mock/?scenario=large");
  await expect(currentFolder(page)).toHaveText("Studio archive");
  const finderCalls = await page.evaluateHandle(() => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
    };
    const invoke = bridge.invoke.bind(bridge);
    const reads: { offset: number; anchor_file_id: string | null }[] = [];
    bridge.invoke = (command, args) => {
      if (command === "search_indexed_files" && args.query === ".") {
        reads.push({
          offset: Number(args.offset),
          anchor_file_id: typeof args.anchor_file_id === "string" ? args.anchor_file_id : null,
        });
      }
      return invoke(command, args);
    };
    async function search(offset: number) {
      return await invoke("search_indexed_files", {
        expected_workspace: "Studio workspace", query: ".", offset, limit: 48,
      }) as IndexedFileSearchPage;
    }
    return {
      reads,
      async moveOtherSite() {
        const tail = await search(4128);
        const oldIndex = tail.matches.findIndex((file) => file.name === "Dailies.mov" && file.site_id === "team-share");
        const selected = tail.matches[oldIndex];
        if (!selected) throw new Error("Dailies.mov is missing from the original Finder page.");
        // Change the mock index independently so the open Details view and Finder session survive.
        await invoke("rename_site", { workspaceName: "Studio workspace", siteId: "studio-archive", name: "Z Studio archive" });
        const head = await search(0);
        return {
          file_id: selected.file_id,
          old_rank: tail.offset + oldIndex + 1,
          new_rank: head.matches.findIndex((file) => file.file_id === selected.file_id) + 1,
          old_count: tail.total_matches,
          new_count: head.total_matches,
        };
      },
    };
  });

  await page.getByRole("button", { name: "Sites", exact: true }).click();
  const sites = page.getByRole("complementary", { name: "Sites", exact: true });
  await page.getByRole("button", { name: "Find files", exact: true }).click();
  const dialog = finder(page);
  const input = query(dialog);
  const dailies = result(dialog, /^Dailies\.mov/);
  const pane = dialog.locator(".atlas-analysis-body");
  const searchText = "  .  ";
  await input.fill(searchText);
  await expect(dialog.getByRole("list", { name: "Matching files" }).getByRole("listitem").first())
    .toHaveAttribute("aria-setsize", "4166");
  await pane.evaluate((body) => { body.scrollTop = body.scrollHeight; });
  await expect(dailies).toBeInViewport();
  await dailies.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(currentFolder(page)).toHaveText("Incoming");
  const dailiesHeading = details(page).getByRole("heading", { name: "Dailies.mov", exact: true });
  await expect(dailiesHeading).toBeVisible();

  const moved = await finderCalls.evaluate((calls) => calls.moveOtherSite());
  expect(moved).toMatchObject({ old_rank: 4164, new_rank: 12, old_count: 4166, new_count: 4166 });
  await sites.getByRole("button", { name: "Scan Field drive", exact: true }).click();
  await page.getByRole("button", { name: "Scan activity", exact: true }).click();
  const activity = page.getByRole("group", { name: "Scan activity", exact: true });
  await expect(activity.getByRole("region", { name: "Latest scan result" })
    .getByText("Scan finished", { exact: true })).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Escape");
  await expect(activity).toBeHidden();
  await expect(dailiesHeading).toBeVisible();

  const before = await finderCalls.evaluate((calls) => calls.reads.length);
  await backToResults(page).press("Enter");
  await expect(input).toHaveValue(searchText);
  await expect(dailies).toBeFocused();
  await expect(dailies).toBeInViewport({ ratio: 0.99 });
  await expect(dialog.locator('[aria-posinset="12"] button')).toBeFocused();
  await expect(dialog.locator('[aria-posinset="4164"]')).toHaveCount(0);
  const restoredReads = await finderCalls.evaluate((calls, start) => calls.reads.slice(start), before);
  expect(restoredReads.flatMap(({ anchor_file_id }) => anchor_file_id ? [anchor_file_id] : [])).toEqual([moved.file_id]);
  expect(restoredReads.filter(({ anchor_file_id, offset }) => !anchor_file_id && offset >= 96)).toEqual([]);
  await page.keyboard.press("ArrowDown");
  await expect(dialog.locator('[aria-posinset="13"] button')).toBeFocused();
});

test("an index refresh keeps a distant Finder result focused while the dialog is open", async ({ page }) => {
  await page.goto("/mock/?scenario=large");
  await expect(currentFolder(page)).toHaveText("Studio archive");
  const refresh = await page.evaluateHandle(() => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
    };
    const invoke = bridge.invoke.bind(bridge);
    let publish!: () => void;
    let complete!: () => void;
    const publishing = new Promise<void>((resolve) => { publish = resolve; });
    const completing = new Promise<void>((resolve) => { complete = resolve; });
    const state = {
      publish, complete, published: false, completed: false,
      reads: [] as { reply_offset: number | null; after_completion: boolean }[],
    };
    bridge.invoke = async (command, args) => {
      if (command === "plugin:event|emit" && args.event === "task://scan/events") {
        const event = args.payload as { site_id: string | null; kind: string; phase: string | null; scope: string };
        if (event.site_id === "field-drive" && event.kind === "progress"
          && (event.phase === "hashing" || event.phase === "finalizing")) {
          await publishing;
          state.published = true;
        }
        if (event.kind === "completed" && (event.site_id === "field-drive" || event.scope === "task")) {
          await completing;
          if (event.site_id === "field-drive") state.completed = true;
        }
      }
      if (!state.published || command !== "search_indexed_files" || String(args.query).toLowerCase() !== ".tif") {
        return invoke(command, args);
      }
      const read = { reply_offset: null as number | null, after_completion: state.completed };
      state.reads.push(read);
      const response = await invoke(command, args);
      read.reply_offset = (response as IndexedFileSearchPage).offset;
      return response;
    };
    return state;
  });

  await page.getByRole("button", { name: "Sites", exact: true }).click();
  await page.getByRole("complementary", { name: "Sites", exact: true })
    .getByRole("button", { name: "Scan Field drive", exact: true }).click();
  await page.getByRole("button", { name: "Find files", exact: true }).click();
  const dialog = finder(page);
  const input = query(dialog);
  const pane = dialog.locator(".atlas-analysis-body");
  const resultsRegion = dialog.getByRole("region", { name: "File search results" });
  const first = result(dialog, /^Botanical study 0016\.tif/);
  const last = result(dialog, /^Print masters\.tif/);
  const searchText = "  .tIf  ";
  await input.fill(searchText);
  await expect(first).toBeInViewport();
  await input.press("ArrowDown");
  await page.keyboard.press("End");
  await expect(last).toBeFocused();
  await expect(last).toBeInViewport({ ratio: 0.99 });
  const savedScroll = await pane.evaluate((body) => body.scrollTop);
  expect(savedScroll).toBeGreaterThan(0);

  try {
    await refresh.evaluate((state) => state.publish());
    await expect.poll(() => refresh.evaluate((state) => state.published
      && state.reads.some((read) => read.reply_offset !== null))).toBe(true);
    await expect(resultsRegion).not.toHaveAttribute("aria-busy", "true");
    await expect(last).toBeFocused();
    await expect(last).toBeInViewport({ ratio: 0.99 });
    await expect(input).toHaveValue(searchText);
    expect(await pane.evaluate((body) => body.scrollTop)).toBe(savedScroll);

    await refresh.evaluate((state) => state.complete());
    await expect.poll(() => refresh.evaluate((state) => state.completed
      && state.reads.some((read) => read.after_completion && read.reply_offset !== null))).toBe(true);
    await expect(resultsRegion).not.toHaveAttribute("aria-busy", "true");
    await expect(last).toBeFocused();
    await expect(last).toBeInViewport({ ratio: 0.99 });
    await expect(input).toHaveValue(searchText);
    expect(await pane.evaluate((body) => body.scrollTop)).toBe(savedScroll);
  } finally {
    await refresh.evaluate((state) => { state.publish(); state.complete(); });
  }
  const offsets = await refresh.evaluate((state) => state.reads.flatMap(({ reply_offset }) => reply_offset === null ? [] : [reply_offset]));
  expect(offsets.every((offset) => offset >= 700)).toBe(true);
  await page.keyboard.press("ArrowUp");
  await expect(result(dialog, /^Studio session 3977\.tif/)).toBeFocused();
});

test("Find files restores the search that opened each inspected result in Atlas history", async ({ page }) => {
  await page.goto("/mock/");
  await page.getByRole("button", { name: "Find files", exact: true }).click();
  const dialog = finder(page);
  const input = query(dialog);
  const proofQuery = "  PrOoF 001  ";
  const trailerQuery = "Trailer master";
  const proof = result(dialog, /^Proof 001\.jpg/i);
  const mirror = result(dialog, /Trailer master\.mov/i).filter({ hasText: mirroredTrailer });
  const previous = folderPath(page).getByRole("button", { name: "Previous location", exact: true });
  const next = folderPath(page).getByRole("button", { name: "Next location", exact: true });
  const proofDetails = details(page).getByRole("heading", { name: "Proof 001.jpg", exact: true });

  await input.fill(proofQuery);
  await proof.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(proofDetails).toBeVisible();
  await backToResults(page).press("Enter");
  await expect(input).toHaveValue(proofQuery);

  await input.fill(trailerQuery);
  await mirror.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(details(page)).toContainText(mirroredTrailer);
  await previous.press("Enter");
  await expect(currentFolder(page)).toHaveText("Photo Library");
  await expect(proofDetails).toBeVisible();
  await expect(backToResults(page)).toBeVisible();
  await backToResults(page).press("Enter");
  await expect(input).toHaveValue(proofQuery);
  await expect(proof).toBeFocused();
  await expect(mirror).toHaveCount(0);
  await proof.press("Enter");
  await expect(dialog).toBeHidden();

  await next.press("Enter");
  await expect(details(page)).toContainText(mirroredTrailer);
  await backToResults(page).press("Enter");
  await expect(input).toHaveValue(trailerQuery);
  await expect(mirror).toBeFocused();
});

test("Atlas history keeps distinct Finder visits to the same file", async ({ page }) => {
  await page.goto("/mock/");
  await page.getByRole("button", { name: "Find files", exact: true }).click();
  const dialog = finder(page);
  const input = query(dialog);
  const proof = result(dialog, /^Proof 001\.jpg/i);
  const proofDetails = details(page).getByRole("heading", { name: "Proof 001.jpg", exact: true });
  const firstQuery = "  PrOoF 001  ";

  await input.fill(firstQuery);
  await proof.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(proofDetails).toBeVisible();
  await backToResults(page).press("Enter");
  await expect(input).toHaveValue(firstQuery);

  await input.fill("001.jpg");
  await proof.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(proofDetails).toBeVisible();

  const path = folderPath(page);
  const next = path.getByRole("button", { name: "Next location", exact: true });
  await expect(next).toBeDisabled();
  await path.getByRole("button", { name: "Previous location", exact: true }).press("Enter");
  await expect(next).toBeEnabled();
  await expect(proofDetails).toBeVisible();
  await backToResults(page).press("Enter");
  await expect(input).toHaveValue(firstQuery);
  await expect(proof).toBeFocused();
});

test("an older finder result cannot replace a newer query and a failed search can be retried", async ({ page }) => {
  await page.goto("/mock/");
  const opener = page.getByRole("button", { name: "Find files", exact: true });
  await expect(opener).toBeEnabled();
  const delayed = await page.evaluateHandle((message) => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: { query?: string }) => Promise<unknown> };
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const request = { pending: false, replied: false, release };
    const invoke = bridge.invoke.bind(bridge);
    let failOnce = true;
    bridge.invoke = async (command, args) => {
      if (command !== "search_indexed_files") return invoke(command, args);
      const query = args.query?.toLowerCase();
      if (query === "camera originals" && failOnce) {
        failOnce = false;
        throw new Error(message);
      }
      const response = await invoke(command, args);
      if (query === "trailer master") {
        request.pending = true;
        await gate;
        request.replied = true;
      }
      return response;
    };
    return request;
  }, searchError);

  await opener.click();
  const dialog = finder(page);
  const input = query(dialog);
  try {
    await input.fill("Trailer master");
    await expect.poll(() => delayed.evaluate((request) => request.pending)).toBe(true);
    await input.fill("Camera originals");
    await expect(dialog.getByRole("alert")).toContainText(searchError);
    await expect(input).toHaveValue("Camera originals");
    await dialog.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(result(dialog, /Camera originals\.mxf/i)).toHaveCount(2);
  } finally {
    await delayed.evaluate((request) => request.release());
  }

  await expect.poll(() => delayed.evaluate((request) => request.replied)).toBe(true);
  await expect(result(dialog, /Camera originals\.mxf/i)).toHaveCount(2);
  await expect(result(dialog, /Trailer master\.mov/i)).toHaveCount(0);
  await expect(input).toHaveValue("Camera originals");
  await input.focus();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  await expect(currentFolder(page)).toHaveText("Studio archive");
});

test.describe("compact workspace finder", () => {
  test.use({ viewport: { width: 320, height: 640 }, hasTouch: true });

  test("keyboard history resumes the same-site Contents cursor after inspecting a Finder result", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 620 });
    await page.goto("/mock/?scenario=large");
    const map = page.getByRole("region", { name: "Circular storage map" });
    await map.getByRole("button", { name: /^Photo Library,/ }).press("Enter");
    await expect(currentFolder(page)).toHaveText("Photo Library");
    await page.getByRole("button", { name: "Sites", exact: true }).tap();
    await page.getByRole("button", { name: "Contents & details", exact: true }).tap();

    const contents = page.getByRole("tabpanel", { name: "Contents", exact: true });
    const grid = contents.getByRole("grid");
    const proof = grid.getByRole("button", { name: /^Proof 095\.jpg/ });
    const filter = contents.getByRole("searchbox", { name: "Find in folder", exact: true });
    await contents.getByRole("button", { name: "Search this folder", exact: true }).press("Enter");
    const filterText = "  pRoOf  ";
    await filter.fill(filterText);
    await expect(grid).toHaveAttribute("aria-rowcount", "96");
    await contents.evaluate((pane) => { pane.scrollTop = pane.scrollHeight; });
    await expect(proof).toBeInViewport();
    await proof.focus();
    const scrollPosition = await contents.evaluate((pane) => pane.scrollTop);
    expect(scrollPosition).toBeGreaterThan(0);

    const actions = page.getByRole("button", { name: "Workspace actions", exact: true });
    await actions.tap();
    await page.getByRole("group", { name: "Workspace actions", exact: true })
      .getByRole("button", { name: "Find files", exact: true }).tap();
    const dialog = finder(page);
    await query(dialog).fill("trailer master");
    await result(dialog, /^Trailer master\.mov/i).filter({ hasText: studioTrailer }).tap();
    await expect(currentFolder(page)).toHaveText("Brand campaign");
    await expect(details(page)).toBeFocused();

    await page.keyboard.press("Alt+ArrowLeft");
    await expect(currentFolder(page)).toHaveText("Photo Library");
    await expect(filter).toHaveValue(filterText);
    await expect(grid).toHaveAttribute("aria-rowcount", "96");
    await expect(proof).toBeFocused();
    await expect(proof).toBeInViewport();
    await expect.poll(() => contents.evaluate((pane) => pane.scrollTop)).toBe(scrollPosition);
    await expect(page.getByRole("button", { name: "Close sites", exact: true })).toBeVisible();

    await page.keyboard.press("ArrowDown");
    await expect(grid.getByRole("button", { name: /^Proof 096\.jpg/ })).toBeFocused();
    await page.keyboard.press("Alt+ArrowRight");
    await expect(currentFolder(page)).toHaveText("Brand campaign");
    await expect(details(page)).toContainText(studioTrailer);
    await expect(details(page)).toBeFocused();
    await expect(backToResults(page)).toBeInViewport();

    const workspaceActions = page.getByRole("group", { name: "Workspace actions", exact: true });
    await actions.tap();
    await workspaceActions.getByRole("button", { name: "Previous location", exact: true }).tap();
    await expect(currentFolder(page)).toHaveText("Photo Library");
    await expect(filter).toHaveValue(filterText);
    await expect(actions).toBeFocused();

    await actions.tap();
    await workspaceActions.getByRole("button", { name: "Next location", exact: true }).tap();
    await expect(currentFolder(page)).toHaveText("Brand campaign");
    await expect(details(page)).toContainText(studioTrailer);
    await page.getByRole("tab", { name: "Contents", exact: true }).tap();
    await expect(grid.getByRole("button", { name: /^Trailer master\.mov/ })).toBeVisible();
  });

  for (const { name, url, filterText, originFile, count, pausesSearch } of [
    { name: "matches", url: "/mock/?scenario=large", filterText: "  pRoOf  ", originFile: /^Proof 095\.jpg/, count: "96", pausesSearch: false },
    { name: "is excluded", url: "/mock/", filterText: "  pRoOf 01  ", originFile: /^Proof 019\.jpg/, count: "10", pausesSearch: true },
  ]) {
    test(`same-folder Contents restores each Finder visit when its result ${name}`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 620 });
      await page.goto(url);
      const map = page.getByRole("region", { name: "Circular storage map" });
      await map.getByRole("button", { name: /^Photo Library,/ }).press("Enter");
      await expect(currentFolder(page)).toHaveText("Photo Library");
      await page.getByRole("button", { name: "Contents & details", exact: true }).press("Enter");

      const contents = page.getByRole("tabpanel", { name: "Contents", exact: true });
      const grid = contents.getByRole("grid");
      const origin = grid.getByRole("button", { name: originFile });
      const filter = contents.getByRole("searchbox", { name: "Find in folder", exact: true });
      const pausedSearch = contents.getByRole("status").filter({ hasText: "Search paused" });
      await contents.getByRole("button", { name: "Search this folder", exact: true }).press("Enter");
      await filter.fill(filterText);
      await expect(grid).toHaveAttribute("aria-rowcount", count);
      await contents.evaluate((pane) => { pane.scrollTop = pane.scrollHeight; });
      await expect(origin).toBeInViewport();
      await origin.focus();
      const originalScroll = await contents.evaluate((pane) => pane.scrollTop);
      expect(originalScroll).toBeGreaterThan(0);

      await page.keyboard.press("ControlOrMeta+f");
      const dialog = finder(page);
      await query(dialog).fill("Proof 001");
      const found = result(dialog, /^Proof 001\.jpg/);
      await found.press("Enter");
      await expect(dialog).toBeHidden();
      await expect(details(page)).toBeFocused();
      await details(page).getByRole("button", { name: "Show in Contents", exact: true }).press("Enter");
      const shown = grid.getByRole("button", { name: /^Proof 001\.jpg/ });
      await expect(shown).toBeFocused();
      const shownScroll = await contents.evaluate((pane) => pane.scrollTop);
      if (pausesSearch) await expect(pausedSearch).toBeVisible();
      else await expect(filter).toHaveValue(filterText);

      await page.keyboard.press("Alt+ArrowLeft");
      await expect(filter).toHaveValue(filterText);
      await expect(pausedSearch).toBeHidden();
      await expect(origin).toBeFocused();
      await expect(origin).toBeInViewport();
      await expect.poll(() => contents.evaluate((pane) => pane.scrollTop)).toBe(originalScroll);

      await page.keyboard.press("Alt+ArrowRight");
      await expect(shown).toBeFocused();
      await expect(shown).toBeInViewport();
      await expect.poll(() => contents.evaluate((pane) => pane.scrollTop)).toBe(shownScroll);
      if (pausesSearch) await expect(pausedSearch).toBeVisible();
      else await expect(filter).toHaveValue(filterText);

      await page.getByRole("tab", { name: "Details", exact: true }).press("Enter");
      await backToResults(page).press("Enter");
      await expect(query(dialog)).toHaveValue("Proof 001");
      await expect(found).toBeFocused();

      if (pausesSearch) {
        await found.press("Enter");
        await expect(dialog).toBeHidden();
        await details(page).getByRole("button", { name: "Show in Contents", exact: true }).press("Enter");
        await expect(shown).toBeFocused();
        await shown.press("Enter");
        await page.getByRole("button", { name: "Back to Contents", exact: true }).press("Enter");
        await expect(pausedSearch).toBeVisible();
        await expect(shown).toBeFocused();
      }
    });
  }

  for (const focus of ["file row", "toolbar", "inspector"] as const) {
    test(`delayed Show in Contents ${focus === "file row" ? "hands focus to the file row" : `preserves newer ${focus} focus`}`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 620 });
      await page.goto("/mock/");
      await expect(currentFolder(page)).toHaveText("Studio archive");
      await page.getByRole("button", { name: "Sites", exact: true }).press("Enter");
      await page.keyboard.press("ControlOrMeta+f");
      const dialog = finder(page);
      await query(dialog).fill("trailer master");
      await result(dialog, /^Trailer master\.mov/i).filter({ hasText: mirroredTrailer }).press("Enter");
      await expect(dialog).toBeHidden();
      await expect(details(page)).toContainText(mirroredTrailer);

      const reveal = await page.evaluateHandle(() => {
        const { __TAURI_INTERNALS__: bridge } = window as unknown as {
          __TAURI_INTERNALS__: { invoke: (command: string, args: unknown) => Promise<unknown> };
        };
        const invoke = bridge.invoke.bind(bridge);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const read = { pending: false, release };
        bridge.invoke = async (command, args) => {
          const response = await invoke(command, args);
          if (command === "get_storage_node_reveal") {
            read.pending = true;
            await gate;
          }
          return response;
        };
        return read;
      });
      const actions = page.getByRole("button", { name: "Workspace actions", exact: true });
      const close = page.getByRole("button", { name: "Close inspector", exact: true });
      const contents = page.getByRole("tabpanel", { name: "Contents", exact: true });
      const file = contents.getByRole("grid").getByRole("button", { name: /^Trailer master\.mov/ });
      const newerFocus = focus === "toolbar" ? actions : focus === "inspector" ? close : null;
      try {
        await details(page).getByRole("button", { name: "Show in Contents", exact: true }).press("Enter");
        await expect.poll(() => reveal.evaluate((read) => read.pending)).toBe(true);
        await expect(details(page).getByRole("button", { name: /Show in Contents|Finding file/ })).toBeFocused();
        if (newerFocus) {
          await newerFocus.evaluate((element) => element.focus({ preventScroll: true }));
          await expect(newerFocus).toBeFocused();
        }
      } finally {
        await reveal.evaluate((read) => read.release());
      }

      await expect(contents).toBeVisible();
      await expect(file).toBeInViewport();
      await expect(newerFocus ?? file).toBeFocused();
      await expect(currentFolder(page)).toHaveText("Campaign mirror");
      await expect(page.getByRole("complementary", { name: "Sites", exact: true })).toBeVisible();
    });
  }

  test("can open and dismiss Find files from Workspace actions without losing focus", async ({ page }) => {
    await page.goto("/mock/");
    await expect(currentFolder(page)).toHaveText("Studio archive");
    const actions = page.getByRole("button", { name: "Workspace actions" });
    await actions.tap();
    await page.getByRole("group", { name: "Workspace actions", exact: true })
      .getByRole("button", { name: "Find files", exact: true }).tap();

    const dialog = finder(page);
    const input = query(dialog);
    await expect(input).toBeFocused();
    await expect(input).toBeInViewport();
    await input.fill("proof 001");
    await expect(result(dialog, /Proof 001\.jpg/i)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(actions).toBeFocused();
    await expect(currentFolder(page)).toHaveText("Studio archive");

    await actions.tap();
    await page.getByRole("group", { name: "Workspace actions", exact: true })
      .getByRole("button", { name: "Find files", exact: true }).tap();
    await expect(input).toHaveValue("");
    await expect(input).toBeFocused();
  });

  test("touch inspection can close Finder and keep browsing the same results", async ({ page }) => {
    await page.goto("/mock/");
    const actions = page.getByRole("button", { name: "Workspace actions" });
    await actions.tap();
    await page.getByRole("group", { name: "Workspace actions", exact: true })
      .getByRole("button", { name: "Find files", exact: true }).tap();

    const dialog = finder(page);
    const searchText = "  pRoOf 00  ";
    await query(dialog).fill(searchText);
    const proof = result(dialog, /Proof 001\.jpg/i);
    await proof.tap();
    await expect(dialog).toBeHidden();
    await expect(details(page).getByRole("heading", { name: "Proof 001.jpg", exact: true })).toBeVisible();
    await expect(backToResults(page)).toBeInViewport();

    const back = backToResults(page);
    const dismiss = dialog.getByRole("button", { name: "Close find files", exact: true });
    await back.tap();
    await expect(query(dialog)).toHaveValue(searchText);
    await expect(proof).toBeFocused();
    await expect(proof).toBeInViewport();
    await dismiss.tap();
    await expect(dialog).toBeHidden();
    await expect(back).toBeFocused();
    await expect(back).toBeInViewport();
    await expect(details(page).getByRole("heading", { name: "Proof 001.jpg", exact: true })).toBeVisible();

    await back.tap();
    await expect(query(dialog)).toHaveValue(searchText);
    await expect(proof).toBeFocused();
    await dismiss.tap();
    await expect(dialog).toBeHidden();
    await expect(back).toBeFocused();
    await page.getByRole("complementary", { name: "Inspector" })
      .getByRole("button", { name: "Next result", exact: true }).tap();
    await expect(details(page).getByRole("heading", { name: "Proof 002.jpg", exact: true })).toBeVisible();
  });
});
