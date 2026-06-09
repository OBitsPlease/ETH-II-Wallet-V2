// ETHII Wallet — renderer app logic

const PUBLIC_RPC_URL = 'https://ethii.net/rpc';

let currentAddress = null;
let currentPrivateKey = null;
let txHistory = [];
let txFilter = 'all';
let txSearch = '';
let txPage = 0;
const TX_PAGE_SIZE = 15;

// Update MetaMask RPC chip: show public RPC endpoint.
(function initMetaMaskRpc() {
  const el = document.getElementById('metamask-rpc-url');
  const note = document.getElementById('metamask-rpc-note');
  if (!el) return;
  if (PUBLIC_RPC_URL) {
    el.textContent = PUBLIC_RPC_URL;
    if (note) note.innerHTML = '<strong>Recommended:</strong> Use the URL above to connect MetaMask from any device. <strong>Local node (optional):</strong> use <code>http://localhost:8545</code> only on the same machine.';
  }
})();

// Populate version badge from main process
window.ethii.getVersion().then(v => {
  const tag = 'v' + v;
  const tb = document.getElementById('app-version');
  const sb = document.getElementById('sidebar-version');
  if (tb) tb.textContent = tag;
  if (sb) sb.textContent = tag;
}).catch(() => {});


// ---- Utility ----
function showToast(msg, duration = 2500) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  t.classList.add('show');
  setTimeout(() => { t.classList.remove('show'); t.classList.add('hidden'); }, duration);
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => showToast('Copied to clipboard!'));
}

function showError(elId, msg) {
  const el = document.getElementById(elId);
  el.textContent = msg;
  el.classList.remove('hidden');
}

function hideError(elId) {
  document.getElementById(elId).classList.add('hidden');
}

function showStatus(elId, msg, type) {
  const el = document.getElementById(elId);
  el.textContent = msg;
  el.className = `status-msg ${type}`;
  el.classList.remove('hidden');
}

// ---- Screen navigation ----
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const target = document.getElementById(id);
  target.classList.add('active');
}

