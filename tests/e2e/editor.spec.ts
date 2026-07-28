import { expect, test, type Page, type TestInfo } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const crossPlatformVisualDiffRatio = 0.04;

async function openIsolatedWorkspace(page: Page, testInfo: TestInfo): Promise<void> {
  await page.goto("/cms");
  await expect(page.locator("[data-cms-hydrated='true']")).toBeVisible();
  const name = `${testInfo.project.name} · ${testInfo.title}`.slice(0, 110);
  await page.getByRole("textbox", { name: "Name" }).fill(name);
  await page
    .getByRole("textbox", { name: "Description" })
    .fill("An isolated end-to-end Change created by Playwright.");
  await page.getByRole("button", { name: "Create Change" }).click();
  await page.waitForURL(/\/cms\/changes\/[^/]+$/u);
  await expect(page.locator("[data-cms-hydrated='true']")).toBeVisible();
}

async function openContentDocument(
  page: Page,
  groupName: "Pages" | "Posts" | "Collections" | "Globals" | "Settings",
  documentName: string,
): Promise<void> {
  const group = page
    .locator(".cms-navigation-groups details")
    .filter({ has: page.locator("summary", { hasText: groupName }) });
  if ((await group.getAttribute("open")) === null) await group.locator("summary").click();
  await group.getByRole("button", { name: documentName }).click();
  await page.waitForURL(/\/cms\/changes\/[^/]+\/documents\/[^/]+$/u);
  await expect(page.locator("[data-cms-hydrated='true']")).toBeVisible();
}

test("public page stays separate from the editor runtime", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Open CMS" })).toBeVisible();
  await expect(page.locator('script[src*="editor"]')).toHaveCount(0);
});

test("pl-PL delivery applies localized pointers and emits hreflang", async ({ page }) => {
  await page.goto("/pl-PL");
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: /Praca redakcyjna|Jeden model treści/u,
    }),
  ).toBeVisible();
  await expect(page.locator('link[rel="alternate"][hreflang="en-US"]')).toHaveCount(1);
  await expect(page.locator('link[rel="alternate"][hreflang="pl-PL"]')).toHaveCount(1);
  await expect(page.locator("html")).toHaveAttribute("lang", "pl-PL");
});

test("published slug redirects preserve the active locale", async ({ page }) => {
  await page.goto("/pl-PL/welcome");
  await expect(page).toHaveURL(/\/pl-PL\/?$/u);
  await expect(page.locator("html")).toHaveAttribute("lang", "pl-PL");
});

test("an editor recovers a draft and updates preview without navigation", async ({
  page,
}, testInfo) => {
  await openIsolatedWorkspace(page, testInfo);
  const editor = page.locator("[data-cms-hydrated='true']");
  await expect(editor).toHaveAttribute("data-cms-preview-connected", "true");
  await page.locator(".cms-section-tree button").first().click();
  const heading = page.getByRole("textbox", { name: "Heading" });
  await heading.fill("A proof, updated in place");
  await expect(page.getByText("1 edits")).toBeVisible();
  await expect(page.frameLocator("iframe").getByText("A proof, updated in place")).toBeVisible();
  await page.waitForTimeout(500);
  await page.reload();
  await page.locator(".cms-section-tree button").first().click();
  await expect(page.getByRole("textbox", { name: "Heading" })).toHaveValue(
    "A proof, updated in place",
  );
});

test("the publication rail is keyboard accessible", async ({ page }, testInfo) => {
  await openIsolatedWorkspace(page, testInfo);
  await expect(page.locator("[data-cms-hydrated='true']")).toBeVisible();
  const rail = page.getByLabel("Publication progress");
  await expect(rail).toContainText("Change");
  await expect(rail).toContainText("Review");
  await expect(rail).toContainText("Staging");
  await expect(rail).toContainText("Live");
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus-visible")).toHaveCount(1);
  await page.getByRole("button", { name: "Tablet" }).click();
  await expect(page.frameLocator("iframe").locator("html")).toHaveAttribute(
    "data-cms-viewport",
    "tablet",
  );
});

