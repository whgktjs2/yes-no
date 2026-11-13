import { test, expect, type Browser, type BrowserContext } from '@playwright/test';

async function participant(browser: Browser, url: string, options = {}) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  await page.goto(url);
  return { context, page };
}

test('three independent participants, fourth denied, reconnect and leave', async ({ browser, page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '말 대신, YES 또는 NO.' })).toBeVisible();
  await page.screenshot({ path: 'test-results/lobby-desktop.png', fullPage: true });
  await page.getByRole('button', { name: '새 방 만들기' }).click();
  await expect(page.getByTestId('my-status')).toHaveText('선택 전');
  const url = page.url();
  const second = await participant(browser, url, { viewport: { width: 1024, height: 768 }, isMobile: true, hasTouch: true });
  const third = await participant(browser, url, { viewport: { width: 768, height: 1024 }, isMobile: true, hasTouch: true });
  const contexts = [second.context, third.context];
  try {
    await expect(page.getByTestId('peer-status')).toHaveCount(2);
    await expect(page.getByText('3/3 연결됨')).toBeVisible();
    await page.getByRole('button', { name: 'YES', exact: true }).click();
    await expect(second.page.getByTestId('peer-status').first()).toHaveText('YES');
    await second.page.getByRole('button', { name: 'NO', exact: true }).click();
    await expect(page.getByTestId('peer-status').first()).toHaveText('NO');
    await third.page.getByRole('button', { name: 'YES', exact: true }).click();
    await expect(page.getByTestId('peer-status').nth(1)).toHaveText('YES');
    await expect(page.getByRole('status')).toContainText('상대방 2의 상태가 YES로 변경되었습니다.');
    await expect(page.getByRole('region', { name: '상대방 2 상태', exact: true })).toHaveCSS('background-color', 'rgb(103, 185, 107)');
    await page.screenshot({ path: 'test-results/room-desktop.png', fullPage: true });
    await third.page.screenshot({ path: 'test-results/room-ipad-portrait.png', fullPage: true });
    await expect(third.page.getByRole('region', { name: '나 상태', exact: true })).toBeVisible();
    const dimensions = await third.page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
    const fourth = await participant(browser, url); contexts.push(fourth.context);
    await expect(fourth.page.getByRole('heading', { name: '방이 가득 찼습니다. (3/3)' })).toBeVisible();
    await third.page.reload();
    await expect(third.page.getByTestId('my-status')).toHaveText('YES');
    await expect(third.page.getByText('3/3 연결됨')).toBeVisible();
    await second.context.setOffline(true);
    await expect(second.page.getByTestId('my-status')).toHaveText('연결 끊김');
    await expect(second.page.getByRole('button', { name: 'YES', exact: true })).toBeDisabled();
    await expect(page.getByTestId('peer-status').first()).toHaveText('연결 끊김');
    await expect(page.getByTestId('peer-status').nth(1)).toHaveText('YES');
    await second.context.setOffline(false);
    await expect(page.getByTestId('peer-status').first()).toHaveText('NO');
    await expect(second.page.getByTestId('my-status')).toHaveText('NO');
    await second.page.getByRole('button', { name: '방 나가기', exact: true }).click();
    await second.page.getByRole('button', { name: '나가기', exact: true }).click();
    await expect(page.getByText('2/3 연결됨')).toBeVisible();
    await fourth.page.getByRole('button', { name: '다시 연결' }).click();
    await expect(fourth.page.getByTestId('my-status')).toHaveText('선택 전');
    await expect(page.getByText('3/3 연결됨')).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await Promise.all(contexts.map(c => c.close())); }
});

test('simultaneous join attempts never exceed three participants', async ({ browser, page }) => {
  await page.goto('/'); await page.getByRole('button', { name: '새 방 만들기' }).click();
  await expect(page.getByTestId('my-status')).toHaveText('선택 전');
  const contexts: BrowserContext[] = [];
  try {
    const others = await Promise.all(Array.from({ length: 3 }, async () => { const p = await participant(browser, page.url()); contexts.push(p.context); return p.page; }));
    await expect(page.getByText('3/3 연결됨')).toBeVisible();
    await expect.poll(async () => (await Promise.all(others.map(p => p.getByText('방이 가득 찼습니다. (3/3)').count()))).reduce((a, b) => a + b, 0)).toBe(1);
    await expect(page.getByTestId('peer-status')).toHaveCount(2);
  } finally { await Promise.all(contexts.map(c => c.close())); }
});

test('unresponsive connections time out and unauthenticated writes fail', async ({ page }) => {
  await page.goto('/'); await page.getByRole('button', { name: '새 방 만들기' }).click();
  await expect(page.getByTestId('my-status')).toHaveText('선택 전');
  const code = new URLSearchParams(new URL(page.url()).hash.slice(1)).get('room');
  const unauthenticated = await page.evaluate(code => new Promise<string>(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:8787/api/rooms/${code}/socket`);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'choice', choice: 'YES' }));
    ws.onmessage = event => { resolve(JSON.parse(event.data).code); ws.close(); };
  }), code);
  expect(unauthenticated).toBe('UNAUTHORIZED');
  await page.evaluate(code => new Promise<void>(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:8787/api/rooms/${code}/socket`);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token: 'a'.repeat(64) }));
    ws.onmessage = event => { if (JSON.parse(event.data).type === 'snapshot') resolve(); };
    (window as unknown as { silentSocket: WebSocket }).silentSocket = ws;
  }), code);
  await expect(page.getByText('2/3 연결됨')).toBeVisible();
  await expect(page.getByTestId('peer-status')).toHaveText('연결 끊김', { timeout: 35_000 });
  await expect(page.getByText('1/3 연결됨')).toBeVisible();
});

test('unknown rooms, invitation validation and small screens', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
  await page.getByLabel('방 코드 또는 초대 링크').fill('wrong');
  await page.getByRole('button', { name: '방 참여하기' }).click();
  await expect(page.getByRole('alert')).toContainText('16자리');
  await page.screenshot({ path: 'test-results/lobby-mobile.png', fullPage: true });
  await page.goto('/#room=0000000000000000');
  await expect(page.getByRole('heading', { name: '방을 찾을 수 없거나 만료되었습니다.' })).toBeVisible();
});
