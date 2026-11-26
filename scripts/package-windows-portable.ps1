#Requires -Version 7.4

[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $DesktopExecutable,
  [Parameter(Mandatory)] [string] $AgentDirectory,
  [Parameter(Mandatory)] [string] $OutputZip
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Test-DesktopWindow([string] $Executable, [string] $WorkingDirectory) {
  $profileDirectory = Join-Path $WorkingDirectory 'WebView data'
  $process = Start-Process -FilePath $Executable -WorkingDirectory $WorkingDirectory -PassThru -Environment @{
    WEBVIEW2_USER_DATA_FOLDER = $profileDirectory
    NAFM_ASKPASS_ADDRESS = $null
    NAFM_ASKPASS_TOKEN = $null
  }

  try {
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    while ($watch.Elapsed.TotalSeconds -lt 45) {
      $process.Refresh()
      if ($process.HasExited) {
        throw "Extracted NAFM exited before its window opened (exit code $($process.ExitCode))."
      }
      if ($process.MainWindowHandle -ne [IntPtr]::Zero -and $process.MainWindowTitle -ceq 'NAFM' -and
          (Test-Path -LiteralPath $profileDirectory -PathType Container)) {
        Write-Host 'The extracted NAFM window and WebView2 profile opened.'
        return
      }
      Start-Sleep -Milliseconds 200
    }
    throw 'The extracted NAFM did not open its window and WebView2 profile within 45 seconds.'
  } finally {
    if (-not $process.HasExited) {
      $closeRequested = $process.CloseMainWindow()
      if ((-not $closeRequested -or -not $process.WaitForExit(5000)) -and -not $process.HasExited) {
        $process.Kill()
        [void] $process.WaitForExit(5000)
      }
    }
    $process.Dispose()
  }
}

if (-not $IsWindows) {
  throw 'The portable package must be built and smoke tested on Windows.'
}

$desktop = Get-Item -LiteralPath $DesktopExecutable
if ($desktop.PSIsContainer -or $desktop.Extension -ine '.exe') {
  throw 'DesktopExecutable must identify the release desktop EXE.'
}
$agentRoot = (Resolve-Path -LiteralPath $AgentDirectory).ProviderPath
$manifestPath = Join-Path $agentRoot 'manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$outputPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputZip)
if ([IO.Path]::GetExtension($outputPath) -ine '.zip') {
  throw 'OutputZip must have a .zip extension.'
}

# The release job verifies the manifest against source with agents:check before staging.
$payload = [ordered]@{
  'NAFM.exe' = $desktop.FullName
  'agents/manifest.json' = $manifestPath
}
foreach ($artifact in $manifest.artifacts) {
  $name = [string] $artifact.file_name
  $relativePath = "agents/$name"
  if ($name -cnotmatch '^nafm-agent-[a-z0-9_-]+(?:\.exe)?$' -or $payload.Contains($relativePath)) {
    throw 'The agent manifest contains an invalid or duplicate archive path.'
  }
  $binary = Get-Item -LiteralPath (Join-Path $agentRoot $name)
  if ($binary.PSIsContainer -or $binary.Length -ne $artifact.size_bytes) {
    throw "The bundled agent size does not match the manifest for $name."
  }
  $payload[$relativePath] = $binary.FullName
}
$windowsAgent = 'agents/nafm-agent-x86_64-pc-windows-msvc.exe'
if (-not $payload.Contains($windowsAgent)) {
  throw 'The bundle has no Windows x64 agent for the smoke test.'
}

$temp = [IO.Directory]::CreateTempSubdirectory('nafm-portable-').FullName
try {
  $stage = Join-Path $temp 'stage/NAFM'
  $unpacked = Join-Path $temp 'extracted copy'
  $launchDirectory = Join-Path $temp 'separate working directory'
  $archive = Join-Path $temp 'portable.zip'
  [void] [IO.Directory]::CreateDirectory((Join-Path $stage 'agents'))
  [void] [IO.Directory]::CreateDirectory($launchDirectory)

  foreach ($relativePath in $payload.Keys) {
    Copy-Item -LiteralPath $payload[$relativePath] -Destination (Join-Path $stage $relativePath)
  }
  Compress-Archive -LiteralPath $stage -DestinationPath $archive
  Expand-Archive -LiteralPath $archive -DestinationPath $unpacked

  $app = Join-Path $unpacked 'NAFM'
  $extractedFiles = @(Get-ChildItem -LiteralPath $app -File -Force -Recurse)
  if ($extractedFiles.Count -ne $payload.Count) {
    throw 'The extracted ZIP does not contain the expected payload.'
  }
  foreach ($relativePath in $payload.Keys) {
    $expected = Get-FileHash -LiteralPath $payload[$relativePath] -Algorithm SHA256
    $actual = Get-FileHash -LiteralPath (Join-Path $app $relativePath) -Algorithm SHA256
    if ($actual.Hash -ne $expected.Hash) {
      throw "ZIP verification failed for $relativePath."
    }
  }

  $exe = Join-Path $app 'NAFM.exe'
  & node --experimental-strip-types (Join-Path $PSScriptRoot 'test-agent.ts') (Join-Path $app $windowsAgent)
  if ($LASTEXITCODE -ne 0) {
    throw 'The extracted Windows agent failed its protocol smoke test.'
  }
  & node --experimental-strip-types (Join-Path $PSScriptRoot 'test-ssh-askpass.ts') $exe
  if ($LASTEXITCODE -ne 0) {
    throw 'The extracted desktop failed its SSH askpass smoke test.'
  }
  Test-DesktopWindow -Executable $exe -WorkingDirectory $launchDirectory

  [void] [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($outputPath))
  Move-Item -LiteralPath $archive -Destination $outputPath -Force
  Write-Host "Verified portable ZIP: $([IO.Path]::GetFileName($outputPath))"
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
