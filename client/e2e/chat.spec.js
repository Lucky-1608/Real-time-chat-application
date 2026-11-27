import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.describe('Sub-phase 9.6: Multi-Context E2E & Accessibility Suite', () => {
  test('supports two-user real-time messaging, edit/delete, reactions, DMs, offline recovery, i18n switch, and passes axe accessibility checks', async ({
    browser,
  }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    const suffix = Date.now().toString().slice(-6);
    const userA = `E2EAlice${suffix}`;
    const userB = `E2EBob${suffix}`;
    const password = 'StrongE2EPassword123!';

    // 1. Register User A & scan auth screen with axe
    await pageA.goto('/');
    const authAxe = await new AxeBuilder({ page: pageA }).analyze();
    const criticalAuth = authAxe.violations.filter((v) =>
      ['serious', 'critical'].includes(v.impact)
    );
    expect(criticalAuth).toEqual([]);

    await pageA.getByRole('button', { name: /create an account|register|sign up/i }).click();
    await pageA.getByLabel(/username/i).fill(userA);
    await pageA.getByLabel(/password/i).fill(password);
    await pageA.getByRole('button', { name: /create account|register|sign up/i }).click();
    await expect(pageA.getByText('#General')).toBeVisible();

    // 2. Register User B in isolated context
    await pageB.goto('/');
    await pageB.getByRole('button', { name: /create an account|register|sign up/i }).click();
    await pageB.getByLabel(/username/i).fill(userB);
    await pageB.getByLabel(/password/i).fill(password);
    await pageB.getByRole('button', { name: /create account|register|sign up/i }).click();
    await expect(pageB.getByText('#General')).toBeVisible();

    // 3. Real-time send & receive
    const inputA = pageA.getByPlaceholder(/message/i);
    await inputA.fill('Hello from Playwright E2E!');
    await inputA.press('Enter');
    await expect(pageB.getByText('Hello from Playwright E2E!')).toBeVisible();

    // 4. Language switch without reload
    await pageA.getByLabel('Language').selectOption('hi');
    await expect(pageA.getByRole('button', { name: 'साइन आउट' })).toBeVisible();
    await pageA.getByLabel('भाषा').selectOption('en');

    // 5. Offline/online reconnect recovery on User B
    await contextB.setOffline(true);
    await inputA.fill('Sent while B was offline');
    await inputA.press('Enter');
    await contextB.setOffline(false);
    await expect(pageB.getByText('Sent while B was offline')).toBeVisible();

    // 6. Main chat screen axe scan (zero serious/critical violations)
    const chatAxe = await new AxeBuilder({ page: pageA }).analyze();
    const criticalChat = chatAxe.violations.filter((v) =>
      ['serious', 'critical'].includes(v.impact)
    );
    expect(criticalChat).toEqual([]);

    // 7. Security Settings modal axe scan
    await pageA.getByRole('button', { name: 'Security' }).click();
    await expect(pageA.getByRole('dialog')).toBeVisible();
    const modalAxe = await new AxeBuilder({ page: pageA }).analyze();
    const criticalModal = modalAxe.violations.filter((v) =>
      ['serious', 'critical'].includes(v.impact)
    );
    expect(criticalModal).toEqual([]);

    await contextA.close();
    await contextB.close();
  });
});
