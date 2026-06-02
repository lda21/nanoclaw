#!/bin/bash
# NanoClaw Voice PWA — installer v2 (macOS + Docker Desktop)
# Run: curl -sL https://raw.githubusercontent.com/lda21/nanoclaw/main/voice-pwa/install.sh | sudo bash
set -e

echo "=== Voice PWA installer ==="

# ── 1. Find voice-gateway container IP ───────────────────────────────────────
echo "[1/3] Finding voice-gateway container..."
VOICE_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' \
  $(docker ps --format "{{.ID}} {{.Names}}" | grep -i voice | awk '{print $1}' | head -1) 2>/dev/null || echo "172.17.0.5")

echo "  Container IP: $VOICE_IP"

# ── 2. Start proxy container ──────────────────────────────────────────────────
echo "[2/3] Starting voice-proxy container (port 3002 → $VOICE_IP:3000)..."
docker rm -f voice-proxy 2>/dev/null || true
docker run -d \
  --name voice-proxy \
  -p 3002:3000 \
  --restart unless-stopped \
  alpine sh -c "apk add -q socat && socat TCP-LISTEN:3000,fork,reuseaddr TCP:${VOICE_IP}:3000"

sleep 2
echo "  Waiting for proxy..."
for i in 1 2 3 4 5; do
  if curl -sf http://localhost:3002/ > /dev/null 2>&1; then
    echo "  ✓ Proxy up (HTTP 200)"
    break
  fi
  sleep 2
done

# ── 3. Configure Tailscale ────────────────────────────────────────────────────
echo "[3/3] Configuring Tailscale HTTPS → port 3002..."
# Remove old conflicting serve entries
tailscale serve --https=443 off 2>/dev/null || true
sleep 1
tailscale serve --bg 3002 2>/dev/null \
  || tailscale serve https / http://localhost:3002 \
  || echo "  ⚠ Run manually: tailscale serve --bg 3002"

echo ""
echo "=== Done ==="
echo "URL: https://danelminis-mac-mini-1.tail6119bd.ts.net/"
echo ""
echo "Verify: curl -I http://localhost:3002/"
echo "Logs:   docker logs voice-proxy"