test("registered sections can be added, reordered, reviewed, and removed", async ({
  page,
}, testInfo) => {
  await openIsolatedWorkspace(page, testInfo);
  await expect(page.locator("[data-cms-hydrated='true']")).toBeVisible();
  const sectionTree = page.locator(".cms-section-tree > li");
  const initialCount = await sectionTree.count();
  await page.getByRole("button", { name: "Add section" }).click();
  await expect(page.getByRole("heading", { name: "Build with registered sections" })).toBeVisible();
  await page.getByRole("button", { name: /Proof/ }).last().click();
  await expect(page.getByText("1 edits")).toBeVisible();
  await expect(sectionTree).toHaveCount(initialCount + 1);
  await page.getByRole("button", { name: /Why this matters proof/ }).hover();
  await page.getByRole("button", { name: "Move Why this matters up" }).click();
  await page.getByRole("button", { name: /Review · 1/ }).click();
  const review = page.getByRole("complementary", { name: "Review Change" });
  await expect(review).toContainText("added");
  await expect(review).toContainText("/sections");
  await review.getByRole("button", { name: "Close review" }).click();
  await page.getByRole("button", { name: /Why this matters proof/ }).hover();
  await page.getByRole("button", { name: "Remove Why this matters" }).click();
  await expect(sectionTree).toHaveCount(initialCount);
});

test("document SEO, locale and XLIFF controls are available without technical Git terms", async ({
  page,
}, testInfo) => {
  await openIsolatedWorkspace(page, testInfo);
  await expect(page.locator("[data-cms-hydrated='true']")).toBeVisible();
  await page.getByRole("button", { name: /SEO & localization/ }).click();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await expect(inspector.getByRole("heading", { name: "SEO & localization" })).toBeVisible();
  await expect(inspector.getByRole("textbox", { name: "Content title" })).toHaveValue(/home/i);
  await expect(inspector.getByRole("link", { name: "Export pl-PL XLIFF" })).toBeVisible();
  await expect(inspector.getByText(/branch|commit|pull request/i)).toHaveCount(0);
});

test("one Change edits a page, global navigation, pricing collection and settings", async ({
  page,
}, testInfo) => {
  test.slow();
  await openIsolatedWorkspace(page, testInfo);

  await page.locator(".cms-section-tree > li > button").first().click();
  await page.getByRole("textbox", { name: "Heading" }).fill("One coordinated content Change");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();

  await openContentDocument(page, "Globals", "Primary navigation");
  await page.getByRole("button", { name: "SEO & localization" }).click();
  const navigationInspector = page.getByRole("complementary", { name: "Inspector" });
  await navigationInspector.getByRole("textbox", { name: "Label" }).first().fill("Dispatches");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();

  await openContentDocument(page, "Collections", "Fieldnotes Lite");
  await page.getByRole("button", { name: "SEO & localization" }).click();
  const pricingInspector = page.getByRole("complementary", { name: "Inspector" });
  await pricingInspector.getByRole("spinbutton", { name: "Amount" }).fill("2500");
  await expect(page.frameLocator("iframe").getByText(/USD 25\.00/u)).toBeVisible();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();

  await openContentDocument(page, "Settings", "Site settings");
  await page.getByRole("button", { name: "SEO & localization" }).click();
  const settingsInspector = page.getByRole("complementary", { name: "Inspector" });
  await settingsInspector
    .getByRole("textbox", { name: "Site name" })
    .fill(`Fieldnotes · ${testInfo.project.name}`);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();

  await page.reload();
  await expect(page.locator("[data-cms-hydrated='true']")).toBeVisible();
  await page.getByRole("button", { name: /Review ·/ }).click();
  const review = page.getByRole("complementary", { name: "Review Change" });
  await expect(
    review
      .locator(".cms-review-panel__summary dl > div")
      .filter({ hasText: "Documents" })
      .locator("dd"),
  ).toHaveText("4");
});

