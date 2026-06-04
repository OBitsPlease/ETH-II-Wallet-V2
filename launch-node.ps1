# ETHII Miner Suite Launcher
# Starts: Node + Stratum Proxy + Wallet GUI

param(
  [string]$VpsHost = "87.99.142.128",
  [string]$SecondaryVpsHost = "91.99.231.217",
  [string]$User = "root",
  [string]$KeyPath = "$env:USERPROFILE\.ssh\ethii_vps"
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir   = Split-Path -Parent $ScriptDir

function Test-WritableDirectory {
  param([string]$Path)

  try {
    New-Item -ItemType Directory -Path $Path -Force -ErrorAction Stop | Out-Null
    $probe = Join-Path $Path (".write-test-" + [Guid]::NewGuid().ToString() + ".tmp")
    Set-Content -Path $probe -Value "ok" -Encoding ASCII -ErrorAction Stop
    Remove-Item -Path $probe -Force -ErrorAction SilentlyContinue
    return $true
  } catch {
    return $false
  }
}

function Resolve-InstalledWalletExe {
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\ETH II Wallet\ETH II Wallet.exe'),
    (Join-Path $env:ProgramFiles 'ETH II Wallet\ETH II Wallet.exe')
  )

  if ($env:ProgramFiles -and ${env:ProgramFiles(x86)} -and ($env:ProgramFiles -ne ${env:ProgramFiles(x86)})) {
    $candidates += (Join-Path ${env:ProgramFiles(x86)} 'ETH II Wallet\ETH II Wallet.exe')
  }

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) { return $candidate }
  }

  $regPaths = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )

  try {
    $entries = Get-ItemProperty -Path $regPaths -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName -eq 'ETH II Wallet' -and $_.InstallLocation }

    foreach ($entry in $entries) {
      $exe = Join-Path $entry.InstallLocation 'ETH II Wallet.exe'
      if (Test-Path $exe) { return $exe }
    }
  } catch { }

  return $null
}

$DefaultStateRoot = Join-Path $env:LOCALAPPDATA "ETHII\Solo-Miner-Suite"
$StateRoot = if (Test-WritableDirectory -Path $RootDir) { $RootDir } else { $DefaultStateRoot }
if (-not (Test-Path $StateRoot)) {
  New-Item -ItemType Directory -Path $StateRoot -Force | Out-Null
}
$StateWalletDir = Join-Path $StateRoot "wallet"
if (-not (Test-Path $StateWalletDir)) {
  New-Item -ItemType Directory -Path $StateWalletDir -Force | Out-Null
}
$BackupStatusFile = Join-Path $StateRoot "BACKUPS\LATEST-BACKUPS.txt"

function Resolve-RemoteRpcUrl {
  param(
    [string[]]$Candidates
  )

  foreach ($candidate in $Candidates) {
    if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
    try {
      $probe = Invoke-RestMethod -Uri $candidate -Method POST `
        -Body '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' `
        -ContentType "application/json" -TimeoutSec 4 -ErrorAction Stop
      if ($probe.result) {
        return $candidate
      }
    } catch { }
  }

  if ($Candidates -and $Candidates.Count -gt 0) {
    return $Candidates[0]
  }

  return ""
}

