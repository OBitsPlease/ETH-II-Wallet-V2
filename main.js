const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
const { ethers } = require('ethers');

// Crash/close log — defined first so all handlers can use it
const LOG_FILE = path.join(require('os').tmpdir(), 'ethii-wallet-crash.log');
process.on('uncaughtException', (err) => {
  fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] uncaughtException: ${err.stack}\n`);
});
process.on('unhandledRejection', (reason) => {
  fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] unhandledRejection: ${reason}\n`);
});

// Prevent duplicate wallet windows — if another instance is already running,
// focus it and exit this new one immediately.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] QUIT: requestSingleInstanceLock returned false — another instance is running\n`);
  app.quit();
}

let WALLET_FILE; // initialized after app is ready
let RPC_PORT = 8545; // default, may be updated by port scan
let RPC_URL = 'http://127.0.0.1:8545';
const PRIMARY_RPC_URL = 'http://87.99.142.128:8545'; // USA VPS (canonical)
const SECONDARY_RPC_URL = 'http://91.99.231.217:8545'; // EU VPS fallback
const PUBLIC_RPC_URL = 'https://ethii.net/rpc'; // public fallback
const READ_RPC_URL = PRIMARY_RPC_URL; // canonical chain source for wallet reads/tx
const READ_RPC_CANDIDATES = [READ_RPC_URL, SECONDARY_RPC_URL, PUBLIC_RPC_URL];
const RELEASES_API_URL = 'https://api.github.com/repos/OBitsPlease/ETH-II-Wallet-V2/releases';
const HTTP_HEADERS = { 'User-Agent': 'ETHII-Wallet-Updater' };
const CHAIN_ID = 2048;
const BOOTNODE_ENODES = [
  'enode://05f7f1c669368d16829699b6e1ddffbd8a3fee08a1301cac33922ad05f56fd53aadbca02f326d6b1c863c560c9adf30a75b44d45e7448ebb41d9c47235204fdf@87.99.142.128:30303',
  'enode://b096bfae7d5e9a7cc985e68726280b75b0a0ef80ce419db5ed5152e9bee7bf83d35ae8b13b34879a0bf36d73a9a674bb61b02f3777745ed770e3150a39c7de5b@91.99.231.217:30303',
];
const AUTO_NUDGE_INTERVAL_MS = 20000;
const AUTO_NUDGE_LAG_THRESHOLD = 2;
const LOCAL_FAILOVER_LAG = 8;
const LOCAL_FAILOVER_NOPEER_LAG = 3;

let mainWindow;
let provider;
let lastAutoNudgeAt = 0;

function normalizeVersion(v) {
  return String(v || '').replace(/^wallet-v/, '').replace(/^v/, '').trim();
}

