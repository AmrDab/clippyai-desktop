/**
 * reach-constraints.ts: the exact version of everything `uv tool install` puts
 * beside Agent Reach 1.6.1 (reach.ts writes these two files and passes them
 * with --constraints / --build-constraints). Generated, not hand-edited: when
 * REACH_VERSION or UV_VERSION changes, regenerate both with the pinned uv:
 *
 *   uv pip compile <agent-reach.zip>/pyproject.toml -c <its constraints.txt, runtime lines>
 *     --universal --python-version 3.12 --no-header --no-annotate
 *   echo hatchling | uv pip compile - --universal --python-version 3.12 --generate-hashes
 *     --no-header --no-annotate
 *
 * Runtime dependencies are pinned by version only: uv 0.13.9's `uv tool install`
 * has no --require-hashes for them, so their files are whatever PyPI serves for
 * that exact version. The build tools (hatchling, which builds Agent Reach from
 * its zip) are pinned with sha256 hashes and installed with --require-build-hashes.
 */

/** Resolved 2026-11-21 for Python 3.12 on Windows and macOS. */
export const RUNTIME_CONSTRAINTS = String.raw`brotli==1.2.1 ; implementation_name == 'cpython' and sys_platform != 'ios'
brotlicffi==1.2.1.0 ; implementation_name != 'cpython'
certifi==2026.11.20
cffi==2.1.1 ; implementation_name != 'cpython'
charset-normalizer==3.5.2
colorama==0.4.6 ; sys_platform == 'win32'
idna==3.20
loguru==0.7.3
mutagen==1.48.1
pycparser==3.12 ; implementation_name != 'PyPy' and implementation_name != 'cpython'
pycryptodomex==3.24.2
pyyaml==6.0.3
requests==2.32.5
urllib3==2.8.0
websockets==17.4
win32-setctime==1.2.1 ; sys_platform == 'win32'
yt-dlp==2026.8.19
yt-dlp-ejs==0.8.0
`;

export const BUILD_CONSTRAINTS = String.raw`hatchling==1.33.0 \
    --hash=sha256:415290b84f464d2884303fca8974d38e7b85579069fab02a15db0828fbb1446d \
    --hash=sha256:4c422bd4d554fcff5de5b73e9596f85e41e9f97f7e553d8f7595ecb31a627bef
packaging==26.3 \
    --hash=sha256:94edc256424af38762eb31306eed28beb9f0efc50a8837492c9d6fd6004aed79 \
    --hash=sha256:d7193f7c8e4e93f444fde0262bf90af30e16fa0ad0ad44cb553c87339b23cd1c
pathspec==1.1.1 \
    --hash=sha256:17db5ecd524104a120e173814c90367a96a98d07c45b2e10c2f3919fff91bf5a \
    --hash=sha256:a00ce642f577bf7f473932318056212bc4f8bfdf53128c78bbd5af0b9b20b189
pluggy==1.7.0 \
    --hash=sha256:7dd7b0d8832ba3cb632c306926ded123429211b83641b35dc5c41ad2d34f9bec \
    --hash=sha256:d1eaa46ebb595891b860ab086b4d09c8588af65ebd4361b8e8f4bb8920b90ba8
tomlkit==0.15.2 \
    --hash=sha256:05562412163a3037b94497385fb7f9204c637bc605af7a48199e41cf2272f437 \
    --hash=sha256:83e32755ba1d20d9340bd069ee97e9f6232ba2346b63ffcba425de01f7e327a6
trove-classifiers==2026.9.21.13 \
    --hash=sha256:0a9ebc8d4e2f3e8a22848c5258033035bec17a3012ac3fea16dbaa764489eb71 \
    --hash=sha256:8b1ff4f9c191b1040b71c37f1e445ab99732911e3cd91de52838453a854d7a17
`;
