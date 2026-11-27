import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.describe('Sub-phase 10.3: Onboarding Tour & Demo Content E2E', () => {
  test('walks through onboarding tour, persists progress across reload, toggles demo content, and passes axe', async ({
    page,
  }) => {
    const suffix = Date.now().toString().slice(-6);
    const username = `OnboardE2E${suffix}`;
    const password = 'StrongE2EPassword123!';

    await page.goto('/');
    await page.getByRole('button', { name: /create an account|register|sign up/i }).click();
    await page.getByLabel(/username/i).fill(username);
    await page.getByLabel(/password/i).fill(password);
    await page.getByRole('button', { name: /create account|register|sign up/i }).click();

    await expect(page.getByText('#General')).toBeVisible();

    // First-run tour appears automatically
    const tour = page.getByRole('region', { name: 'Getting started tour' });
    await expect(tour).toBeVisible();
    await expect(tour.getByText('Getting Started (1 / 4)')).toBeVisible();

    // Axe accessibility scan with tour open
    const tourAxe = await new AxeBuilder({ page }).analyze();
    const critical = tourAxe.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
    expect(critical).toEqual([]);

    // Advance to step 2 and reload -> tour progress persists
    await tour.getByRole('button', { name: 'Next' }).click();
    await expect(tour.getByText('Getting Started (2 / 4)')).toBeVisible();

    await page.reload();
    await expect(page.getByRole('region', { name: 'Getting started tour' })).toBeVisible();
    await expect(page.getByText('Getting Started (2 / 4)')).toBeVisible();

    // Add demo content -> #demo-playground appears, then Remove demo content -> disappears
    await page.getByRole('button', { name: 'Add demo content' }).click();
    await expect(page.getByText('#demo-playground')).toBeVisible();
    await page.getByRole('button', { name: 'Remove demo content' }).click();
    await expect(page.getByText('#demo-playground')).toHaveCount(0);

    // Finish tour and re-open from Help button
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Finish tour' }).click();
    await expect(page.getByRole('region', { name: 'Getting started tour' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Help' }).click();
    await expect(page.getByRole('region', { name: 'Getting started tour' })).toBeVisible();
  });
});
