#!/bin/sh
# Resolve assets/wasm/hledger.wasm from wasm.lock.
#
# Run automatically as a Trunk `pre_build` hook, and safe to run by hand.
#
# This script ALWAYS exits 0. That is deliberate: a missing hledger.wasm must
# not stop the project from building or from starting `trunk serve`. Without the
# artifact the app still compiles and renders, and shows an explicit
# "hledger.wasm is missing" state with the instructions below, rather than
# failing the build or showing blank panels.
#
# The artifact itself is committed at assets/wasm/hledger.wasm, so a fresh clone
# can build without a network. This script exists to keep it honest: it verifies
# the file against the `sha256` in wasm.lock, and lets a local rebuild take
# precedence so that changing the build inputs is enough to change the engine.
#
# Resolution order:
#   1. $HLEDGER_WASM_PATH          explicit override, for experimenting
#   2. artifacts/hledger.wasm      a local build from build-hledger-wasm.sh
#   3. assets/wasm/hledger.wasm    the committed artifact, if it verifies
#   4. wasm.lock `url`             a pinned, checksummed download, if one is set
#   5. nothing available           print instructions, exit 0
#
# Whenever a checksum is recorded in wasm.lock it is enforced, including on
# files that are already in place, so a stale or corrupted binary is replaced
# rather than silently used.

set -u

# --- locate the repository root -------------------------------------------
_here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(CDPATH= cd -- "$_here/.." && pwd)
lock="$root/wasm.lock"
dest="$root/assets/wasm/hledger.wasm"
local_build="$root/artifacts/hledger.wasm"

say() { printf '%s\n' "$*"; }
warn() { printf '%s\n' "$*" >&2; }

# --- read a flat `key = "value"` out of wasm.lock -------------------------
lock_get() {
    [ -f "$lock" ] || return 0
    awk -v want="$1" '
        /^[[:space:]]*#/ { next }
        {
            line = $0
            sub(/[[:space:]]*#.*$/, "", line)
            if (index(line, "=") == 0) next
            key = substr(line, 1, index(line, "=") - 1)
            val = substr(line, index(line, "=") + 1)
            gsub(/^[[:space:]]+|[[:space:]]+$/, "", key)
            gsub(/^[[:space:]]+|[[:space:]]+$/, "", val)
            gsub(/^"|"$/, "", val)
            if (key == want) { print val; exit }
        }
    ' "$lock"
}

# --- sha256, portably ------------------------------------------------------
sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d' ' -f1
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | cut -d' ' -f1
    else
        echo ""
    fi
}

want_sha=$(lock_get sha256)
flavor=$(lock_get flavor)
version=$(lock_get hledger_version)

# Is the file already in place and does it match the recorded checksum?
already_ok() {
    [ -f "$dest" ] || return 1
    if [ -z "$want_sha" ]; then
        return 0
    fi
    got=$(sha256_of "$dest")
    [ -n "$got" ] && [ "$got" = "$want_sha" ]
}

verify_or_fail() {
    # $1 = candidate path
    if [ -z "$want_sha" ]; then
        warn "  ! no sha256 recorded in wasm.lock; accepting without verification"
        return 0
    fi
    got=$(sha256_of "$1")
    if [ -z "$got" ]; then
        warn "  ! no sha256 tool available (sha256sum/shasum); cannot verify"
        return 0
    fi
    if [ "$got" != "$want_sha" ]; then
        warn "  ! checksum mismatch: expected $want_sha"
        warn "                     got      $got"
        return 1
    fi
    return 0
}

install_from() {
    # $1 = source path, $2 = human description
    if [ ! -f "$1" ]; then
        return 1
    fi
    if ! verify_or_fail "$1"; then
        return 1
    fi
    mkdir -p "$(dirname -- "$dest")"
    if [ "$1" != "$dest" ]; then
        cp "$1" "$dest" || return 1
    fi
    say "hledger.wasm: using $2 (flavor=$flavor, hledger $version, $(wc -c <"$dest" | tr -d ' ') bytes)"
    return 0
}

# --- 0. already correct ----------------------------------------------------
if already_ok; then
    say "hledger.wasm: up to date (flavor=$flavor, hledger $version)"
    exit 0
fi

# --- 1. explicit override --------------------------------------------------
if [ -n "${HLEDGER_WASM_PATH:-}" ]; then
    if install_from "$HLEDGER_WASM_PATH" "\$HLEDGER_WASM_PATH"; then
        exit 0
    fi
    warn "HLEDGER_WASM_PATH=$HLEDGER_WASM_PATH could not be used"
fi

# --- 2. a local build ------------------------------------------------------
if [ -f "$local_build" ]; then
    if install_from "$local_build" "local build (artifacts/hledger.wasm)"; then
        exit 0
    fi
    warn "artifacts/hledger.wasm exists but did not validate; continuing"
fi

# --- 3. pinned download ----------------------------------------------------
url=$(lock_get url)
if [ -n "$url" ]; then
    tmp=$(mktemp "${dest}.download.XXXXXX" 2>/dev/null || mktemp) || tmp=""
    if [ -n "$tmp" ]; then
        say "hledger.wasm: downloading $url"
        if command -v curl >/dev/null 2>&1 && curl -fsSL -o "$tmp" "$url"; then
            if verify_or_fail "$tmp"; then
                mkdir -p "$(dirname -- "$dest")"
                mv "$tmp" "$dest"
                say "hledger.wasm: installed (flavor=$flavor, hledger $version, $(wc -c <"$dest" | tr -d ' ') bytes)"
                exit 0
            fi
        else
            warn "  ! download failed"
        fi
        rm -f "$tmp"
    fi
fi

# --- 4. nothing available --------------------------------------------------
rm -f "$dest" 2>/dev/null || true
warn ""
warn "hledger.wasm is NOT available — the app will build and run, but the"
warn "terminal will report that the engine is missing."
warn ""
warn "To build the real hledger CLI for WebAssembly (recommended):"
warn "    sh scripts/build-hledger-wasm.sh"
warn ""
warn "To fetch the pinned artifact recorded in wasm.lock, set its url, or point"
warn "at an existing binary:"
warn "    HLEDGER_WASM_PATH=/path/to/hledger.wasm sh scripts/fetch-hledger-wasm.sh"
warn ""
exit 0
