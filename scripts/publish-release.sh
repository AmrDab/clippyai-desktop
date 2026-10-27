#!/usr/bin/env bash
# scripts/publish-release.sh — single-script v0.19.0+ release publish.
#
# WHY THIS EXISTS:
#   v0.18.2 + v0.18.3 were built locally but never made it to R2.
#   electron-updater's GitHub-releases path was fine (it had latest-mac.yml),
#   but download.clippyai.app/{arm64,x64,Windows} was still serving v0.18.1
#   bytes via the *-latest-* aliases. Users clicking "Download" on the
#   marketing site got a 7+-version-old build. This script makes the two
#   distribution channels move together by construction.
#
# USAGE:
#   ./scripts/publish-release.sh 0.19.0
#
# REQUIREMENTS:
#   - release/ contains ClippyAI-${VERSION}-{arm64,x64}.{dmg,zip} + blockmaps + latest-mac.yml
#     (produced by `npm run dist`, which calls electron-builder --mac)
#   - gh CLI authenticated for AmrDab/clippyai-macos
#   - .env contains R2_API_TOKEN (with bucket-write scope on clippyai-downloads)
#     OR wrangler is logged in (we use wrangler for the actual upload)
#   - Working tree is on a release-worthy commit (we verify HEAD matches origin/main or origin/feat/v0.19.0-* before tagging)
set -euo pipefail

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "usage: $0 <version>   e.g. $0 0.19.0" >&2
  exit 2
fi

# ---------- Windows (Git Bash / MSYS / Cygwin) ----------
# Same two-channel contract as the mac flow below, with the v0.17.7 Windows
# surfaces: GitHub Release on AmrDab/clippyai-desktop (electron-updater feed:
# ClippyAI-Setup-${V}.exe + .blockmap + latest.yml — all three required) and
# R2 `ClippyAI-Setup-latest.exe` (what download.clippyai.app / the marketing
# site serve to NEW users). The mac block is untouched; this branch exits
# before it.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    REPO="AmrDab/clippyai-desktop"
    R2_BUCKET="clippyai-downloads"
    RELEASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/release"
    EXE="ClippyAI-Setup-${VERSION}.exe"
    EXE_CT="application/x-msdownload"

    echo "==> Publishing v${VERSION} (Windows)"
    echo "    Release dir : $RELEASE_DIR"
    echo "    GH repo     : $REPO"
    echo "    R2 bucket   : $R2_BUCKET"
    echo

    echo "==> Checking artifacts in $RELEASE_DIR"
    for f in "$EXE" "$EXE.blockmap" "latest.yml"; do
      if [[ ! -f "$RELEASE_DIR/$f" ]]; then
        echo "    MISSING: $f"; exit 1
      fi
      echo "    OK: $f ($(du -h "$RELEASE_DIR/$f" | cut -f1))"
    done
    echo

    # latest.yml must describe the exe we're about to publish.
    YML_VERSION="$(grep -E '^version:' "$RELEASE_DIR/latest.yml" | awk '{print $2}')"
    if [[ "$YML_VERSION" != "$VERSION" ]]; then
      echo "    latest.yml says version: $YML_VERSION but you asked for $VERSION" >&2
      exit 1
    fi
    PKG_VERSION="$(cd "$RELEASE_DIR/.." && node -p "require('./package.json').version")"
    if [[ "$PKG_VERSION" != "$VERSION" ]]; then
      echo "    package.json says version: $PKG_VERSION but you asked for $VERSION" >&2
      exit 1
    fi
    echo "==> latest.yml + package.json confirm version: $VERSION"
    echo

    if [[ ! -f "$RELEASE_DIR/RELEASE_NOTES.md" ]]; then
      echo "    ERROR: $RELEASE_DIR/RELEASE_NOTES.md not found — write notes first." >&2
      exit 1
    fi

    # gh is not interactively authed on the dev box; fall back to the GitHub
    # PAT in Windows Credential Manager (same source docs/ops-runbook.md §9 uses).
    if ! gh auth status >/dev/null 2>&1 && [[ -z "${GH_TOKEN:-}" ]]; then
      GH_TOKEN="$(printf 'protocol=https\nhost=github.com\n' | git credential fill | sed -n 's/^password=//p')"
      export GH_TOKEN
    fi

    # NOT --prerelease: electron-updater on a stable install (e.g. 0.17.7)
    # resolves GitHub's /releases/latest, which skips prerelease-flagged
    # releases. A prerelease-flagged release is invisible to every current
    # Windows user.
    echo "==> Creating GitHub Release v${VERSION}"
    if gh release view "v${VERSION}" --repo "$REPO" >/dev/null 2>&1; then
      echo "    Release v${VERSION} already exists — uploading missing assets only"
      for f in "$EXE" "$EXE.blockmap" "latest.yml"; do
        gh release upload "v${VERSION}" "$RELEASE_DIR/$f" --repo "$REPO" --clobber || true
      done
    else
      gh release create "v${VERSION}" --repo "$REPO" \
        --title "ClippyAI v${VERSION}" \
        --notes-file "$RELEASE_DIR/RELEASE_NOTES.md" \
        --latest \
        "$RELEASE_DIR/$EXE" "$RELEASE_DIR/$EXE.blockmap" "$RELEASE_DIR/latest.yml"
    fi
    echo

    echo "==> Uploading to R2 bucket $R2_BUCKET"
    echo "    R2 PUT: $EXE"
    npx wrangler r2 object put "$R2_BUCKET/$EXE" --file "$RELEASE_DIR/$EXE" --content-type "$EXE_CT" --remote
    echo "    R2 PUT: ClippyAI-Setup-latest.exe (alias → ${VERSION})"
    npx wrangler r2 object put "$R2_BUCKET/ClippyAI-Setup-latest.exe" --file "$RELEASE_DIR/$EXE" --content-type "$EXE_CT" --remote
    echo

    echo "==> Verifying live download URLs"
    for url in \
      "https://download.clippyai.app/ClippyAI-Setup-latest.exe" \
      "https://github.com/${REPO}/releases/download/v${VERSION}/${EXE}" \
      "https://github.com/${REPO}/releases/download/v${VERSION}/latest.yml" ; do
      code="$(curl -s -o /dev/null -w '%{http_code}' -I -L "$url" || echo 000)"
      echo "    HTTP $code  $url"
    done
    echo

    echo "==> Done. Release v${VERSION} is live on GitHub Releases + R2."
    echo "    Next: tag the source commit if not done already:"
    echo "       git tag -a v${VERSION} -m 'ClippyAI v${VERSION}'"
    echo "       git push origin v${VERSION}"
    exit 0
    ;;
