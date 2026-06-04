@echo off
:: Launch ETHII Wallet
:: Clears ELECTRON_RUN_AS_NODE only for this process - does NOT affect system or other apps
set ELECTRON_RUN_AS_NODE=
cd /d "%~dp0"
if exist "..\repair-shortcuts.ps1" (
	powershell -NoProfile -ExecutionPolicy Bypass -File "..\repair-shortcuts.ps1" -Quiet
)
if exist "..\update-manager.ps1" (
	powershell -NoProfile -ExecutionPolicy Bypass -File "..\update-manager.ps1" -Mode auto -SkipSuite
)
if not exist "node_modules\electron\dist\electron.exe" if not exist "%LOCALAPPDATA%\Programs\ETH II Wallet\ETH II Wallet.exe" (
	echo Wallet runtime not found. Attempting bundled wallet install...
	if exist "..\ETHII-Wallet-Setup.exe" (
		start /wait "" "..\ETHII-Wallet-Setup.exe" /S
	)
)
if not exist "node_modules\electron\dist\electron.exe" if not exist "%LOCALAPPDATA%\Programs\ETH II Wallet\ETH II Wallet.exe" (
	echo Bundled wallet install not found or failed. Attempting wallet auto-update...
	if exist "..\update-manager.ps1" (
		powershell -NoProfile -ExecutionPolicy Bypass -File "..\update-manager.ps1" -Mode apply -SkipSuite -NonInteractive
	)
)
if exist "node_modules\electron\dist\electron.exe" (
	node_modules\electron\dist\electron.exe .
) else if exist "%LOCALAPPDATA%\Programs\ETH II Wallet\ETH II Wallet.exe" (
	start "" "%LOCALAPPDATA%\Programs\ETH II Wallet\ETH II Wallet.exe"
) else (
	echo ERROR: Wallet runtime not found.
	echo Missing: %~dp0node_modules\electron\dist\electron.exe
	echo Missing: %LOCALAPPDATA%\Programs\ETH II Wallet\ETH II Wallet.exe
	echo Download latest wallet installer: https://github.com/OBitsPlease/ETH-II-Wallet/releases/latest
	pause
	exit /b 1
)