function compareVersions(a, b) {
  const pa = normalizeVersion(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = normalizeVersion(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const av = pa[i] || 0;
    const bv = pb[i] || 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

async function backupWalletBeforeUpdate() {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(app.getPath('userData'), 'update-backups', `pre-update-${stamp}`);
    fs.mkdirSync(backupDir, { recursive: true });

    if (WALLET_FILE && fs.existsSync(WALLET_FILE)) {
      fs.copyFileSync(WALLET_FILE, path.join(backupDir, 'ethii-wallet.json'));
    }

    const note = [
      `created=${new Date().toISOString()}`,
      `appVersion=${app.getVersion()}`,
      'type=wallet pre-update backup',
    ].join('\n');
    fs.writeFileSync(path.join(backupDir, 'BACKUP-INFO.txt'), note, 'utf8');
  } catch (e) {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] backup-before-update-failed: ${e.message}\n`);
  }
}

async function checkForWalletUpdate() {
  if (process.platform !== 'win32') return;
  try {
    const res = await fetch(RELEASES_API_URL, { headers: HTTP_HEADERS, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return;
    const releases = await res.json();
    const walletReleases = (Array.isArray(releases) ? releases : [])
      .filter((r) => r && r.tag_name && /^v\d+\.\d+\.\d+$/.test(r.tag_name) && !r.draft && !r.prerelease)
      .sort((a, b) => new Date(b.published_at || 0) - new Date(a.published_at || 0));
    const latest = walletReleases[0];
    if (!latest) return;

    const currentVersion = app.getVersion();
    const latestVersion = normalizeVersion(latest.tag_name);
    if (compareVersions(currentVersion, latestVersion) >= 0) return;

    const installer = (latest.assets || []).find((a) => /\.exe$/i.test(a.name || ''));
    if (!installer || !installer.browser_download_url) return;

    const prompt = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Update now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Wallet Update Available',
      message: `A new wallet version is available (v${latestVersion}).`,
      detail: 'Before updating, verify you have your wallet password and seed phrase backed up. A dated backup will be created automatically before install.',
    });
    if (prompt.response !== 0) return;

    await backupWalletBeforeUpdate();

    const tmpExe = path.join(require('os').tmpdir(), `ethii-wallet-update-${latestVersion}.exe`);
    const download = await fetch(installer.browser_download_url, { headers: HTTP_HEADERS, signal: AbortSignal.timeout(300000) });
    if (!download.ok) throw new Error(`download failed: ${download.status}`);
    const bytes = Buffer.from(await download.arrayBuffer());
    fs.writeFileSync(tmpExe, bytes);

    spawn(tmpExe, ['/S'], { detached: true, stdio: 'ignore' }).unref();
    app.quit();
  } catch (e) {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] wallet-update-check-failed: ${e.message}\n`);
  }
}

// Check if a port is in use
function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(true));
    server.once('listening', () => { server.close(); resolve(false); });
    server.listen(port, '127.0.0.1');
  });
}

// Find the port where the ETHII node is listening.
// Reads rpc-port.txt written by launch-node.ps1 (which knows the exact port).
// Falls back to scanning if the file isn't present (e.g. node started manually).
async function findNodePort(base = 8545) {
  const portFile = path.join(__dirname, 'rpc-port.txt');
  if (fs.existsSync(portFile)) {
    const p = parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10);
    if (!isNaN(p) && p > 0) return p;
  }
  // Fallback: scan for the first port in use
  for (let p = base; p < base + 20; p++) {
    if (await isPortInUse(p)) return p;
  }
  return base;
}

// Write the correct VPS bootnode into static-nodes.json and config.toml so the
// local ethii node always has a peer to sync from, even on a fresh install.
// Tries both <datadir> candidates: one level up from wallet (dev layout) and
// the wallet dir itself (in case the user put data/ alongside the wallet.exe).
function ensureBootstrapFiles() {
  const candidates = [
    path.join(__dirname, '..', 'data', 'geth'),
    path.join(__dirname, 'data', 'geth'),
  ];
  for (const gethDir of candidates) {
    try {
      if (!fs.existsSync(gethDir)) continue; // only write if the dir exists (node has been init'd)
      // static-nodes.json — read by older geth/ethii builds
      const staticNodesPath = path.join(gethDir, 'static-nodes.json');
      fs.writeFileSync(staticNodesPath, JSON.stringify(BOOTNODE_ENODES, null, 2), 'utf8');
      // config.toml — read by newer geth/ethii builds (takes precedence over static-nodes.json)
      const configTomlPath = path.join(gethDir, 'config.toml');
      const tomlNodes = BOOTNODE_ENODES.map((enode) => `  "${enode}"`).join(',\n');
      const configToml = `[Node.P2P]\nStaticNodes = [\n${tomlNodes}\n]\n`;
      // Only write config.toml if it doesn't exist or doesn't already contain the correct enode.
      // Avoids overwriting custom user config that may have additional settings.
      const existing = fs.existsSync(configTomlPath) ? fs.readFileSync(configTomlPath, 'utf8') : '';
      const hasAllBootnodes = BOOTNODE_ENODES.every((enode) => existing.includes(enode));
      if (!hasAllBootnodes) {
        fs.writeFileSync(configTomlPath, configToml, 'utf8');
      }
    } catch (e) {
      fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ensureBootstrapFiles(${gethDir}): ${e.message}\n`);
    }
  }
}

function createWindow() {

  mainWindow = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#000000',
    titleBarStyle: 'hidden',
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: fs.existsSync(path.join(__dirname, 'assets', 'icon.png')) ? path.join(__dirname, 'assets', 'icon.png') : undefined,
  });
  mainWindow.loadFile('renderer/index.html');
  // Log renderer crashes
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] renderer-crash: ${JSON.stringify(details)}\n`);
  });
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    if (level >= 3) { // errors only
      fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] renderer-console[${level}]: ${message} (${sourceId}:${line})\n`);
    }
  });
  mainWindow.on('close', () => {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] mainWindow close event fired\n`);
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function focusOrCreateMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    return;
  }
  if (app.isReady()) {
    createWindow();
  }
}