test("parallel Changes resolve semantic conflicts before Staging", async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  const editHeading = async (value: string): Promise<void> => {
    await page.locator(".cms-section-tree > li > button").first().click();
    await page.getByRole("textbox", { name: "Heading" }).fill(value);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();
  };
  const resolveAllConflicts = async (): Promise<void> => {
    await page.getByRole("button", { name: /Review ·/ }).click();
    const review = page.getByRole("complementary", { name: "Review Change" });
    await expect(review).toContainText("semantic conflict");
    const keepChange = review.getByRole("button", { name: "Keep this Change" });
    const conflictCount = await keepChange.count();
    expect(conflictCount).toBeGreaterThan(0);
    for (let index = 0; index < conflictCount; index += 1) {
      await keepChange.nth(index).click();
    }
    await Promise.all([
      page.waitForEvent("domcontentloaded"),
      review.getByRole("button", { name: /Resolve \d+ conflict/u }).click(),
    ]);
    await expect(page.locator("[data-cms-hydrated='true']")).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve Change" })).toBeVisible();
    await page.getByRole("button", { name: "Approve Change" }).click();
    await expect(page.locator(".cms-workflow-note")).toContainText("Approve Change completed");
    await page.getByRole("button", { name: "Add to staging" }).click();
    await expect(page.locator(".cms-workflow-note")).toContainText("Add to staging completed");
  };
  const submitApproveAndStage = async (): Promise<void> => {
    await page.getByRole("button", { name: "Send for review" }).click();
    await expect(page.locator(".cms-workflow-note")).toContainText("Send for review completed");
    await page.getByRole("button", { name: "Approve Change" }).click();
    await expect(page.locator(".cms-workflow-note")).toContainText("Approve Change completed");
    await page.getByRole("button", { name: "Add to staging" }).click();
    await expect
      .poll(() => page.locator(".cms-workflow-note").textContent())
      .toMatch(/Add to staging completed|Resolve semantic conflicts/u);
    if ((await page.locator(".cms-workflow-note").textContent())?.includes("Resolve")) {
      await resolveAllConflicts();
    }
  };

  await openIsolatedWorkspace(page, testInfo);
  const firstChangeUrl = page.url();
  await editHeading(`Staging choice from ${testInfo.project.name}`);

  await openIsolatedWorkspace(page, testInfo);
  const secondChangeUrl = page.url();
  await editHeading(`Parallel choice from ${testInfo.project.name}`);

  await page.goto(firstChangeUrl);
  await expect(page.locator("[data-cms-hydrated='true']")).toBeVisible();
  await submitApproveAndStage();

  await page.goto(secondChangeUrl);
  await expect(page.locator("[data-cms-hydrated='true']")).toBeVisible();
  await page.getByRole("button", { name: "Send for review" }).click();
  await page.getByRole("button", { name: "Approve Change" }).click();
  await page.getByRole("button", { name: "Add to staging" }).click();
  await expect(page.locator(".cms-workflow-note")).toContainText(
    "Resolve semantic conflicts with Staging",
  );

  await resolveAllConflicts();
});

test("inline fields use the same patch stream as the inspector", async ({ page }, testInfo) => {
  await openIsolatedWorkspace(page, testInfo);
  await expect(page.locator("[data-cms-hydrated='true']")).toBeVisible();
  const heading = page.frameLocator("iframe").locator("[data-cms-inline-field='heading']").first();
  await heading.dblclick();
  await heading.fill("Edited directly on the canvas");
  await page.locator(".cms-canvas-toolbar").click();
  await expect(page.getByText("1 edits")).toBeVisible();
  await page.locator(".cms-section-tree > li > button").first().click();
  await expect(page.getByRole("textbox", { name: "Heading" })).toHaveValue(
    "Edited directly on the canvas",
  );
});

test("a media-enabled block selects an asset from storage and updates preview", async ({
  page,
}, testInfo) => {
  await openIsolatedWorkspace(page, testInfo);
  await expect(page.locator("[data-cms-hydrated='true']")).toBeVisible();
  await page.locator(".cms-section-tree > li > button").first().click();

  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await inspector.getByRole("button", { name: /Choose Hero media/ }).click();

  const library = page.getByRole("dialog", { name: "Choose Hero media" });
  await expect(library.getByText("editorial-grid.png")).toBeVisible();
  await library.getByRole("button", { name: "Use asset" }).click();

  await expect(page.getByText("1 edits")).toBeVisible();
  const altText = inspector.getByRole("textbox", {
    name: "Alternative text for Hero media",
  });
  await altText.fill("Editorial grid selected from project storage");
  await expect(
    page.frameLocator("iframe").locator('img[alt="Editorial grid selected from project storage"]'),
  ).toBeVisible();

  await inspector.getByRole("button", { name: "Replace" }).click();
  await page.getByRole("searchbox", { name: "Find an asset" }).fill("application/pdf");
  await expect(page.getByText("No compatible assets")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Choose Hero media" })).toHaveCount(0);
});

test("the standalone storage gallery can browse and filter project assets", async ({ page }) => {
  await page.goto("/cms/assets");
  await expect(page.locator("[data-cms-hydrated='true']")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Assets" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Asset gallery" })).toBeVisible();
  await expect(page.getByText("editorial-grid.png", { exact: true })).toBeVisible();
  const search = page.getByRole("searchbox", { name: "Search assets" });
  await search.fill("image/png");
  await expect(page.getByText("editorial-grid.png", { exact: true })).toBeVisible();
  await search.fill("application/pdf");
  await expect(page.getByRole("heading", { name: "No matching assets" })).toBeVisible();
});