// ---- Dashboard view switching ----
function showView(id) {
  document.querySelectorAll('.dash-view').forEach(v => v.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  document.querySelectorAll('.nav-item').forEach(n => {
    n.classList.toggle('active', n.dataset.view === id);
  });
  if (id === 'view-history') {
    refreshTxHistory();
  }
}

function shortHash(hash) {
  if (!hash || hash.length < 14) return hash || '—';
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

function getFilteredTxs() {
  const q = txSearch.trim().toLowerCase();
  return txHistory.filter((tx) => {
    if (txFilter !== 'all' && tx.direction !== txFilter) return false;
    if (!q) return true;
    return (
      (tx.from || '').toLowerCase().includes(q) ||
      (tx.to || '').toLowerCase().includes(q) ||
      (tx.hash || '').toLowerCase().includes(q) ||
      String(tx.value || '').includes(q) ||
      String(tx.blockNumber ?? '').includes(q)
    );
  });
}

function renderTxHistory() {
  const tbody = document.getElementById('history-tbody');
  if (!tbody) return;

  const filtered = getFilteredTxs();
  const totalPages = Math.max(1, Math.ceil(filtered.length / TX_PAGE_SIZE));
  if (txPage >= totalPages) txPage = totalPages - 1;
  if (txPage < 0) txPage = 0;

  const start = txPage * TX_PAGE_SIZE;
  const items = filtered.slice(start, start + TX_PAGE_SIZE);

  const pageLabel = document.getElementById('history-page-label');
  const prevBtn = document.getElementById('btn-hist-prev');
  const nextBtn = document.getElementById('btn-hist-next');
  if (pageLabel) pageLabel.textContent = filtered.length
    ? `Page ${txPage + 1} of ${totalPages}  (${filtered.length} txn${filtered.length !== 1 ? 's' : ''})`
    : '0 transactions';
  if (prevBtn) prevBtn.disabled = txPage === 0;
  if (nextBtn) nextBtn.disabled = txPage >= totalPages - 1;

  if (!items.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="mono small">${txSearch ? 'No transactions match your search.' : 'No transactions found.'}</td></tr>`;
    return;
  }

  tbody.innerHTML = items.map((tx) => {
    const counterparty = tx.direction === 'in' ? tx.from : tx.to;
    const dirClass = tx.direction === 'in' ? 'tx-dir-in' : 'tx-dir-out';
    const dirText = tx.direction === 'in' ? '▼ IN' : '▲ OUT';
    const amt = parseFloat(tx.value || '0');
    const amtDisplay = Number.isFinite(amt) ? amt.toFixed(4) : '—';
    return `<tr>
      <td class="${dirClass}">${dirText}</td>
      <td>${amtDisplay} ETHII</td>
      <td class="mono" title="${counterparty || ''}">${truncateAddress(counterparty || '—')}</td>
      <td>${Number.isFinite(tx.blockNumber) ? tx.blockNumber : '—'}</td>
      <td class="mono" title="${tx.hash || ''}">${shortHash(tx.hash)}</td>
    </tr>`;
  }).join('');
}

async function refreshTxHistory() {
  if (!currentAddress) return;
  const status = document.getElementById('history-status');
  if (status) {
    status.textContent = 'Scanning blocks for transactions… (this may take a few seconds)';
    status.className = 'status-msg loading';
    status.classList.remove('hidden');
  }

  const result = await window.ethii.getTxHistory({ address: currentAddress, limit: 500, scan: 50000 });
  if (!result.success) {
    if (status) {
      status.textContent = `History load failed: ${result.error}`;
      status.className = 'status-msg error';
    }
    return;
  }

  txHistory = Array.isArray(result.txs) ? result.txs : [];
  txPage = 0;
  renderTxHistory();
  if (status) {
    if (txHistory.length === 0) {
      status.textContent = 'No transactions found for this address.';
      status.className = 'status-msg';
    } else {
      status.textContent = `Found ${txHistory.length} transaction(s).`;
      status.className = 'status-msg success';
    }
  }
}

// ---- Window controls ----
document.getElementById('btn-min').addEventListener('click', () => window.ethii.minimize());
document.getElementById('btn-max').addEventListener('click', () => window.ethii.maximize());
document.getElementById('btn-close').addEventListener('click', () => window.ethii.close());

// ---- Determine initial screen ----
async function initApp() {
  const exists = await window.ethii.walletExists();
  if (exists) {
    // Show unlock if wallet file found
    document.getElementById('card-unlock').querySelector('button').style.boxShadow = '0 0 12px rgba(139,92,246,0.5)';
  }
  showScreen('screen-setup');
}

// ---- Setup card buttons ----
document.getElementById('card-new').querySelector('button').addEventListener('click', () => {
  // Always reset to step1 (password entry) before showing the create screen
  document.getElementById('new-wallet-step1').classList.remove('hidden');
  document.getElementById('new-wallet-step2').classList.add('hidden');
  document.getElementById('new-password').value = '';
  document.getElementById('new-password-confirm').value = '';
  showScreen('screen-new-wallet');
});
document.getElementById('card-unlock').querySelector('button').addEventListener('click', async () => {
  const exists = await window.ethii.walletExists();
  if (!exists) { showToast('No wallet found. Create one first.'); return; }
  showScreen('screen-unlock');
});
document.getElementById('card-import').querySelector('button').addEventListener('click', () => showScreen('screen-import'));

// ---- Back buttons ----
document.getElementById('back-from-new').addEventListener('click', () => {
  // Reset create-wallet screen so step1 (password) always shows on re-entry
  document.getElementById('new-wallet-step1').classList.remove('hidden');
  document.getElementById('new-wallet-step2').classList.add('hidden');
  document.getElementById('new-password').value = '';
  document.getElementById('new-password-confirm').value = '';
  showScreen('screen-setup');
});
document.getElementById('back-from-unlock').addEventListener('click', () => showScreen('screen-setup'));
document.getElementById('back-from-import').addEventListener('click', () => showScreen('screen-setup'));

// ---- Create new wallet ----
document.getElementById('btn-generate').addEventListener('click', async () => {
  const pw = document.getElementById('new-password').value;
  const pw2 = document.getElementById('new-password-confirm').value;
  if (pw.length < 8) { showToast('Password must be at least 8 characters.'); return; }
  if (pw !== pw2)    { showToast('Passwords do not match.'); return; }

  document.getElementById('btn-generate').textContent = 'Generating...';
  const wallet = await window.ethii.createWallet();
  const saved  = await window.ethii.saveWallet({ privateKey: wallet.privateKey, password: pw });
  document.getElementById('btn-generate').textContent = 'Generate Wallet';

  if (!saved.success) { showToast('Error saving wallet: ' + saved.error); return; }

  document.getElementById('new-address-display').value = wallet.address;
  document.getElementById('new-privkey-display').value = wallet.privateKey;
  document.getElementById('new-mnemonic-display').textContent = wallet.mnemonic || '(no mnemonic — imported key)';

  currentAddress   = wallet.address;
  currentPrivateKey = wallet.privateKey;

  document.getElementById('new-wallet-step1').classList.add('hidden');
  document.getElementById('new-wallet-step2').classList.remove('hidden');
});

document.getElementById('btn-go-dashboard').addEventListener('click', () => openDashboard());

// ---- Unlock wallet ----
document.getElementById('btn-unlock').addEventListener('click', async () => {
  const pw = document.getElementById('unlock-password').value;
  hideError('unlock-error');
  document.getElementById('btn-unlock').textContent = 'Unlocking...';
  const result = await window.ethii.unlockWallet({ password: pw });
  document.getElementById('btn-unlock').textContent = 'Unlock →';
  if (!result.success) { showError('unlock-error', result.error); return; }
  currentAddress    = result.address;
  currentPrivateKey = result.privateKey;
  openDashboard();
});

// ---- Import wallet ----
document.getElementById('btn-import').addEventListener('click', async () => {
  const pk = document.getElementById('import-privkey').value.trim();
  const pw = document.getElementById('import-password').value;
  hideError('import-error');
  if (!pk) { showError('import-error', 'Please enter a private key.'); return; }
  if (pw.length < 8) { showError('import-error', 'Password must be at least 8 characters.'); return; }
  document.getElementById('btn-import').textContent = 'Importing...';
  const result = await window.ethii.importWallet({ privateKey: pk, password: pw });
  document.getElementById('btn-import').textContent = 'Import Wallet';
  if (!result.success) { showError('import-error', result.error); return; }
  currentAddress    = result.address;
  // Unlock immediately to get privateKey in memory
  const unlocked = await window.ethii.unlockWallet({ password: pw });
  currentPrivateKey = unlocked.privateKey;
  openDashboard();
});

// ---- Open Dashboard ----
function openDashboard() {
  if (!currentAddress) return;
  document.getElementById('dash-address').textContent = truncateAddress(currentAddress);
  document.getElementById('receive-address').textContent = currentAddress;
  document.getElementById('receive-address-input').value = currentAddress;
  // Update node command with real address
  document.querySelector('.code-block').textContent =
    `ethii.exe --datadir ".\\data" --config ".\\data\\geth\\config.toml" --networkid 20482 --syncmode full --gcmode archive --state.scheme hash --bootnodes "enode://b096bfae7d5e9a7cc985e68726280b75b0a0ef80ce419db5ed5152e9bee7bf83d35ae8b13b34879a0bf36d73a9a674bb61b02f3777745ed770e3150a39c7de5b@91.99.231.217:30303" --http --http.addr 127.0.0.1 --http.port 8545 --http.api "eth,net,web3,miner,ethash,txpool,admin,debug" --http.corsdomain "*" --http.vhosts "*" --miner.pending.feeRecipient ${currentAddress}`;
  showScreen('screen-dashboard');
  showView('view-wallet');
  refreshBalance({ showSpinner: true });
  refreshTxHistory();
  refreshNodeStatus();
  // Update stratum URL with current address
  const stratumEl = document.getElementById('stratum-url');
  if (stratumEl) stratumEl.textContent = `stratum+tcp://${currentAddress}.rig1@localhost:8546`;
}

function truncateAddress(addr) {
  return addr.slice(0, 8) + '…' + addr.slice(-6);
}

// ---- Balance ----
async function refreshBalance({ showSpinner = false } = {}) {
  if (!currentAddress) return;
  const el = document.getElementById('balance-value');
  // Only blank the display on explicit first-load or manual refresh, not background polls
  if (showSpinner) el.textContent = '…';
  let result;
  try {
    result = await window.ethii.getBalance({ address: currentAddress });
  } catch (e) {
    if (showSpinner) el.textContent = '—';
    return;
  }
  if (result && result.success) {
    const num = parseFloat(result.balance);
    el.textContent = isFinite(num) ? num.toFixed(4) : '—';
  } else {
    // Only overwrite with '—' if we haven't shown a real value yet
    if (el.textContent === '…' || el.textContent === '—') el.textContent = '—';
    if (result && result.error && showSpinner) showToast(result.error);
  }
}

document.getElementById('btn-refresh-balance').addEventListener('click', () => refreshBalance({ showSpinner: true }));

// ---- Send transaction ----
document.getElementById('btn-send').addEventListener('click', async () => {
  const to       = document.getElementById('send-to').value.trim();
  const amount   = document.getElementById('send-amount').value.trim();
  const gasPrice = document.getElementById('send-gasprice').value.trim();
  const password = document.getElementById('send-password').value;

  if (!to || !amount) { showStatus('send-status', 'Please fill in all fields.', 'error'); return; }
  if (!password && !currentPrivateKey) { showStatus('send-status', 'Please enter your wallet password.', 'error'); return; }

  // Unlock private key using password
  showStatus('send-status', 'Signing transaction…', 'loading');
  document.getElementById('btn-send').textContent = 'Sending…';

  let pk = currentPrivateKey;
  if (!pk) {
    const unlocked = await window.ethii.unlockWallet({ password });
    if (!unlocked.success) {
      showStatus('send-status', 'Wrong password.', 'error');
      document.getElementById('btn-send').textContent = 'Send Transaction →';
      return;
    }
    pk = unlocked.privateKey;
  }

  const result = await window.ethii.sendTx({ privateKey: pk, to, amount, gasPrice: gasPrice || '0.5' });
  document.getElementById('btn-send').textContent = 'Send Transaction →';
  if (result.success) {
    showStatus('send-status', `✔ Broadcasted! TX: ${result.hash}`, 'success');
    document.getElementById('send-to').value = '';
    document.getElementById('send-amount').value = '';
    document.getElementById('send-password').value = '';
    setTimeout(refreshBalance, 2000);
    setTimeout(refreshTxHistory, 3000);
  } else {
    showStatus('send-status', result.error, 'error');
  }
});

// ---- Node status ----
async function refreshNodeStatus() {
  console.log('[UI] refreshNodeStatus() called');
  const indicator = document.getElementById('node-indicator');
  const statusText = document.getElementById('node-status-text');
  const syncFill = document.getElementById('node-sync-progress-fill');
  const syncLabel = document.getElementById('node-sync-progress-label');
  const result = await window.ethii.getNodeStatus();
  console.log('[UI] getNodeStatus result:', result);
  if (result.success) {
    const source = result.source || 'local';
    const localBlock = Number.isFinite(result.localBlockNumber) ? result.localBlockNumber : null;
    const networkBlock = Number.isFinite(result.networkBlockNumber) ? result.networkBlockNumber : null;
    const peers = Number.isFinite(result.peers) ? result.peers : 0;
    const networkPeers = Number.isFinite(result.networkPeers) ? result.networkPeers : null;
    const lag = Number.isFinite(result.syncLag) ? result.syncLag : null;

    if (source === 'vps') {
      indicator.className = 'node-indicator online';
      statusText.textContent = lag !== null
        ? `Using VPS - Network #${networkBlock !== null ? networkBlock : '—'} (local behind ${lag})`
        : `Using VPS - Network #${networkBlock !== null ? networkBlock : '—'}`;

      document.getElementById('node-block').textContent = localBlock !== null ? localBlock : '—';
      document.getElementById('node-network-block').textContent = networkBlock !== null ? networkBlock : '—';
      document.getElementById('node-network-peers').textContent = networkPeers !== null ? networkPeers : '—';
      document.getElementById('node-sync-lag').textContent = lag !== null ? lag : '—';
      document.getElementById('node-peers').textContent = peers;

      if (lag !== null && lag >= 2 && networkBlock !== null && localBlock !== null && localBlock < networkBlock) {
        window.ethii.autoSyncNudge({ lag, reason: 'wallet-vps-failover' }).catch(() => {});
      }

      if (syncFill && syncLabel) {
        syncFill.classList.remove('indeterminate');
        syncFill.style.width = '100%';
        syncLabel.textContent = lag !== null
          ? `Failover active: wallet is using VPS while local catches up (${lag} behind).`
          : 'Failover active: wallet is using VPS RPC.';
      }
      return;
    }

    const isSynced = lag !== null ? lag <= 3 : peers > 0;
    indicator.className = isSynced ? 'node-indicator online' : 'node-indicator offline';
    statusText.textContent = isSynced
      ? `Connected - Local #${localBlock}${networkBlock !== null ? ` / Network #${networkBlock}` : ''}`
      : `Local node behind - Local #${localBlock}${networkBlock !== null ? ` / Network #${networkBlock}` : ''}`;

    document.getElementById('node-block').textContent = Number.isFinite(localBlock) ? localBlock : '—';
    document.getElementById('node-network-block').textContent = networkBlock !== null ? networkBlock : '—';
    document.getElementById('node-network-peers').textContent = networkPeers !== null ? networkPeers : '—';
    document.getElementById('node-sync-lag').textContent = lag !== null ? lag : '—';
    document.getElementById('node-peers').textContent = peers;

    if (lag !== null && lag >= 2 && networkBlock !== null && localBlock < networkBlock) {
      window.ethii.autoSyncNudge({ lag, reason: 'wallet-node-status' }).catch(() => {});
    }

    if (syncFill && syncLabel) {
      if (networkBlock !== null && networkBlock > 0) {
        const pct = Math.max(0, Math.min(100, (localBlock / networkBlock) * 100));
        if (peers === 0 && localBlock === 0) {
          syncFill.classList.add('indeterminate');
          syncFill.style.width = '45%';
          syncLabel.textContent = 'Waiting for peers to begin sync...';
        } else {
          syncFill.classList.remove('indeterminate');
          syncFill.style.width = `${pct.toFixed(1)}%`;
          syncLabel.textContent = lag === 0
            ? 'Fully synced with network.'
            : lag >= 3
              ? `⚠ Node is ${lag} blocks behind network. (${localBlock} / ${networkBlock})`
              : `Syncing: ${localBlock} / ${networkBlock} (${pct.toFixed(1)}%)`;
        }
      } else {
        syncFill.classList.add('indeterminate');
        syncFill.style.width = '45%';
        syncLabel.textContent = 'Connected locally, checking network height...';
      }
    }

    console.log('[UI] Node status local/network/peers/lag:', localBlock, networkBlock, peers, lag);
  } else {
    console.log('[UI] Node offline, error:', result.error);
    indicator.className = 'node-indicator offline';
    statusText.textContent = 'Node and VPS RPC offline';
    document.getElementById('node-block').textContent = '—';
    document.getElementById('node-network-block').textContent = '—';
    document.getElementById('node-network-peers').textContent = '—';
    document.getElementById('node-sync-lag').textContent = '—';
    document.getElementById('node-peers').textContent = '—';
    if (syncFill && syncLabel) {
      syncFill.classList.remove('indeterminate');
      syncFill.style.width = '0%';
      syncLabel.textContent = 'Node offline.';
    }
  }
}

document.getElementById('btn-refresh-node').addEventListener('click', refreshNodeStatus);

// ---- Graceful shutdown button ----
document.getElementById('btn-shutdown-node').addEventListener('click', async () => {
  const confirmed = confirm(
    'This will gracefully stop the local node (saving the database safely), stop the stratum proxy, then close the wallet.\n\nProceed with shutdown?'
  );
  if (!confirmed) return;
  const btn = document.getElementById('btn-shutdown-node');
  btn.textContent = 'Shutting down...';
  btn.disabled = true;
  await window.ethii.gracefulShutdown();
});

// Auto-refresh node status every 10s
setInterval(refreshNodeStatus, 10000);

// ---- Nav items ----
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => showView(item.dataset.view));
});

