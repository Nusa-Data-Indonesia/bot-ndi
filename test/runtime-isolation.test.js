const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('runtime Compose names and data volume are isolated for Bot NDI', () => {
  const compose = fs.readFileSync(path.join(root, 'compose.yaml'), 'utf8');
  assert.match(compose, /^name: bot-ndi$/m);
  assert.match(compose, /name: bot-ndi_mysql_data/);
  assert.match(compose, /MYSQL_DATABASE: \$\{DB_NAME:\?/);
  assert.match(compose, /MYSQL_USER: \$\{DB_USER:\?/);
  assert.match(compose, /ports:\n\s+- "\$\{HOST_IP:\?/);
  assert.doesNotMatch(compose, /BOTMERZZ|botmerzz|merzz_mysql_data/i);
  assert.doesNotMatch(compose, /(^|\n)\s+ports:\s*\[?\s*["']?3306:/);
});

test('fresh runtime template is secret-free and integrations start disabled', () => {
  const template = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  const values = Object.fromEntries(template.split(/\r?\n/)
    .filter((line) => /^[A-Z0-9_]+=/.test(line))
    .map((line) => {
      const split = line.indexOf('=');
      return [line.slice(0, split), line.slice(split + 1)];
    }));

  assert.equal(values.HOST_IP, '');
  assert.equal(values.BASE_URL, 'https://botndi.sequein.my.id');
  assert.equal(values.DB_NAME, 'bot_ndi');
  assert.equal(values.DB_USER, 'bot_ndi_app');
  assert.equal(values.DB_PASSWORD, '');
  assert.equal(values.DB_ROOT_PASSWORD, '');
  assert.equal(values.SCHEDULER_ENABLED, 'false');
  assert.equal(values.TEBAR_API_KEY, '');
  assert.equal(values.OPENROUTER_API_KEY, '');
  assert.equal(values.TELEGRAM_BOT_TOKEN, '');
  assert.doesNotMatch(template, /BOTMERZZ|botmerzz|merzz\.sequein/i);
});