test("editor shell has no serious WCAG 2.2 A or AA violations", async ({ page }, testInfo) => {
  await openIsolatedWorkspace(page, testInfo);
  await expect(page.locator("[data-cms-hydrated='true']")).toBeVisible();
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    result.violations.filter((violation) =>
      ["serious", "critical"].includes(violation.impact ?? ""),
    ),
  ).toEqual([]);

  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await expect(page.locator(".cms-app")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("button", { name: "Hide inspector" })).toHaveCSS(
    "background-color",
    "rgb(24, 33, 42)",
  );
  const darkResult = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    darkResult.violations.filter((violation) =>
      ["serious", "critical"].includes(violation.impact ?? ""),
    ),
  ).toEqual([]);
});

test("editor shell matches light and dark visual baselines", async ({
  page,
  browserName,
}, testInfo) => {
  test.skip(browserName !== "chromium", "Chromium is the canonical visual regression renderer.");
  await openIsolatedWorkspace(page, testInfo);
  const editor = page.locator(".cms-app");
  await expect(page.locator("[data-cms-hydrated='true']")).toHaveAttribute(
    "data-cms-preview-connected",
    "true",
  );
  await Promise.all(page.frames().map((frame) => frame.evaluate(() => document.fonts.ready)));
  await expect(editor).toHaveScreenshot("editor-light.png", {
    animations: "disabled",
    caret: "hide",
    maxDiffPixelRatio: crossPlatformVisualDiffRatio,
    scale: "css",
  });

  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await expect(editor).toHaveAttribute("data-theme", "dark");
  await expect(editor).toHaveScreenshot("editor-dark.png", {
    animations: "disabled",
    caret: "hide",
    maxDiffPixelRatio: crossPlatformVisualDiffRatio,
    scale: "css",
  });
});

test("complete UI workflow publishes immutable delivery and restores the previous release", async ({
  page,
}, testInfo) => {
  await openIsolatedWorkspace(page, testInfo);
  await page.locator(".cms-section-tree > li > button").first().click();
  await page
    .getByRole("textbox", { name: "Heading" })
    .fill(`Published through ${testInfo.project.name}`);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();

  await page.getByRole("button", { name: "Send for review" }).click();
  const workflowNote = page.locator(".cms-workflow-note");
  await expect(workflowNote).toContainText("Send for review completed");
  await page.reload();
  await expect(page.locator("[data-cms-hydrated='true']")).toBeVisible();

  await page.getByRole("button", { name: /Review ·/ }).click();
  const review = page.getByRole("complementary", { name: "Review Change" });
  await review
    .getByRole("textbox", { name: "Review note" })
    .fill("Preview, localization and checks are ready.");
  await review.getByRole("button", { name: "Add comment" }).click();
  await expect(review).toContainText("Preview, localization and checks are ready.");

  await page.getByRole("button", { name: "Approve Change" }).click();
  await expect(workflowNote).toContainText("Approve Change completed");
  await page.getByRole("button", { name: "Add to staging" }).click();
  await expect
    .poll(() => workflowNote.textContent())
    .toMatch(/Add to staging completed|Resolve semantic conflicts/u);
  if ((await workflowNote.textContent())?.includes("Resolve")) {
    const keepChange = review.getByRole("button", { name: "Keep this Change" });
    const conflictCount = await keepChange.count();
    expect(conflictCount).toBeGreaterThan(0);
    for (let index = 0; index < conflictCount; index += 1) {
      await keepChange.nth(index).click();
    }
    await Promise.all([
      page.waitForEvent("domcontentloaded"),
      review.getByRole("button", { name: /Resolve \d+ conflict/u }).click(),
    ]);
    await expect(page.locator("[data-cms-hydrated='true']")).toBeVisible();
    await page.getByRole("button", { name: "Approve Change" }).click();
    await expect(workflowNote).toContainText("Approve Change completed");
    await page.getByRole("button", { name: "Add to staging" }).click();
  }
  await expect(workflowNote).toContainText("Add to staging completed");
  await page.getByRole("button", { name: "Publish live" }).click();
  await expect(workflowNote).toContainText(/Published release rel_/u);

  await page.goto("/cms/releases");
  await expect(page.getByRole("heading", { name: "Release timeline" })).toBeVisible();
  await expect(page.getByText(/active on production/iu)).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Restore" }).first().click();
  await expect(page.getByRole("status")).toContainText("Production pointer was restored");
});
