#!/bin/sh
# Lints the Tauri crate for other platforms from any host:
#
#   scripts/cross-clippy.sh                       # macOS arm64/x64 and Windows x64
#   scripts/cross-clippy.sh x86_64-pc-windows-msvc
#
# `cargo check` and clippy never link, but some build scripts compile C (ring,
# objc2's exception helper) and would need each platform's SDK. Stand-in
# compiler and archiver scripts write empty objects and archives instead, so
# every Rust line, including platform-only modules and tests, is type-checked
# and linted. It cannot run anything: behaviour still needs the platform (CI).
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd)
tools=$(mktemp -d)
trap 'rm -rf "$tools"' EXIT

cat > "$tools/cc" <<'EOF'
#!/bin/sh
out=""
prev=""
for arg in "$@"; do
  [ "$prev" = "-o" ] && out="$arg"
  case "$arg" in
    -o?*) out="${arg#-o}" ;;
    -Fo*|/Fo*) out="${arg#?Fo}" ;;
  esac
  prev="$arg"
done
[ -n "$out" ] && : > "$out"
exit 0
EOF
cat > "$tools/ar" <<'EOF'
#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    -out:*|/OUT:*|/out:*) printf '!<arch>\n' > "${arg#*:}"; exit 0 ;;
    *.a|*.lib) printf '!<arch>\n' > "$arg"; exit 0 ;;
  esac
done
exit 0
EOF
chmod +x "$tools/cc" "$tools/ar"

[ "$#" -gt 0 ] || set -- aarch64-apple-darwin x86_64-apple-darwin x86_64-pc-windows-msvc
for target in "$@"; do
  rustup target add "$target" >/dev/null
  var=$(printf '%s' "$target" | tr '-' '_')
  echo "== $target"
  env "CC_$var=$tools/cc" "CXX_$var=$tools/cc" "AR_$var=$tools/ar" \
    cargo clippy --manifest-path "$repo/src-tauri/Cargo.toml" --locked \
    --all-targets --target "$target" -- -D warnings
done
