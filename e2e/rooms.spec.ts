import { test, expect, type Browser, type BrowserContext } from '@playwright/test';

async function participant(browser: Browser, url: string, options = {}) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  await page.goto(url);
  return { context, page };
}

test('choices, optional names and disconnections stay in sync across four devices', async ({ browser, page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.screenshot({ path: 'test-results/lobby-desktop.png', fullPage: true });
  await page.locator('.create-button').click();
  await expect(page.getByTestId('my-status')).toBeVisible();
  const url = page.url();
  const second = await participant(browser, url, { viewport: { width: 1024, height: 768 }, isMobile: true, hasTouch: true });
  const third = await participant(browser, url, { viewport: { width: 768, height: 1024 }, isMobile: true, hasTouch: true });
  const contexts = [second.context, third.context];
  const peer = (slot: number) => page.locator('.peer').filter({ has: page.locator('.panel-label', { hasText: new RegExp(`^#${slot} `) }) });
  try {
    await expect(page.getByTestId('peer-status')).toHaveCount(2);
    await expect(page.locator('.connection-indicator')).toContainText('3/10');
    await expect(page.locator('.mine .panel-label')).toHaveText('#1 나');
    await page.getByRole('button', { name: 'YES', exact: true }).click();
    await expect(second.page.getByTestId('peer-status').first()).toHaveAttribute('data-choice', 'YES');
    await second.page.getByRole('button', { name: 'NO', exact: true }).click();
    await expect(page.getByTestId('peer-status').first()).toHaveAttribute('data-choice', 'NO');

    await second.page.locator('.edit-name').click();
    await second.page.locator('#display-name').fill('민지');
    await second.page.locator('.dialog-actions .primary-button').click();
    await expect(second.page.locator('.mine .panel-label')).toHaveText('#2 민지');
    await expect(page.locator('.peer .panel-label').first()).toHaveText('#2 민지');
    await expect(second.page.locator('.mine .status-name')).toHaveText('민지');
    await expect(page.locator('.peer .status-name').first()).toHaveText('민지');
    await second.page.locator('.mine .name-trigger').click();
    await expect(second.page.locator('#display-name')).toHaveValue('민지');
    await second.page.locator('.dialog-close').click();
    await expect(page.locator('.peers-title')).toHaveCount(0);
    await third.page.getByRole('button', { name: 'YES', exact: true }).click();
    await expect(peer(3).getByTestId('peer-status')).toHaveAttribute('data-choice', 'YES');
    await expect(page.locator('.toast-stack')).toContainText('YES');

    await second.page.reload();
    await expect(second.page.locator('.mine .panel-label')).toHaveText('#2 민지');
    await expect(second.page.getByTestId('my-status')).toHaveAttribute('data-choice', 'NO');
    await page.screenshot({ path: 'test-results/room-desktop.png', fullPage: true });
    await third.page.screenshot({ path: 'test-results/room-ipad-portrait.png', fullPage: true });
    const dimensions = await third.page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);

    const fourth = await participant(browser, url); contexts.push(fourth.context);
    await expect(page.getByTestId('peer-status')).toHaveCount(3);
    await expect(page.locator('.peers')).toHaveClass(/many-peers/);
    await expect(peer(4).locator('.panel-label')).toHaveText('#4 상대방');
    await expect(page.locator('.connection-indicator')).toContainText('4/10');
    await second.context.setOffline(true);
    await expect(peer(2).getByTestId('peer-status')).toHaveText('연결 끊김');
    await second.context.setOffline(false);
    await expect(peer(2).getByTestId('peer-status')).toHaveAttribute('data-choice', 'NO');

    await second.page.locator('.edit-name').click();
    await second.page.locator('#display-name').fill('');
    await second.page.locator('.dialog-actions .primary-button').click();
    await expect(second.page.locator('.mine .panel-label')).toHaveText('#2 나');
    await expect(peer(2).locator('.panel-label')).toHaveText('#2 상대방');
    await second.page.locator('.toolbar .icon-button').last().click();
    await second.page.locator('.dialog-actions .primary-button').click();
    await expect(page.locator('.connection-indicator')).toContainText('3/10');
    await expect(page.locator('.peer .panel-label')).toHaveText(['#2 상대방', '#3 상대방']);
    expect(errors).toEqual([]);
  } finally { await Promise.all(contexts.map(c => c.close())); }
});

