# ET News Platform — start all services
# Usage: .\start-all.ps1 -ApiKey "sk-proj-..."

param(
  [string]$ApiKey = $env:OPENAI_API_KEY
)

if (-not $ApiKey) {
  Write-Host "ERROR: Set OPENAI_API_KEY or pass -ApiKey parameter" -ForegroundColor Red
  exit 1
}

Write-Host "Starting ET News Platform..." -ForegroundColor Green

# Start Docker infrastructure
Write-Host "Starting Docker infrastructure..." -ForegroundColor Yellow
docker compose up qdrant neo4j redis kafka postgres -d

Write-Host "Waiting for infrastructure to be healthy..." -ForegroundColor Yellow
$maxWait = 60
$waited = 0
do {
  Start-Sleep -Seconds 3
  $waited += 3
  try {
    $response = Invoke-WebRequest -Uri "http://localhost:6333/healthz" -UseBasicParsing -TimeoutSec 2 -ErrorAction SilentlyContinue
    if ($response.StatusCode -eq 200) {
      Write-Host "Infrastructure ready after ${waited}s" -ForegroundColor Green
      break
    }
  } catch {}
  Write-Host "  Waiting... (${waited}s)" -ForegroundColor Gray
} while ($waited -lt $maxWait)

# Extra 5 second buffer for Postgres and Neo4j
Start-Sleep -Seconds 5

# Capture current PATH so child windows inherit conda/Node/Python paths
$currentPath = $env:PATH

# Start each service in a new PowerShell window
$services = @(
  @{name="vernacular";          port=8005; path="services/feature-vernacular"},
  @{name="feed";                port=8011; path="services/feature-feed"},
  @{name="briefing";            port=8002; path="services/feature-briefing"},
  @{name="arc";                 port=8004; path="services/feature-arc"},
  @{name="video";               port=8003; path="services/feature-video"},
  @{name="ingestion-pipeline";  port=8006; path="services/ingestion-pipeline"},
  @{name="agent";               port=8007; path="services/agent"}
)

foreach ($svc in $services) {
  $cmd = "`$env:PATH='C:\Users\anish\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg.Essentials_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-7.1.1-essentials_build\bin;$currentPath'; `$env:OPENAI_API_KEY='$ApiKey'; `$env:DATABASE_URL='postgresql://postgres:postgres@localhost:5432/etnews'; `$env:AGENT_URL='http://localhost:8007'; cd '$PWD\$($svc.path)'; .venv\Scripts\activate; uvicorn main:app --port $($svc.port)"
  Start-Process powershell -ArgumentList "-NoExit", "-Command", $cmd
  Write-Host "Started $($svc.name) on port $($svc.port)" -ForegroundColor Green
  Start-Sleep -Seconds 2
}

# Try to find npm from multiple locations
$npmCmd = Get-Command npm -ErrorAction SilentlyContinue
$npmSource = if ($npmCmd) { $npmCmd.Source } else { $null }
$npmDir = $null
if ($npmSource) {
  $npmDir = Split-Path $npmSource
} else {
  $candidates = @(
    "$env:APPDATA\npm",
    "$env:ProgramFiles\nodejs",
    "C:\Program Files\nodejs",
    "$env:USERPROFILE\AppData\Roaming\npm",
    "C:\nvm4w\nodejs"
  )
  foreach ($c in $candidates) {
    if (Test-Path "$c\npm.cmd") { $npmDir = $c; break }
    if (Test-Path "$c\npm.ps1") { $npmDir = $c; break }
  }
}

if ($npmDir) {
  $frontendCmd = "`$env:PATH='$npmDir;$currentPath'; cd '$PWD\frontend'; npm run dev"
} else {
  Write-Host "ERROR: npm not found. Install Node.js and re-run." -ForegroundColor Red
  exit 1
}

Start-Process powershell -ArgumentList "-NoExit", "-Command", $frontendCmd
Write-Host "Started frontend on port 3000" -ForegroundColor Green

Write-Host ""
Write-Host "All services started!" -ForegroundColor Green
Write-Host "Dashboard: http://localhost:3000" -ForegroundColor Cyan
Write-Host ""
Write-Host "Service ports:" -ForegroundColor Yellow
Write-Host "  Vernacular:         http://localhost:8005/docs"
Write-Host "  Feed:               http://localhost:8011/docs"
Write-Host "  Briefing:           http://localhost:8002/docs"
Write-Host "  Arc:                http://localhost:8004/docs"
Write-Host "  Video:              http://localhost:8003/docs"
Write-Host "  Ingestion Pipeline: http://localhost:8006/docs"
Write-Host "  Agent:              http://localhost:8007/docs"
