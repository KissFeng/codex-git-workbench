param(
  [switch]$Codex,
  [switch]$Antigravity,
  [switch]$All,
  [string]$Ref = "main",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$Repo = "KissFeng/git-workbench"
$Marketplace = "kissfeng-git-tools"
$Plugin = "codex-git-workbench@$Marketplace"

$HasCodexCli = [bool](Get-Command codex -ErrorAction SilentlyContinue)
$AgDataDir = if ($env:ANTIGRAVITY_APP_DATA_DIR) { $env:ANTIGRAVITY_APP_DATA_DIR } else { Join-Path $HOME ".gemini\antigravity" }
$GeminiConfigDir = Join-Path $HOME ".gemini\config"
$HasAntigravity = (Test-Path $AgDataDir) -or (Test-Path $GeminiConfigDir)

$WantCodex = $All -or $Codex
$WantAntigravity = $All -or $Antigravity
if (-not $WantCodex -and -not $WantAntigravity) {
  $WantCodex = $HasCodexCli
  $WantAntigravity = $HasAntigravity
}

if (-not $WantCodex -and -not $WantAntigravity) {
  Write-Error "Neither Codex CLI nor Antigravity was detected. Pass -Codex, -Antigravity, or -All to install explicitly."
  exit 1
}

if ($WantCodex) {
  if (-not $HasCodexCli -and -not $DryRun) {
    Write-Error "Codex CLI ('codex') was not found on PATH."
    exit 1
  }
  Write-Host "[git-workbench] Installing for Codex (ref: $Ref)..."
  if ($DryRun) {
    Write-Host "[dry-run] codex plugin marketplace add $Repo --ref $Ref"
    Write-Host "[dry-run] codex plugin add $Plugin"
  } else {
    try { codex plugin marketplace remove $Marketplace | Out-Null } catch {}
    codex plugin marketplace add $Repo --ref $Ref
    codex plugin add $Plugin
    Write-Host "[git-workbench] Codex plugin installed. Fully quit and reopen Codex desktop."
  }
}

if ($WantAntigravity) {
  Write-Host "[git-workbench] Installing for Antigravity (ref: $Ref)..."
  if ($DryRun) {
    Write-Host "[dry-run] Download https://github.com/$Repo/archive/$Ref.zip and run node scripts/install-antigravity.mjs --install"
  } else {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
      Write-Error "Node.js is required to install the Antigravity plugin."
      exit 1
    }
    $TmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("git-workbench-" + [System.Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $TmpDir | Out-Null
    try {
      $ZipPath = Join-Path $TmpDir "repo.zip"
      Invoke-WebRequest -Uri "https://github.com/$Repo/archive/$Ref.zip" -OutFile $ZipPath -UseBasicParsing
      Expand-Archive -Path $ZipPath -DestinationPath $TmpDir -Force
      $SrcDir = Get-ChildItem -Path $TmpDir -Directory | Select-Object -First 1
      $Installer = Join-Path $SrcDir.FullName "scripts\install-antigravity.mjs"
      if (-not (Test-Path $Installer)) {
        throw "Failed to locate Antigravity installer in downloaded archive (ref: $Ref)."
      }
      node $Installer --install
      Write-Host "[git-workbench] Antigravity plugin installed. Open Git Workbench from the right auxiliary pane."
    } finally {
      Remove-Item -Path $TmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}
