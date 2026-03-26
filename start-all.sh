#!/bin/bash
# ET News Platform — start all services
# Usage: ./start-all.sh

export OPENAI_API_KEY=${OPENAI_API_KEY:-""}
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/etnews"
export AGENT_URL="http://localhost:8007"

if [ -z "$OPENAI_API_KEY" ]; then
  echo "ERROR: Set OPENAI_API_KEY environment variable"
  exit 1
fi

echo "Starting ET News Platform..."

# Detect FFmpeg and export path for feature-video
if command -v ffmpeg &>/dev/null; then
  export FFMPEG_PATH="$(command -v ffmpeg)"
  echo "FFmpeg found: $FFMPEG_PATH"
else
  echo "WARNING: ffmpeg not found. Video generation will be disabled."
  echo "  macOS:  brew install ffmpeg"
  echo "  Linux:  sudo apt install ffmpeg"
fi

# Start Docker infrastructure
echo "Starting Docker infrastructure..."
docker compose up qdrant neo4j redis kafka postgres -d

# Wait for Qdrant to be healthy (up to 60 seconds)
echo "Waiting for infrastructure to be healthy..."
MAX_WAIT=60
WAITED=0
until curl -sf http://localhost:6333/healthz > /dev/null 2>&1; do
  sleep 3
  WAITED=$((WAITED + 3))
  echo "  Waiting... (${WAITED}s)"
  if [ "$WAITED" -ge "$MAX_WAIT" ]; then
    echo "WARNING: Qdrant did not respond within ${MAX_WAIT}s — continuing anyway"
    break
  fi
done
echo "Infrastructure ready after ${WAITED}s"

# Extra buffer for Postgres and Neo4j
sleep 5

ROOT="$(pwd)"

start_service() {
  local name=$1
  local path=$2
  local port=$3
  (
    cd "$path"
    source .venv/bin/activate
    export OPENAI_API_KEY="$OPENAI_API_KEY"
    export DATABASE_URL="$DATABASE_URL"
    export AGENT_URL="$AGENT_URL"
    [ -n "$FFMPEG_PATH" ] && export FFMPEG_PATH="$FFMPEG_PATH"
    uvicorn main:app --port "$port"
  ) &
  echo "Started $name on port $port (PID: $!)"
}

start_service "vernacular"          "$ROOT/services/feature-vernacular" 8005
start_service "feed"                "$ROOT/services/feature-feed"        8011
start_service "briefing"            "$ROOT/services/feature-briefing"    8002
start_service "arc"                 "$ROOT/services/feature-arc"         8004
start_service "video"               "$ROOT/services/feature-video"       8003
start_service "ingestion-pipeline"  "$ROOT/services/ingestion-pipeline"  8006
start_service "agent"               "$ROOT/services/agent"               8007

(cd "$ROOT/frontend" && npm run dev) &
echo "Started frontend on port 3000"

echo ""
echo "All services started!"
echo "Dashboard: http://localhost:3000"
echo ""
echo "Service ports:"
echo "  Vernacular:          http://localhost:8005/docs"
echo "  Feed:                http://localhost:8011/docs"
echo "  Briefing:            http://localhost:8002/docs"
echo "  Arc:                 http://localhost:8004/docs"
echo "  Video:               http://localhost:8003/docs"
echo "  Ingestion Pipeline:  http://localhost:8006/docs"
echo "  Agent:               http://localhost:8007/docs"