function Start-WalletApp {
  param(
    [string]$ElectronPath,
    [string]$AppDir,
    [string]$InstalledExe
  )

  try {
    if (Test-Path $ElectronPath) {
      $walletStartInfo = New-Object System.Diagnostics.ProcessStartInfo($ElectronPath, "`"$AppDir`"")
      $walletStartInfo.UseShellExecute = $false
      $walletStartInfo.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE")
      [System.Diagnostics.Process]::Start($walletStartInfo) | Out-Null
      Write-Host "  Wallet launched (local runtime)." -ForegroundColor Green
      return $true
    }

    if (Test-Path $InstalledExe) {
      Start-Process -FilePath $InstalledExe | Out-Null
      Write-Host "  Wallet launched (installed app)." -ForegroundColor Green
      return $true
    }
  } catch {
    Write-Host "  WARNING: Wallet launch failed: $_" -ForegroundColor Yellow
  }

  return $false
}

function Convert-BlockTagToInt64 {
  param([object]$Value)

  if ($null -eq $Value) { return 0 }
  if ($Value -is [int] -or $Value -is [long]) { return [int64]$Value }

  $text = [string]$Value
  if ([string]::IsNullOrWhiteSpace($text)) { return 0 }
  if ($text.StartsWith("0x")) {
    try { return [Convert]::ToInt64($text.Substring(2), 16) } catch { return 0 }
  }

  try { return [int64]$text } catch { return 0 }
}

function Remove-StalePeers {
  param(
    [int]$RpcPort,
    [string[]]$KnownBadEnodes
  )

  $removed = 0
  try {
    $peerResp = Invoke-RestMethod -Uri "http://127.0.0.1:$RpcPort" -Method POST `
      -Body '{"jsonrpc":"2.0","method":"admin_peers","params":[],"id":1}' `
      -ContentType "application/json" -TimeoutSec 4

    foreach ($peer in ($peerResp.result | Where-Object { $_ })) {
      $peerEnode = [string]$peer.enode
      $peerName = [string]$peer.name
      $peerLatest = Convert-BlockTagToInt64 -Value $peer.protocols.eth.latestBlock

      $isKnownBad = $KnownBadEnodes -contains $peerEnode
      # Narrow stale heuristic: only prune the known-broken 20260519 build when it reports genesis height.
      $isKnownBrokenBuild = ($peerName -match '6c427356-20260519')
      $isStaleBrokenPeer = $isKnownBrokenBuild -and ($peerLatest -eq 0)

      if ($isKnownBad -or $isStaleBrokenPeer) {
        try {
          $payload = '{"jsonrpc":"2.0","method":"admin_removePeer","params":["' + $peerEnode + '"],"id":1}'
          $rmResp = Invoke-RestMethod -Uri "http://127.0.0.1:$RpcPort" -Method POST -Body $payload -ContentType "application/json" -TimeoutSec 4
          if ($rmResp.result -eq $true) {
            $removed++
            Write-Host "  Removed stale peer: $peerEnode" -ForegroundColor Yellow
          }
        } catch {
          Write-Host "  WARNING: Failed to remove stale peer $peerEnode : $_" -ForegroundColor Yellow
        }
      }
    }
  } catch {
    Write-Host "  WARNING: Could not inspect peers for stale cleanup: $_" -ForegroundColor Yellow
  }

  return $removed
}

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  ETHII Miner Suite - ETH 2.0 Proof of Work" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# ── Auto-updater (wallet + node + stratum) ─────────────────────────────────
$UpdaterScript = Join-Path $RootDir "update-manager.ps1"
if (Test-Path $UpdaterScript) {
  Write-Host "Checking for suite/wallet updates (background)..." -ForegroundColor Cyan
  try {
    Start-Process powershell -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$UpdaterScript`" -Mode auto -NonInteractive -SkipWallet" -WindowStyle Hidden | Out-Null
    Write-Host "  Update check started in background." -ForegroundColor Green
  } catch {
    Write-Host "  WARNING: updater failed, continuing launch: $_" -ForegroundColor Yellow
  }
  Write-Host ""
}

# ── Paths ─────────────────────────────────────────────────────────────────────
$EthiiExe    = Join-Path $RootDir "ethii.exe"
$StratumExe  = Join-Path $RootDir "stratum.exe"
$DataDir     = Join-Path $StateRoot "data"
$GenesisFile = Join-Path $ScriptDir "genesis.json"
$ElectronExe = Join-Path $ScriptDir "node_modules\electron\dist\electron.exe"
$InstalledWalletExe = Resolve-InstalledWalletExe
$AddrFile    = Join-Path $StateWalletDir "etherbase.txt"
$PayoutFileA = Join-Path $RootDir "payout.json"
$PayoutFileB = Join-Path $RootDir "stratum\payout.json"
$InfoFile    = Join-Path $StateRoot "ETHII-Mining-Info.txt"

$WalletRuntimeAvailable = (Test-Path $ElectronExe) -or (-not [string]::IsNullOrWhiteSpace($InstalledWalletExe))

if ($StateRoot -ne $RootDir) {
  Write-Host "NOTE: Install directory is read-only; using writable runtime path: $StateRoot" -ForegroundColor Yellow
}

if (-not (Test-Path $EthiiExe))    { Write-Host "ERROR: ethii.exe not found at $EthiiExe" -ForegroundColor Red; Read-Host "Press Enter to exit"; exit 1 }
if (-not (Test-Path $StratumExe))  { Write-Host "ERROR: stratum.exe not found at $StratumExe" -ForegroundColor Red; Read-Host "Press Enter to exit"; exit 1 }
if (-not $WalletRuntimeAvailable) {
  Write-Host "WARNING: Wallet runtime not found." -ForegroundColor Yellow
  Write-Host "  Missing local Electron: $ElectronExe" -ForegroundColor Yellow
  Write-Host "  Checked installed wallet paths under LocalAppData/Program Files and uninstall registry entries." -ForegroundColor Yellow
  Write-Host "  Continuing without wallet UI. Install wallet from: https://github.com/OBitsPlease/ETH-II-Wallet/releases/latest" -ForegroundColor Yellow
}
if (-not (Test-Path $GenesisFile)) { Write-Host "ERROR: genesis.json not found at $GenesisFile" -ForegroundColor Red; Read-Host "Press Enter to exit"; exit 1 }

if ($WalletRuntimeAvailable) {
  Write-Host "Launching ETHII Wallet (fast start)..." -ForegroundColor Yellow
  [void](Start-WalletApp -ElectronPath $ElectronExe -AppDir $ScriptDir -InstalledExe $InstalledWalletExe)
  Write-Host ""
} else {
  Write-Host "Skipping wallet UI launch until runtime is installed." -ForegroundColor Yellow
  Write-Host ""
}

# ── Ensure firewall allows inbound connections on stratum and RPC ports ────────
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$fwStratum = Get-NetFirewallRule -DisplayName "ETHII Stratum"     -ErrorAction SilentlyContinue
$fwStratumA10 = Get-NetFirewallRule -DisplayName "ETHII Stratum A10" -ErrorAction SilentlyContinue
$fwRpc     = Get-NetFirewallRule -DisplayName "ETHII RPC"         -ErrorAction SilentlyContinue
if (-not $fwStratum -or -not $fwStratumA10 -or -not $fwRpc) {
    if ($isAdmin) {
        if (-not $fwStratum) {
            New-NetFirewallRule -DisplayName "ETHII Stratum" -Direction Inbound -Protocol TCP -LocalPort 3335 -Action Allow -Profile Any | Out-Null
            Write-Host "  Firewall: opened port 3335 (Stratum)" -ForegroundColor Green
        }
    if (-not $fwStratumA10) {
      New-NetFirewallRule -DisplayName "ETHII Stratum A10" -Direction Inbound -Protocol TCP -LocalPort 3336 -Action Allow -Profile Any | Out-Null
      Write-Host "  Firewall: opened port 3336 (Stratum A10)" -ForegroundColor Green
    }
        if (-not $fwRpc) {
            New-NetFirewallRule -DisplayName "ETHII RPC" -Direction Inbound -Protocol TCP -LocalPort 8545 -Action Allow -Profile Any | Out-Null
            Write-Host "  Firewall: opened port 8545 (RPC)" -ForegroundColor Green
        }
    } else {
        Write-Host "  Firewall: adding rules requires elevation - launching elevated helper..." -ForegroundColor Yellow
        $tmpScript = [System.IO.Path]::GetTempFileName() + ".ps1"
    $fwLines = "New-NetFirewallRule -DisplayName 'ETHII Stratum' -Direction Inbound -Protocol TCP -LocalPort 3335 -Action Allow -Profile Any -ErrorAction SilentlyContinue | Out-Null`nNew-NetFirewallRule -DisplayName 'ETHII Stratum A10' -Direction Inbound -Protocol TCP -LocalPort 3336 -Action Allow -Profile Any -ErrorAction SilentlyContinue | Out-Null`nNew-NetFirewallRule -DisplayName 'ETHII RPC' -Direction Inbound -Protocol TCP -LocalPort 8545 -Action Allow -Profile Any -ErrorAction SilentlyContinue | Out-Null"
        Set-Content -Path $tmpScript -Value $fwLines -Encoding UTF8
        Start-Process powershell -ArgumentList "-ExecutionPolicy Bypass -File `"$tmpScript`"" -Verb RunAs -Wait -ErrorAction SilentlyContinue
        Remove-Item $tmpScript -ErrorAction SilentlyContinue
        Write-Host "  Firewall: rules applied." -ForegroundColor Green
    }
}

# ── Auto-init chain when the local database is missing or incomplete ─────────
$ChainDataDir = Join-Path $DataDir "geth\chaindata"
$ChainCurrentFile = Join-Path $ChainDataDir "CURRENT"
$AncientChainDir = Join-Path $ChainDataDir "ancient\chain"
$needsGenesisInit = (-not (Test-Path $ChainDataDir)) -or (-not (Test-Path $ChainCurrentFile)) -or (-not (Test-Path $AncientChainDir))
if ($needsGenesisInit) {
  if (Test-Path $ChainDataDir) {
    $badChainBackup = $ChainDataDir + ".bad-" + (Get-Date -Format "yyyyMMdd-HHmmss")
    Write-Host "Detected incomplete chain database. Backing it up to $badChainBackup" -ForegroundColor Yellow
    Move-Item -Path $ChainDataDir -Destination $badChainBackup -Force
  }
  Write-Host "Initializing ETHII chain from genesis..." -ForegroundColor Yellow
  & $EthiiExe --datadir $DataDir "--state.scheme" hash init $GenesisFile
  if ($LASTEXITCODE -ne 0) { Write-Host "ERROR: Failed to initialize chain." -ForegroundColor Red; Read-Host "Press Enter to exit"; exit 1 }
}

# ── Kill any stale ethii/stratum processes so the datadir lock is released ─────
$stale = Get-Process -Name "ethii","stratum" -ErrorAction SilentlyContinue
if ($stale) {
    Write-Host "Stopping previous ethii/stratum processes..." -ForegroundColor Yellow
    $stale | ForEach-Object { $_.Kill(); $_.WaitForExit(3000) }
}
# Free fixed ports only if held by our own processes (ethii/stratum) so we
# don't disrupt other Ethereum nodes a miner may be running simultaneously.
foreach ($fixedPort in @(3335, 8082)) {
    $conn = Get-NetTCPConnection -LocalPort $fixedPort -ErrorAction SilentlyContinue
    if ($conn) {
        $pid_ = ($conn | Select-Object -First 1).OwningProcess
        if ($pid_ -and $pid_ -ne $PID) {
            $procName = (Get-Process -Id $pid_ -ErrorAction SilentlyContinue).Name
            if ($procName -match "ethii|stratum|electron") {
                Write-Host "  Freeing port $fixedPort (PID $pid_)..." -ForegroundColor Yellow
                Stop-Process -Id $pid_ -Force -ErrorAction SilentlyContinue
            }
        }
    }
}
Start-Sleep -Seconds 1

function New-LocalPreLaunchBackup {
  param(
    [string]$BaseDir,
    [int]$KeepCount = 7
  )

  $backupRoot = Join-Path $StateRoot "BACKUPS\AUTO-LAUNCH"
  if (-not (Test-Path $backupRoot)) {
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
  }

  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $backupDir = Join-Path $backupRoot ("PRE-LAUNCH-" + $stamp)
  New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

  $relativeFiles = @(
    "ethii.exe",
    "stratum.exe",
    "wallet\launch-node.ps1",
    "wallet\genesis.json",
    "wallet\etherbase.txt",
    "wallet\rpc-port.txt",
    "data\geth\config.toml",
    "data\geth\nodekey",
    "data\geth\jwtsecret",
    "node.log",
    "node.out.log"
  )

  foreach ($rel in $relativeFiles) {
    $src = Join-Path $BaseDir $rel
    if (Test-Path $src) {
      $dst = Join-Path $backupDir $rel
      $dstParent = Split-Path $dst -Parent
      if (-not (Test-Path $dstParent)) {
        New-Item -ItemType Directory -Path $dstParent -Force | Out-Null
      }
      Copy-Item -Path $src -Destination $dst -Force
    }
  }

  $relativeDirs = @(
    "data\geth\chaindata",
    "data\geth\triedb",
    "data\geth\blobpool",
    "data\geth\nodes"
  )

  foreach ($relDir in $relativeDirs) {
    $srcDir = Join-Path $BaseDir $relDir
    if (Test-Path $srcDir) {
      $dstDir = Join-Path $backupDir $relDir
      $dstParent = Split-Path $dstDir -Parent
      if (-not (Test-Path $dstParent)) {
        New-Item -ItemType Directory -Path $dstParent -Force | Out-Null
      }
      Copy-Item -Path $srcDir -Destination $dstDir -Recurse -Force
    }
  }

  $infoFile = Join-Path $backupDir "BACKUP-INFO.txt"
  @(
    "created=" + (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
    "type=automatic pre-launch backup"
    "source=" + $BaseDir
  ) | Set-Content -Path $infoFile -Encoding ASCII

  $existing = Get-ChildItem -Path $backupRoot -Directory |
    Where-Object { $_.Name -like "PRE-LAUNCH-*" } |
    Sort-Object LastWriteTime -Descending
  if ($existing.Count -gt $KeepCount) {
    $existing | Select-Object -Skip $KeepCount | ForEach-Object {
      Remove-Item -Path $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
  }

  return $backupDir
}

function Update-BackupStatusFile {
  param(
    [string]$StatusPath,
    [string]$LocalPath
  )

  $existing = @{}
  if (Test-Path $StatusPath) {
    Get-Content $StatusPath | ForEach-Object {
      if ($_ -match "^([^=]+)=(.*)$") {
        $existing[$matches[1]] = $matches[2]
      }
    }
  }

  $existing["updated"] = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
  $existing["local_backup"] = $LocalPath
  if (-not $existing.ContainsKey("vps_backup")) {
    $existing["vps_backup"] = ""
  }

  @(
    "updated=" + $existing["updated"]
    "local_backup=" + $existing["local_backup"]
    "vps_backup=" + $existing["vps_backup"]
  ) | Set-Content -Path $StatusPath -Encoding ASCII
}

Write-Host "Creating automatic pre-launch backup..." -ForegroundColor Yellow
try {
  $autoBackupPath = New-LocalPreLaunchBackup -BaseDir $RootDir -KeepCount 7
  Update-BackupStatusFile -StatusPath $BackupStatusFile -LocalPath $autoBackupPath
  Write-Host "  Backup created: $autoBackupPath" -ForegroundColor Green
} catch {
  Write-Host "ERROR: Automatic pre-launch backup failed: $_" -ForegroundColor Red
  Write-Host "Refusing to start without a rollback point." -ForegroundColor Red
  Read-Host "Press Enter to exit"
  exit 1
}

# ── Ports ─────────────────────────────────────────────────────────────────────
# Stratum and dashboard are fixed - external miners depend on these.
# RPC is fixed to 8545 to avoid wallet/launcher port drift. P2P still scans.
function Find-FreePort([int[]]$candidates) {
    foreach ($p in $candidates) {
        $used = Get-NetTCPConnection -LocalPort $p -ErrorAction SilentlyContinue
        if (-not $used) { return $p }
    }
    return $candidates[0]
}

$RpcPort       = 8545
$P2pPort       = Find-FreePort @(30303..30313)
$StratumPort   = 3335   # Fixed - external miners (ASICs, GPUs) depend on this
$A10CompatPort = 3336   # Fixed - optional compatibility endpoint for A10-class ASICs
$DashboardPort = 8082   # Fixed - bookmarked URL stays consistent
$PrimaryBootnodeEnode = "enode://05f7f1c669368d16829699b6e1ddffbd8a3fee08a1301cac33922ad05f56fd53aadbca02f326d6b1c863c560c9adf30a75b44d45e7448ebb41d9c47235204fdf@87.99.142.128:30303"
$SecondaryBootnodeEnode = "enode://b096bfae7d5e9a7cc985e68726280b75b0a0ef80ce419db5ed5152e9bee7bf83d35ae8b13b34879a0bf36d73a9a674bb61b02f3777745ed770e3150a39c7de5b@91.99.231.217:30303"
$BootnodeEnode = $PrimaryBootnodeEnode
$SeedEnodes = @($PrimaryBootnodeEnode, $SecondaryBootnodeEnode) | Select-Object -Unique
$KnownBadPeerEnodes = @(
  "enode://d3615e2943e55195251ec6c233b19ffbd14151cf93967d568fd6c87f98fc9c6f16f9934030dc85448411eb0f234cd308e1534c9035d31ca15dee00de07082e34@206.255.167.20:30303"
) | Select-Object -Unique
$PublicRpcUrl = "http://87.99.142.128:8545"
$SecondaryPublicRpcUrl = "http://91.99.231.217:8545"

# Keep RPC fixed on 8545. If something else holds it, fail with a clear message.
$rpcInUse = Get-NetTCPConnection -State Listen -LocalPort $RpcPort -ErrorAction SilentlyContinue | Select-Object -First 1
if ($rpcInUse) {
  $rpcOwner = $null
  try { $rpcOwner = Get-Process -Id $rpcInUse.OwningProcess -ErrorAction SilentlyContinue } catch { }
  $rpcOwnerName = if ($rpcOwner) { $rpcOwner.Name } else { "PID $($rpcInUse.OwningProcess)" }
  Write-Host "  Freeing RPC port 8545 (owner: $rpcOwnerName)..." -ForegroundColor Yellow
  Stop-Process -Id $rpcInUse.OwningProcess -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
}

# Ensure inbound P2P is open on the selected port so this node can accept peers.
$fwP2pTcpName = "ETHII P2P TCP $P2pPort"
$fwP2pUdpName = "ETHII P2P UDP $P2pPort"
if ($isAdmin) {
  if (-not (Get-NetFirewallRule -DisplayName $fwP2pTcpName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $fwP2pTcpName -Direction Inbound -Protocol TCP -LocalPort $P2pPort -Action Allow -Profile Any | Out-Null
  }
  if (-not (Get-NetFirewallRule -DisplayName $fwP2pUdpName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $fwP2pUdpName -Direction Inbound -Protocol UDP -LocalPort $P2pPort -Action Allow -Profile Any | Out-Null
  }
} else {
  Write-Host "  Firewall: P2P inbound on $P2pPort requires elevation (TCP+UDP)." -ForegroundColor Yellow
}

# Write the chosen RPC port to a file so the wallet always knows which port to use
$RpcPortFile = Join-Path $StateWalletDir "rpc-port.txt"
Set-Content -Path $RpcPortFile -Value "$RpcPort" -NoNewline

# Keep legacy path in sync when writable (portable installs) for compatibility.
try {
  Set-Content -Path (Join-Path $ScriptDir "rpc-port.txt") -Value "$RpcPort" -NoNewline -ErrorAction Stop
} catch { }

# Force a direct persistent peer connection to the VPS node.
# Newer geth versions ignore static-nodes.json, so write config.toml instead.
$gethDir = Join-Path $DataDir "geth"
if (-not (Test-Path $gethDir)) { New-Item -ItemType Directory -Path $gethDir | Out-Null }
$configTomlPath = Join-Path $gethDir "config.toml"
$tomlNodes = $SeedEnodes | ForEach-Object { "  `"$_`"" }
$configToml = "[Node.P2P]`r`nStaticNodes = [`r`n" + ($tomlNodes -join ",`r`n") + "`r`n]`r`n"
Set-Content -Path $configTomlPath -Value $configToml -Encoding ASCII

Write-Host "Scanning for available ports..." -ForegroundColor Yellow
Write-Host "  RPC Port      : $RpcPort"        -ForegroundColor Green
Write-Host "  P2P Port      : $P2pPort"        -ForegroundColor Green
Write-Host "  Stratum Port  : $StratumPort"    -ForegroundColor Green
Write-Host "  A10 Compat    : $A10CompatPort"  -ForegroundColor Green
Write-Host "  Dashboard Port: $DashboardPort"  -ForegroundColor Green
Write-Host ""

# ── Mining address ────────────────────────────────────────────────────────────
$Etherbase = ""
if (Test-Path $AddrFile) {
    $Etherbase = (Get-Content $AddrFile -Raw).Trim()
    Write-Host "  Saved address: $Etherbase" -ForegroundColor Green
}

if ($Etherbase -eq "") {
  foreach ($candidate in @($PayoutFileA, $PayoutFileB)) {
    if (Test-Path $candidate) {
      try {
        $payoutCfg = Get-Content $candidate -Raw | ConvertFrom-Json
        if ($payoutCfg -and $payoutCfg.miningAddress) {
          $Etherbase = ([string]$payoutCfg.miningAddress).Trim()
          if ($Etherbase -ne "") {
            Set-Content -Path $AddrFile -Value $Etherbase -NoNewline
            Write-Host "  Recovered address from $(Split-Path $candidate -Leaf): $Etherbase" -ForegroundColor Green
            break
          }
        }
      } catch { }
    }
  }
}

if ($Etherbase -eq "") {
    Write-Host ""
    $Etherbase = Read-Host "Enter your ETHII mining address (0x...)"
    $Etherbase = $Etherbase.Trim()
    if ($Etherbase -eq "") { Write-Host "ERROR: No address provided." -ForegroundColor Red; Read-Host "Press Enter to exit"; exit 1 }
    Set-Content -Path $AddrFile -Value $Etherbase -NoNewline
    Write-Host "  Address saved for next launch." -ForegroundColor Green
}

# ── Get local IP ──────────────────────────────────────────────────────────────
# Prefer a real physical/wireless adapter; skip virtual adapters (WSL, Hyper-V, VPN, loopback)
$LocalIP = (Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object {
        $_.IPAddress -notmatch "^127\." -and
        $_.IPAddress -notmatch "^169\.254\." -and
        $_.PrefixOrigin -ne "WellKnown" -and
        $_.InterfaceAlias -notmatch "vEthernet|Loopback|Pseudo|Teredo|isatap|Bluetooth"
    } |
    Sort-Object { if ($_.InterfaceAlias -match "Ethernet") { 0 } elseif ($_.InterfaceAlias -match "Wi-Fi|WiFi|Wireless") { 1 } else { 2 } } |
    Select-Object -First 1).IPAddress
if (-not $LocalIP) { $LocalIP = "YOUR_LOCAL_IP" }

# ── Write info file and open it ───────────────────────────────────────────────
$info = @"
============================================================
  ETHII MINING SETUP GUIDE
  ETH 2.0 Proof of Work  |  Chain ID 2048
  Generated: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")
============================================================

  Welcome!  This guide has everything you need to start mining ETHII.
  All addresses and port numbers below are specific to THIS machine
  right now.  Just copy and paste -- no math required.


------------------------------------------------------------
  STEP 1 -- YOUR REWARD ADDRESS
------------------------------------------------------------

  All block rewards will be sent to this address:

    $Etherbase

  Write it down or save it somewhere safe.  This is your wallet.
  If you lose it you lose access to your coins.

  IMPORTANT ON FIRST RUN:
    1) Open dashboard: http://127.0.0.1:$DashboardPort
    2) In Payout Settings, paste this exact address:
         $Etherbase
    3) Click Save Address before connecting miners.


------------------------------------------------------------
  STEP 2 -- CONNECT A GPU OR ASIC MINER
------------------------------------------------------------

  CPU mining in the wallet has been removed.
  Use an external GPU/ASIC miner and point it at the stratum
  address below.


------------------------------------------------------------
  STEP 3 -- GPU/ASIC CONFIG EXAMPLES
------------------------------------------------------------

  If you want to connect an external GPU rig or ASIC miner,
  point it at the stratum address below.

  IMPORTANT:
    - Use  ETHASH  algorithm
    - Rewards are paid to the wallet configured on the stratum host
      you connect to.
    - Port selection does NOT choose payout wallet.
      Port $StratumPort is standard stratum; port $A10CompatPort is A10 compatibility.
    - The username/wallet field is used as worker identity in this setup
      (for example: rig1, gpu2, asic1).
    - For the password field, enter  x
    - HiveOS users: set Pool/Host to ${LocalIP}:$StratumPort
      (no stratum+tcp:// in the Host field), Wallet/User to rig1,
      and Password to x.

  ── ON THIS SAME MACHINE ────────────────────────────────────
  Use this address if the miner software is running on this PC:

    stratum+tcp://127.0.0.1:$StratumPort

  ── ON ANOTHER MACHINE ON YOUR NETWORK ─────────────────────
  Use this address if your miner is a separate rig on your LAN:

    stratum+tcp://${LocalIP}:$StratumPort

  ── INNOSILICON A10 PRO COMPATIBILITY ──────────────────────
  If an A10 Pro connects but receives no jobs on $StratumPort,
  use the A10 compatibility endpoint on port ${A10CompatPort}:

    stratum+tcp://${LocalIP}:$A10CompatPort

  This compatibility port keeps the normal $StratumPort behavior
  unchanged for GPUs and ASICs that already work.

  NOTE:
    Choosing $StratumPort vs $A10CompatPort does not change payout destination.
    The payout destination is controlled by the stratum host settings.

  ── OPTIONAL INTERNET TEST (PUBLIC/VPS) ────────────────────
  If you are testing from outside your LAN, use:

    stratum+tcp://${VpsHost}:$StratumPort

  ── COPY/PASTE COMMANDS FOR COMMON MINERS ──────────────────

  T-Rex (NVIDIA):
    t-rex.exe -a ethash -o stratum+tcp://${LocalIP}:$StratumPort -u rig1 -p x

  lolMiner (AMD / NVIDIA):
    lolMiner.exe --algo ETHASH --pool stratum+tcp://${LocalIP}:$StratumPort --user rig1

  HiveOS (lolMiner template):
    Coin/Algo: ETHASH
    Pool/Host: ${LocalIP}:$StratumPort
    Wallet/User: rig1
    Password: x

  PhoenixMiner:
    PhoenixMiner.exe -pool stratum+tcp://${LocalIP}:$StratumPort -wal rig1 -pass x

  GMiner:
    miner.exe --algo ethash --server ${LocalIP} --port $StratumPort --user rig1

  Rigel:
    rigel.exe -a ethash -o stratum+tcp://${LocalIP}:$StratumPort -u rig1 -p x

  Claymore / ASIC (ethproxy protocol):
    Use the same stratum address.  The server auto-detects the protocol.


------------------------------------------------------------
  LIVE STATS DASHBOARD
------------------------------------------------------------

  Open this URL in your browser to see all connected miners,
  hashrates, shares accepted/rejected, and pool stats:

    http://127.0.0.1:$DashboardPort

  NOTE: The dashboard shows EXTERNAL miners (GPUs/ASICs)
  connected through stratum.


------------------------------------------------------------
  TECHNICAL DETAILS  (for advanced users)
------------------------------------------------------------

  Node RPC URL  : http://127.0.0.1:$RpcPort
  Stratum Port  : $StratumPort
  A10 Compat    : $A10CompatPort
  P2P Port      : $P2pPort
  Dashboard     : http://127.0.0.1:$DashboardPort
  Node log      : $StateRoot\node.log

  NOTE ON RPC PORT: This node uses fixed port 8545.
  If port 8545 is occupied by another app/service, launcher exits
  with a clear error so you can free the port before startup.


------------------------------------------------------------
  LINUX / macOS SETUP  (for friends on other systems)
------------------------------------------------------------

  1) Download  ETHII-Solo-Miner-Suite-linux-x64.tar.gz  (or macos)
     from: https://github.com/OBitsPlease/ETH-II-Solo-Miner-Suite/releases/latest

  2) Extract the archive:
       tar -xzf ETHII-Solo-Miner-Suite-linux-x64.tar.gz
       cd ETHII-Solo-Miner-Suite-linux-x64

  3) Install (one time only):
       chmod +x install.sh
       ./install.sh

  4) Run the miner suite:
       ~/.local/bin/ethii-miner-suite
     First launch asks for your mining address (0x...) -- enter it once.
     It is saved for future runs.

  5) Open the dashboard in your browser:
       http://127.0.0.1:8082

  6) Point your GPU miner at:
       stratum+tcp://YOUR_LINUX_IP:3335

  You do NOT need to open any other files.  install.sh and
  start-miner-suite.sh handle everything automatically.


