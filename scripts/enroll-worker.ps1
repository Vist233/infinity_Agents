# Register a new Worker on the Infinity Agents control plane.
#
# Usage:
#   .\scripts\enroll-worker.ps1                     # default http://localhost:8008
#   .\scripts\enroll-worker.ps1 http://10.0.0.5:8008
#
# Output: WORKER_ID and WORKER_CREDENTIAL to add to your worker's .env

param(
    [string]$ServerUrl = "http://localhost:8008"
)

$ErrorActionPreference = "Stop"

Write-Host "==> Registering a new Worker at $ServerUrl ..."

try {
    $response = Invoke-RestMethod -Uri "$ServerUrl/api/worker-enrollments" `
        -Method POST -ContentType "application/json" -Body "{}"
} catch {
    Write-Host "ERROR: Failed to reach API at $ServerUrl" -ForegroundColor Red
    Write-Host $_.Exception.Message
    Write-Host ""
    Write-Host "Make sure the API is running on the server:"
    Write-Host "  source .env.local && uvicorn backend.app:app --host 0.0.0.0 --port 8008"
    exit 1
}

$workerId = $response.worker_id
$credential = $response.credential
$namespace = $response.namespace

if (-not $workerId -or -not $credential) {
    Write-Host "ERROR: Unexpected API response:" -ForegroundColor Red
    Write-Host ($response | ConvertTo-Json)
    exit 1
}

Write-Host ""
Write-Host "=========================================" -ForegroundColor Green
Write-Host " Worker enrolled successfully!" -ForegroundColor Green
Write-Host "=========================================" -ForegroundColor Green
Write-Host ""
Write-Host " Add these to your Worker's environment:"
Write-Host ""
Write-Host "   WORKER_ID=$workerId"
Write-Host "   WORKER_CREDENTIAL=$credential"
Write-Host ""
Write-Host " Then start the Worker:"
Write-Host ""
Write-Host '   $env:WORKER_ID="' + $workerId + '"'
Write-Host '   $env:WORKER_CREDENTIAL="' + $credential + '"'
Write-Host '   $env:WORKER_CONTROL_PLANE_URL="' + $ServerUrl + '"'
Write-Host '   $env:ANTHROPIC_API_KEY="sk-ant-your-key"'
Write-Host '   python -m backend.code_agent.worker.consumer_v2 $env:WORKER_ID'
Write-Host ""