app.on('second-instance', () => {
  // If an orphan process holds the lock without a window, recreate it.
  focusOrCreateMainWindow();
});

app.whenReady().then(async () => {
  WALLET_FILE = path.join(app.getPath('userData'), 'ethii-wallet.json');
  // Find the port where the ETHII node RPC is listening (default 8545)
  RPC_PORT = await findNodePort(8545);
  RPC_URL = `http://127.0.0.1:${RPC_PORT}`;
  // Ensure the VPS peer is configured in the data directory so the node
  // always connects to the chain on first launch (or after a reinstall).
  ensureBootstrapFiles();
  createWindow();
  tryConnectProvider();
  setTimeout(() => {
    checkForWalletUpdate().catch(() => {});
  }, 4000);
  // Fire an immediate sync nudge shortly after startup so the local node
  // connects to the VPS peer right away rather than waiting for the UI timer.
  setTimeout(() => {
    performSyncNudge({ force: true, reason: 'startup' }).catch(() => {});
  }, 6000);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) focusOrCreateMainWindow();
  });
});

app.on('will-quit', () => {
  fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] will-quit event fired\n`);
});

app.on('window-all-closed', () => {
  fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] window-all-closed event fired\n`);
  if (process.platform !== 'darwin') app.quit();
});

// Try to connect to the local ETHII node
function tryConnectProvider() {
  try {
    const network = ethers.Network.from({ chainId: CHAIN_ID, name: 'ethii' });
    provider = new ethers.JsonRpcProvider(READ_RPC_URL, network, { staticNetwork: network });
  } catch (e) {
    provider = null;
  }
}

