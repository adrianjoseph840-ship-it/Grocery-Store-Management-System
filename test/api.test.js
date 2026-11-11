import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('cashier sale and settlement reconcile in persistent API', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'canteen-test-'));
  const port = 31000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['src/server.js'], { cwd: process.cwd(), env: { ...process.env, CANTEEN_DATA_DIR: dir, CANTEEN_ADMIN_PASSWORD: 'TestPassword123456', PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const base = `http://127.0.0.1:${port}/api`;
  let cookie;
  let stage = 'startup';
  async function call(path, method = 'GET', data, expectedStatus) {
    stage = `${method} ${path}`;
    const response = await fetch(base + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(data ? { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() } : {}) }, body: data ? JSON.stringify(data) : undefined });
    const value = await response.json();
    if (expectedStatus) { assert.equal(response.status, expectedStatus); return value; }
    if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(value)}`);
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return value;
  }
  try {
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { await fetch(base + '/me'); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert.ok(ready, 'server started');
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /aria-label="Main navigation"/);
    const theme = await fetch(`http://127.0.0.1:${port}/theme.css`);
    assert.equal(theme.status, 200);
    assert.match(await theme.text(), /login-story/);
    const styles = await fetch(`http://127.0.0.1:${port}/style.css`);
    assert.equal(styles.status, 200);
    assert.match(await styles.text(), /pos-grid/);
    await call('/login', 'POST', { username: 'admin', password: 'TestPassword123456' });
    const section = await call('/sections', 'POST', { name: 'Tracking' });
    const buyer = await call('/users', 'POST', { name: 'Test Buyer', username: 'buyer', password: 'BuyerPassword123', role: 'BUYER', sectionId: section.id, creditLimitMinor: 20000, creditAllowed: true });
    const item = await call('/items', 'POST', { name: 'Lunch', priceMinor: 10000 });
    await call('/drawers/open', 'POST', { openingMinor: 5000 });
    const sale = await call('/sales', 'POST', { buyerId: buyer.id, lines: [{ itemId: item.id, quantity: 1 }], tenders: [{ type: 'CASH', amountMinor: 3000 }, { type: 'DEBT', amountMinor: 7000 }] });
    assert.equal(sale.debtChargeMinor, 7000);
    assert.equal((await call(`/buyers/${buyer.id}`)).balanceMinor, 7000);
    await call(`/buyers/${buyer.id}/payments`, 'POST', { amountMinor: 2000 });
    assert.equal((await call(`/buyers/${buyer.id}`)).balanceMinor, 5000);
    const summary = await call('/reports/summary');
    assert.deepEqual([summary.gross, summary.cash, summary.debt, summary.outstanding], [10000, 3000, 7000, 5000]);
    const blocked = await call(`/sales/${sale.id}/void`, 'POST', { reason: 'Customer returned meal' }, 400);
    assert.match(blocked.error, /later payment/);
    const cashSale = await call('/sales', 'POST', { lines: [{ itemId: item.id, quantity: 1 }], tenders: [{ type: 'CASH', amountMinor: 10000 }] });
    const voided = await call(`/sales/${cashSale.id}/void`, 'POST', { reason: 'Wrong item entered' });
    assert.deepEqual([voided.status, voided.cashRefundMinor], ['VOIDED', 10000]);
    const date = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
    const period = await call(`/reports/period?from=${date}&to=${date}`);
    assert.deepEqual([period.gross, period.cash, period.debt, period.settled], [10000, 3000, 7000, 2000]);
    const close = await call('/drawers/close', 'POST', { countedMinor: 10000 });
    assert.equal(close.varianceMinor, 0);
  } catch (error) {
    await new Promise(resolve => setTimeout(resolve, 20));
    throw new Error(`${stage}: ${error.message}\nServer: ${stderr}`);
  } finally {
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
