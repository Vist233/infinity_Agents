[CmdletBinding()]
param(
    [string]$StagingDirectory = 'C:\Users\86138\InfinityAgentsWorkers',
    [string]$PiecePrefix = 'infinity-agents-worker-r7-8m-piece-part-',
    [ValidateRange(1, 10000)]
    [int]$PartCount = 49,
    [ValidateRange(1, [long]::MaxValue)]
    [long]$PieceBytes = 8388608,
    [ValidateRange(1, [long]::MaxValue)]
    [long]$ExpectedArchiveBytes = 406582272,
    [ValidatePattern('^[0-9a-fA-F]{64}$')]
    [string]$ExpectedSha256 = 'bdd3073f097da34d3226ea1f2d9b6182d0b5fa1bf9ede54412d4b2950a623774',
    [string]$ArchiveName = 'infinity-agents-worker-r7-canonical.tar',
    [switch]$LoadDocker
)

$ErrorActionPreference = 'Stop'

function Stop-R7Reassembly {
    param([string]$Message)

    throw "r7 reassembly rejected: $Message"
}

if (-not (Test-Path -LiteralPath $StagingDirectory -PathType Container)) {
    Stop-R7Reassembly "staging directory does not exist: $StagingDirectory"
}

if ([IO.Path]::GetFileName($ArchiveName) -ne $ArchiveName) {
    Stop-R7Reassembly 'ArchiveName must be a filename, not a path'
}

if ($PartCount -lt 1 -or $ExpectedArchiveBytes -lt $PartCount) {
    Stop-R7Reassembly 'archive size and part count are inconsistent'
}

$expectedParts = @()
$expectedSizes = @{}
$fullPartCount = $PartCount - 1
$lastPartBytes = $ExpectedArchiveBytes - ([long]$fullPartCount * $PieceBytes)
if ($lastPartBytes -le 0 -or $lastPartBytes -gt $PieceBytes) {
    Stop-R7Reassembly 'expected final part size is outside the valid range'
}

for ($index = 0; $index -lt $PartCount; $index++) {
    $name = '{0}{1:D3}' -f $PiecePrefix, $index
    $expectedParts += $name
    $expectedSizes[$name] = if ($index -lt $fullPartCount) { $PieceBytes } else { $lastPartBytes }
}

$pieceFiles = @(
    Get-ChildItem -LiteralPath $StagingDirectory -File -Filter "$PiecePrefix*" |
        Sort-Object -Property Name
)
$actualByName = @{}
foreach ($file in $pieceFiles) {
    $actualByName[$file.Name] = $file
}

# Include differently named r7/piece candidates in the bounded inventory so an
# old partial file is visible, but never allow it into the reassembly set.
$inventoryFiles = @(
    Get-ChildItem -LiteralPath $StagingDirectory -File |
        Where-Object { $_.Name -like '*r7*' -or $_.Name -like '*piece*' } |
        Sort-Object -Property Name
)
Write-Output "staging=$StagingDirectory"
Write-Output "piece_prefix=$PiecePrefix"
Write-Output "expected_part_count=$PartCount"
Write-Output "expected_archive_bytes=$ExpectedArchiveBytes"
Write-Output "expected_sha256=$($ExpectedSha256.ToLowerInvariant())"
Write-Output 'inventory_name|bytes|accepted'
foreach ($file in $inventoryFiles) {
    $accepted = $actualByName.ContainsKey($file.Name) -and $expectedSizes.ContainsKey($file.Name)
    Write-Output "$($file.Name)|$([long]$file.Length)|$accepted"
}

$missingNames = @(
    $expectedParts | Where-Object { -not $actualByName.ContainsKey($_) }
)
$unexpectedNames = @(
    $pieceFiles | Where-Object { -not $expectedSizes.ContainsKey($_.Name) } |
        ForEach-Object { $_.Name }
)
$wrongSizes = @(
    $pieceFiles | Where-Object {
        $expectedSizes.ContainsKey($_.Name) -and [long]$_.Length -ne [long]$expectedSizes[$_.Name]
    } | ForEach-Object {
        '{0}:{1} (expected {2})' -f $_.Name, [long]$_.Length, [long]$expectedSizes[$_.Name]
    }
)

