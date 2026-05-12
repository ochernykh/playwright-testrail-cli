import { test, expect } from '@playwright/test';

test('successful login', async ({ page }) => {
  await page.goto('https://example.com/login');
  await page.fill('#username', 'user@example.com');
  await page.fill('#password', 'your-password');
  await page.click('button[type="submit"]');
  await expect(page.locator('.dashboard')).toBeVisible();
});
