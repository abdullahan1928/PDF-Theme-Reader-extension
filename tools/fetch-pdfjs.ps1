# Downloads PDF.js and copies only what the extension uses into ..\pdfjs.
# Run with -Slim to skip CJK character maps (saves ~1.7 MB).
param([switch]$Slim)
$ErrorActionPreference = "Stop"

$Version = "6.4.299"
$Url = "https://github.com/mozilla/pdf.js/releases/download/v$Version/pdfjs-$Version-dist.zip"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("pdfjs-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $Tmp | Out-Null

try {
    Write-Host "Downloading PDF.js $Version..."
    Invoke-WebRequest -Uri $Url -OutFile "$Tmp\dist.zip" -UseBasicParsing
    Expand-Archive -Path "$Tmp\dist.zip" -DestinationPath "$Tmp\x" -Force

    $Out = Join-Path $Root "pdfjs"
    if (Test-Path $Out) { Remove-Item $Out -Recurse -Force }
    New-Item -ItemType Directory -Path "$Out\wasm" | Out-Null

    Copy-Item "$Tmp\x\build\pdf.mjs", "$Tmp\x\build\pdf.worker.mjs" $Out
    Copy-Item "$Tmp\x\web\standard_fonts" $Out -Recurse
    Copy-Item "$Tmp\x\web\wasm\*" "$Out\wasm"
    Remove-Item "$Out\wasm\quickjs-eval.*" -ErrorAction SilentlyContinue
    if (-not $Slim) { Copy-Item "$Tmp\x\web\cmaps" $Out -Recurse }
    Copy-Item "$Tmp\x\LICENSE" "$Out\LICENSE"

    $mb = [math]::Round((Get-ChildItem $Out -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
    Write-Host "PDF.js $Version installed in $Out ($mb MB)" -ForegroundColor Green
}
finally {
    Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue   # never leaves temp files in the project
}
