#!/bin/sh
# Installs slipbox into ~/.local/bin from the latest release. No sudo needed.
#   curl -fsSL https://raw.githubusercontent.com/unlaboredlabs/slipbox/main/install.sh | sh
# SLIPBOX_RELEASE_URL and SLIPBOX_BIN_DIR override where it downloads from and installs to.
set -eu

REPO="unlaboredlabs/slipbox"

NAME="${REPO##*/}"
RELEASE_URL="${SLIPBOX_RELEASE_URL:-https://github.com/$REPO/releases/download/edge}"
BIN_DIR="${SLIPBOX_BIN_DIR:-$HOME/.local/bin}"
SERVICE="${SLIPBOX_SERVICE_NAME:-$NAME}"
TRIES=4
WAIT="${SLIPBOX_RETRY_SECONDS:-10}"

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

# Check the tools before the long download.
if command -v curl >/dev/null 2>&1; then
  fetch=curl
elif command -v wget >/dev/null 2>&1; then
  fetch=wget
else
  fail "curl or wget is needed."
fi
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  fail "sha256sum or shasum is needed to check the download."
fi
if ! git --version >/dev/null 2>&1; then
  if [ "$os" = darwin ]; then how="xcode-select --install"; else how="your package manager"; fi
  echo "note: $NAME keeps its history with git, which is not installed. Install it with $how before starting $NAME."
fi

asset="$NAME-$os-$arch"
mkdir -p "$BIN_DIR"
# Download next to the target, so the final move is an atomic rename on one filesystem.
tmp="$(mktemp -d "$BIN_DIR/.$NAME.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

# download URL FILE [progress]: 0 on success, 2 when the server answered an error, 1 otherwise.
download() {
  code=0
  if [ "$fetch" = curl ]; then
    if [ "${3:-}" = progress ]; then
      curl -fL --progress-bar "$1" -o "$2" || code=$?
    else
      curl -fsSL "$1" -o "$2" || code=$?
    fi
    case "$code" in 0) return 0 ;; 22) return 2 ;; *) return 1 ;; esac
  fi
  if [ "${3:-}" != progress ]; then
    wget -q "$1" -O "$2" || code=$?
  elif wget --help 2>&1 | grep -q -- --show-progress; then
    wget -q --show-progress "$1" -O "$2" || code=$?
  else
    wget "$1" -O "$2" || code=$? # busybox wget shows progress unless -q
  fi
  # GNU wget answers 8 for an HTTP error; busybox wget 1 for any failure.
  case "$code" in 0) return 0 ;; 1 | 8) return 2 ;; *) return 1 ;; esac
}

# The edge release is replaced in place on every push: for a few seconds an asset
# can be missing, or the binary and checksums.txt can be from two releases.
# Fetch both again until they agree.
echo "Downloading $asset ..."
try=1
while :; do
  problem=""
  code=0
  download "$RELEASE_URL/$asset" "$tmp/$asset" progress || code=$?
  [ "$code" = 1 ] && fail "could not download $RELEASE_URL/$asset"
  if [ "$code" = 2 ]; then
    problem="$asset is not there"
  else
    code=0
    download "$RELEASE_URL/checksums.txt" "$tmp/checksums.txt" || code=$?
    [ "$code" = 1 ] && fail "could not download $RELEASE_URL/checksums.txt"
    if [ "$code" = 2 ]; then
      problem="checksums.txt is not there"
    else
      expected="$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$tmp/checksums.txt")"
      actual="$(sha256 "$tmp/$asset")"
      if [ -z "$expected" ]; then
        problem="checksums.txt has no entry for $asset"
      elif [ "$expected" != "$actual" ]; then
        problem="checksum mismatch for $asset (expected $expected, got $actual)"
      fi
    fi
  fi
  [ -z "$problem" ] && break
  if [ "$try" -ge "$TRIES" ]; then
    fail "$problem. A new release may still be being published; try again in a minute."
  fi
  echo "A new release is being published; trying again in $WAIT s."
  sleep "$WAIT"
  try=$((try + 1))
done

updating=""
[ -e "$BIN_DIR/$NAME" ] && updating=1
chmod 755 "$tmp/$asset"
mv "$tmp/$asset" "$BIN_DIR/$NAME"

echo "Installed $("$BIN_DIR/$NAME" version) to $BIN_DIR/$NAME"

# A running service keeps the old program until it restarts.
if [ -n "$updating" ]; then
  if [ "$os" = linux ] && systemctl --user is-active --quiet "$SERVICE" 2>/dev/null; then
    systemctl --user restart "$SERVICE" && echo "Restarted the $SERVICE service."
  elif [ "$os" = darwin ] && launchctl print "gui/$(id -u)/$SERVICE" >/dev/null 2>&1; then
    launchctl kickstart -k "gui/$(id -u)/$SERVICE" && echo "Restarted the $SERVICE service."
  fi
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) cmd="$NAME" ;;
  *)
    case "${SHELL:-}" in
      */zsh) profile=.zprofile ;;
      *) profile=.profile ;;
    esac
    echo "Add $BIN_DIR to your PATH, then open a new terminal: echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/$profile"
    echo "Meanwhile, run it as $BIN_DIR/$NAME."
    cmd="$BIN_DIR/$NAME"
    ;;
esac
echo
echo "Run it in the background and at login:  $cmd service install"
echo "Or in the foreground:                   $cmd serve"
