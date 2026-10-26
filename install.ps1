<#
.SYNOPSIS
Install opencode-github-sync on Windows and open its menu.

.DESCRIPTION
  irm https://raw.githubusercontent.com/doomsday616/opencode-github-sync/main/install.ps1 | iex

  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/doomsday616/opencode-github-sync/main/install.ps1))) -Mode auto -Repo owner/name

What it does, and nothing else:
  1. checks for Node.js 18+ and git, and offers to install a missing one with
     winget (it asks first; it never installs anything silently)
  2. npm install -g opencode-github-sync@latest
  3. starts opencode-sync: the interactive menu, or a non-interactive setup
     when -Mode is given

Works in Windows PowerShell 5.1 and PowerShell 7. Running through `irm | iex`
does not touch the execution policy, because no script file is executed.

.PARAMETER Mode
cli: install only. link: link -Repo. auto: link and make this the primary
device with autosync.

.PARAMETER Repo
Repository to link, as owner/name or any git URL.

.PARAMETER Interval
Autosync interval in minutes (minimum 2).

.PARAMETER Lang
Interface language: en or zh-CN.

.PARAMETER Proxy
HTTP(S) proxy for npm and git during the install and for later syncs.

.PARAMETER Yes
Do not ask before installing missing prerequisites.

.PARAMETER Package
npm package spec to install. Default: opencode-github-sync@latest.

.PARAMETER DryRun
Print what would run and exit.
#>
[CmdletBinding()]
param(
  [ValidateSet('', 'cli', 'link', 'auto')]
  [string]$Mode = '',
  [string]$Repo = '',
  [int]$Interval = 0,
  [ValidateSet('', 'en', 'zh-CN', 'zh')]
  [string]$Lang = '',
  [string]$Proxy = '',
  [switch]$Yes,
  [string]$Package = 'opencode-github-sync@latest',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$Text) { Write-Host $Text }
function Stop-Install([string]$Text) {
  Write-Host "error: $Text" -ForegroundColor Red
  # `exit` would close the window when this runs through `irm | iex`.
  throw $Text
}

if (($Mode -eq 'link' -or $Mode -eq 'auto') -and -not $Repo) {
  Stop-Install "-Mode $Mode needs -Repo"
}
if ($Interval -ne 0 -and $Interval -lt 2) {
  Stop-Install '-Interval must be at least 2'
}

# The proxy applies to everything this script starts: npm, git and the CLI.
if ($Proxy) {
  foreach ($name in 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'npm_config_proxy', 'npm_config_https_proxy') {
    Set-Item -Path "Env:$name" -Value $Proxy
  }
}

# Arguments handed to `opencode-sync setup`.
$cliArgs = @()
if ($Mode) { $cliArgs += @('setup', '--mode', $Mode) }
if ($Repo) { $cliArgs += @('--repo', $Repo) }
if ($Interval -gt 0) { $cliArgs += @('--interval', [string]$Interval) }
if ($Lang) { $cliArgs += @('--lang', $Lang) }
if ($Proxy) { $cliArgs += @('--proxy', $Proxy) }

function ConvertTo-ArgumentString([string[]]$Items) {
  # Windows command-line quoting, so paths and URLs with spaces survive
  # Start-Process in both PowerShell editions.
  $quoted = foreach ($item in $Items) {
    if ($item -notmatch '[\s"]' -and $item -ne '') { $item; continue }
    $out = '"'
    $slashes = 0
    foreach ($ch in $item.ToCharArray()) {
      if ($ch -eq '\') { $slashes++; continue }
      if ($ch -eq '"') { $out += ('\' * ($slashes * 2 + 1)) + '"' }
      else { $out += ('\' * $slashes) + $ch }
      $slashes = 0
    }
    $out + ('\' * ($slashes * 2)) + '"'
  }
  return ($quoted -join ' ')
}

if ($DryRun) {
  Write-Output "npm install -g $Package"
  if ($cliArgs.Count -gt 0) { Write-Output ("opencode-sync " + (ConvertTo-ArgumentString $cliArgs)) }
  else { Write-Output 'opencode-sync' }
  if ($Proxy) { Write-Output "proxy $Proxy" }
  return
}

# --- Prerequisites ---

function Update-SessionPath {
  # A fresh winget install updates the registry, not this session.
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
}

function Test-Command([string]$Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Request-Install([string]$What, [string]$WingetId, [string]$Why, [string]$Manual) {
  Write-Step $Why
  if (-not (Test-Command 'winget')) {
    Stop-Install "Install $What from $Manual and run this again."
  }
  $command = "winget install --id $WingetId -e --source winget"
  Write-Step 'It can be installed with:'
  Write-Step "  $command"
  $go = [bool]$Yes
  if (-not $go) {
    $answer = Read-Host 'Run that now? [y/N]'
    $go = $answer -match '^(y|yes)$'
  }
  if (-not $go) {
    Stop-Install 'Not installed. Run the command above, then this installer again.'
  }
  & winget install --id $WingetId -e --source winget --accept-package-agreements --accept-source-agreements
  Update-SessionPath
}

function Get-NodeVersion {
  if (-not (Test-Command 'node')) { return $null }
  try { return [version]((& node -p 'process.versions.node') -replace '[^0-9.]', '') } catch { return $null }
}

$nodeVersion = Get-NodeVersion
if (-not $nodeVersion -or -not (Test-Command 'npm')) {
  Request-Install 'Node.js' 'OpenJS.NodeJS.LTS' 'Node.js (18 or newer) and npm are needed and were not found.' 'https://nodejs.org'
  $nodeVersion = Get-NodeVersion
}
if (-not $nodeVersion -or $nodeVersion.Major -lt 18) {
  Request-Install 'Node.js' 'OpenJS.NodeJS.LTS' "Node.js $nodeVersion is too old; 18 or newer is needed." 'https://nodejs.org'
  $nodeVersion = Get-NodeVersion
  if (-not $nodeVersion -or $nodeVersion.Major -lt 18) { Stop-Install 'Node.js 18 or newer is still not available on PATH.' }
}
if ($nodeVersion -lt [version]'22.5.0') {
  Write-Step "Note: Node.js $nodeVersion syncs configuration fine; session sync needs 22.5 or newer."
}
if (-not (Test-Command 'git')) {
  Request-Install 'git' 'Git.Git' 'git is needed and was not found.' 'https://git-scm.com'
  if (-not (Test-Command 'git')) { Stop-Install 'git is still not available on PATH.' }
}

# --- Install ---

Write-Step "Installing $Package ..."
& npm install -g $Package
if ($LASTEXITCODE -ne 0) { Stop-Install 'npm install -g failed.' }

$prefix = (& npm prefix -g).Trim()
$bin = Join-Path $prefix 'opencode-sync.cmd'
if (-not (Test-Path -LiteralPath $bin)) {
  $found = Get-Command 'opencode-sync.cmd' -ErrorAction SilentlyContinue
  if ($found) { $bin = $found.Source } else { Stop-Install "opencode-sync was installed but cannot be found. Add $prefix to PATH." }
}

# Started as its own process in this console, so the menu owns the keyboard
# even when this script itself arrived through a pipe (`irm | iex`).
$startArgs = @{ FilePath = $bin; NoNewWindow = $true; Wait = $true; PassThru = $true }
if ($cliArgs.Count -gt 0) { $startArgs.ArgumentList = ConvertTo-ArgumentString $cliArgs }
$process = Start-Process @startArgs
if ($process.ExitCode -ne 0) {
  Stop-Install "opencode-sync exited with code $($process.ExitCode)."
}
