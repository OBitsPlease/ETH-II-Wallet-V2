const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ethii', {
  // Window controls
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close:    () => ipcRenderer.send('window-close'),
  copySensitive: (args) => ipcRenderer.invoke('clipboard-write-sensitive', args),

  // Wallet operations
  createWallet:   ()       => ipcRenderer.invoke('wallet-create'),
  saveWallet:     (args)   => ipcRenderer.invoke('wallet-save', args),
  walletExists:   ()       => ipcRenderer.invoke('wallet-exists'),
  unlockWallet:   (args)   => ipcRenderer.invoke('wallet-unlock', args),
  previewImport:  (args)   => ipcRenderer.invoke('wallet-preview-import', args),
  importWallet:   (args)   => ipcRenderer.invoke('wallet-import', args),
  exportKeystore: ()       => ipcRenderer.invoke('export-keystore'),

  // Chain operations
  getBalance:    (args) => ipcRenderer.invoke('get-balance', args),
  sendTx:        (args) => ipcRenderer.invoke('send-tx', args),
  getTxHistory:  (args) => ipcRenderer.invoke('get-tx-history', args),
  getNodeStatus: ()     => ipcRenderer.invoke('get-node-status'),
  autoSyncNudge: (args) => ipcRenderer.invoke('auto-sync-nudge', args),

  // Graceful shutdown: stop local node via RPC, stop stratum, then quit the wallet.
  gracefulShutdown: () => ipcRenderer.invoke('graceful-shutdown'),

  // App info
  getVersion: () => ipcRenderer.invoke('get-version'),
});
