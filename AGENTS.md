# AGENTS.md

## Comments

A comment earns its place by answering a WHY the code cannot show: a non-obvious
constraint, a browser/engine quirk, timing arithmetic, a cross-file pointer, a
deliberate behaviour that looks wrong otherwise (e.g. `save` never rejects), the
reason a check asserts what it asserts when ordering matters. Everything else is
deleted on sight: narration of what the next line does, doc comments that restate
the name or signature, essays a reader will not need. Module headers (`//!`) stay
only while they state the module's reason to exist or its layout contract.
Vendored code (`assets/plugins/vendor/`, THIRD_PARTY_LICENSES.md) is never edited.

## No quickfixes or workarounds

Do not add `TODO`, `FIXME`, `XXX`, `HACK`, "for now", "temporary", or
workaround-shaped code — fix the thing properly, or state in a necessary comment
the constraint that makes the approach the right one. Existing workarounds are
found and removed or replaced by proper fixes as part of quality work. Tests may
encode real external behaviour (browser key handling, cache headers); that is a
fact of the world being asserted, not a workaround, and belongs in a necessary
comment.

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
