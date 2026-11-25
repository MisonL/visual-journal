$ErrorActionPreference = 'Stop'

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$distDir = Join-Path $projectRoot 'dist'
$stageDir = Join-Path $distDir 'visual-journal'
$zipPath = Join-Path $distDir 'visual-journal.zip'

$excludedNames = @(
    '.git',
    '.next',
    'artifacts',
    'node_modules',
    'generated-images',
    'dist'
)

$excludedFiles = @(
    'dev-server.log',
    'dev-server.err.log',
    '.env.local',
    'tsconfig.tsbuildinfo',
    'next-env.d.ts'
)

if (Test-Path $stageDir) {
    Remove-Item -LiteralPath $stageDir -Recurse -Force
}

if (Test-Path $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}

New-Item -ItemType Directory -Path $stageDir | Out-Null

Get-ChildItem -LiteralPath $projectRoot -Force | ForEach-Object {
    if ($excludedNames -contains $_.Name) {
        return
    }

    if (-not $_.PSIsContainer -and $excludedFiles -contains $_.Name) {
        return
    }

    Copy-Item -LiteralPath $_.FullName -Destination $stageDir -Recurse -Force
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($stageDir, $zipPath)

Write-Host ''
Write-Host "Customer package: $zipPath"
Write-Host ''
Write-Host 'Send this zip file to the customer. They can unzip it and run start-windows.bat.'
