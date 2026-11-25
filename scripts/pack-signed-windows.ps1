param(
    [ValidatePattern('^[0-9A-Fa-f]{40}$')]
    [string]$Thumbprint = $env:NUBO_SIGN_CERT_THUMBPRINT,
    [switch]$SignHook
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
$timestamp = 'http://timestamp.digicert.com'
if (!$Thumbprint) {
    throw 'Set NUBO_SIGN_CERT_THUMBPRINT to a trusted Windows code-signing certificate.'
}
$cert = Get-ChildItem Cert:/CurrentUser/My -CodeSigningCert |
    Where-Object Thumbprint -eq $Thumbprint | Select-Object -First 1
if (!$cert -or !$cert.HasPrivateKey -or $cert.NotAfter -le (Get-Date)) {
    throw 'A valid code-signing certificate with a private key is required in CurrentUser\My.'
}

if (!$env:TAURI_WINDOWS_SIGNTOOL_PATH) {
    $tool = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($tool) {
        $env:TAURI_WINDOWS_SIGNTOOL_PATH = $tool.Source
    } else {
        $kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
        $tool = Get-ChildItem -Path "$kits\*\x64\signtool.exe" -ErrorAction SilentlyContinue |
            Sort-Object FullName -Descending | Select-Object -First 1
        if (!$tool) { throw 'Install the Windows SDK or set TAURI_WINDOWS_SIGNTOOL_PATH.' }
        $env:TAURI_WINDOWS_SIGNTOOL_PATH = $tool.FullName
    }
}

function Assert-Signature([string]$Path) {
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($signature.Status -ne 'Valid' -or
        $signature.SignerCertificate.Thumbprint -ne $Thumbprint -or
        !$signature.TimeStamperCertificate) {
        throw "Missing, untrusted, unexpected, or untimestamped signature: $Path"
    }
}

$hook = 'target/release/nubo-hook.exe'
if ($SignHook) {
    & $env:TAURI_WINDOWS_SIGNTOOL_PATH sign /sha1 $Thumbprint /fd SHA256 /tr $timestamp /td SHA256 $hook
    if ($LASTEXITCODE) { throw 'SignTool failed to sign the hook relay.' }
    Assert-Signature $hook
    exit 0
}

if ((node -p process.arch) -ne 'x64') { throw 'This release script targets Windows x64.' }
$lib = node scripts/verify-native.mjs
if ($LASTEXITCODE -or !(Test-Path -LiteralPath $lib -PathType Container)) {
    throw 'Could not prepare verified Sherpa ONNX libraries.'
}
$env:SHERPA_ONNX_LIB_DIR = $lib
$env:NUBO_SIGN_CERT_THUMBPRINT = $Thumbprint
$env:CARGO_TARGET_DIR = Join-Path (Get-Location) 'target'
$config = @{
    build = @{
        beforeBuildCommand = 'npm run build && powershell.exe -NoProfile -File scripts/pack-signed-windows.ps1 -SignHook'
    }
    bundle = @{
        windows = @{
            certificateThumbprint = $Thumbprint
            digestAlgorithm = 'sha256'
            timestampUrl = $timestamp
            tsp = $true
        }
    }
}
$configFile = Join-Path (Get-Location) 'target/nubo-signing.json'
[IO.File]::WriteAllText($configFile, ($config | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
npm.cmd run tauri -- build --bundles nsis,msi --ci --config $configFile -- --locked
if ($LASTEXITCODE) { throw 'Signed Nubo build failed.' }

$version = (Get-Content src-tauri/tauri.conf.json -Raw | ConvertFrom-Json).version
$setup = "target/release/bundle/nsis/Nubo_${version}_x64-setup.exe"
$msi = "target/release/bundle/msi/Nubo_${version}_x64_en-US.msi"
foreach ($path in @($setup, $msi, $hook, 'target/release/nubo.exe')) {
    Assert-Signature $path
}
New-Item -ItemType Directory -Path 'release' -Force | Out-Null
Copy-Item -LiteralPath $setup -Destination "release/Nubo-Windows-${version}-setup.exe"
Copy-Item -LiteralPath $msi -Destination "release/Nubo-Windows-${version}.msi"
Get-FileHash -Algorithm SHA256 -LiteralPath @("release/Nubo-Windows-${version}-setup.exe", "release/Nubo-Windows-${version}.msi")
