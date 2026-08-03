const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { Wallet } = require('ethers');
const { replaceWalletFile } = require('../wallet-storage');

test('active and backed-up keystores retain their original passwords and addresses', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ethii-keystore-recovery-'));
  const walletFile = path.join(root, 'user-data', 'ethii-wallet.json');
  const backupRoot = path.join(root, 'backups');
  const oldWallet = Wallet.createRandom();
  const newWallet = Wallet.createRandom();
  const oldPassword = 'Disposable-Old-Password-42';
  const newPassword = 'Disposable-New-Password-84';
  fs.mkdirSync(path.dirname(walletFile), { recursive: true });
  fs.writeFileSync(walletFile, await oldWallet.encrypt(oldPassword));

  const result = replaceWalletFile(
    walletFile,
    await newWallet.encrypt(newPassword),
    backupRoot,
    'recovery-test',
  );

  const active = await Wallet.fromEncryptedJson(fs.readFileSync(walletFile, 'utf8'), newPassword);
  const backup = await Wallet.fromEncryptedJson(fs.readFileSync(result.backupFile, 'utf8'), oldPassword);
  assert.equal(active.address, newWallet.address);
  assert.equal(backup.address, oldWallet.address);
  await assert.rejects(Wallet.fromEncryptedJson(fs.readFileSync(walletFile, 'utf8'), oldPassword));
  fs.rmSync(root, { recursive: true, force: true });
});

test('malformed existing wallet data is preserved and blocks replacement', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ethii-keystore-recovery-'));
  const walletFile = path.join(root, 'user-data', 'ethii-wallet.json');
  const backupRoot = path.join(root, 'backups');
  const original = 'existing data requiring manual recovery';
  fs.mkdirSync(path.dirname(walletFile), { recursive: true });
  fs.writeFileSync(walletFile, original);
  const replacement = await Wallet.createRandom().encrypt('Disposable-Replacement-Password-21');

  assert.throws(
    () => replaceWalletFile(walletFile, replacement, backupRoot, 'malformed-test'),
    /Unexpected token|JSON/,
  );
  assert.equal(fs.readFileSync(walletFile, 'utf8'), original);
  fs.rmSync(root, { recursive: true, force: true });
});