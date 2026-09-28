#!/bin/sh
# Headless regression tests via JavaScriptCore (osascript).
# Runs the real analytics.js + scheduler.js logic with stubbed browser globals.
cd "$(dirname "$0")/.."
echo "──────── Flow analytics ────────"
cat tests/e2e-head.js analytics.js tests/e2e-tail.js > tests/.combined.js
osascript -l JavaScript tests/.combined.js 2>&1
echo ""
echo "──────── Ceremony scheduler ────────"
cat tests/sched-head.js scheduler.js tests/sched-tail.js > tests/.combined-sched.js
osascript -l JavaScript tests/.combined-sched.js 2>&1
rm -f tests/.combined.js tests/.combined-sched.js