test('recent changes rise while a ten-second disconnection falls once', async ({ browser, page }) => {
  await page.goto('/'); await page.locator('.create-button').click();
  await expect(page.getByTestId('my-status')).toBeVisible();
  const first = await participant(browser, page.url());
  const second = await participant(browser, page.url());
  const third = await participant(browser, page.url());
  const labels = () => page.locator('.peer .panel-label').allTextContents();
  try {
    await expect.poll(labels).toEqual(['#2 상대방', '#3 상대방', '#4 상대방']);
    await second.page.getByRole('button', { name: 'YES', exact: true }).click();
    await expect.poll(labels).toEqual(['#3 상대방', '#2 상대방', '#4 상대방']);
    await first.page.getByRole('button', { name: 'NO', exact: true }).click();
    await expect.poll(labels).toEqual(['#2 상대방', '#3 상대방', '#4 상대방']);

    await second.context.setOffline(true);
    await expect(page.locator('.peer').nth(1).getByTestId('peer-status')).toHaveText('연결 끊김');
    await expect.poll(labels, { timeout: 15_000 }).toEqual(['#2 상대방', '#4 상대방', '#3 상대방']);
    await second.context.setOffline(false);
    await expect(page.locator('.peer').nth(2).getByTestId('peer-status')).toHaveAttribute('data-choice', 'YES');
    await expect.poll(labels).toEqual(['#2 상대방', '#4 상대방', '#3 상대방']);
    await second.page.getByRole('button', { name: 'NO', exact: true }).click();
    await expect.poll(labels).toEqual(['#3 상대방', '#2 상대방', '#4 상대방']);
  } finally { await Promise.all([first.context.close(), second.context.close(), third.context.close()]); }
});

test('concurrent joins stop at ten and the peer list scrolls', async ({ page }) => {
  await page.goto('/'); await page.locator('.create-button').click();
  await expect(page.getByTestId('my-status')).toBeVisible();
  const code = new URLSearchParams(new URL(page.url()).hash.slice(1)).get('room');
  const results = await page.evaluate(async roomCode => {
    const sockets: WebSocket[] = [];
    (window as unknown as { testSockets: WebSocket[] }).testSockets = sockets;
    return Promise.all(Array.from({ length: 10 }, () => new Promise<string>(resolve => {
      const ws = new WebSocket(`ws://127.0.0.1:8787/api/rooms/${roomCode}/socket`);
      sockets.push(ws);
      const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('');
      ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token }));
      ws.onmessage = event => {
        const data = JSON.parse(event.data);
        if (data.type === 'snapshot') { ws.onmessage = null; resolve('joined'); }
        else if (data.type === 'error') { resolve(data.code); ws.close(); }
      };
      ws.onerror = () => resolve('socket-error');
    })));
  }, code);
  expect(results.filter(result => result === 'joined')).toHaveLength(9);
  expect(results.filter(result => result === 'ROOM_FULL')).toHaveLength(1);
  await expect(page.locator('.connection-indicator')).toContainText('10/10');
  await expect(page.getByTestId('peer-status')).toHaveCount(9);
  await expect(page.locator('.peers')).toHaveCSS('overflow-y', 'auto');
  await page.evaluate(() => (window as unknown as { testSockets: WebSocket[] }).testSockets.forEach(ws => ws.close()));
});

test('voice tokens require an authenticated room connection', async ({ page }) => {
  await page.goto('/'); await page.locator('.create-button').click();
  await expect(page.getByTestId('my-status')).toBeVisible();
  const code = new URLSearchParams(new URL(page.url()).hash.slice(1)).get('room');
  const status = await page.evaluate(async roomCode => {
    const response = await fetch(`http://127.0.0.1:8787/api/rooms/${roomCode}/voice`, { method: 'POST' });
    return response.status;
  }, code);
  expect(status).toBe(403);
});

