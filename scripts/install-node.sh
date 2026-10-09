#!/bin/sh
set -eu
umask 077
boss_root=$(CDPATH= cd -P "$(dirname "$0")/.." && pwd)
boss_runtime="$boss_root/.runtime"
boss_fail() { printf '%s\n' "$1" >&2; exit 1; }
boss_node_ok() { [ -x "$1" ] && "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1; }

# Prefer a functioning system installation; never edit it or shell profiles.
if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  boss_system_node=$(command -v node)
  if boss_node_ok "$boss_system_node"; then printf '%s\n' "$boss_system_node"; exit 0; fi
fi
[ ! -L "$boss_runtime" ] || boss_fail '.runtime 不能是符号链接，请改用完整项目目录。'
[ ! -e "$boss_runtime" ] || [ -d "$boss_runtime" ] || boss_fail '.runtime 必须是普通目录。'
mkdir -p "$boss_runtime"
[ ! -L "$boss_runtime/node" ] || boss_fail '.runtime/node 不能是符号链接。'
if [ -e "$boss_runtime/node" ]; then
  if [ -d "$boss_runtime/node" ] && [ -f "$boss_runtime/node/lib/node_modules/npm/bin/npm-cli.js" ] && boss_node_ok "$boss_runtime/node/bin/node"; then
    printf '%s\n' "$boss_runtime/node/bin/node"; exit 0
  fi
  boss_fail '项目内 Node 不完整；未覆盖已有文件。请检查或删除 .runtime/node 后重新安装。'
fi
case "$(uname -s)" in Darwin) boss_platform=darwin ;; Linux) boss_platform=linux ;; *) boss_fail '当前系统不支持一键安装，请从 https://nodejs.org/ 安装 Node.js 22 或更新版。' ;; esac
case "$(uname -m)" in arm64|aarch64) boss_arch=arm64 ;; x86_64|amd64) boss_arch=x64 ;; *) boss_fail '当前 CPU 架构不支持一键安装，请从 https://nodejs.org/ 安装 Node.js 22 或更新版。' ;; esac
command -v curl >/dev/null 2>&1 || boss_fail '缺少 curl。请安装 curl 或从 https://nodejs.org/ 安装 Node.js 22 或更新版。'
command -v tar >/dev/null 2>&1 || boss_fail '缺少 tar，不能安全解压 Node.js。'
boss_name="node-v22.23.3-$boss_platform-$boss_arch"
boss_archive="$boss_name.tar.gz"
boss_manifest="$boss_root/scripts/install-node-checksums.txt"
[ -f "$boss_manifest" ] && [ ! -L "$boss_manifest" ] || boss_fail '缺少 Node SHA-256 校验表，请重新下载完整源码。'
boss_expected=$(awk -v name="$boss_archive" '$2==name {print $1}' "$boss_manifest")
[ "${#boss_expected}" -eq 64 ] || boss_fail 'Node SHA-256 校验表缺失或不唯一。'
case "$boss_expected" in *[!a-f0-9]*) boss_fail 'Node SHA-256 校验表格式错误。' ;; esac
if command -v shasum >/dev/null 2>&1; then boss_hash=shasum; elif command -v sha256sum >/dev/null 2>&1; then boss_hash=sha256sum; else boss_fail '缺少 SHA-256 校验工具，未下载或执行 Node.js。'; fi
mkdir "$boss_runtime/node-install.lock" 2>/dev/null || boss_fail '另一个安装任务正在运行。若此前安装被强制结束，请删除 .runtime/node-install.lock 后重试。'
boss_stage=''
boss_cleanup() { [ -z "$boss_stage" ] || rm -rf "$boss_stage"; rmdir "$boss_runtime/node-install.lock" 2>/dev/null || true; }
trap boss_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
boss_stage=$(mktemp -d "$boss_runtime/.node-install.XXXXXX")
printf '%s\n' '首次启动：下载官方 Node.js 22.23.3 到本项目，并校验 SHA-256…' >&2
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 15 --max-time 180 --output "$boss_stage/$boss_archive" "https://nodejs.org/dist/v22.23.3/$boss_archive" || boss_fail 'Node 下载失败或超时。请检查网络后重试；不会修改系统 Node。'
if [ "$boss_hash" = shasum ]; then boss_actual=$(shasum -a 256 "$boss_stage/$boss_archive" | awk '{print $1}'); else boss_actual=$(sha256sum "$boss_stage/$boss_archive" | awk '{print $1}'); fi
[ "$boss_actual" = "$boss_expected" ] || boss_fail 'Node 下载文件的 SHA-256 校验不一致；未解压、未执行，请检查网络后重试。'
tar -xzf "$boss_stage/$boss_archive" -C "$boss_stage"
[ -f "$boss_stage/$boss_name/lib/node_modules/npm/bin/npm-cli.js" ] && boss_node_ok "$boss_stage/$boss_name/bin/node" || boss_fail 'Node 无法运行或不完整；Linux 需要兼容的 glibc/libstdc++ 与桌面环境。'
[ ! -e "$boss_runtime/node" ] && [ ! -L "$boss_runtime/node" ] || boss_fail '项目内 Node 目录在安装期间发生变化；未覆盖文件。'
mv "$boss_stage/$boss_name" "$boss_runtime/node"
printf '%s\n' "$boss_runtime/node/bin/node"