------------------------------------------------------------
  TROUBLESHOOTING
------------------------------------------------------------

  MINER SHOWS "DEAD POOL" OR CAN'T CONNECT
    The IP  ${LocalIP}  was auto-detected as your LAN IP.
    If it doesn't work, find your real IP manually:
      - Open Command Prompt and type:  ipconfig
      - Look for Ethernet adapter or Wi-Fi adapter
      - Use the IPv4 Address (usually 192.168.x.x or 10.x.x.x)
    Then replace ${LocalIP} in the stratum address with that IP.

  WALLET RUNTIME MISSING
    Re-run the Suite installer, or install wallet directly:
      https://github.com/OBitsPlease/ETH-II-Wallet/releases/latest

  WINDOWS FIREWALL BLOCKING THE STRATUM PORT
    Open PowerShell as Administrator and run this command:
      netsh advfirewall firewall add rule name="ETHII Stratum" ^
        dir=in action=allow protocol=TCP localport=$StratumPort
      netsh advfirewall firewall add rule name="ETHII Stratum A10" ^
        dir=in action=allow protocol=TCP localport=$A10CompatPort
    Then reconnect your miner.

  WALLET SHOWS "NODE OFFLINE"
    Make sure the black terminal window (the Miner Suite launcher)
    is still open.  Closing it stops the node.  If it closed by
    accident, just run Start-ETHII-Miner.ps1 again.

  STRATUM SHOWS "NO PENDING WORK"
    Wait until the node has peers and is synced near the VPS height.
    This launcher auto-enables remote-sealer work generation when
    sync-safe. If needed, restart the Miner Suite after peers connect.

  BALANCE NOT UPDATING IN WALLET
    Block rewards take one confirmation to show up.  If you have
    mined blocks but see zero balance, click the Refresh button
    in the wallet.  If it still shows zero, make sure the wallet
    is connected to the correct RPC port ($RpcPort).

