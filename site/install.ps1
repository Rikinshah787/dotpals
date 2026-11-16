# dotpals installer for Windows (PowerShell 5.1 or newer).
#
#   irm https://dotpals.vercel.app/install.ps1 | iex
#
# If Node.js 20 or newer isn't installed, it installs Node.js LTS for every app on
# this PC (with winget, or the official installer from nodejs.org), then runs
# `npx --yes dotpals@latest setup`. It only downloads from nodejs.org and npm.
# Everything runs inside a function, so `| iex` never closes your PowerShell window.

function Install-Dotpals {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue' # Windows PowerShell downloads crawl with the progress bar on
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $help = 'https://dotpals.vercel.app/guide/troubleshooting.html#installer'

  function Step($text) { Write-Host ''; Write-Host "-> $text" -ForegroundColor Cyan }
  function Ok($text) { Write-Host "   $text" -ForegroundColor Green }
  function Fail($text) {
    Write-Host ''
    Write-Host "x  $text" -ForegroundColor Red
    Write-Host "   What to do next: $help"
    $global:LASTEXITCODE = 1
  }

  # Node's major version, or 0 when there's none.
  function Get-NodeMajor {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return 0 }
    try { $version = & node --version } catch { return 0 }
    if ($version -match '^v(\d+)\.') { return [int]$Matches[1] }
    return 0
  }

  # Installers change PATH for new windows only. Read it again so node and npx work here now,
  # from the same place every other app (and your agents' hooks) will find them.
  function Update-Path {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    # The saved PATH first (where a new Node.js just went), then this window's own extra folders (version managers' shims).
    $saved = "$machine;$user" -split ';' | Where-Object { $_ }
    $extra = $env:Path -split ';' | Where-Object { $_ -and ($saved -notcontains $_) }
    $env:Path = (@($saved) + @($extra)) -join ';'
  }

  function Install-NodeWithWinget {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { return }
    Step 'Installing Node.js LTS with winget. Windows may ask for permission.'
    & winget install --id OpenJS.NodeJS.LTS -e --silent --accept-source-agreements --accept-package-agreements
    Update-Path
  }

  function Install-NodeFromNodejsOrg {
    $arch = 'x64'
    if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { $arch = 'arm64' }
    Step 'Finding the latest Node.js LTS on nodejs.org...'
    # Saved first: Windows PowerShell passes a JSON list down a pipe as one item.
    $releases = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
    $version = ($releases | Where-Object { $_.lts } | Select-Object -First 1).version
    $name = "node-$version-$arch.msi"
    $msi = Join-Path $env:TEMP $name
    Step "Downloading Node.js $version ($arch)..."
    Invoke-WebRequest "https://nodejs.org/dist/$version/$name" -OutFile $msi -UseBasicParsing
    if ((Get-AuthenticodeSignature $msi).Status -ne 'Valid') { throw "The Node.js installer isn't signed as expected, so it wasn't run." }
    Step 'Installing Node.js. Windows will ask for permission.'
    $run = Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /passive /norestart" -Verb RunAs -Wait -PassThru
    Remove-Item $msi -ErrorAction SilentlyContinue
    if ($run.ExitCode -ne 0 -and $run.ExitCode -ne 3010) { throw "The Node.js installer stopped (code $($run.ExitCode))." }
    Update-Path
  }

  Write-Host 'dotpals installer' -ForegroundColor Magenta
  Step 'Checking for Node.js 20 or newer...'
  $major = Get-NodeMajor
  if ($major -ge 20) {
    Ok "Found Node.js $(& node --version)."
  } else {
    if ($major -gt 0) { Write-Host "   Node.js $(& node --version) is too old." } else { Write-Host '   Node.js is not installed.' }
    try {
      Install-NodeWithWinget
      if ((Get-NodeMajor) -lt 20) { Install-NodeFromNodejsOrg }
    } catch {
      Fail "Couldn't install Node.js. $($_.Exception.Message)"
      return
    }
    if ((Get-NodeMajor) -lt 20) {
      Fail 'Node.js 20 or newer still isn''t the one on your PATH. If you use a Node version manager, switch it to 20 or newer, then run this again.'
      return
    }
    Ok "Installed Node.js $(& node --version)."
  }

  Step 'Installing dotpals (npx --yes dotpals@latest setup)...'
  # npx.cmd rather than npx.ps1, which PowerShell's script policy can block.
  $npx = Get-Command npx.cmd, npx.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $npx) { Fail 'npx is missing. Reinstall Node.js from https://nodejs.org, then run this again.'; return }
  & $npx.Source --yes dotpals@latest setup
  if ($LASTEXITCODE -ne 0) { Fail "dotpals setup didn't finish (exit code $LASTEXITCODE)."; return }
  $global:LASTEXITCODE = 0
  Write-Host ''
  Write-Host 'dotpals is installed.' -ForegroundColor Green
}

Install-Dotpals
