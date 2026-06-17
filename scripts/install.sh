#!/usr/bin/env bash
set -euo pipefail

package_name="${LISTEN_NPM_PACKAGE:-@tinycloud/listen-cli}"

echo "Installing $package_name..."
npm install --global "$package_name"

if [[ "${1:-}" == "--migrate" ]]; then
  listen migrate-state
fi

listen doctor
