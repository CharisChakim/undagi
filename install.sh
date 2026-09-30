#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY="CharisChakim/undagi"
# The ARCHITECH_* names from before the rename are still accepted as fallbacks.
INSTALL_DIR="${UNDAGI_INSTALL_DIR:-${ARCHITECH_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/undagi}}"
BIN_DIR="${UNDAGI_BIN_DIR:-${ARCHITECH_BIN_DIR:-$HOME/.local/bin}}"
# Until after 1.0.1-beta the app was called The Architech and installed here.
# Its data/ and .env live in the install directory, so the old one is moved
# to the new name rather than left behind.
LEGACY_INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/the-architech"
ARCHIVE_URL="${UNDAGI_ARCHIVE_URL:-${ARCHITECH_ARCHIVE_URL:-https://github.com/${REPOSITORY}/archive/refs/heads/main.tar.gz}}"

for command_name in node npm curl tar; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Missing requirement: %s\n' "$command_name" >&2
    exit 1
  fi
done

if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 14) ? 0 : 1)'; then
  printf 'Node.js 22.14 or newer is required. Current version: %s\n' "$(node --version)" >&2
  exit 1
fi

if [[ -z "${UNDAGI_INSTALL_DIR:-}" && -z "${ARCHITECH_INSTALL_DIR:-}" && -d "$LEGACY_INSTALL_DIR" && ! -e "$INSTALL_DIR" ]]; then
  printf 'Moving The Architech install to %s...\n' "$INSTALL_DIR"
  mv "$LEGACY_INSTALL_DIR" "$INSTALL_DIR"
  # The old launcher still points at the directory that was just moved.
  rm -f "$BIN_DIR/the-architech"
fi

temp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$temp_dir"
}
trap cleanup EXIT

printf 'Downloading Undagi...\n'
curl -fsSL "$ARCHIVE_URL" -o "$temp_dir/source.tar.gz"
tar -xzf "$temp_dir/source.tar.gz" -C "$temp_dir"
source_dir="$(find "$temp_dir" -mindepth 1 -maxdepth 1 -type d -name 'undagi-*' -print -quit)"
if [[ -z "$source_dir" ]]; then
  printf 'Downloaded archive did not contain the application.\n' >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR" "$BIN_DIR"
# Copying over the existing directory intentionally keeps data/ and .env when
# this installer is used for an update.
cp -a "$source_dir/." "$INSTALL_DIR/"

printf 'Installing dependencies and building production files...\n'
(
  cd "$INSTALL_DIR"
  npm ci
  npm run build
  if [[ ! -f dist/index.html || ! -f dist/server.cjs ]]; then
    printf 'Production build is incomplete.\n' >&2
    exit 1
  fi
)

launcher="$BIN_DIR/undagi"
{
  printf '#!/usr/bin/env bash\n'
  printf 'cd %q\n' "$INSTALL_DIR"
  printf 'exec node dist/server.cjs --production\n'
} > "$launcher"
chmod +x "$launcher"

printf '\nInstalled in: %s\n' "$INSTALL_DIR"
printf 'Start with: %s\n' "$launcher"
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  printf 'Add %s to PATH to run: undagi\n' "$BIN_DIR"
fi
printf 'Then open http://localhost:3000\n'
