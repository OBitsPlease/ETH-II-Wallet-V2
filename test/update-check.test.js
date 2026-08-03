const assert = require('node:assert/strict');
const test = require('node:test');
const { compareVersions, normalizeVersion, selectLatestRelease } = require('../update-check');

test('compares normalized wallet versions', () => {
  assert.equal(normalizeVersion('wallet-v2.1.20'), '2.1.20');
  assert.equal(compareVersions('2.1.20', 'v2.1.19'), 1);
  assert.equal(compareVersions('v2.1.20', '2.1.20'), 0);
  assert.equal(compareVersions('2.1.9', '2.1.20'), -1);
});

test('selects the highest official stable release', () => {
  const release = selectLatestRelease([
    { tag_name: 'v2.1.19', html_url: 'https://github.com/OBitsPlease/ETH-II-Wallet-V2/releases/tag/v2.1.19' },
    { tag_name: 'v9.0.0', prerelease: true, html_url: 'https://github.com/OBitsPlease/ETH-II-Wallet-V2/releases/tag/v9.0.0' },
    { tag_name: 'v2.1.21', html_url: 'https://github.com/OBitsPlease/ETH-II-Wallet-V2/releases/tag/v2.1.21' },
    { tag_name: 'v8.0.0', html_url: 'https://example.com/releases/tag/v8.0.0' },
    { tag_name: 'latest', html_url: 'https://github.com/OBitsPlease/ETH-II-Wallet-V2/releases/tag/latest' },
  ]);
  assert.equal(release.tag_name, 'v2.1.21');
});

test('rejects drafts and malformed release responses', () => {
  assert.equal(selectLatestRelease(null), null);
  assert.equal(selectLatestRelease([
    { tag_name: 'v2.1.21', draft: true, html_url: 'https://github.com/OBitsPlease/ETH-II-Wallet-V2/releases/tag/v2.1.21' },
  ]), null);
});