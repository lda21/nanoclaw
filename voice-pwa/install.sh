#!/bin/bash
# NanoClaw Voice PWA — installer v3
# Fixes macOS Docker Desktop networking: proxy container joins voice-gateway's network
set -e

echo "=== Voice PWA — Mac Mini setup ==="

PROXY_NAME="voice-pwa-proxy"
HOST_PORT=3001
CONTAINER_PORT=3000

# ── 1. Find voice-gateway container + its network ────────────────────────────
echo "[1/3] Finding voice-gateway container..."
VOICE_ID=$(docker ps --format "{{.ID}} {{.Names}}" \
  | grep -i "voice" | grep -v "$PROXY_NAME" | awk '{print $1}' | head -1)

if [ -z "$VOICE_ID" ]; then
  echo "ERROR: voice-gateway container not found. Is NanoClaw running?"
  exit 1
fi

VOICE_IP=$(docker inspect "$VOICE_ID" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' | awk '{print $1}')
VOICE_NETWORK=$(docker inspect "$VOICE_ID" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' | awk '{print $1}')

echo "  Container IP: $VOICE_IP"
echo "  Network: $VOICE_NETWORK"

# ── 2. Start proxy container on the SAME network ─────────────────────────────
echo "[2/3] Starting proxy container (same Docker network as voice-gateway)..."
docker rm -f "$PROXY_NAME" 2>/dev/null || true
docker run -d \
  --name "$PROXY_NAME" \
  --network "$VOICE_NETWORK" \
  -p "${HOST_PORT}:${CONTAINER_PORT}" \
  --restart unless-stopped \
  alpine sh -c "apk add -q socat && socat TCP-LISTEN:${CONTAINER_PORT},fork,reuseaddr TCP:${VOICE_IP}:${CONTAINER_PORT}"

echo "  Waiting for proxy to start..."
sleep 3
if curl -sf http://localhost:${HOST_PORT}/ > /dev/null 2>&1; then
  echo "  ✓ HTTP 200"
else
  echo "  ⚠ Not yet reachable — check: docker logs $PROXY_NAME"
fi

# ── 3. Configure Tailscale ────────────────────────────────────────────────────
echo "[3/3] Configuring Tailscale HTTPS → port ${HOST_PORT}..."
tailscale serve --https=443 off 2>/dev/null || true
sleep 1
tailscale serve --bg ${HOST_PORT} 2>/dev/null \
  || tailscale serve https / http://localhost:${HOST_PORT} \
  || echo "  ⚠ Run manually: tailscale serve --bg ${HOST_PORT}"

echo ""
echo "=== Done ==="
echo "URL: https://danelminis-mac-mini-1.tail6119bd.ts.net/"
echo "Verify: curl -I http://localhost:${HOST_PORT}/"
echo "Logs:   docker logs $PROXY_NAME"