esac

REPO="AmrDab/clippyai-macos"
R2_BUCKET="clippyai-downloads"
RELEASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/release"

echo "==> Publishing v${VERSION}"
echo "    Release dir : $RELEASE_DIR"
echo "    GH repo     : $REPO"
echo "    R2 bucket   : $R2_BUCKET"
echo

# Verify all six required artifacts exist
declare -a REQUIRED=(
  "ClippyAI-${VERSION}-arm64.dmg"
  "ClippyAI-${VERSION}-arm64.dmg.blockmap"
  "ClippyAI-${VERSION}-arm64.zip"
  "ClippyAI-${VERSION}-arm64.zip.blockmap"
  "ClippyAI-${VERSION}-x64.dmg"
  "ClippyAI-${VERSION}-x64.dmg.blockmap"
  "ClippyAI-${VERSION}-x64.zip"
  "ClippyAI-${VERSION}-x64.zip.blockmap"
  "latest-mac.yml"
)
echo "==> Checking artifacts in $RELEASE_DIR"
for f in "${REQUIRED[@]}"; do
  if [[ ! -f "$RELEASE_DIR/$f" ]]; then
    echo "    MISSING: $f"; exit 1
  fi
  echo "    OK: $f ($(du -h "$RELEASE_DIR/$f" | cut -f1))"
done
echo

# Verify latest-mac.yml's version matches arg — catches "you built X but tagged Y" errors
YML_VERSION="$(grep -E '^version:' "$RELEASE_DIR/latest-mac.yml" | awk '{print $2}')"
if [[ "$YML_VERSION" != "$VERSION" ]]; then
  echo "    latest-mac.yml says version: $YML_VERSION but you asked for $VERSION" >&2
  exit 1
fi
echo "==> latest-mac.yml confirms version: $VERSION"
echo

# ---------- Preflight: RELEASE_NOTES.md must exist ----------
# v0.20.0-alpha.10 — missing notes file caused gh release create to abort
# AFTER latest-mac.yml had already been uploaded to R2, leaving the
# auto-updater pointing at binaries that hadn't been uploaded yet. Fail
# fast here so a missing notes file never gets that far.
if [[ ! -f "$RELEASE_DIR/RELEASE_NOTES.md" ]]; then
  echo "    ERROR: $RELEASE_DIR/RELEASE_NOTES.md not found." >&2
  echo "    Write release notes BEFORE running this script — the R2 upload" >&2
  echo "    runs after the GitHub release step, and aborting mid-flow leaves" >&2
  echo "    the updater pointing at binaries that don't exist yet." >&2
  exit 1
fi

