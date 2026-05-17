#!/usr/bin/env bash
# Exercises each tool locally (uses .env automatically).
# Run after: ntn workers env set + ntn workers oauth start smartcarAuth.
set -euo pipefail

echo "▸ getVehicleStatus"
ntn workers exec getVehicleStatus --local -d '{}'

echo ""
echo "▸ canIMakeIt 100 mi"
ntn workers exec canIMakeIt --local -d '{"destination_miles": 100}'

echo ""
echo "▸ canIMakeIt 380 mi (LA-style trip)"
ntn workers exec canIMakeIt --local -d '{"destination_miles": 380}'

echo ""
echo "▸ lockCar"
ntn workers exec lockCar --local -d '{}'

echo ""
echo "▸ unlockCar"
ntn workers exec unlockCar --local -d '{}'
