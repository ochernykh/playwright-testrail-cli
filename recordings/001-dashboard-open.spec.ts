import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('https://www.digital.pumb.ua/demo-cabinet/dashboard');
  await page.getByTestId('create-uah-payment-button').click();
  await page.getByRole('textbox', { name: '№ платежу' }).click();
  await page.getByRole('textbox', { name: '№ платежу' }).fill('345');
  await page.getByRole('combobox', { name: 'Рахунок для сплати UA' }).click();
  await page.getByLabel('Банківські рахунки').getByText('ФОП Тесла Нікола', { exact: true }).click();
  await page.locator('#payment-payer-account-dialogApplyButton').click();
  await page.getByRole('button', { name: 'Обрати', exact: true }).click();
  await page.locator('span').filter({ hasText: 'ФОП Тесла Н.' }).click();
  await page.locator('#payment-receiver-template-dialogApplyButton').click();
  await page.getByRole('textbox', { name: 'Сума UAH' }).click();
  await page.getByRole('textbox', { name: 'Сума UAH' }).fill('500');
  await page.getByRole('button', { name: 'Створити' }).click();
});