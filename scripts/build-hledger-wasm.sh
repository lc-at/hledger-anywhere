#!/bin/sh
# Build the real hledger CLI for WebAssembly (wasm32-wasi):
#   sh scripts/build-hledger-wasm.sh
# Output: artifacts/hledger.wasm (size and SHA-256 printed at the end).
#
# A LONG build: the ghc-wasm-meta toolchain is a 1-2 GB download and hledger's
# dependency tree is compiled twice (native for Template Haskell splices, then
# for wasm). Budget an hour or more.
#
# A separate step from `trunk build` on purpose: trunk runs
# fetch-hledger-wasm.sh, which treats a missing artifact as non-fatal, so the
# app stays buildable and runnable while this runs in the background.
#
# After a successful build, record the printed flavor, versions, size and
# sha256 in wasm.lock; the fetch script then prefers artifacts/hledger.wasm and
# verifies it.

set -eu

_here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(CDPATH= cd -- "$_here/.." && pwd)

# shellcheck disable=SC1091
. "$root/scripts/env.sh"

# ghc-wasm-meta's bootstrap runs `npm install` in its own source tree and cabal
# keeps its config and store under $HOME, so the toolchain install and every
# cabal build need a writable home; HOME (and the XDG dirs) point at
# .tools/home to keep them inside the workspace.
#
# Deliberately scoped to this script: `trunk build` and `cargo` do not want a
# relocated HOME, which is why scripts/env.sh does not set it.
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

# The ghc-wasm env is a wasm32-wasi cross-compilation environment (PATH, CC,
# CXX, LD, AR); leaking it into an ordinary `cargo`/`trunk` build replaces the
# host linker with the wasi-sdk one. Sourced here rather than in scripts/env.sh
# so host builds stay safe while this script gets the cross toolchain.
if [ -f "$GHC_WASM_PREFIX/env" ]; then
    # shellcheck disable=SC1091
    . "$GHC_WASM_PREFIX/env"
fi

# --- 1. toolchain ----------------------------------------------------------
if ! command -v wasm32-wasi-cabal >/dev/null 2>&1; then
    say "==> wasm32-wasi-cabal not found; installing ghc-wasm-meta (FLAVOUR=$GHC_FLAVOUR)"
    say "    prefix: $GHC_WASM_PREFIX"
    # bootstrap.sh reads PREFIX, not our namespaced GHC_WASM_PREFIX, so export
    # it right here rather than leaking that generic name from env.sh.
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

# --- 2b. wasm adaptations to the vendored source ---------------------------
# GHC's wasm backend has no *threaded* RTS: the toolchain ships
# libHSrts-1.0.3.a (plus _p and _debug variants) but no _thr, so hledger's
# `-threaded` makes the linker look for libHSrts-1.0.3_thr and fail with
# "unable to find library". WASI has no threads to hand out in any case, so
# dropping the flag selects the RTS that actually exists; the rest of the
# stanza, `-with-rtsopts=-T` (RTS statistics), is unaffected.
#
# sed rather than editing vendor/hledger: vendor/ is a pristine, gitignored
# clone of the upstream tag. Idempotent — once patched the pattern no longer
# matches.
CABAL_FILE="$SRC/hledger/hledger.cabal"
if grep -q -- '-threaded -with-rtsopts=-T' "$CABAL_FILE"; then
    say "==> dropping -threaded from the hledger executable (wasm has no threaded RTS)"
    sed -i 's/ -threaded -with-rtsopts=-T/ -with-rtsopts=-T/' "$CABAL_FILE"
else
    say "==> hledger.cabal already free of -threaded"
fi

# --- 3. build --------------------------------------------------------------
say "==> building hledger for wasm32-wasi (this takes a while)"
cd "$root"
# `--project-dir`, not `-f`: cabal's `-f` is a *flag assignment* (as in
# `-fdebug`), and an absolute `--project-file` is deprecated. Absolute
# `--builddir` keeps the output at the repository root rather than inside
# hledger-wasm/.
wasm32-wasi-cabal build hledger \
    --project-dir="$root/hledger-wasm" \
    --builddir="$root/dist-newstyle" \
    || die "hledger wasm build failed. See README.md for the known failure modes
(terminal-size, githash) and their stubs."

# --- 4. collect the artifact ----------------------------------------------
built=$(find "$root/dist-newstyle" -type f -name 'hledger.wasm' 2>/dev/null | head -1)
if [ -z "$built" ]; then
    built=$(find "$root/dist-newstyle" -type f -name '*.wasm' 2>/dev/null | head -1)
fi
[ -n "$built" ] || die "Build reported success but no .wasm file was found under dist-newstyle."

mkdir -p "$OUT_DIR"
cp "$built" "$OUT"

# --- 3b. shrink the artifact ----------------------------------------------
# GHC's wasm output is far larger than it needs to be: Binaryen's `-Oz` takes
# the module down about 60% (32 MB -> 13 MB) unchanged, and that size is what
# every visitor's browser downloads (or what would have to be stored if the
# artifact were ever committed instead of fetched). Optional — binaryen is not
# guaranteed to be present; without it the build still produces a correct, just
# larger, artifact, and says so.
WASM_OPT=$(command -v wasm-opt 2>/dev/null || true)
if [ -z "$WASM_OPT" ]; then
    for candidate in \
        "${GHC_WASM_PREFIX:-/nonexistent}/binaryen/bin/wasm-opt" \
        "$root/.tools/ghc-wasm/binaryen/bin/wasm-opt"
    do
        if [ -x "$candidate" ]; then
            WASM_OPT="$candidate"
            break
        fi
    done
fi

if [ -n "$WASM_OPT" ]; then
    say "==> shrinking with $("$WASM_OPT" --version 2>/dev/null || echo wasm-opt)"
    if "$WASM_OPT" -Oz "$OUT" -o "$OUT.min" 2>/dev/null; then
        before=$(wc -c <"$OUT" | tr -d ' ')
        mv "$OUT.min" "$OUT"
        after=$(wc -c <"$OUT" | tr -d ' ')
        say "    $before -> $after bytes"
    else
        rm -f "$OUT.min"
        warn "wasm-opt failed; keeping the unoptimized artifact"
    fi
else
    warn "wasm-opt not found; keeping the unoptimized artifact (about 3x larger)"
fi

size=$(wc -c <"$OUT" | tr -d ' ')
# if/elif rather than `sha=$(A || B) | cut`: the pipeline puts the assignment
# in a subshell, so the variable stays unset and `set -u` then reports
# "parameter not set".
if command -v sha256sum >/dev/null 2>&1; then
    sha=$(sha256sum "$OUT" | cut -d' ' -f1)
elif command -v shasum >/dev/null 2>&1; then
    sha=$(shasum -a 256 "$OUT" | cut -d' ' -f1)
else
    warn "no sha256sum or shasum found; record the checksum by hand in wasm.lock"
    sha=""
fi

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
