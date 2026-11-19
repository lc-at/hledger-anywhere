# AGENTS.md

## Building and testing

`cargo test` needs a C linker this machine does not have (no `cc`, no glibc-devel), so the Rust suite runs in a prepared podman image — `hla-build`, Tumbleweed with gcc:

```sh
podman run --rm -v "$PWD":/work -w /work \
  -v "$HOME/.rustup":/root/.rustup -v "$HOME/.cargo":/root/.cargo \
  -e RUSTUP_HOME=/root/.rustup -e CARGO_HOME=/root/.cargo \
  hla-build sh -lc 'export PATH=/root/.cargo/bin:$PATH; cargo test'
```

Swap the last line for `cargo clippy --all-targets -- -D warnings` or the wasm-target line to match CI. `trunk build` needs the same container (mount `.tools/bin/trunk` at `/usr/local/bin/trunk`); `dist/` it writes is gitignored. If `hla-build` is missing, build it from `registry.opensuse.org/opensuse/tumbleweed:latest` with `zypper in -y gcc` and `podman commit`.

JS checks need Chrome, which this machine keeps behind a wrapper: `CHROME=$HOME/.local/bin/agent-browser-chrome node scripts/check-<name>.mjs`. On CI, Chrome is on PATH and no `CHROME` is needed.

## Agent skills

### Issue tracker

Issues live in GitHub Issues (lc-at/hledger-anywhere), via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.
