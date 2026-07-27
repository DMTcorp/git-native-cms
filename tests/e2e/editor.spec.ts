import { expect, test } from "@playwright/test";

test("public page stays separate from the editor runtime", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Open CMS" })).toBeVisible();
  await expect(page.locator('script[src*="editor"]')).toHaveCount(0);
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
  const rail = page.getByLabel("Publication progress");
  await expect(rail).toContainText("Change");
  await expect(rail).toContainText("Review");
  await expect(rail).toContainText("Staging");
  await expect(rail).toContainText("Live");
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus-visible")).toHaveCount(1);
});
