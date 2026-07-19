import { expect, test } from "@playwright/test";

test("Next fixture hydrates the marketplace surface without browser errors", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/", { waitUntil: "networkidle" });

  await expect(
    page.getByRole("heading", { name: "AgenC marketplace listings" }),
  ).toBeVisible();
  await expect(
    page.locator(".agenc-listing-grid article").first(),
  ).toBeVisible();
  expect(
    await page.locator(".agenc-listing-grid article").count(),
  ).toBeGreaterThan(0);
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Confirm and fund escrow" }),
  ).toBeVisible();

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
