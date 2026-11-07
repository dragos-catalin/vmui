# Rugix Ctrl / Rugix Bundler pin (P5-04). Sourced by rootfs-ab.sh, bundle.sh and the image scripts.
# Release https://github.com/rugix/rugix/releases/tag/v1.4.0 (MIT OR Apache-2.0), musl static builds;
# sha256 of the release tarballs as published on the release page (2026-11-02).
RUGIX_VERSION=v1.4.0
declare -A RUGIX_TRIPLE=([amd64]=x86_64-unknown-linux-musl [arm64]=aarch64-unknown-linux-musl)
declare -A RUGIX_SHA=(
  [amd64]=4f90e9d09f1b04374911581131baf9a1c5105300e04e1b4bd18c4a4c65ef01be
  [arm64]=db5e53d4726ba99f05b9fa990e7067cd80d60ec9a7b3b92b2999c88c8fe3f6b4
)

# rugix_fetch <amd64|arm64> <dest dir>: verified tarball -> <dest>/rugix-ctrl + <dest>/rugix-bundler
rugix_fetch() {
  local arch="$1" dest="$2" tar f b
  [ -n "${RUGIX_SHA[$arch]:-}" ] || { echo "rugix: unsupported arch $arch" >&2; return 1; }
  tar="/tmp/rugix-${RUGIX_VERSION}-${arch}.tar"
  if ! echo "${RUGIX_SHA[$arch]}  $tar" | sha256sum -c --status - 2>/dev/null; then
    curl -fsSL -o "$tar" "https://github.com/rugix/rugix/releases/download/${RUGIX_VERSION}/binaries-${RUGIX_TRIPLE[$arch]}.tar"
    echo "${RUGIX_SHA[$arch]}  $tar" | sha256sum -c - >/dev/null
  fi
  rm -rf "$dest.x"; mkdir -p "$dest.x" "$dest"
  tar -xf "$tar" -C "$dest.x"
  for b in rugix-ctrl rugix-bundler; do
    f="$(find "$dest.x" -type f -name "$b" | head -n1)"
    [ -n "$f" ] || { echo "rugix: no $b in $tar" >&2; return 1; }
    install -m 0755 "$f" "$dest/$b"
  done
  rm -rf "$dest.x"
}