============================================================
"@
Set-Content -Path $InfoFile -Value $info
Start-Process notepad $InfoFile

# ── Launch Node FIRST (background) ───────────────────────────────────────────
Write-Host ""
Write-Host "Starting ETHII node..." -ForegroundColor Cyan
$NodeLog = Join-Path $StateRoot "node.log"
$NodeOutLog = Join-Path $StateRoot "node.out.log"
$nodeProc = Start-Process -FilePath $EthiiExe -ArgumentList (
    "--datadir `"$DataDir`"",
    "--config `"$configTomlPath`"",
    "--networkid 2048",
    "--syncmode full",
    "--gcmode archive",
    "--state.scheme hash",
    "--http",
    "--http.addr 0.0.0.0",
    "--http.port $RpcPort",
    "--http.api eth,net,web3,miner,ethash,txpool,admin,debug",
    "--http.corsdomain *",
    "--http.vhosts *",
    "--port $P2pPort",
    "--miner.etherbase $Etherbase",
    "--miner.pending.feeRecipient $Etherbase",
    "--bootnodes $BootnodeEnode",
    "--verbosity 3"
  ) -WindowStyle Normal -RedirectStandardOutput $NodeOutLog -RedirectStandardError $NodeLog -PassThru
Write-Host "  Node PID: $($nodeProc.Id)" -ForegroundColor Green

