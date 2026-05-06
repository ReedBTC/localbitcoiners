#!/bin/bash
# Manually publish all three Local Bitcoiners leaderboards, in order.
# Run ~1 hour before recording the next episode.
#
# Order:
#   1. episodesats     — top episodes by all-time sats
#   2. boost-leaders   — listeners ranked by number of shows boosted
#   3. top-boosts      — single largest boosts of all time
#
# No systemd, no sudo — invokes the bot scripts directly. Set -e bails
# out on the first failing publish so the next bot doesn't fire mid-error.
# Every successful publish appends a row to ../data/leaderboards.csv via
# record_published_leaderboard().

set -e

DIR="$(cd "$(dirname "$0")" && pwd)"

run_one() {
    local label="$1"
    local script="$2"
    echo
    echo "=============================================================="
    echo "  $label"
    echo "=============================================================="
    python3 "$DIR/$script"
    echo "--- done ---"
}

run_one "1/3  episodesats — top episodes by all-time sats" "weekly-recap/local_bitcoiners_episodesats.py"
run_one "2/3  boost-leaders — most shows boosted"         "boost-leaders/local_bitcoiners_boostleaders.py"
run_one "3/3  top-boosts — largest boosts of all time"    "top-boosts/local_bitcoiners_topboosts.py"

echo
echo "All three leaderboards published."
