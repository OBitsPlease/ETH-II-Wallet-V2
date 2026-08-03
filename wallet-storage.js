const fs = require('fs');
const path = require('path');

function parseKeystore(json) {
  const parsed = JSON.parse(json);
  const crypto = parsed.Crypto || parsed.crypto;
  if (
    parsed.version !== 3 ||
    !crypto ||
    typeof crypto.cipher !== 'string' ||
    typeof crypto.ciphertext !== 'string' ||
    typeof crypto.kdf !== 'string' ||
    typeof crypto.mac !== 'string'
  ) {
    throw new Error('Invalid encrypted wallet format.');
  }
  return parsed;
}

function safeStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function backupExistingWallet(walletFile, backupRoot, reason) {
  if (!fs.existsSync(walletFile)) return null;

  const source = fs.readFileSync(walletFile);
  parseKeystore(source.toString('utf8'));

  const backupDir = path.join(backupRoot, `${safeStamp()}-${reason}`);
  const backupFile = path.join(backupDir, 'ethii-wallet.json');
  fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(walletFile, backupFile, fs.constants.COPYFILE_EXCL);

  const copied = fs.readFileSync(backupFile);
  if (!source.equals(copied)) {
    throw new Error('Wallet backup verification failed. Existing wallet was not changed.');
  }
  try { fs.chmodSync(backupFile, 0o600); } catch { /* Windows ACLs are inherited. */ }

  const note = [
    `created=${new Date().toISOString()}`,
    `reason=${reason}`,
    `source=${walletFile}`,
  ].join('\n');
  fs.writeFileSync(path.join(backupDir, 'BACKUP-INFO.txt'), note, { encoding: 'utf8', mode: 0o600 });
  return backupFile;
}

function replaceWalletFile(walletFile, encryptedJson, backupRoot, reason) {
  parseKeystore(encryptedJson);
  fs.mkdirSync(path.dirname(walletFile), { recursive: true });

  const backupFile = backupExistingWallet(walletFile, backupRoot, reason);
  const suffix = `${process.pid}-${Date.now()}`;
  const temporaryFile = `${walletFile}.new-${suffix}`;
  const rollbackFile = `${walletFile}.rollback-${suffix}`;
  let movedExisting = false;

  try {
    const fd = fs.openSync(temporaryFile, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, encryptedJson, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    if (fs.existsSync(walletFile)) {
      fs.renameSync(walletFile, rollbackFile);
      movedExisting = true;
    }
    fs.renameSync(temporaryFile, walletFile);
    try { fs.chmodSync(walletFile, 0o600); } catch { /* Windows ACLs are inherited. */ }
    if (movedExisting) fs.unlinkSync(rollbackFile);
    return { backupFile };
  } catch (error) {
    try { if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile); } catch { /* Best effort cleanup. */ }
    if (movedExisting && fs.existsSync(rollbackFile) && !fs.existsSync(walletFile)) {
      fs.renameSync(rollbackFile, walletFile);
    }
    throw error;
  }
}

module.exports = { backupExistingWallet, parseKeystore, replaceWalletFile };