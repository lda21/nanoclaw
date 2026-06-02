#!/bin/bash
# NanoClaw Voice PWA — one-shot installer
# Run: curl <url> | sudo bash
set -e

echo "=== Voice PWA installer ==="

# Create temp dir
TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT

# Write voice-pwa-start.sh
cat > "$TMP/voice-pwa-start.sh" << 'STARTSCRIPT'
#!/bin/bash
# voice-pwa-start.sh — run by launchd on boot.
# Finds the voice-gateway Docker container IP dynamically,
# then runs socat to forward host port 3001 → container:3000.
# Loops every 30s to repoint socat if the container restarts and gets a new IP.

LOG="/var/log/voice-pwa.log"
PORT_HOST=3001
PORT_CONTAINER=3000

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" | tee -a "$LOG"; }

find_ip() {
  # Search Docker containers whose name contains "voice" (NanoClaw naming convention)
  local cid ip
  cid=$(docker ps --format "{{.ID}} {{.Names}}" 2>/dev/null \
        | grep -i "voice" | awk '{print $1}' | head -1)
  if [ -n "$cid" ]; then
    ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$cid" 2>/dev/null)
    [ -n "$ip" ] && echo "$ip" && return
  fi
  # Fallback: last known static IP
  echo "172.17.0.5"
}

kill_socat() { pkill -f "socat TCP-LISTEN:${PORT_HOST}" 2>/dev/null || true; sleep 0.5; }

CURRENT_IP=""
SOCAT_PID=""

log "voice-pwa-start: starting"

while true; do
  NEW_IP=$(find_ip)

  if [ "$NEW_IP" != "$CURRENT_IP" ] || ! kill -0 "$SOCAT_PID" 2>/dev/null; then
    log "Container IP: ${NEW_IP} (was: ${CURRENT_IP:-none}). Restarting socat."
    kill_socat
    CURRENT_IP="$NEW_IP"
    socat TCP-LISTEN:${PORT_HOST},fork,reuseaddr "TCP:${CURRENT_IP}:${PORT_CONTAINER}" &
    SOCAT_PID=$!
    log "socat PID=$SOCAT_PID → ${CURRENT_IP}:${PORT_CONTAINER}"
  fi

  sleep 30
done

STARTSCRIPT

# Write plist
cat > "$TMP/com.nanoclaw.voice-pwa.plist" << 'PLISTEOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.nanoclaw.voice-pwa</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/usr/local/bin/voice-pwa-start.sh</string>
  </array>

  <!-- Start immediately when loaded, and on every boot -->
  <key>RunAtLoad</key>
  <true/>

  <!-- Restart automatically if the script exits for any reason -->
  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>/var/log/voice-pwa.log</string>
  <key>StandardErrorPath</key>
  <string>/var/log/voice-pwa.log</string>

  <!-- Give Docker time to come up before this runs on boot -->
  <key>StartInterval</key>
  <integer>0</integer>
  <key>ThrottleInterval</key>
  <integer>10</integer>
</dict>
</plist>

PLISTEOF

# Install
if ! command -v socat >/dev/null 2>&1; then
  echo "[1/4] Installing socat..."
  brew install socat
else
  echo "[1/4] socat OK"
fi

echo "[2/4] Installing start script..."
cp "$TMP/voice-pwa-start.sh" /usr/local/bin/voice-pwa-start.sh
chmod +x /usr/local/bin/voice-pwa-start.sh

echo "[3/4] Installing launchd daemon..."
cp "$TMP/com.nanoclaw.voice-pwa.plist" /Library/LaunchDaemons/com.nanoclaw.voice-pwa.plist
launchctl unload /Library/LaunchDaemons/com.nanoclaw.voice-pwa.plist 2>/dev/null || true
launchctl load /Library/LaunchDaemons/com.nanoclaw.voice-pwa.plist
echo "  Logs: tail -f /var/log/voice-pwa.log"

echo "[4/4] Tailscale serve..."
if tailscale serve status 2>/dev/null | grep -q "3001"; then
  echo "  already configured"
else
  tailscale serve --bg 3001 2>/dev/null || echo "  Run manually: tailscale serve --bg 3001"
fi

echo ""
echo "Done! URL: https://danelminis-mac-mini-1.tail6119bd.ts.net/"
echo "Check: curl -I http://localhost:3001/"
