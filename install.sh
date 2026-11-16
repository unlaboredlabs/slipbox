#!/bin/sh
# Installs slipbox into ~/.local/bin from the latest release. No sudo needed.
#   curl -fsSL https://raw.githubusercontent.com/unlaboredlabs/slipbox/main/install.sh | sh
# RELEASE_URL and BIN_DIR override where it downloads from and installs to.
set -eu

REPO="unlaboredlabs/slipbox"

NAME="${REPO##*/}"
RELEASE_URL="${RELEASE_URL:-https://github.com/$REPO/releases/download/edge}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"

fail() {
  echo "error: $*" >&2
  exit 1
}

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) fail "$NAME runs on Linux and macOS; this is $(uname -s)." ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "no $NAME build for $(uname -m) yet." ;;
esac

# A shell under Rosetta reports x86_64 on Apple silicon; install the native build.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
  arch=arm64
fi

asset="$NAME-$os-$arch"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2" || fail "could not download $1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$1" -O "$2" || fail "could not download $1"
  else
    fail "curl or wget is needed."
  fi
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    fail "sha256sum or shasum is needed to check the download."
  fi
}

echo "Downloading $asset ..."
download "$RELEASE_URL/$asset" "$tmp/$asset"
download "$RELEASE_URL/checksums.txt" "$tmp/checksums.txt"

expected="$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$tmp/checksums.txt")"
[ -n "$expected" ] || fail "checksums.txt has no entry for $asset."
actual="$(sha256 "$tmp/$asset")"
[ "$expected" = "$actual" ] || fail "checksum mismatch for $asset (expected $expected, got $actual)."

mkdir -p "$BIN_DIR"
chmod 755 "$tmp/$asset"
mv "$tmp/$asset" "$BIN_DIR/$NAME"

echo "Installed $("$BIN_DIR/$NAME" version) to $BIN_DIR/$NAME"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "Add $BIN_DIR to your PATH, for example: echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.profile" ;;
esac
echo
echo "Run it in the background and at login:  $NAME service install"
echo "Or in the foreground:                   $NAME serve"