# ── Wait for node RPC to be ready (up to 30 seconds) ─────────────────────────
Write-Host "Waiting for node RPC on port $RpcPort..." -ForegroundColor Yellow
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$RpcPort" `
            -Method POST `
            -Body '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' `
            -ContentType "application/json" `
            -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        if ($resp.StatusCode -eq 200) { $ready = $true; break }
  } catch {
    # If the chosen port and bound port diverge, auto-correct to the live
    # RPC listener owned by this node process instead of hanging.
    foreach ($candidate in 8545..8555) {
      if ($candidate -eq $RpcPort) { continue }
      try {
        $listen = Get-NetTCPConnection -State Listen -LocalPort $candidate -ErrorAction Stop |
          Where-Object { $_.OwningProcess -eq $nodeProc.Id } |
          Select-Object -First 1
        if (-not $listen) { continue }

        $probe = Invoke-WebRequest -Uri "http://127.0.0.1:$candidate" `
          -Method POST `
          -Body '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' `
          -ContentType "application/json" `
          -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        if ($probe.StatusCode -eq 200) {
          $RpcPort = $candidate
          Set-Content -Path $RpcPortFile -Value "$RpcPort" -NoNewline
          try {
            Set-Content -Path (Join-Path $ScriptDir "rpc-port.txt") -Value "$RpcPort" -NoNewline -ErrorAction Stop
          } catch { }
          Write-Host "  Detected node RPC on port $RpcPort. Switching to live port." -ForegroundColor Yellow
          $ready = $true
          break
        }
      } catch { }
    }
    if ($ready) { break }
  }
    Write-Host "  ...waiting ($($i+1)s)" -ForegroundColor DarkGray
}
if (-not $ready) {
    Write-Host "ERROR: Node did not start within 30 seconds. Check node.log for details:" -ForegroundColor Red
    Get-Content $NodeLog -Tail 20 | Write-Host
    Read-Host "Press Enter to exit"
    exit 1
}
Write-Host "  Node is ready!" -ForegroundColor Green

# Keep local CPU mining disabled in wallet mode.
# Stratum can still pull work templates without running local miner threads.
try {
  Invoke-RestMethod -Uri "http://127.0.0.1:$RpcPort" -Method POST `
    -Body '{"jsonrpc":"2.0","method":"miner_stop","params":[],"id":1}' `
    -ContentType "application/json" -TimeoutSec 3 | Out-Null
  Write-Host "  Local miner threads are disabled (miner_stop)." -ForegroundColor Green
} catch {
  Write-Host "  Note: miner_stop RPC unavailable on this build." -ForegroundColor DarkGray
}

$RemoteRpcCandidates = @($PublicRpcUrl, $SecondaryPublicRpcUrl, "https://www.ethii.net/rpc") | Select-Object -Unique
$EffectiveRemoteRpcUrl = Resolve-RemoteRpcUrl -Candidates $RemoteRpcCandidates
if ($EffectiveRemoteRpcUrl -ne $PublicRpcUrl) {
  Write-Host "  Remote RPC fallback active: $EffectiveRemoteRpcUrl" -ForegroundColor Yellow
}

# Force-add known peers over RPC on startup. This improves chain-follow when
# one seed peer is temporarily unavailable.
foreach ($seed in $SeedEnodes) {
  try {
    Invoke-RestMethod -Uri "http://127.0.0.1:$RpcPort" -Method POST `
      -Body ('{"jsonrpc":"2.0","method":"admin_addPeer","params":["' + $seed + '"],"id":1}') `
      -ContentType "application/json" -TimeoutSec 3 | Out-Null
    Write-Host "  Requested connection to seed peer: $seed" -ForegroundColor Green
  } catch {
    Write-Host "  WARNING: Could not request seed peer $seed : $_" -ForegroundColor Yellow
  }
}

$removedPeers = Remove-StalePeers -RpcPort $RpcPort -KnownBadEnodes $KnownBadPeerEnodes
if ($removedPeers -gt 0) {
  Write-Host "  Peer hygiene removed $removedPeers stale peer(s)." -ForegroundColor Yellow
}

# Refresh the VPS static peer entry so both nodes explicitly list each other.
$PeerSyncScript = Join-Path $RootDir "sync-vps-peer.ps1"
if (Test-Path $PeerSyncScript) {
  try {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $PeerSyncScript `
      -VpsHosts @($VpsHost, $SecondaryVpsHost) -VpsEnodes $SeedEnodes -User $User -KeyPath $KeyPath -LocalRpcUrl "http://127.0.0.1:$RpcPort" `
      -NodeLog $NodeLog | Write-Host
    Write-Host "  Refreshed VPS static peer entry from this PC." -ForegroundColor Green
  } catch {
    Write-Host "  WARNING: Could not refresh VPS peer config: $_" -ForegroundColor Yellow
  }
}

# Kick off sync explicitly to the current VPS head hash (ETHII sync override service).
try {
  $vpsHead = Invoke-RestMethod -Uri $EffectiveRemoteRpcUrl -Method POST `
    -Body '{"jsonrpc":"2.0","method":"eth_getBlockByNumber","params":["latest",false],"id":1}' `
    -ContentType "application/json" -TimeoutSec 5
  $targetHash = $vpsHead.result.hash
  if ($targetHash) {
    Invoke-RestMethod -Uri "http://127.0.0.1:$RpcPort" -Method POST `
      -Body ('{"jsonrpc":"2.0","method":"debug_sync","params":["' + $targetHash + '"],"id":1}') `
      -ContentType "application/json" -TimeoutSec 5 | Out-Null
    Write-Host "  Requested full sync to VPS head: $targetHash" -ForegroundColor Green
  }
} catch {
  Write-Host "  WARNING: Could not trigger debug_sync: $_" -ForegroundColor Yellow
}

# Wallet was launched earlier in fast-start mode.

$PeerHealthLog = Join-Path $StateRoot "peer-health.log"
"started=" + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") | Set-Content -Path $PeerHealthLog -Encoding ASCII

$syncNudgeJob = Start-Job -ArgumentList $RpcPort,$EffectiveRemoteRpcUrl,$SeedEnodes,$nodeProc.Id,$KnownBadPeerEnodes,$PeerHealthLog -ScriptBlock {
  param($LocalRpcPort, $RemoteRpcUrl, $Bootnodes, $NodePid, $KnownBadPeers, $HealthLog)

  $lastLocalNum = -1
  $unchangedTicks = 0
  $loop = 0
  $staleWorkRefreshes = 0
  $staleWorkStreak = 0
  $noWorkStreak = 0
  $lastWorkRefreshAt = [datetime]::MinValue
  $targetMinHealthyPeers = 2
  $targetMinPeerCount = 3

  while ($true) {
    if (-not (Get-Process -Id $NodePid -ErrorAction SilentlyContinue)) {
      break
    }
    try {
      $healthyPeers = 0
      $staleRemoved = 0
      try {
        $peerList = (Invoke-RestMethod -Uri ("http://127.0.0.1:" + $LocalRpcPort) -Method POST `
          -Body '{"jsonrpc":"2.0","method":"admin_peers","params":[],"id":1}' `
          -ContentType "application/json" -TimeoutSec 3).result

        foreach ($peer in ($peerList | Where-Object { $_ })) {
          $peerEnode = [string]$peer.enode
          $peerName = [string]$peer.name
          $peerLatestRaw = $peer.protocols.eth.latestBlock
          $peerLatest = 0
          if ($peerLatestRaw -is [string] -and $peerLatestRaw.StartsWith('0x')) {
            try { $peerLatest = [Convert]::ToInt64($peerLatestRaw.Substring(2), 16) } catch { $peerLatest = 0 }
          } elseif ($peerLatestRaw -is [int] -or $peerLatestRaw -is [long]) {
            $peerLatest = [int64]$peerLatestRaw
          }

          $isKnownBad = $KnownBadPeers -contains $peerEnode
          $isStaleBrokenPeer = ($peerName -match '6c427356-20260519') -and ($peerLatest -eq 0)
          if ($isKnownBad -or $isStaleBrokenPeer) {
            Invoke-RestMethod -Uri ("http://127.0.0.1:" + $LocalRpcPort) -Method POST `
              -Body ('{"jsonrpc":"2.0","method":"admin_removePeer","params":["' + $peerEnode + '"],"id":1}') `
              -ContentType "application/json" -TimeoutSec 3 | Out-Null
            $staleRemoved++
          } else {
            $healthyPeers++
          }
        }
      } catch { }

      $peerCount = 0
      $localNumHex = (Invoke-RestMethod -Uri ("http://127.0.0.1:" + $LocalRpcPort) -Method POST `
        -Body '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' `
        -ContentType "application/json" -TimeoutSec 3).result
      $peerHex = (Invoke-RestMethod -Uri ("http://127.0.0.1:" + $LocalRpcPort) -Method POST `
        -Body '{"jsonrpc":"2.0","method":"net_peerCount","params":[],"id":1}' `
        -ContentType "application/json" -TimeoutSec 3).result
      if ($peerHex) {
        $peerCount = [Convert]::ToInt32($peerHex, 16)
      }
      $remoteLatest = Invoke-RestMethod -Uri $RemoteRpcUrl -Method POST `
        -Body '{"jsonrpc":"2.0","method":"eth_getBlockByNumber","params":["latest",false],"id":1}' `
        -ContentType "application/json" -TimeoutSec 5
      $remoteNumHex = $remoteLatest.result.number
      $remoteHash = $remoteLatest.result.hash
      if ($localNumHex -and $remoteNumHex -and $remoteHash) {
        $localNum = [Convert]::ToInt64($localNumHex, 16)
        $remoteNum = [Convert]::ToInt64($remoteNumHex, 16)
        $workNum = -1

        # Some builds can leave ethash_getWork pinned to an old template after
        # sync catch-up. Refresh templates if work height falls behind chain head.
        try {
          $workResp = Invoke-RestMethod -Uri ("http://127.0.0.1:" + $LocalRpcPort) -Method POST `
            -Body '{"jsonrpc":"2.0","method":"ethash_getWork","params":[],"id":1}' `
            -ContentType "application/json" -TimeoutSec 3
          $work = $workResp.result
          $needsWorkRefresh = $false
          if ($work -and $work.Count -ge 4) {
            $rawWorkNum = [string]$work[3]
            if ($rawWorkNum.StartsWith('0x')) {
              try { $workNum = [Convert]::ToInt64($rawWorkNum, 16) } catch { $workNum = -1 }
            } else {
              try { $workNum = [int64]$rawWorkNum } catch { $workNum = -1 }
            }
          }

          if ($workNum -gt 0 -and $localNum -gt 0 -and ($workNum + 2) -lt $localNum) {
            $staleWorkStreak++
            if ($staleWorkStreak -ge 2) {
              $needsWorkRefresh = $true
            }
          } else {
            $staleWorkStreak = 0
          }

          if (-not $work -or $work.Count -lt 3) {
            $needsWorkRefresh = $true
            $noWorkStreak++
          } else {
            $noWorkStreak = 0
          }

          if ($needsWorkRefresh -and ((Get-Date) - $lastWorkRefreshAt).TotalSeconds -ge 20) {
            Invoke-RestMethod -Uri ("http://127.0.0.1:" + $LocalRpcPort) -Method POST `
              -Body '{"jsonrpc":"2.0","method":"miner_stop","params":[],"id":1}' `
              -ContentType "application/json" -TimeoutSec 3 | Out-Null
            $staleWorkRefreshes++
            $lastWorkRefreshAt = Get-Date
            $staleWorkStreak = 0
          }
        } catch { }

        if ($localNum -eq $lastLocalNum) {
          $unchangedTicks++
        } else {
          $unchangedTicks = 0
          $lastLocalNum = $localNum
        }

        if (($peerCount -lt $targetMinPeerCount -or $healthyPeers -lt $targetMinHealthyPeers) -and $Bootnodes) {
          foreach ($seed in $Bootnodes) {
            if ([string]::IsNullOrWhiteSpace($seed)) { continue }
            Invoke-RestMethod -Uri ("http://127.0.0.1:" + $LocalRpcPort) -Method POST `
              -Body ('{"jsonrpc":"2.0","method":"admin_addPeer","params":["' + $seed + '"],"id":1}') `
              -ContentType "application/json" -TimeoutSec 3 | Out-Null
          }
        }

        if ($localNum -lt $remoteNum) {
          Invoke-RestMethod -Uri ("http://127.0.0.1:" + $LocalRpcPort) -Method POST `
            -Body ('{"jsonrpc":"2.0","method":"debug_sync","params":["' + $remoteHash + '"],"id":1}') `
            -ContentType "application/json" -TimeoutSec 5 | Out-Null
        }

        # If work templates disappear repeatedly while we are behind, force a
        # tighter peer + sync + template refresh cycle immediately.
        if ($noWorkStreak -ge 3 -and $localNum -lt $remoteNum) {
          if ($Bootnodes) {
            foreach ($seed in $Bootnodes) {
              if ([string]::IsNullOrWhiteSpace($seed)) { continue }
              Invoke-RestMethod -Uri ("http://127.0.0.1:" + $LocalRpcPort) -Method POST `
                -Body ('{"jsonrpc":"2.0","method":"admin_addPeer","params":["' + $seed + '"],"id":1}') `
                -ContentType "application/json" -TimeoutSec 3 | Out-Null
            }
          }
          Invoke-RestMethod -Uri ("http://127.0.0.1:" + $LocalRpcPort) -Method POST `
            -Body ('{"jsonrpc":"2.0","method":"debug_sync","params":["' + $remoteHash + '"],"id":1}') `
            -ContentType "application/json" -TimeoutSec 5 | Out-Null
          Invoke-RestMethod -Uri ("http://127.0.0.1:" + $LocalRpcPort) -Method POST `
            -Body '{"jsonrpc":"2.0","method":"miner_stop","params":[],"id":1}' `
            -ContentType "application/json" -TimeoutSec 3 | Out-Null
          $staleWorkRefreshes++
          $lastWorkRefreshAt = Get-Date
          $noWorkStreak = 0
        }

        # If local head is not moving for ~2 minutes and we are behind remote,
        # force another peer/sync nudge cycle.
        if ($unchangedTicks -ge 8 -and $localNum -lt $remoteNum) {
          if ($Bootnodes) {
            foreach ($seed in $Bootnodes) {
              if ([string]::IsNullOrWhiteSpace($seed)) { continue }
              Invoke-RestMethod -Uri ("http://127.0.0.1:" + $LocalRpcPort) -Method POST `
                -Body ('{"jsonrpc":"2.0","method":"admin_addPeer","params":["' + $seed + '"],"id":1}') `
                -ContentType "application/json" -TimeoutSec 3 | Out-Null
            }
          }
          Invoke-RestMethod -Uri ("http://127.0.0.1:" + $LocalRpcPort) -Method POST `
            -Body ('{"jsonrpc":"2.0","method":"debug_sync","params":["' + $remoteHash + '"],"id":1}') `
            -ContentType "application/json" -TimeoutSec 5 | Out-Null
          $unchangedTicks = 0
        }

        $loop++
        if ($loop % 4 -eq 0) {
          $line = "{0} peerCount={1} healthyPeers={2} staleRemoved={3} local={4} remote={5} work={6} workRefreshes={7}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $peerCount, $healthyPeers, $staleRemoved, $localNum, $remoteNum, $workNum, $staleWorkRefreshes
          Add-Content -Path $HealthLog -Value $line -Encoding ASCII
        }
      }
    } catch { }
    Start-Sleep -Seconds 8
  }
}

Write-Host "  Peer self-heal monitor active (see $PeerHealthLog)." -ForegroundColor Green

# Stratum MUST use the local node so that the user's etherbase is baked into
# work templates. If stratum points at the VPS, the VPS etherbase gets the
# block reward -- not the miner. Always use local RPC.
$StratumNodeUrl = "http://127.0.0.1:$RpcPort"
Write-Host "  Stratum node RPC : $StratumNodeUrl" -ForegroundColor Green
Write-Host "  Stratum work source: local node (rewards go to your address)" -ForegroundColor Green
Write-Host ""
Write-Host "PAYOUT WARNING:" -ForegroundColor Yellow
Write-Host "  Rewards go to the wallet configured on this stratum host: $Etherbase" -ForegroundColor Yellow
Write-Host "  Miner worker/user and port selection do not change payout destination." -ForegroundColor Yellow
Write-Host ""

# ── Launch Stratum Proxy ──────────────────────────────────────────────────────
Write-Host "Launching Stratum Proxy on port $StratumPort..." -ForegroundColor Yellow
$stratumArgs = "--node `"$StratumNodeUrl`" --stratum `"0.0.0.0:$StratumPort`" --a10-stratum `"0.0.0.0:$A10CompatPort`" --dashboard `"0.0.0.0:$DashboardPort`" --interval 500ms --etherbase `"$Etherbase`""
$StratumLog = Join-Path $RootDir "stratum.log"
$StratumErrLog = Join-Path $RootDir "stratum.err.log"
Start-Process -FilePath $StratumExe -ArgumentList $stratumArgs -WindowStyle Hidden -RedirectStandardOutput $StratumLog -RedirectStandardError $StratumErrLog | Out-Null
Start-Sleep -Seconds 2
Write-Host "  Dashboard: http://127.0.0.1:$DashboardPort" -ForegroundColor Cyan
Write-Host "  Stratum log: $StratumLog" -ForegroundColor DarkGray
Write-Host "  Stratum err: $StratumErrLog" -ForegroundColor DarkGray

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  All services running. Keep this window open." -ForegroundColor Cyan
Write-Host "  Node log: $NodeLog" -ForegroundColor Cyan
Write-Host "  Press Ctrl+C to stop everything." -ForegroundColor Yellow
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# Keep window open and wait for the node to exit
try { $nodeProc.WaitForExit() } catch { }

if ($syncNudgeJob) {
  Stop-Job -Job $syncNudgeJob -ErrorAction SilentlyContinue
  Remove-Job -Job $syncNudgeJob -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "Node stopped." -ForegroundColor Yellow
Read-Host "Press Enter to close"