if ($missingNames.Count -gt 0 -or $unexpectedNames.Count -gt 0 -or $wrongSizes.Count -gt 0) {
    $missingText = if ($missingNames.Count) { $missingNames -join ',' } else { 'none' }
    $unexpectedText = if ($unexpectedNames.Count) { $unexpectedNames -join ',' } else { 'none' }
    $wrongSizeText = if ($wrongSizes.Count) { $wrongSizes -join ',' } else { 'none' }
    Stop-R7Reassembly "piece set is not complete; missing=$missingText; unexpected=$unexpectedText; size_mismatch=$wrongSizeText"
}

$archivePath = Join-Path -Path $StagingDirectory -ChildPath $ArchiveName
$expectedHash = $ExpectedSha256.ToLowerInvariant()
$verifiedArchivePath = $null
$temporaryPath = $null

try {
    if (Test-Path -LiteralPath $archivePath -PathType Leaf) {
        $existing = Get-Item -LiteralPath $archivePath
        if ([long]$existing.Length -ne $ExpectedArchiveBytes) {
            Stop-R7Reassembly "existing archive has $([long]$existing.Length) bytes; refusing to overwrite it"
        }
        $existingHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($existingHash -ne $expectedHash) {
            Stop-R7Reassembly 'existing archive hash does not match; refusing to overwrite it'
        }
        $verifiedArchivePath = $archivePath
        Write-Output "archive=already_verified|bytes=$([long]$existing.Length)|sha256=$existingHash"
    } else {
        $temporaryName = '.{0}.{1}.partial' -f $ArchiveName, ([guid]::NewGuid().ToString('N'))
        $temporaryPath = Join-Path -Path $StagingDirectory -ChildPath $temporaryName
        $outputStream = [IO.File]::Open(
            $temporaryPath,
            [IO.FileMode]::CreateNew,
            [IO.FileAccess]::Write,
            [IO.FileShare]::None
        )
        try {
            foreach ($name in $expectedParts) {
                $inputStream = [IO.File]::OpenRead($actualByName[$name].FullName)
                try {
                    $inputStream.CopyTo($outputStream, 1048576)
                } finally {
                    $inputStream.Dispose()
                }
            }
        } finally {
            $outputStream.Dispose()
        }

        $candidate = Get-Item -LiteralPath $temporaryPath
        if ([long]$candidate.Length -ne $ExpectedArchiveBytes) {
            Stop-R7Reassembly "reassembled candidate has $([long]$candidate.Length) bytes"
        }
        $candidateHash = (Get-FileHash -LiteralPath $temporaryPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($candidateHash -ne $expectedHash) {
            Stop-R7Reassembly 'reassembled candidate hash does not match'
        }

        # Move is intentionally non-overwriting. A concurrent successful run
        # may win the destination race; that destination is verified below.
        try {
            Move-Item -LiteralPath $temporaryPath -Destination $archivePath
            $temporaryPath = $null
            $verifiedArchivePath = $archivePath
        } catch {
            if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) {
                throw
            }
            $raced = Get-Item -LiteralPath $archivePath
            $racedHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
            if ([long]$raced.Length -ne $ExpectedArchiveBytes -or $racedHash -ne $expectedHash) {
                Stop-R7Reassembly 'destination appeared concurrently with a different archive'
            }
            $verifiedArchivePath = $archivePath
        }
        Write-Output "archive=reassembled|bytes=$ExpectedArchiveBytes|sha256=$expectedHash"
    }

    if ($LoadDocker) {
        if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
            Stop-R7Reassembly 'docker executable was not found after archive verification'
        }
        Write-Output "docker_load=starting|archive=$verifiedArchivePath"
        & docker load --input $verifiedArchivePath *> $null
        if ($LASTEXITCODE -ne 0) {
            Stop-R7Reassembly "docker load failed with exit code $LASTEXITCODE"
        }
        Write-Output 'docker_load=passed'
    } else {
        Write-Output 'docker_load=skipped|reason=verification_only'
    }
} finally {
    if ($temporaryPath -and (Test-Path -LiteralPath $temporaryPath -PathType Leaf)) {
        Remove-Item -LiteralPath $temporaryPath -Force
    }
}
