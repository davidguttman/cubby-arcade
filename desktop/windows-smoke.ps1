$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
$evidence = Join-Path $root 'dist/windows-smoke'
$fixture = Join-Path $env:RUNNER_TEMP 'cubby-smoke-fixture'
uv run python (Join-Path $PSScriptRoot 'smoke-fixture.py') $fixture
if ($LASTEXITCODE -ne 0) { throw 'Fixture generation failed' }
$env:CUBBY_ARCADE_SMOKE_INSTALL_DIR = $fixture
$env:CUBBY_ARCADE_SMOKE_UNINSTALL_PACKAGE = Join-Path $root 'hosting/releases/line-cutter/0.2.1/line-cutter-0.2.1.game.zip'
$env:CUBBY_ARCADE_SMOKE_OFFLINE = '1'
$exe = Join-Path $root 'dist/CubbyArcade-win32-x64/CubbyArcade.exe'
foreach ($mode in @('install', 'uninstall')) {
    $env:CUBBY_ARCADE_USER_DATA = Join-Path $env:RUNNER_TEMP ("cubby-$mode-" + [guid]::NewGuid())
    $env:CUBBY_ARCADE_SMOKE_DIR = Join-Path $evidence $mode
    New-Item -ItemType Directory -Force $env:CUBBY_ARCADE_SMOKE_DIR | Out-Null
    $process = Start-Process -FilePath $exe -ArgumentList "--$mode-smoke", '--disable-gpu' -PassThru -RedirectStandardOutput (Join-Path $env:CUBBY_ARCADE_SMOKE_DIR 'stdout.log') -RedirectStandardError (Join-Path $env:CUBBY_ARCADE_SMOKE_DIR 'stderr.log')
    if (-not $process.WaitForExit(120000)) { throw "$mode smoke exceeded 120 seconds" }
    $process.Refresh()
    Get-Content (Join-Path $env:CUBBY_ARCADE_SMOKE_DIR 'stdout.log')
    Get-Content (Join-Path $env:CUBBY_ARCADE_SMOKE_DIR 'stderr.log')
    if ($process.ExitCode -ne 0) { throw "$mode smoke exited $($process.ExitCode)" }
    $report = Get-Content -Raw (Join-Path $env:CUBBY_ARCADE_SMOKE_DIR "$mode-report.json") | ConvertFrom-Json
    $checks = if ($mode -eq 'install') { @('nativeInstall','retry','progress','play','fileManifest','unchangedFilesReused','fileGamePlayable','deferredUpdate','corruptPreserved','offlinePlayable') } else { @('uninstall','cancelDefault','repeatSafe','backCancels','retry','bytesRemoved','savesPreserved','favoritesPreserved','tokensPreserved','reinstall','gameIPCRejected') }
    foreach ($check in $checks) { if ($report.$check -ne $true) { throw "$mode smoke failed $check" } }
    if ($mode -eq 'install' -and -not ($report.versions | Where-Object { $_.id -eq 'demo' -and $_.version -eq '3' })) { throw 'Updated version missing' }
    if (@(Get-ChildItem $env:CUBBY_ARCADE_SMOKE_DIR -Filter '*.png').Count -lt 2) { throw "$mode screenshots missing" }
}
