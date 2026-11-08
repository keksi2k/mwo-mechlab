# Installs the current Node.js LTS on Windows. start.bat runs this only after the user said yes.
# Tries winget first (built into Windows 10/11); otherwise downloads the official installer from
# nodejs.org, checks it against the published SHA-256 sums and runs it.
#   -NoWinget   skip winget
#   -CheckOnly  download and verify the installer, but don't install (for testing)
param([switch]$NoWinget, [switch]$CheckOnly)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # the progress bar makes downloads very slow in Windows PowerShell
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

if (-not $NoWinget -and -not $CheckOnly -and (Get-Command winget -ErrorAction SilentlyContinue)) {
  Write-Host 'Installing Node.js LTS with winget ...'
  winget install --id OpenJS.NodeJS.LTS --exact --source winget --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -eq 0) { exit 0 }
  Write-Host "winget did not succeed (code $LASTEXITCODE), using the installer from nodejs.org instead ..."
}

try {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' }
          elseif ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' }
  # assign first: Windows PowerShell 5.1 passes a JSON array down a pipe as one object
  $all = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
  $release = $all | Where-Object { $_.lts } | Select-Object -First 1
  $version = [string]$release.version
  if ($version -notmatch '^v\d+\.\d+\.\d+$') { throw 'Could not find the current LTS version on nodejs.org.' }
  $name = "node-$version-$arch.msi"
  $file = Join-Path $env:TEMP $name

  Write-Host "Downloading Node.js $version ($arch) from nodejs.org ..."
  Invoke-WebRequest "https://nodejs.org/dist/$version/$name" -OutFile $file -UseBasicParsing

  $sums = Invoke-RestMethod "https://nodejs.org/dist/$version/SHASUMS256.txt"
  $line = ($sums -split "`n") | Where-Object { $_ -match ('\s' + [regex]::Escape($name) + '\s*$') } | Select-Object -First 1
  if (-not $line) { throw "No checksum published for $name." }
  $expected = ($line.Trim() -split '\s+')[0]
  $actual = (Get-FileHash $file -Algorithm SHA256).Hash
  if ($actual -ne $expected) {
    Remove-Item $file -ErrorAction SilentlyContinue
    throw "Checksum mismatch for $name, the download was not used."
  }
  Write-Host 'Checksum OK.'
  if ($CheckOnly) { Remove-Item $file; exit 0 }

  Write-Host 'Running the Node.js installer (Windows may ask for permission) ...'
  $p = Start-Process msiexec.exe -ArgumentList '/i', "`"$file`"", '/passive', '/norestart' -Wait -PassThru
  Remove-Item $file -ErrorAction SilentlyContinue
  # 3010: installed, a restart is recommended
  if ($p.ExitCode -eq 0 -or $p.ExitCode -eq 3010) { exit 0 }
  Write-Host "The installer ended with code $($p.ExitCode)."
  exit 1
} catch {
  Write-Host "Installing Node.js failed: $($_.Exception.Message)"
  exit 1
}
