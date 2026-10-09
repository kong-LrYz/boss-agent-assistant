#!/bin/sh
set -eu
boss_project_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
exec sh "$boss_project_dir/start.sh" --open-chrome-download "$@"
