import { test, expect } from '@playwright/test';

test('successful login', async ({ page }) => {
  await page.goto('https://example.com/login');
  await page.fill('#username', 'admin');
  await page.fill('#password', 'secret');
  await page.click('button[type="submit"]');
  await expect(page.locator('.dashboard')).toBeVisible();
});