test('unresponsive connections time out and unauthenticated writes fail', async ({ page }) => {
  await page.goto('/'); await page.locator('.create-button').click();
  await expect(page.getByTestId('my-status')).toBeVisible();
  const code = new URLSearchParams(new URL(page.url()).hash.slice(1)).get('room');
  const unauthenticated = await page.evaluate(roomCode => new Promise<string>(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:8787/api/rooms/${roomCode}/socket`);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'choice', choice: 'YES' }));
    ws.onmessage = event => { resolve(JSON.parse(event.data).code); ws.close(); };
  }), code);
  expect(unauthenticated).toBe('UNAUTHORIZED');
  await page.evaluate(roomCode => new Promise<void>(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:8787/api/rooms/${roomCode}/socket`);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token: 'a'.repeat(64) }));
    ws.onmessage = event => { if (JSON.parse(event.data).type === 'snapshot') resolve(); };
    (window as unknown as { silentSocket: WebSocket }).silentSocket = ws;
  }), code);
  await expect(page.locator('.connection-indicator')).toContainText('2/10');
  await expect(page.getByTestId('peer-status')).toHaveText('연결 끊김', { timeout: 35_000 });
  await expect(page.locator('.connection-indicator')).toContainText('1/10');
});

test('unknown rooms, invitation validation and small screens', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
  await page.locator('#room-input').fill('wrong');
  await page.locator('.join-button').click();
  await expect(page.locator('.form-error')).toBeVisible();
  await page.screenshot({ path: 'test-results/lobby-mobile.png', fullPage: true });
  await page.goto('/#room=0000000000000000');
  await expect(page.locator('.lobby-content')).toBeVisible();
  await page.goto('/#room=0000');
  await expect(page.locator('.connection-card')).toBeVisible();
});

test('new room uses a four digit code that another device can enter', async ({ browser, page }) => {
  await page.goto('/');
  await expect(page.locator('#room-input')).toHaveAttribute('inputmode', 'numeric');
  await page.locator('.create-button').click();
  await expect(page.getByTestId('my-status')).toBeVisible();
  const code = new URLSearchParams(new URL(page.url()).hash.slice(1)).get('room');
  expect(code).toMatch(/^\d{4}$/);
  await expect(page.locator('.room-code')).toContainText(code!);
  const other = await participant(browser, new URL('/', page.url()).toString());
  try {
    await other.page.locator('#room-input').fill(code!);
    await other.page.locator('.join-button').click();
    await expect(other.page.getByTestId('my-status')).toBeVisible();
    await expect(other.page.locator('.room-code')).toContainText(code!);
    await expect(page.locator('.connection-indicator')).toContainText('2/10');
  } finally { await other.context.close(); }
});

test('a sixteen-character name fits inside the status panel on a phone screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.locator('.create-button').click();
  await expect(page.getByTestId('my-status')).toBeVisible();
  const name = '가'.repeat(16);
  await page.locator('.mine .name-trigger').click();
  await page.locator('#display-name').fill(name);
  await page.locator('.dialog-actions .primary-button').click();
  await page.getByRole('button', { name: 'YES', exact: true }).click();
  await expect(page.locator('.mine .status-name')).toHaveText(name);
  const fits = await page.locator('.mine').evaluate(panel => {
    const nameBounds = panel.querySelector('.status-name')!.getBoundingClientRect();
    const panelBounds = panel.getBoundingClientRect();
    const controlsBounds = panel.querySelector('.my-controls')!.getBoundingClientRect();
    return nameBounds.left >= panelBounds.left && nameBounds.right <= panelBounds.right &&
      nameBounds.top >= panelBounds.top && nameBounds.bottom < controlsBounds.top;
  });
  expect(fits).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
