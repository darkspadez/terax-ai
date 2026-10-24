# Testing

This guide elaborates on `AGENTS.md` and `CONTRIBUTING.md`. If anything conflicts with those files, they win.

## Running checks locally

The canonical commands are what CI runs (`.github/workflows/ci.yml`):

```bash
bun run lint
bun run check-types
bun run test

cd src-tauri
cargo clippy --all-targets --locked -- -D warnings
cargo nextest run --locked        # CI uses nextest
```

If you do not have `cargo-nextest` installed, `cargo test --locked` is the local fallback. Install nextest with `cargo install cargo-nextest`.

## macOS and Windows code from another host

`scripts/cross-clippy.sh` runs `cargo clippy --all-targets -D warnings` for `aarch64-apple-darwin`, `x86_64-apple-darwin` and `x86_64-pc-windows-msvc` from any host (pass targets to choose). Build scripts that compile C get stand-in tools, since clippy never links, so platform-only modules and their tests are fully type-checked and linted. Nothing runs: behaviour on those platforms is covered by the CI jobs.

## CI runners

CI, release and the Nix-sources job run on [Namespace](https://namespace.so) runner profiles, each with a cache volume attached: `oarlock-linux-amd64` (Linux amd64, Ubuntu 22.04, the release glibc baseline), `oarlock-linux-arm64` (Linux arm64, Ubuntu 22.04; release builds only) and `oarlock-macos-arm64` (macOS arm64). A repository needs the Namespace GitHub app and those profiles before its workflows can start. There is no Windows profile yet, so CI and release have no Windows legs until one exists. `keychain_compat` runs only in the macOS job (`--run-ignored only`), against a throwaway keychain.

## What must have a test

`CONTRIBUTING.md` requires a test for any change that touches behavior in these load-bearing paths:

- Shell / terminal spawn (what shell launches, with which cwd, env, and login flags)
- Workspace authorization (both the allow and deny side)
- Git command layer (repo-root resolution, pathspec/argument guards, status parsing)
- Filesystem mutation (atomic writes, symlink handling, no-data-loss on partial failure)
- IPC command surface and AI tool surface
- Pure logic with wide reach (cwd inheritance, tab/split tree transforms, OSC/prompt parsing, command guard)

The bar is real coverage of the contract, not a placeholder. Test the edge, the deny path, the "what happens one level above home".

## What does not need a test

UI rendering, themes, syntax-highlight tables, and anything the type-checker already guarantees do not need tests.

## Writing a good test

A good test locks the invariant you are relying on. Examples from the codebase:

- `src-tauri/src/modules/workspace.rs` `auth_tests` verify that an authorized path, a subdir of an authorized root, an unauthorized path, a missing path, and a symlink escape all behave correctly, and that the file-command gates refuse paths outside, links pointing out, `..` tricks and WSL paths outside while a missing path outside never reads differently from an existing one.
- `src-tauri/src/modules/proc/job.rs` tests verify that dropping the Job Object kills the assigned process tree on Windows.
- `src-tauri/src/modules/pty/session.rs` tests verify that dropping a `Session` kills the child process.
- `src-tauri/src/modules/pty/shell_init.rs` tests verify shell classification and WSL fish launch specs.
- `src/modules/ai/lib/security.ts` is exercised by tests that assert specific paths are refused and that canonicalization catches symlink traversal.

## Cross-platform PTY tests

Platform-specific behavior must be gated:

```rust
#[cfg(unix)]
fn shell_has_children(shell_pid: u32) -> bool { ... }

#[cfg(windows)]
fn shell_has_children(shell_pid: u32) -> bool { ... }
```

Tests for ConPTY/Job Object belong behind `#[cfg(windows)]`; tests for Unix PTY lifecycle belong behind `#[cfg(unix)]`. Do not assume a helper that works on one platform works on the other.

## macOS filesystem watcher tests

The FSEvents integration tests require access to the macOS service `com.apple.FSEvents`, including its Mach lookup. Filesystem read/write access alone does not grant that service. In the restricted agent execution environment, a diagnostic probe found that `sandbox_check` denied this lookup, `FSEventsGetCurrentEventId()` returned 0, stream creation succeeded, and `FSEventStreamStart()` returned false. That made all eight original watcher integration tests fail before they could receive events. The same revision passed all eight tests in the macOS CI job.

The fixture reports the failed startup stage explicitly. Keep these tests enabled: run the full suite in an environment that can access FSEvents, such as the macOS CI runner. Do not turn service unavailability into a passing test or add watcher exclusions. The fault-injection tests exercise retry and replay state without requiring the service.

A failed startup leaves the backend retryable, including when a subsequent registration does not change the watch roots. Its first usable event cursor is retained across failures so recovery can replay changes from the interrupted watch; removing all watches clears the failed state and cursor. Healthy registrations still avoid rebuilding the stream.

## Security function tests

When testing `src/modules/ai/lib/security.ts` or the Rust equivalents, cover:

1. The literal path is refused.
2. The canonicalized path is re-refused (symlink case).
3. Case variants match on case-insensitive filesystems.
4. NTFS alternate data streams and trailing dot/space variants are normalized.
5. Write-only deny prefixes block writes but allow reads where appropriate.

## Invariants

- A local fix with global blast radius must be caught by a test; review alone is not enough.
- Test the deny path and the edge, not just the happy path.
- Keep platform-specific tests behind the right `#[cfg(...)]` gate.

## See also

- [`AGENTS.md`](../../AGENTS.md) - the architecture source of truth
- [`CONTRIBUTING.md`](../../CONTRIBUTING.md) - quality bar, project layout, how to contribute
- [`docs/README.md`](../README.md) - index of contributor guides
