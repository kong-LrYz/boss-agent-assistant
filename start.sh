#!/bin/sh
set -eu

# Keep the project directory independent of the terminal's current directory.
boss_project_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
cd "$boss_project_dir"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

boss_node=$(sh "$boss_project_dir/scripts/install-node.sh")
exec "$boss_node" "$boss_project_dir/scripts/install.js" "$@"
