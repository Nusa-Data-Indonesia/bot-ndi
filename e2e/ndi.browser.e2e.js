'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { loadEnv } = require('../src/config');
const { createPool } = require('../src/db');
const { runMigrations } = require('../src/migrate');
const { hashPassword } = require('../src/auth');

const ROOT = path.resolve(__dirname, '..');
const EMAIL = `ndi-browser-${randomUUID()}@example.test`;
const PASSWORD = 'Ndi Browser Password 2026!';

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer(child, url, readOutput) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Application server exited early: ${readOutput()}`);
    try {
      const response = await fetch(`${url}/health/ready`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch { /* Wait while migration and server startup finish. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Application server did not become ready: ${readOutput()}`);
}

async function assertAccessible(page, surface) {
  const results = await page.evaluate(async () => window.axe.run(document, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'] },
  }));
  assert.deepEqual(results.violations.map(({ id, impact, description, nodes }) => ({
    id, impact, description, nodes: nodes.map((node) => ({ target: node.target, summary: node.failureSummary })),
  })), [], `axe-core WCAG 2.2 AA violations on ${surface}`);
}

test('NDI dashboard readiness and unknown-publication review on disposable MySQL and local Chromium', async (t) => {
  const requestedConfig = loadEnv(process.env);
  assert.equal(process.env.NODE_ENV, 'test', 'Browser test requires NODE_ENV=test');
  assert.equal(process.env.ALLOW_DESTRUCTIVE_DB_TESTS, 'true', 'Browser test requires explicit test-database authorization');
  assert.equal(requestedConfig.db.database, 'bot_ndi_browser_test', 'Use the dedicated bot_ndi_browser_test database');
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(requestedConfig.db.host), 'Refusing a non-local database host');

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const appEnv = {
    ...process.env,
    NODE_ENV: 'test', PORT: String(port), BASE_URL: baseUrl,
    SCHEDULER_ENABLED: 'false', EXTERNAL_INTEGRATIONS_ENABLED: 'false',
    NODE_OPTIONS: `--require=${path.join(ROOT, 'test/deny-external-network.cjs')}`,
    DB_POOL_SIZE: '3', TEBAR_API_KEY: '', TEBAR_PROFILE_ID: '', TEBAR_ACCOUNT_ID: '',
    OPENROUTER_API_KEY: '', OPENROUTER_MODEL: '', TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '',
    LEARNING_CAPTURE_ENABLED: 'false', LEARNING_ACTIVATION_ENABLED: 'false',
    LEARNING_RETRIEVAL_ENABLED: 'false', LEARNING_PROMPT_INTEGRATION_ENABLED: 'false',
    LEARNING_SHADOW_ENABLED: 'false', LEARNING_RETENTION_ENABLED: 'false',
  };
  const pool = createPool(loadEnv(appEnv));
  let browser;
  let child;
  let serverOutput = '';
  let fixtureAdminId = null;
  let slotId = null;
  let stopApp;

  t.after(async () => {
    let teardownError = null;
    try { await browser?.close().catch(() => {}); } catch (error) { teardownError = error; }
    try { await stopApp?.(); } catch (error) { teardownError ||= error; }
    try {
      if (fixtureAdminId) {
        if (slotId) await pool.execute('DELETE FROM slots WHERE id=?', [slotId]);
        await pool.execute('DELETE FROM sessions WHERE admin_id=?', [fixtureAdminId]);
        await pool.execute('DELETE FROM audit_logs WHERE admin_id=?', [fixtureAdminId]);
        await pool.execute('DELETE FROM admins WHERE id=?', [fixtureAdminId]);
      }
    } catch (error) { teardownError ||= error; }
    try { await pool.end(); } catch (error) { teardownError ||= error; }
    if (teardownError) throw teardownError;
  });

  await runMigrations(pool);
  const [[adminCount]] = await pool.query('SELECT COUNT(*) AS n FROM admins');
  const [[slotCount]] = await pool.query('SELECT COUNT(*) AS n FROM slots');
  assert.equal(Number(adminCount.n), 0, 'Use a fresh isolated database; admins table must be empty');
  assert.equal(Number(slotCount.n), 0, 'Use a fresh isolated database; slots table must be empty');
  const [adminResult] = await pool.execute('INSERT INTO admins (email,password_hash) VALUES (?,?)', [EMAIL, await hashPassword(PASSWORD)]);
  fixtureAdminId = Number(adminResult.insertId);

  child = spawn(process.execPath, ['src/cli.js', 'server'], { cwd: ROOT, env: appEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8').on('data', (chunk) => { serverOutput = `${serverOutput}${chunk}`.slice(-12000); });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { serverOutput = `${serverOutput}${chunk}`.slice(-12000); });
  stopApp = async () => {
    const runningChild = child;
    if (!runningChild || runningChild.exitCode !== null) { child = null; return; }
    const exited = new Promise((resolve) => runningChild.once('exit', resolve));
    runningChild.kill('SIGTERM');
    let timer;
    const result = await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(() => resolve(null), 10_000); })]);
    clearTimeout(timer);
    if (result === null) { runningChild.kill('SIGKILL'); await exited; }
    child = null;
  };
  await waitForServer(child, baseUrl, () => serverOutput);

  const chromePath = [
    process.env.BOT_NDI_CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/chromium', '/usr/bin/google-chrome',
  ].find((candidate) => candidate && fs.existsSync(candidate));
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(chromePath ? { executablePath: chromePath } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route('**/*', async (route) => {
    const hostname = new URL(route.request().url()).hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '::1' || hostname === '127.0.0.1' || hostname.startsWith('127.')) {
      await route.fallback();
    } else {
      await route.abort('blockedbyclient');
    }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.setDefaultNavigationTimeout(8000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
  await page.route(`${baseUrl}/__test__/axe-core.js`, (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: axeSource }));
  await page.addScriptTag({ url: `${baseUrl}/__test__/axe-core.js` });

  await t.test('anonymous access is rejected and dashboard shows the Phase B publication gate', async () => {
    const anonymous = await context.request.get(`${baseUrl}/api/dashboard`);
    assert.equal(anonymous.status(), 401);
    await page.locator('#login-email').fill(EMAIL);
    await page.locator('#login-password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Masuk' }).click();
    await page.locator('#app-view:not([hidden])').waitFor();
    await page.locator('#automation-reason').getByText(/Tinjau dan aktifkan strategi/u).waitFor();
    assert.match(await page.locator('#automation-label').innerText(), /Otomasi nonaktif/u);
    assert.match(await page.locator('#automation-reason').innerText(), /kategori dan gaya diperiksa/u);
    assert.match(await page.locator('#onboarding-list').innerText(), /Strategi konten NDI disetujui/u);
    assert.match(await page.locator('#onboarding-list').innerText(), /Wajib · Belum selesai/u);
    const data = await (await page.request.get(`${baseUrl}/api/dashboard`)).json();
    assert.equal(data.automation.contentStrategyReady, false);
    assert.equal(data.onboarding.find((item) => item.key === 'contentStrategy')?.complete, false);
    const html = await page.locator('#app-view').innerText();
    assert.doesNotMatch(html, /Tautan top-up berpelacak|Game top-up yang disetujui|Tautan top-up dan jual akun|AI Learning/u);
    await assertAccessible(page, 'NDI dashboard');
  });

  await t.test('Reviewer accepts a manual Model ID only after mocked OpenRouter verification', async () => {
    const [[originalConfig]] = await pool.query('SELECT model,reviewer_model FROM integration_config WHERE id=1');
    await pool.execute("UPDATE integration_config SET model='test/generator',reviewer_model=NULL WHERE id=1");
    let validationRequests = 0;
    let validatedModel = null;
    await page.route('**/api/integrations/validate-reviewer-model', async (route) => {
      validationRequests++;
      validatedModel = route.request().postDataJSON()?.model || null;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        model: { id: validatedModel, name: 'Manual Reviewer Test Model', provider: 'test' },
      }) });
    });
    try {
      await page.getByRole('tab', { name: 'AI', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#ai-active-model')?.textContent === 'test/generator');
      await page.locator('#reviewer-model-manual-panel summary').click();
      const manualInput = page.locator('#reviewer-model-manual');
      await manualInput.fill('invalid-model-id');
      await page.locator('#reviewer-model-use-manual').click();
      await page.locator('#reviewer-model-validation').getByText(/Format Model ID tidak valid/u).waitFor();
      assert.equal(validationRequests, 0, 'malformed IDs are rejected locally before provider validation');
      assert.equal(await page.locator('#reviewer-model-verify').isDisabled(), true);
      assert.equal(await page.locator('#reviewer-model-form button[type="submit"]').isDisabled(), true);

      await manualInput.fill('custom/reviewer-model');
      await page.locator('#reviewer-model-use-manual').click();
      assert.equal(await page.locator('#reviewer-model-select').inputValue(), 'custom/reviewer-model');
      assert.equal(await page.locator('#reviewer-model-verify').isEnabled(), true);
      assert.equal(await page.locator('#reviewer-model-form button[type="submit"]').isDisabled(), true,
        'manual selection alone must not enable saving');

      await page.locator('#reviewer-model-verify').click();
      await page.waitForFunction(() => document.querySelector('#reviewer-model-validation')?.dataset.validationStatus === 'AVAILABLE');
      assert.equal(validationRequests, 1);
      assert.equal(validatedModel, 'custom/reviewer-model');
      assert.equal(await page.locator('#reviewer-model-form button[type="submit"]').isEnabled(), true,
        'saving becomes available only after backend metadata verification');
      await assertAccessible(page, 'manual Reviewer model selection and verification');
    } finally {
      await page.unroute('**/api/integrations/validate-reviewer-model');
      await pool.execute('UPDATE integration_config SET model=?,reviewer_model=? WHERE id=1', [originalConfig.model, originalConfig.reviewer_model]);
    }
  });

  await t.test('website synchronization is click-only and renders website text as inert content', async () => {
    let reads = 0;
    let syncPosts = 0;
    const hostileText = '<img src=x onerror=window.__websiteInjected=true>';
    await page.route('**/api/website-sync', async (route) => {
      if (route.request().method() === 'POST') {
        syncPosts++;
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ proposalCount: 1 }) });
      }
      reads++;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        knowledgeVersion: 1,
        runs: [],
        proposals: [{ id: '77', syncRunId: 'test-run', knowledgeVersion: 1, field: 'services', operation: 'add', targetValue: hostileText,
          baseValue: null, sourceUrl: 'https://nusadataindonesia.com/', sourceTitle: '<script>window.__websiteInjected=true</script>',
          fetchedAt: new Date().toISOString(), status: 'pending' }],
      }) });
    });
    await page.getByRole('tab', { name: 'Konten & brand' }).click();
    await page.locator('#website-sync-button').waitFor();
    assert.equal(syncPosts, 0, 'opening the tab only reads existing proposals and does not fetch the website');
    assert.equal(reads, 1);
    const proposal = page.locator('#website-sync-proposals article');
    await proposal.waitFor();
    assert.equal(await proposal.locator('img,script').count(), 0, 'untrusted HTML is shown only as text');
    assert.ok((await proposal.innerText()).includes(hostileText));
    assert.equal(await page.evaluate(() => window.__websiteInjected), undefined);
    await page.getByRole('button', { name: 'Sinkronkan Website NDI' }).click();
    await page.locator('#website-sync-proposals article').waitFor();
    assert.equal(syncPosts, 1, 'one explicit admin button click makes exactly one API request');
    assert.equal(await page.evaluate(() => window.__websiteInjected), undefined);
    await assertAccessible(page, 'manual website sync review');
    await page.unroute('**/api/website-sync');
  });

  await t.test('unknown publication displays reason, timestamps, original account and safe recovery', async () => {
    slotId = randomUUID();
    const profileId = `browser-profile-${randomUUID()}`;
    const accountId = `browser-account-${randomUUID()}`;
    const caption = 'Informasi publikasi lama sedang ditinjau pada akun asal.';
    await pool.execute(
      "INSERT INTO slots (id,scheduled_at,status,provider_status,provider_post_id,caption,request_payload,idempotency_key,tebar_profile_id,tebar_account_id,error_code,publish_started_at) VALUES (?,UTC_TIMESTAMP(3),'unknown','unknown',NULL,?,?,?,?,?,'network_error',UTC_TIMESTAMP(3))",
      [slotId, caption, JSON.stringify({ content: caption, targets: [{ account_id: accountId }] }), `browser-key-${slotId}`, profileId, accountId],
    );
    await page.getByRole('tab', { name: 'Integrasi' }).click();
    const card = page.locator('#publication-blockers article.publication-card').filter({ hasText: slotId });
    await card.waitFor();
    const cardText = await card.innerText();
    for (const evidence of ['Waktu percobaan', 'Waktu terjadwal', 'Status slot', 'Status Tebar', 'Kode error', profileId, accountId, caption]) {
      assert.ok(cardText.includes(evidence), `unknown card must show ${evidence}`);
    }
    const action = card.getByRole('button', { name: /Tutup sebagai tidak terverifikasi/u });
    await action.click();
    const dialog = page.getByRole('dialog', { name: /Tutup sebagai tidak terverifikasi/u });
    await dialog.waitFor({ state: 'visible' });
    assert.match(await dialog.innerText(), /Tebar dan Threads pada akun asal diperiksa/u);
    assert.match(await dialog.innerText(), /tanpa mengirim ulang/u);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    const [[saved]] = await pool.execute('SELECT status,provider_post_id,tebar_profile_id,tebar_account_id FROM slots WHERE id=?', [slotId]);
    assert.deepEqual([saved.status, saved.provider_post_id, saved.tebar_profile_id, saved.tebar_account_id], ['unknown', null, profileId, accountId]);
    await assertAccessible(page, 'publication unknown review');
  });

  assert.deepEqual(pageErrors, [], 'the dashboard must not emit browser runtime errors');
});
