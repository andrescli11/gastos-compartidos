import { expect, test } from '@playwright/test';
test('revisión exacta, cambio de moneda y errores accesibles', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Vista de desarrollo')).toBeVisible();
  await page.getByLabel('Importe total').fill('10.00');
  await expect(page.locator('.preview').getByText('S/ 3.34', { exact: true })).toBeVisible();
  await page.getByLabel('Moneda').selectOption('USD');
  await expect(page.locator('.preview').getByText('US$ 3.34', { exact: true })).toBeVisible();
  await page.getByLabel('Importe total').fill('0.01');
  await expect(page.getByText('Cada beneficiario debe recibir al menos un céntimo.')).toBeVisible();
  await expect(page.getByLabel('Importe total')).toHaveAttribute('aria-invalid', 'true');
  await page.getByLabel('Participante 2').uncheck();
  await page.getByLabel('Participante 3').uncheck();
  await expect(page.locator('.preview').getByText('US$ 0.01', { exact: true })).toHaveCount(2);
  await expect(page.getByRole('heading', { name: '¿Quién le devuelve a quién?' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
