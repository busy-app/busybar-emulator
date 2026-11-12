#!/bin/zsh
# Installs BUSY Bar Emulator for the current user on macOS (Apple Silicon or Intel), starts it and prints the path of
# its command line. Nothing but what macOS has: curl, shasum, ditto, plutil. No Node, no administrator rights.
# What it downloads and from where: public-docs/install.md.
#
#   zsh install-macos.sh
#
# BUSY_EMULATOR_RELEASE_URL replaces the address of the latest release (the folder the release files lie in): only
# for tests and for a mirror the user names. It must be https (http only to 127.0.0.1 or localhost).
set -eu

official=https://github.com/busy-app/busybar-emulator/releases/latest/download
base=${BUSY_EMULATOR_RELEASE_URL:-$official}
base=${base%/}
# The build for this Mac's processor. The hardware, not uname -m: a shell under Rosetta says x86_64 on Apple Silicon.
# An Intel Mac has no such key, and takes the Intel build.
if [ "$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ]; then
  zip=busybar-emulator-mac-arm64.zip
else
  zip=busybar-emulator-mac-x64.zip
fi
name='BUSY Bar Emulator.app'
pointer="$HOME/Library/Application Support/BUSY Bar Emulator/install.json"

say() { printf 'install: %s\n' "$*"; }
fail() { printf 'install: %s\n' "$*" >&2; exit 1; }
in_pointer() { /usr/bin/plutil -extract "$1" raw -o - "$pointer" 2>/dev/null || true; }

case $base in
  https://?*|http://127.0.0.1:*|http://127.0.0.1/*|http://localhost:*|http://localhost/*) ;;
  *) fail "BUSY_EMULATOR_RELEASE_URL must be an https address: $base" ;;
esac
[ "$base" = "$official" ] || say "not the official release: the files come from $base"

# 1. Is the emulator installed? The pointer file says, if the app it names is still there; the command may well not
# be on PATH. An app moved or put in the Trash leaves the pointer file and the command line behind.
cli=
if [ -f "$pointer" ]; then
  cli=$(in_pointer cli)
  named=$(in_pointer app)
  if [ -n "$cli" ] && [ -f "$cli" ] && [ -x "$cli" ] && [ -n "$named" ] && [ -d "$named" ]; then
    say "installed: $pointer names $cli"
  else
    say "$pointer names no app or command line that exists; looking for the app"
    cli=
  fi
fi

if [ -n "$cli" ]; then
  start=$cli
else
  # 2. The app may be in place without the pointer file (it writes it at its first start).
  app=
  for place in "/Applications/$name" "$HOME/Applications/$name"; do
    if [ -d "$place" ]; then
      app=$place
      break
    fi
  done
  if [ -n "$app" ]; then
    say "found $app"
  else
    tmp=$(/usr/bin/mktemp -d -t busy-emulator-install)
    trap '/bin/rm -rf "$tmp"' EXIT
    say "downloading $base/$zip and $base/SHA256SUMS"
    /usr/bin/curl -fsSL --proto-redir '=https' --retry 2 -o "$tmp/$zip" "$base/$zip" || fail "could not download $base/$zip"
    /usr/bin/curl -fsSL --proto-redir '=https' --retry 2 -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" || fail "could not download $base/SHA256SUMS"
    # 3. The archive must match its line in SHA256SUMS before anything is unpacked.
    expected=$(/usr/bin/awk -v n="$zip" '$2 == n { print $1 }' "$tmp/SHA256SUMS")
    printf '%s\n' "$expected" | /usr/bin/grep -Eqx '[0-9a-f]{64}' || fail "SHA256SUMS has no single sum for $zip; nothing installed"
    actual=$(/usr/bin/shasum -a 256 "$tmp/$zip" | /usr/bin/awk '{ print $1 }')
    [ "$actual" = "$expected" ] || fail "$zip does not match SHA256SUMS (expected $expected, got $actual); nothing unpacked, nothing installed"
    say "$zip matches SHA256SUMS"
    # 4. Unpack beside the download, then move the app into ~/Applications: no half app is ever left there.
    /usr/bin/ditto -x -k "$tmp/$zip" "$tmp/unpacked"
    [ -d "$tmp/unpacked/$name" ] || fail "$zip holds no $name; nothing installed"
    /bin/mkdir -p "$HOME/Applications"
    [ ! -e "$HOME/Applications/$name" ] || fail "$HOME/Applications/$name appeared meanwhile; nothing replaced"
    /bin/mv "$tmp/unpacked/$name" "$HOME/Applications/$name"
    app="$HOME/Applications/$name"
    say "installed $app"
  fi
  start="$app/Contents/Resources/bin/busy-emulator"
fi

# 5. Start it. At every start the app writes the pointer file and the command line at its fixed place.
say "starting the emulator"
"$start" start
cli=$(in_pointer cli)
[ -n "$cli" ] && [ -f "$cli" ] && [ -x "$cli" ] || fail "the emulator started but $pointer names no command line"
say "the command line is $cli"
printf 'cli=%s\n' "$cli"
