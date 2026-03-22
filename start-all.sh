#!/bin/bash
# ET News Platform — start all services
# Usage: ./start-all.sh

export OPENAI_API_KEY=${OPENAI_API_KEY:-""}
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/etnews"

if [ -z "$OPENAI_API_KEY" ]; then
  echo "ERROR: Set OPENAI_API_KEY environment variable"
  exit 1
fi

echo "Starting Docker infrastructure..."
docker compose up qdrant neo4j redis kafka postgres -d

echo "Waiting 20 seconds for infrastructure..."
sleep 20

start_service() {
  local name=$1
  local path=$2
  local port=$3
  cd "$path"
  source .venv/bin/activate
  uvicorn main:app --port $port &
  echo "Started $name on port $port (PID: $!)"
  cd -
}

ROOT=$(pwd)
start_service "vernacular" "$ROOT/services/feature-vernacular" 8005
start_service "feed"       "$ROOT/services/feature-feed"       8011
start_service "briefing"   "$ROOT/services/feature-briefing"   8002
start_service "arc"        "$ROOT/services/feature-arc"        8004
start_service "video"      "$ROOT/services/feature-video"      8003

cd frontend && npm run dev &
echo "Started frontend on port 3000"

echo ""
echo "All services started!"
echo "Dashboard: http://localhost:3000"
