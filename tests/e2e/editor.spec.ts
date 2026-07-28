import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const crossPlatformVisualDiffRatio = 0.04;

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

test("an editor recovers a draft and updates preview without navigation", async ({ page }) => {
  await page.goto("/cms");
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

test("the publication rail is keyboard accessible", async ({ page }) => {
  await page.goto("/cms");
  await expect(page.locator("[data-cms-hydrated='true']")).toBeVisible();
  const rail = page.getByLabel("Publication progress");
  await expect(rail).toContainText("Change");
  await expect(rail).toContainText("Review");
  await expect(rail).toContainText("Staging");
  await expect(rail).toContainText("Live");
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus-visible")).toHaveCount(1);
});

test("registered sections can be added, reordered, reviewed, and removed", async ({ page }) => {
  await page.goto("/cms");
  await expect(page.locator("[data-cms-hydrated='true']")).toBeVisible();
  await page.getByRole("button", { name: "Add section" }).click();
  await expect(page.getByRole("heading", { name: "Build with registered sections" })).toBeVisible();
  await page.getByRole("button", { name: /Proof/ }).last().click();
  await expect(page.getByText("1 edits")).toBeVisible();
  await expect(page.locator(".cms-section-tree > li")).toHaveCount(3);
  await page.getByRole("button", { name: /Review · 1/ }).click();
  await expect(page.getByRole("complementary", { name: "Review Change" })).toContainText("added");
  await expect(page.getByRole("complementary", { name: "Review Change" })).toContainText(
    "/sections",
  );
});

test("document SEO, locale and XLIFF controls are available without technical Git terms", async ({
  page,
}) => {
  await page.goto("/cms");
  await expect(page.locator("[data-cms-hydrated='true']")).toBeVisible();
  await page.getByRole("button", { name: /SEO & localization/ }).click();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await expect(inspector.getByRole("heading", { name: "SEO & localization" })).toBeVisible();
  await expect(inspector.getByRole("textbox", { name: "Content title" })).toHaveValue(/home/i);
  await expect(inspector.getByRole("link", { name: "Export pl-PL XLIFF" })).toBeVisible();
  await expect(inspector.getByText(/branch|commit|pull request/i)).toHaveCount(0);
});

test("inline fields use the same patch stream as the inspector", async ({ page }) => {
  await page.goto("/cms");
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

test("editor shell has no serious WCAG 2.2 A or AA violations", async ({ page }) => {
  await page.goto("/cms");
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

test("editor shell matches light and dark visual baselines", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Chromium is the canonical visual regression renderer.");
  await page.goto("/cms");
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