document.querySelectorAll('[data-view]').forEach(btn => {
  if (!btn.classList.contains('nav-item')) {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  }
});

document.querySelectorAll('.history-filter').forEach((btn) => {
  btn.addEventListener('click', () => {
    txFilter = btn.dataset.filter;
    txPage = 0;
    document.querySelectorAll('.history-filter').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    renderTxHistory();
  });
});

document.getElementById('history-search')?.addEventListener('input', (e) => {
  txSearch = e.target.value;
  txPage = 0;
  renderTxHistory();
});

document.getElementById('btn-hist-prev')?.addEventListener('click', () => {
  if (txPage > 0) { txPage--; renderTxHistory(); }
});

document.getElementById('btn-hist-next')?.addEventListener('click', () => {
  const totalPages = Math.max(1, Math.ceil(getFilteredTxs().length / TX_PAGE_SIZE));
  if (txPage < totalPages - 1) { txPage++; renderTxHistory(); }
});

document.getElementById('btn-refresh-history')?.addEventListener('click', refreshTxHistory);

// ---- Copy buttons ----
document.querySelectorAll('.btn-copy').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = document.getElementById(btn.dataset.target);
    if (target) copyToClipboard(target.value);
  });
});

document.getElementById('copy-address').addEventListener('click', () => {
  if (currentAddress) copyToClipboard(currentAddress);
});

// ---- Reveal private key ----
document.querySelectorAll('.btn-reveal').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.target);
    if (!input) return;
    input.type = input.type === 'password' ? 'text' : 'password';
    btn.textContent = input.type === 'password' ? '👁' : '🙈';
  });
});

// ---- Lock wallet ----
document.getElementById('btn-lock').addEventListener('click', () => {
  currentAddress    = null;
  currentPrivateKey = null;
  document.getElementById('unlock-password').value = '';
  showScreen('screen-setup');
  showToast('Wallet locked.');
});

// ---- Export keystore ----
document.getElementById('btn-export').addEventListener('click', async () => {
  const result = await window.ethii.exportKeystore();
  if (result.success) showToast('Keystore exported!');
  else showToast('Export failed: ' + result.error);
});

// ---- Enter key support ----
document.getElementById('unlock-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-unlock').click();
});
document.getElementById('new-password-confirm').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-generate').click();
});

// ---- Auto-refresh balance every 30s when on dashboard ----
setInterval(() => {
  const dashboard = document.getElementById('screen-dashboard');
  if (dashboard.classList.contains('active') && currentAddress) {
    refreshBalance();
  }
}, 30000);

// ---- Init ----
initApp();

