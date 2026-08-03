const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { replaceWalletFile } = require('../wallet-storage');

function keystore(marker) {
  return JSON.stringify({
    version: 3,
    id: `${marker}-id`,
    address: `${marker}-address`,
    crypto: {
      cipher: 'aes-128-ctr',
      ciphertext: `${marker}-ciphertext`,
      kdf: 'scrypt',
      mac: `${marker}-mac`,
    },
  });
}

test('replacement backs up the existing wallet before committing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ethii-wallet-storage-'));
  const walletFile = path.join(root, 'user-data', 'ethii-wallet.json');
  const backupRoot = path.join(root, 'backups');
  fs.mkdirSync(path.dirname(walletFile), { recursive: true });
  fs.writeFileSync(walletFile, keystore('old'));

  const result = replaceWalletFile(walletFile, keystore('new'), backupRoot, 'test-replace');

  assert.equal(fs.readFileSync(walletFile, 'utf8'), keystore('new'));
  assert.equal(fs.readFileSync(result.backupFile, 'utf8'), keystore('old'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('a failed commit restores the existing wallet', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ethii-wallet-storage-'));
  const walletFile = path.join(root, 'user-data', 'ethii-wallet.json');
  const backupRoot = path.join(root, 'backups');
  fs.mkdirSync(path.dirname(walletFile), { recursive: true });
  fs.writeFileSync(walletFile, keystore('old'));

  const originalRename = fs.renameSync;
  let renameCount = 0;
  fs.renameSync = (...args) => {
    renameCount += 1;
    if (renameCount === 2) throw new Error('simulated commit failure');
    return originalRename(...args);
  };
  try {
    assert.throws(
      () => replaceWalletFile(walletFile, keystore('new'), backupRoot, 'test-failure'),
      /simulated commit failure/,
    );
  } finally {
    fs.renameSync = originalRename;
  }

  assert.equal(fs.readFileSync(walletFile, 'utf8'), keystore('old'));
  fs.rmSync(root, { recursive: true, force: true });
});