#!/usr/bin/env bash
set -euo pipefail

TELEGRAM_BOT_API_REF="${TELEGRAM_BOT_API_REF:-}"
BUILD_ROOT="${BUILD_ROOT:-/usr/local/src/telegram-bot-api-build}"
REPO_DIR="${BUILD_ROOT}/telegram-bot-api"
INSTALL_BIN="${INSTALL_BIN:-/usr/local/bin/telegram-bot-api}"

if [[ -z "${TELEGRAM_BOT_API_REF}" ]]; then
  echo "Set TELEGRAM_BOT_API_REF to a reviewed telegram-bot-api tag or commit before running."
  exit 1
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root or through sudo."
  exit 1
fi

apt-get update
apt-get install -y --no-install-recommends \
  git make g++ cmake gperf zlib1g-dev libssl-dev \
  libreadline-dev libconfig++-dev ca-certificates

mkdir -p "${BUILD_ROOT}"
if [[ ! -d "${REPO_DIR}/.git" ]]; then
  git clone --recursive https://github.com/tdlib/telegram-bot-api.git "${REPO_DIR}"
else
  git -C "${REPO_DIR}" fetch --tags origin
fi

git -C "${REPO_DIR}" checkout "${TELEGRAM_BOT_API_REF}"
git -C "${REPO_DIR}" submodule update --init --recursive

cmake -S "${REPO_DIR}" -B "${REPO_DIR}/build" -DCMAKE_BUILD_TYPE=Release
cmake --build "${REPO_DIR}/build" --target telegram-bot-api -j"$(nproc)"
install -m 0755 "${REPO_DIR}/build/telegram-bot-api" "${INSTALL_BIN}"

"${INSTALL_BIN}" --version || true
echo "Installed telegram-bot-api from ${TELEGRAM_BOT_API_REF} to ${INSTALL_BIN}"
