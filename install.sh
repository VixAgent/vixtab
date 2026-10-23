#!/usr/bin/env bash
# VixTab installer for Linux: downloads the latest release, checks its SHA-256, installs the CLI to ~/.vixtab/bin,
# the Claude Code skills, and (if the `code` command exists) the VS Code extension.
#   curl -fsSL https://raw.githubusercontent.com/VixAgent/vixtab/main/install.sh | bash
#   VIXTAB_VERSION=v0.1.0 bash install.sh        # a specific release
set -euo pipefail
REPO="VixAgent/vixtab"
case "$(uname -m)" in x86_64|amd64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; *) echo "unsupported CPU: $(uname -m)" >&2; exit 1 ;; esac
[ "$(uname -s)" = Linux ] || { echo "this installer is for Linux (Windows: install.ps1)" >&2; exit 1; }
BASE="https://github.com/$REPO/releases/${VIXTAB_VERSION:+download/$VIXTAB_VERSION}"
[ -n "${VIXTAB_VERSION:-}" ] || BASE="https://github.com/$REPO/releases/latest/download"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
echo "Downloading VixTab ($ARCH)…"
for f in "vixtab-linux-$ARCH.tar.gz" "vixtab-linux-$ARCH.vsix" SHA256SUMS; do curl -fsSL "$BASE/$f" -o "$TMP/$f"; done
(cd "$TMP" && grep -E " (vixtab-linux-$ARCH\.tar\.gz|vixtab-linux-$ARCH\.vsix)$" SHA256SUMS | sha256sum -c --quiet -)
tar -xzf "$TMP/vixtab-linux-$ARCH.tar.gz" -C "$TMP" vixtab
"$TMP/vixtab" setup
if command -v code >/dev/null 2>&1; then
  "$TMP/vixtab" setup --extension "$TMP/vixtab-linux-$ARCH.vsix"
else
  echo "VS Code's \`code\` command was not found: install the extension from the Marketplace (VixTab) or from $BASE/vixtab-linux-$ARCH.vsix"
fi
echo "Done. Run: vixtab doctor   (inside a repository)"
