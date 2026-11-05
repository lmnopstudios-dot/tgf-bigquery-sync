import assert from 'node:assert/strict';
import { acceptanceServer } from './oracle-acceptance.js';
import {
  multiPeriodFixture,
  liveMultiPeriodPrompt
} from './multi-period-daily-fixture.js';
export async function verifyMultiPeriodDailyBrowser(browser) {
  for (const width of [390, 1280]) {
    const f = multiPeriodFixture(),
      h = await acceptanceServer(f, {
        durable: true,
        now: Date.parse('2026-11-05T12:00:00Z')
      }),
      page = await browser.newPage({ viewport: { width, height: 900 } });
    try {
      await page.goto(h.origin + '/oracle/');
      await page.locator('#password').fill('fixture');
      await page.locator('#login-form button').click();
      await page.locator('#app').waitFor({ state: 'visible' });
      await page.locator('#message').fill(liveMultiPeriodPrompt);
      await page.locator('#send').click();
      await page.waitForFunction(
        () =>
          !document.querySelector('#send').disabled &&
          document.querySelector('.analytical-answer')
      );
      const answer = page.locator('.analytical-answer').last(),
        text = await answer.innerText();
      assert.match(text, /May Bank Holiday 2026/);
      assert.match(text, /2025-11-27.*VIP/);
      assert.match(text, /2025-11-28.*Public/);
      assert.match(text, /2024-11-11T00:00:00Z/);
      assert.ok((await answer.locator('table').count()) >= 10);
      const count = f.queries.length;
      await page.reload();
      await page.waitForFunction(
        () =>
          !document.querySelector('#send').disabled &&
          document.querySelector('.analytical-answer')
      );
      assert.match(
        await page.locator('.analytical-answer').last().innerText(),
        /May Bank Holiday 2026/
      );
      assert.equal(f.queries.length, count);
    } finally {
      await page.close();
      await h.close();
    }
  }
}