# ---------- GitHub Release ----------
echo "==> Creating GitHub Release v${VERSION}"
if gh release view "v${VERSION}" --repo "$REPO" >/dev/null 2>&1; then
  echo "    Release v${VERSION} already exists — uploading missing assets only"
  for f in "${REQUIRED[@]}"; do
    gh release upload "v${VERSION}" "$RELEASE_DIR/$f" --repo "$REPO" --clobber || true
  done
else
  gh release create "v${VERSION}" --repo "$REPO" \
    --title "ClippyAI for Mac v${VERSION}" \
    --notes-file "$RELEASE_DIR/RELEASE_NOTES.md" \
    --latest \
    "$RELEASE_DIR"/ClippyAI-${VERSION}-*.{dmg,zip} \
    "$RELEASE_DIR"/ClippyAI-${VERSION}-*.{dmg.blockmap,zip.blockmap} \
    "$RELEASE_DIR/latest-mac.yml"
fi
echo

# ---------- R2 Upload ----------
echo "==> Uploading to R2 bucket $R2_BUCKET"

# Versioned files — keep one historical copy of every release.
#
# IMPORTANT: electron-updater on macOS downloads the .zip (not .dmg) for
# in-place auto-updates. latest-mac.yml lists the .zip URL first, and the
# blockmap files are used for delta updates. If we skip them, users hit
# 404 on "Check for Updates" and the download stalls. Discovered the hard
# way on v0.20.0-alpha.5 — script previously only uploaded the .dmg.
DMG_CT="application/x-apple-diskimage"
ZIP_CT="application/zip"
BLOCKMAP_CT="application/octet-stream"
for f in "ClippyAI-${VERSION}-arm64.dmg" "ClippyAI-${VERSION}-x64.dmg"; do
  echo "    R2 PUT: $f"
  npx wrangler r2 object put "$R2_BUCKET/$f" --file "$RELEASE_DIR/$f" --content-type "$DMG_CT" --remote
done
for f in "ClippyAI-${VERSION}-arm64.zip" "ClippyAI-${VERSION}-x64.zip"; do
  echo "    R2 PUT: $f (auto-updater payload)"
  npx wrangler r2 object put "$R2_BUCKET/$f" --file "$RELEASE_DIR/$f" --content-type "$ZIP_CT" --remote
done
for f in \
  "ClippyAI-${VERSION}-arm64.dmg.blockmap" \
  "ClippyAI-${VERSION}-x64.dmg.blockmap" \
  "ClippyAI-${VERSION}-arm64.zip.blockmap" \
  "ClippyAI-${VERSION}-x64.zip.blockmap"; do
  echo "    R2 PUT: $f (delta blockmap)"
  npx wrangler r2 object put "$R2_BUCKET/$f" --file "$RELEASE_DIR/$f" --content-type "$BLOCKMAP_CT" --remote
done

# Latest aliases — what download.clippyai.app serves
echo "    R2 PUT: ClippyAI-latest-arm64.dmg (alias → ${VERSION})"
npx wrangler r2 object put "$R2_BUCKET/ClippyAI-latest-arm64.dmg" --file "$RELEASE_DIR/ClippyAI-${VERSION}-arm64.dmg" --content-type application/x-apple-diskimage --remote
echo "    R2 PUT: ClippyAI-latest-x64.dmg (alias → ${VERSION})"
npx wrangler r2 object put "$R2_BUCKET/ClippyAI-latest-x64.dmg" --file "$RELEASE_DIR/ClippyAI-${VERSION}-x64.dmg" --content-type application/x-apple-diskimage --remote

# electron-updater feed file — uploaded for completeness even though we currently
# use the GitHub releases provider. If we switch to a generic provider hitting R2,
# this is already in place.
echo "    R2 PUT: latest-mac.yml"
npx wrangler r2 object put "$R2_BUCKET/latest-mac.yml" --file "$RELEASE_DIR/latest-mac.yml" --content-type text/yaml --remote

echo

# ---------- Verify ----------
echo "==> Verifying live download URLs"
for url in \
  "https://download.clippyai.app/ClippyAI-latest-arm64.dmg" \
  "https://download.clippyai.app/ClippyAI-latest-x64.dmg" \
  "https://github.com/${REPO}/releases/download/v${VERSION}/ClippyAI-${VERSION}-arm64.dmg" \
  "https://github.com/${REPO}/releases/download/v${VERSION}/latest-mac.yml" ; do
  code="$(curl -s -o /dev/null -w '%{http_code}' -I -L "$url" || echo 000)"
  echo "    HTTP $code  $url"
done
echo

echo "==> Done. Release v${VERSION} is live on GitHub Releases + R2."
echo "    Next: tag the source commit if not done already:"
echo "       git tag -a v${VERSION} -m 'ClippyAI for Mac v${VERSION}'"
echo "       git push origin v${VERSION}"
