#!/bin/sh
# Central environment for building hledger-anywhere.
#
#   . scripts/env.sh && trunk serve
#
# Two things are redirected into the workspace on purpose:
#
#   CARGO_HOME  Cargo writes its registry and crate caches under CARGO_HOME.
#               Pointing it inside the project keeps builds self-contained and
#               working under a restricted (workspace-write) file sandbox, where
#               ~/.cargo is read-only.
#   npm_config_cache
#               The ghc-wasm-meta bootstrap installs a Node runtime internally
#               and npm otherwise fails with EROFS writing to ~/.npm/_cacache.
#
# Both are overridable, so a normal developer machine can just use its defaults
# by exporting CARGO_HOME/npm_config_cache beforehand.
#
# NOTE: this file is POSIX sh and is *sourced*, so it must not `exit`, and it
# must be sourced from the repository root or referenced by absolute path.

# Resolve the repository root from this file's location. When sourced, $0 is
# the *calling* shell, so prefer BASH_SOURCE when the shell provides it, and
# fall back to walking up from the working directory.
_env_dir=""
if [ -n "${BASH_SOURCE:-}" ]; then
    _env_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE}")" && pwd)
elif [ -f "$0" ]; then
    _env_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fi
if [ -n "$_env_dir" ] && [ -f "$_env_dir/../Cargo.toml" ]; then
    _env_root=$(CDPATH= cd -- "$_env_dir/.." && pwd)
else
    # Walk up from the current directory looking for the crate root.
    _env_root=$PWD
    while [ "$_env_root" != "/" ] && [ ! -f "$_env_root/Cargo.toml" ]; do
        _env_root=$(dirname -- "$_env_root")
    done
fi

# Workspace-local tooling: trunk, and optionally the ghc-wasm toolchain.
PATH="$_env_root/.tools/bin:$PATH"
export PATH

# Redirect a cache location into the workspace unless the one already in effect
# is genuinely usable.
#
# Testing "is the variable set?" is not enough here. The environment this runs in
# exports npm_config_cache=/home/<user>/.npm (inherited from the npm/npx process
# that launched the agent), and a value can be set yet point at a read-only
# location. A real write probe is the only reliable test, and it also means a
# normal developer machine keeps its existing caches instead of re-downloading.
#
#   _use_dir <VARIABLE_NAME> <workspace fallback>
_use_dir() {
    _var=$1
    _fallback=$2
    eval "_current=\${$_var:-}"
    if [ -n "$_current" ] && mkdir -p "$_current" 2>/dev/null; then
        _probe="$_current/.write-probe.$$"
        if (: >"$_probe") 2>/dev/null; then
            rm -f "$_probe" 2>/dev/null
            return 0
        fi
    fi
    eval "$_var=\$_fallback"
    mkdir -p "$_fallback" 2>/dev/null || true
    export "$_var"
}

_use_dir CARGO_HOME "$_env_root/.tools/cargo"
_use_dir npm_config_cache "$_env_root/.tools/npm-cache"

# Trunk keeps downloaded tools (the wasm-bindgen CLI matching our crate version,
# and binaryen for wasm-opt) plus its build cache under the XDG cache home, so
# that has to be writable too.
_use_dir XDG_CACHE_HOME "$_env_root/.tools/cache"

unset _current _probe _var _fallback

# Quiet, non-interactive npm for the toolchain bootstrap.
npm_config_update_notifier=false
npm_config_fund=false
npm_config_audit=false
export npm_config_update_notifier npm_config_fund npm_config_audit

# Trunk parses NO_COLOR as a *boolean* flag value (clap's `env` support), so the
# conventional NO_COLOR=1 aborts every trunk command with
# "invalid value '1' for '--no-color'". Normalise it to the form clap accepts,
# which still means "do not colourise".
if [ "${NO_COLOR:-}" = "1" ]; then
    NO_COLOR=true
    export NO_COLOR
fi

# The Haskell WASM toolchain installed by scripts/build-hledger-wasm.sh.
GHC_WASM_PREFIX="${GHC_WASM_PREFIX:-$_env_root/.tools/ghc-wasm}"
export GHC_WASM_PREFIX
if [ -f "$GHC_WASM_PREFIX/env" ]; then
    # shellcheck disable=SC1091
    . "$GHC_WASM_PREFIX/env"
fi

unset _env_root _env_dir
