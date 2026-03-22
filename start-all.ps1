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

Write-Host "Waiting 20 seconds for infrastructure to be healthy..." -ForegroundColor Yellow
Start-Sleep -Seconds 20

# Start each service in a new PowerShell window
$services = @(
  @{name="vernacular"; port=8005; path="services/feature-vernacular"},
  @{name="feed";       port=8011; path="services/feature-feed"},
  @{name="briefing";   port=8002; path="services/feature-briefing"},
  @{name="arc";        port=8004; path="services/feature-arc"},
  @{name="video";      port=8003; path="services/feature-video"}
)

foreach ($svc in $services) {
  $cmd = "cd '$PWD\$($svc.path)'; `$env:OPENAI_API_KEY='$ApiKey'; `$env:DATABASE_URL='postgresql://postgres:postgres@localhost:5432/etnews'; .venv\Scripts\activate; uvicorn main:app --port $($svc.port)"
  Start-Process powershell -ArgumentList "-NoExit", "-Command", $cmd
  Write-Host "Started $($svc.name) on port $($svc.port)" -ForegroundColor Green
  Start-Sleep -Seconds 2
}

# Start frontend
$frontendCmd = "cd '$PWD\frontend'; npm run dev"
Start-Process powershell -ArgumentList "-NoExit", "-Command", $frontendCmd
Write-Host "Started frontend on port 3000" -ForegroundColor Green

Write-Host ""
Write-Host "All services started!" -ForegroundColor Green
Write-Host "Dashboard: http://localhost:3000" -ForegroundColor Cyan
Write-Host ""
Write-Host "Service ports:" -ForegroundColor Yellow
Write-Host "  Vernacular:  http://localhost:8005/docs"
Write-Host "  Feed:        http://localhost:8011/docs"
Write-Host "  Briefing:    http://localhost:8002/docs"
Write-Host "  Arc:         http://localhost:8004/docs"
Write-Host "  Video:       http://localhost:8003/docs"
