#!/usr/bin/env sh
# Tracked copy of the launcher example_plugin/README.md tells you to write yourself for a local
# `stand` run. CI copies this into generated/local/run/ (see ci.yml) since that directory is
# gitignored and can't hold a script of its own. Keep this in sync with the README snippet.
set -e

cd "$(dirname "$0")"

JAVA_BIN="${JAVA_BIN:-java}"
JVM_ARGS="${JVM_ARGS:--Xmx2G}"

exec "$JAVA_BIN" $JVM_ARGS -Dcom.mojang.eula.agree=true -jar server.jar --nogui
