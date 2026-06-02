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
