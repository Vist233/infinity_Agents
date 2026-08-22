# Revoke ALL Worker enrollments on the Infinity Agents control plane.
#
# Usage:
#   .\scripts\delete-all-workers.ps1                    # default http://localhost:8008
#   .\scripts\delete-all-workers.ps1 http://10.0.0.5:8008
#
# This revokes every Worker credential. Workers that are currently running
# will lose their next poll/heartbeat and disconnect.

param(
    [string]$ServerUrl = "http://localhost:8008"
)

$ErrorActionPreference = "Stop"

Write-Host "==> Listing all Workers at $ServerUrl ..."

try {
    $response = Invoke-RestMethod -Uri "$ServerUrl/api/worker-enrollments" -Method GET
} catch {
    Write-Host "ERROR: Failed to reach API at $ServerUrl" -ForegroundColor Red
    Write-Host $_.Exception.Message
    exit 1
}

$workers = $response.workers
if (-not $workers -or $workers.Count -eq 0) {
    Write-Host "No Workers found. Nothing to revoke." -ForegroundColor Yellow
    exit 0
}

Write-Host "Found $($workers.Count) Worker(s):"
Write-Host ""

$revokedCount = 0
$failedCount = 0

foreach ($w in $workers) {
    $workerId = $w.worker_id
    $namespace = $w.namespace
    $status = $w.status

    Write-Host "  Revoking: $workerId (namespace: $namespace, status: $status) ..."

    try {
        $revokeResponse = Invoke-RestMethod `
            -Uri "$ServerUrl/api/worker-enrollments/$workerId/revoke?namespace=$namespace" `
            -Method POST
        Write-Host "    -> Revoked" -ForegroundColor Green
        $revokedCount++
    } catch {
        Write-Host "    -> FAILED: $($_.Exception.Message)" -ForegroundColor Red
        $failedCount++
    }
}

Write-Host ""
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host " Done: $revokedCount revoked, $failedCount failed" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host ""
if ($failedCount -gt 0) {
    Write-Host "Some Workers could not be revoked. Check the API logs." -ForegroundColor Yellow
    exit 1
}