// Probe each candidate RPC URL and return the first reachable provider.
async function resolveWorkingProvider() {
  const urls = [...new Set([...READ_RPC_CANDIDATES, RPC_URL])];
  const network = ethers.Network.from({ chainId: CHAIN_ID, name: 'ethii' });
  let lastErr;
  for (const url of urls) {
    try {
      const p = new ethers.JsonRpcProvider(url, network, { staticNetwork: network });
      await p.send('eth_chainId', []);
      return p;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('No RPC endpoint reachable');
}

// Window controls
ipcMain.on('window-minimize', () => mainWindow.minimize());
ipcMain.on('window-maximize', () => {
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('window-close', () => {
  fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] window-close IPC received\n`);
  mainWindow.close();
});

// Create new wallet
ipcMain.handle('wallet-create', async () => {
  const wallet = ethers.Wallet.createRandom();
  return { address: wallet.address, privateKey: wallet.privateKey, mnemonic: wallet.mnemonic?.phrase };
});

// Save encrypted wallet to disk
ipcMain.handle('wallet-save', async (_, { privateKey, password }) => {
  try {
    fs.mkdirSync(path.dirname(WALLET_FILE), { recursive: true });
    const wallet = new ethers.Wallet(privateKey);
    const encrypted = await wallet.encrypt(password);
    fs.writeFileSync(WALLET_FILE, encrypted, 'utf8');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Load wallet file exists check
ipcMain.handle('wallet-exists', async () => {
  return fs.existsSync(WALLET_FILE);
});

// Unlock saved wallet
ipcMain.handle('wallet-unlock', async (_, { password }) => {
  try {
    const json = fs.readFileSync(WALLET_FILE, 'utf8');
    const wallet = await ethers.Wallet.fromEncryptedJson(json, password);
    return { success: true, address: wallet.address, privateKey: wallet.privateKey };
  } catch (e) {
    return { success: false, error: 'Invalid password or corrupted wallet file.' };
  }
});

// Import wallet from private key
ipcMain.handle('wallet-import', async (_, { privateKey, password }) => {
  try {
    const wallet = new ethers.Wallet(privateKey);
    const encrypted = await wallet.encrypt(password);
    fs.writeFileSync(WALLET_FILE, encrypted, 'utf8');
    return { success: true, address: wallet.address };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Get balance — uses direct RPC fetch for reliability (ethers.js provider may be warming up)
ipcMain.handle('get-balance', async (_, { address }) => {
  try {
    if (!address) throw new Error('No address');
    const result = await rpcCallRead('eth_getBalance', [address, 'latest']);
    if (!result || result === '0x') throw new Error('Empty RPC result');
    const balanceBN = BigInt(result);
    const balanceEth = Number(balanceBN) / 1e18;
    if (!isFinite(balanceEth)) throw new Error('Non-finite balance');
    return { success: true, balance: balanceEth.toFixed(4) };
  } catch (e) {
    return { success: false, error: 'RPC unavailable. Start a local node or check VPS connectivity.' };
  }
});

// Send transaction
ipcMain.handle('send-tx', async (_, { privateKey, to, amount, gasPrice }) => {
  try {
    const p = await resolveWorkingProvider();
    const wallet = new ethers.Wallet(privateKey, p);
    const tx = await wallet.sendTransaction({
      to,
      value: ethers.parseEther(amount),
      gasPrice: ethers.parseUnits(gasPrice || '0.5', 'gwei'),
      chainId: CHAIN_ID,
    });
    // Return immediately after broadcast so UI doesn't look stuck on "Signing".
    return { success: true, hash: tx.hash, status: 'broadcast' };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Get transaction history for an address by scanning chain blocks.
ipcMain.handle('get-tx-history', async (_, { address, limit = 200 }) => {
  try {
    if (!address) throw new Error('No address provided');

    const needle = String(address).toLowerCase();
    const latestHex = await rpcCallRead('eth_blockNumber', []);
    let blockNum = parseInt(latestHex, 16);
    if (!Number.isFinite(blockNum) || blockNum < 0) {
      throw new Error('Unable to read latest block');
    }

    const txs = [];
    for (let n = blockNum; n >= 0; n -= 1) {
      if (txs.length >= limit) break;
      const blockHex = '0x' + n.toString(16);
      const block = await rpcCallRead('eth_getBlockByNumber', [blockHex, true]);
      if (!block || !Array.isArray(block.transactions)) continue;

      for (const tx of block.transactions) {
        const from = String(tx.from || '').toLowerCase();
        const to = tx.to ? String(tx.to).toLowerCase() : '';
        if (from !== needle && to !== needle) continue;

        const direction = to === needle ? 'in' : 'out';
        txs.push({
          hash: tx.hash,
          blockNumber: parseInt(tx.blockNumber || blockHex, 16),
          timestamp: parseInt(block.timestamp || '0x0', 16),
          from: tx.from || '',
          to: tx.to || '',
          value: ethers.formatEther(tx.value || '0x0'),
          direction,
        });

        if (txs.length >= limit) break;
      }
    }

    return { success: true, txs };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Get node status — uses direct RPC fetch for reliability
ipcMain.handle('get-node-status', async () => {
  try {
    const status = await fetchNodeSyncStatus();
    const localLag = Number.isFinite(status.syncLag) ? status.syncLag : null;
    const localPeers = Number.isFinite(status.localPeers) ? status.localPeers : 0;
    const useVps =
      (localLag !== null && localLag >= LOCAL_FAILOVER_LAG) ||
      (localLag !== null && localLag >= LOCAL_FAILOVER_NOPEER_LAG && localPeers === 0);
    const source = useVps ? 'vps' : 'local';

    return {
      success: true,
      source,
      blockNumber: source === 'vps' && Number.isFinite(status.networkBlockNum) ? status.networkBlockNum : status.localBlockNum,
      localBlockNumber: status.localBlockNum,
      networkBlockNumber: status.networkBlockNum,
      networkPeers: Number.isFinite(status.networkPeers) ? status.networkPeers : null,
      peers: Number.isFinite(status.localPeers) ? status.localPeers : 0,
      syncLag: status.syncLag,
      timestamp: source === 'vps' && status.networkLatestBlock ? parseInt(status.networkLatestBlock.timestamp, 16) : (status.localBlock ? parseInt(status.localBlock.timestamp, 16) : null),
      gasLimit: source === 'vps' && status.networkLatestBlock ? parseInt(status.networkLatestBlock.gasLimit, 16).toString() : (status.localBlock ? parseInt(status.localBlock.gasLimit, 16).toString() : null),
      rpcPort: RPC_PORT,
    };
  } catch (e) {
    // Wallet-only mode: if local RPC is down, fall back to VPS read RPC.
    try {
      const [networkBlockHex, networkPeersHex, networkLatestBlock] = await Promise.all([
        rpcCallRead('eth_blockNumber', []),
        rpcCallRead('net_peerCount', []),
        rpcCallRead('eth_getBlockByNumber', ['latest', false]),
      ]);

      const networkBlockNum = parseInt(networkBlockHex, 16);
      const networkPeers = parseInt(networkPeersHex, 16);

      return {
        success: true,
        source: 'vps',
        blockNumber: networkBlockNum,
        localBlockNumber: null,
        networkBlockNumber: networkBlockNum,
        networkPeers: Number.isFinite(networkPeers) ? networkPeers : null,
        peers: 0,
        syncLag: 0,
        timestamp: networkLatestBlock ? parseInt(networkLatestBlock.timestamp, 16) : null,
        gasLimit: networkLatestBlock ? parseInt(networkLatestBlock.gasLimit, 16).toString() : null,
        rpcPort: 'vps',
      };
    } catch {
      return { success: false, error: 'Node and VPS RPC offline', rpcPort: RPC_PORT };
    }
  }
});

async function performSyncNudge({ force = false, lag = null, reason = 'wallet-auto' } = {}) {
  const now = Date.now();
  if (!force && now - lastAutoNudgeAt < AUTO_NUDGE_INTERVAL_MS) {
    return { success: true, nudged: false, reason: 'cooldown' };
  }
  if (!force && Number.isFinite(lag) && lag < AUTO_NUDGE_LAG_THRESHOLD) {
    return { success: true, nudged: false, reason: 'lag-below-threshold' };
  }

  try {
    // Keep the VPS peer sticky in case local discovery drifts to stale peers.
    for (const bootnode of BOOTNODE_ENODES) {
      await rpcCallLocal('admin_addPeer', [bootnode]);
    }
  } catch {
    // Ignore peer-add failures when admin API is unavailable (manual node launch).
  }

  try {
    const [localBlockHex, remoteBlockHex] = await Promise.all([
      rpcCallLocal('eth_blockNumber', []),
      rpcCallRead('eth_blockNumber', []),
    ]);
    const localBlock = parseInt(localBlockHex, 16);
    const remoteBlock = parseInt(remoteBlockHex, 16);

    lastAutoNudgeAt = now;
    return {
      success: true,
      nudged: true,
      localBlock: Number.isFinite(localBlock) ? localBlock : null,
      networkBlock: Number.isFinite(remoteBlock) ? remoteBlock : null,
      reason,
    };
  } catch (e) {
    return { success: false, nudged: false, error: e.message, reason };
  }
}

ipcMain.handle('auto-sync-nudge', async (_, payload) => {
  const input = payload || {};
  return performSyncNudge({
    force: !!input.force,
    lag: Number.isFinite(input.lag) ? input.lag : null,
    reason: input.reason || 'wallet-auto',
  });
});

async function fetchNodeSyncStatus() {
  const [localBlockHex, localPeersHex] = await Promise.all([
    rpcCallLocal('eth_blockNumber', []),
    rpcCallLocal('net_peerCount', []),
  ]);

  const localBlockNum = parseInt(localBlockHex, 16);
  const localPeers = parseInt(localPeersHex, 16);
  const localBlock = await rpcCallLocal('eth_getBlockByNumber', ['latest', false]);

  let networkBlockNum = null;
  let networkPeers = null;
  let networkLatestBlock = null;
  try {
    const [networkBlockHex, networkPeersHex, latestBlock] = await Promise.all([
      rpcCallRead('eth_blockNumber', []),
      rpcCallRead('net_peerCount', []),
      rpcCallRead('eth_getBlockByNumber', ['latest', false]),
    ]);
    networkBlockNum = parseInt(networkBlockHex, 16);
    networkPeers = parseInt(networkPeersHex, 16);
    networkLatestBlock = latestBlock;
  } catch {
    networkBlockNum = null;
    networkPeers = null;
    networkLatestBlock = null;
  }

  const syncLag = (Number.isFinite(networkBlockNum) && Number.isFinite(localBlockNum))
    ? Math.max(0, networkBlockNum - localBlockNum)
    : null;

  // source is always 'local' here — local RPC is reachable.
  // The 'vps' source is only set in the get-node-status catch block when local RPC is completely offline.
  return {
    source: 'local',
    localBlockNum,
    localPeers,
    localBlock,
    networkBlockNum,
    networkPeers,
    networkLatestBlock,
    syncLag,
  };
}


// Wallet read RPC helper - public canonical first, local fallback.
async function rpcCallRead(method, params = []) {
  const urls = [...new Set([...READ_RPC_CANDIDATES, RPC_URL])];
  let lastErr;
  for (const url of urls) {
    try {
      return await rpcCallOnUrl(url, method, params);
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// Local-only RPC helper for node control and mining controls.
async function rpcCallLocal(method, params = []) {
  return rpcCallOnUrl(RPC_URL, method, params);
}

async function rpcCallOnUrl(url, method, params = []) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  let json;
  try { json = await resp.json(); }
  catch (parseErr) {
    const raw = await resp.text().catch(() => '(unreadable)');
    throw new Error(`Invalid JSON from node (${method}): ${raw.slice(0, 120)}`);
  }
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

// Graceful shutdown: stop the local node via RPC, then quit the wallet.
// This prevents Pebble/freezer DB corruption from abrupt process kills.
ipcMain.handle('graceful-shutdown', async () => {
  // 1. Ask the node to stop via admin_stopNode (best-effort; may fail if node is already down).
  try {
    await rpcCallLocal('admin_stopNode', []);
    // Give the node ~3s to flush and exit cleanly before we quit.
    await new Promise((resolve) => setTimeout(resolve, 3000));
  } catch {
    // Node already offline or no admin API — that's fine, proceed.
  }

  // 2. Kill the stratum proxy if it's running (Windows only).
  if (process.platform === 'win32') {
    try {
      const { execSync } = require('child_process');
      execSync('tasklist /FI "IMAGENAME eq stratum.exe" /NH /FO CSV', { timeout: 3000 })
        .toString()
        .split('\n')
        .forEach((line) => {
          const parts = line.split(',');
          if (parts.length >= 2) {
            const pid = parseInt(parts[1].replace(/"/g, '').trim(), 10);
            if (Number.isFinite(pid) && pid > 0) {
              try { execSync(`taskkill /PID ${pid} /F`, { timeout: 3000 }); } catch { /* ignore */ }
            }
          }
        });
    } catch { /* stratum not running — ignore */ }
  }

  // 3. Quit the Electron wallet app.
  app.quit();
});

// Return wallet app version
ipcMain.handle('get-version', () => app.getVersion());

// Export keystore dialog
ipcMain.handle('export-keystore', async () => {
  if (!fs.existsSync(WALLET_FILE)) return { success: false, error: 'No wallet found.' };
  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: 'ethii-keystore.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (filePath) {
    fs.copyFileSync(WALLET_FILE, filePath);
    return { success: true };
  }
  return { success: false, error: 'Cancelled.' };
});


