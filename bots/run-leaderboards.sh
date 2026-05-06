#!/bin/bash
# Manually publish all three Local Bitcoiners leaderboards, in order.
# Run ~1 hour before recording the next episode.
#
# Order:
#   1. episodesats     — top episodes by all-time sats
#   2. boost-leaders   — listeners ranked by number of shows boosted
#   3. top-boosts      — single largest boosts of all time
#
# Each step waits for the previous one to finish (Type=oneshot blocks).
# After each unit completes, its journal output for this run is printed.

set -e

run_one() {
    local unit="$1"
    local label="$2"
    echo
    echo "=============================================================="
    echo "  $label  ($unit)"
    echo "=============================================================="
    local started
    started=$(date '+%Y-%m-%d %H:%M:%S')
    sudo systemctl start "$unit"
    journalctl -u "$unit" --since "$started" --no-pager
    echo "--- $unit done ---"
}

run_one weekly-recap.service   "1/3  episodesats — top episodes by all-time sats"
run_one boost-leaders.service  "2/3  boost-leaders — most shows boosted"
run_one top-boosts.service     "3/3  top-boosts — largest boosts of all time"

echo
echo "All three leaderboards published."
