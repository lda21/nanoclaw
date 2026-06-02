#!/usr/bin/env bash
# Assemble each agent's CLAUDE.local.md from the shared layers + its identity.
# Edit team/COMPANY.md, team/_memory.md, team/_candlekeep.md, or
# team/identities/<key>.md, then re-run this script to propagate.
set -euo pipefail
cd "$(dirname "$0")/.."   # nanoclaw-v2 root
TEAM=team

# key:folder  (folder is the groups/<folder> directory)
AGENTS=("keeper:keeper" "intel:intel" "herald:herald" "quill:quill" "seneschal:seneschal" "elon:elon" "scout:scout")

for spec in "${AGENTS[@]}"; do
  key="${spec%%:*}"; folder="${spec##*:}"
  id_file="$TEAM/identities/$key.md"
  if [[ ! -f "$id_file" ]]; then echo "skip $key (no $id_file)"; continue; fi
  mkdir -p "groups/$folder"
  out="groups/$folder/CLAUDE.local.md"
  {
    echo "<!-- AUTO-ASSEMBLED by team/assemble.sh. Edit team/identities/$key.md or the shared team/*.md, then re-run. Do not hand-edit this file. -->"
    echo
    echo "<!-- COMPANY:BEGIN -->"
    cat "$TEAM/COMPANY.md"
    echo "<!-- COMPANY:END -->"
    echo
    echo "---"
    echo
    cat "$id_file"
    echo
    echo "---"
    echo
    cat "$TEAM/_memory.md"
    echo
    cat "$TEAM/_candlekeep.md"
  } > "$out"
  echo "wrote $out ($(wc -l < "$out") lines)"
done
