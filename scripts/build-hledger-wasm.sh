#!/bin/sh
# Build the real hledger CLI for WebAssembly (wasm32-wasi).
#
#   sh scripts/build-hledger-wasm.sh
#
# Output: artifacts/hledger.wasm  (plus its size and SHA-256 printed at the end)
#
# This is a LONG build. The ghc-wasm-meta toolchain is a 1-2 GB download, and
# hledger pulls in a large dependency tree that is compiled twice (native for
# Template Haskell splices, then for wasm). Budget an hour or more.
#
# It is a separate step from `trunk build` on purpose: `trunk build` runs
# fetch-hledger-wasm.sh, which treats a missing artifact as non-fatal so the app
# stays buildable and runnable while this runs in the background.
#
# After a successful build, update wasm.lock: set flavor = "hledger-cli",
# hledger_version, ghc_version, size and sha256 to the printed values. The fetch
# script then prefers artifacts/hledger.wasm and verifies it.

set -eu

_here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(CDPATH= cd -- "$_here/.." && pwd)

# shellcheck disable=SC1091
. "$root/scripts/env.sh"

# ghc-wasm-meta's setup.sh bundles a Node runtime and then runs `npm install`
# inside its own source tree, and cabal keeps its config and package store under
# $HOME as well. On a machine whose ~ is writable this is all invisible, but it
# means the toolchain install and every cabal build need a writable home.
# Point HOME (and the XDG dirs) at the workspace so everything lands in
# .tools/home, and so this stays self-contained and reproducible.
#
# This is deliberately scoped to this script: `trunk build` and `cargo` do not
# want a relocated HOME, which is why scripts/env.sh does not set it.
HASKELL_HOME="${HLEDGER_WASM_HOME:-$root/.tools/home}"
mkdir -p "$HASKELL_HOME"
HOME="$HASKELL_HOME"
XDG_CACHE_HOME="$HASKELL_HOME/.cache"
XDG_CONFIG_HOME="$HASKELL_HOME/.config"
XDG_DATA_HOME="$HASKELL_HOME/.local/share"
export HOME XDG_CACHE_HOME XDG_CONFIG_HOME XDG_DATA_HOME
mkdir -p "$XDG_CACHE_HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME"

HEDGER_VERSION="${HLEDGER_VERSION:-1.52.4}"
GHC_FLAVOUR="${GHC_FLAVOUR:-9.12}"
HEDGER_REPO="${HLEDGER_REPO:-https://github.com/hledgerorg/hledger.git}"
HEDGER_TAG="hledger-$HEDGER_VERSION"
SRC="$root/vendor/hledger"
OUT_DIR="$root/artifacts"
OUT="$OUT_DIR/hledger.wasm"

say() { printf '%s\n' "$*"; }
die() { printf '\n%s\n' "$*" >&2; exit 1; }

# --- 1. toolchain ----------------------------------------------------------
if ! command -v wasm32-wasi-cabal >/dev/null 2>&1; then
    say "==> wasm32-wasi-cabal not found; installing ghc-wasm-meta (FLAVOUR=$GHC_FLAVOUR)"
    say "    prefix: $GHC_WASM_PREFIX"
    # bootstrap.sh reads PREFIX (not our namespaced GHC_WASM_PREFIX), so export
    # it right here rather than leaking such a generic name from env.sh.
    PREFIX="$GHC_WASM_PREFIX" FLAVOUR="$GHC_FLAVOUR" \
        sh -c 'curl -sSL https://gitlab.haskell.org/haskell-wasm/ghc-wasm-meta/-/raw/master/bootstrap.sh | sh' \
        || die "ghc-wasm-meta installation failed."
    # shellcheck disable=SC1091
    . "$GHC_WASM_PREFIX/env"
fi

command -v wasm32-wasi-cabal >/dev/null 2>&1 \
    || die "wasm32-wasi-cabal is still not on PATH after installing the toolchain."
say "==> wasm32-wasi-cabal: $(command -v wasm32-wasi-cabal)"
# The toolchain's env script puts these on PATH; use them by name rather than
# guessing at a path inside the prefix, which differs between flavours.
wasm32-wasi-ghc --version | sed 's/^/    /'

# --- 2. pinned hledger source ---------------------------------------------
if [ ! -d "$SRC/.git" ]; then
    say "==> cloning hledger $HEDGER_VERSION into vendor/hledger"
    mkdir -p "$(dirname -- "$SRC")"
    git clone --depth 1 --branch "$HEDGER_TAG" "$HEDGER_REPO" "$SRC" \
        || die "Could not clone hledger tag $HEDGER_TAG."
else
    say "==> reusing vendor/hledger ($(git -C "$SRC" describe --tags --always 2>/dev/null || echo unknown))"
fi

# --- 3. build --------------------------------------------------------------
say "==> building hledger for wasm32-wasi (this takes a while)"
cd "$root"
# `--project-dir`, not `-f`: cabal's `-f` is a *flag assignment* (as in
# `-fdebug`), and an absolute `--project-file` is deprecated. `--builddir` is
# absolute so the output stays at the repository root rather than inside
# hledger-wasm/.
wasm32-wasi-cabal build hledger \
    --project-dir="$root/hledger-wasm" \
    --builddir="$root/dist-newstyle" \
    || die "hledger wasm build failed. See README.md for the known failure modes
(terminal-size, githash) and their stubs."

# --- 4. collect the artifact ----------------------------------------------
# The wasm backend emits the executable as <name>.wasm under dist-newstyle.
built=$(find "$root/dist-newstyle" -type f -name 'hledger.wasm' 2>/dev/null | head -1)
if [ -z "$built" ]; then
    built=$(find "$root/dist-newstyle" -type f -name '*.wasm' 2>/dev/null | head -1)
fi
[ -n "$built" ] || die "Build reported success but no .wasm file was found under dist-newstyle."

mkdir -p "$OUT_DIR"
cp "$built" "$OUT"
size=$(wc -c <"$OUT" | tr -d ' ')
sha=$( (command -v sha256sum >/dev/null 2>&1 && sha256sum "$OUT") \
    || (command -v shasum >/dev/null 2>&1 && shasum -a 256 "$OUT") ) | cut -d' ' -f1

say ""
say "==> built $OUT"
say "    size    = $size"
say "    sha256  = $sha"
say ""
say "Update wasm.lock so the app targets this build:"
say ""
say "    flavor          = \"hledger-cli\""
say "    hledger_version = \"$HEDGER_VERSION\""
say "    ghc_version     = \"$GHC_FLAVOUR\""
say "    size            = $size"
say "    sha256          = \"$sha\""
say "    url             = \"\"   # or a release asset URL to share this build"
say ""
