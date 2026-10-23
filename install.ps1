# VixTab installer for Windows: downloads the latest release, checks its SHA-256, installs the CLI to %USERPROFILE%\.vixtab\bin,
# the Claude Code skills, and (if the `code` command exists) the VS Code extension.
#   irm https://raw.githubusercontent.com/VixAgent/vixtab/main/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$repo = 'VixAgent/vixtab'
$base = if ($env:VIXTAB_VERSION) { "https://github.com/$repo/releases/download/$($env:VIXTAB_VERSION)" } else { "https://github.com/$repo/releases/latest/download" }
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("vixtab-" + [guid]::NewGuid())
New-Item -ItemType Directory $tmp | Out-Null
try {
  Write-Host 'Downloading VixTab (windows-x64)...'
  foreach ($f in 'vixtab-windows-x64.zip', 'vixtab-win32-x64.vsix', 'SHA256SUMS') { Invoke-WebRequest -UseBasicParsing "$base/$f" -OutFile (Join-Path $tmp $f) }
  $sums = Get-Content (Join-Path $tmp 'SHA256SUMS')
  foreach ($f in 'vixtab-windows-x64.zip', 'vixtab-win32-x64.vsix') {
    $want = ($sums | Where-Object { $_ -match " $([regex]::Escape($f))$" }) -replace ' .*$', ''
    $got = (Get-FileHash -Algorithm SHA256 (Join-Path $tmp $f)).Hash.ToLower()
    if ($want -ne $got) { throw "checksum mismatch for $f" }
  }
  Expand-Archive (Join-Path $tmp 'vixtab-windows-x64.zip') -DestinationPath $tmp -Force
  $exe = Join-Path $tmp 'vixtab.exe'
  & $exe setup
  if (Get-Command code -ErrorAction SilentlyContinue) { & $exe setup --extension (Join-Path $tmp 'vixtab-win32-x64.vsix') }
  else { Write-Host "VS Code's 'code' command was not found: install the extension from the Marketplace (VixTab) or from $base/vixtab-win32-x64.vsix" }
  Write-Host 'Done. Open a new terminal and run: vixtab doctor   (inside a repository)'
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
