/**
 * Custom signtool wrapper for electron-builder using Azure Trusted Signing.
 *
 * electron-builder calls this with `configuration.path` = path to the file
 * to sign. We invoke Microsoft's TrustedSigning DLib via SignTool.exe.
 *
 * Required env vars (read from %USERPROFILE%\.azure\clippyai-signing-creds.json
 * if not already in env):
 *   AZURE_TENANT_ID
 *   AZURE_CLIENT_ID
 *   AZURE_CLIENT_SECRET
 *   CLIPPY_SIGN_ENDPOINT          (e.g. https://eus.codesigning.azure.net/)
 *   CLIPPY_SIGN_ACCOUNT           (e.g. clippyai-signing)
 *   CLIPPY_SIGN_CERT_PROFILE      (created after identity validation)
 *
 * Configured in electron-builder.yml:
 *   win:
 *     signtoolOptions:
 *       sign: ./build/signing/sign.js
 */

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 1) Load credentials. Prefer process env (CI), fall back to local creds file.
function loadCreds() {
  const have = (k) => typeof process.env[k] === 'string' && process.env[k].length > 0;
  if (have('AZURE_TENANT_ID') && have('AZURE_CLIENT_ID') && have('AZURE_CLIENT_SECRET')) {
    return {
      AZURE_TENANT_ID: process.env.AZURE_TENANT_ID,
      AZURE_CLIENT_ID: process.env.AZURE_CLIENT_ID,
      AZURE_CLIENT_SECRET: process.env.AZURE_CLIENT_SECRET,
      ENDPOINT: process.env.CLIPPY_SIGN_ENDPOINT,
      ACCOUNT_NAME: process.env.CLIPPY_SIGN_ACCOUNT,
      CERT_PROFILE: process.env.CLIPPY_SIGN_CERT_PROFILE,
    };
  }
  const credsPath = path.join(os.homedir(), '.azure', 'clippyai-signing-creds.json');
  if (!fs.existsSync(credsPath)) {
    throw new Error(`No signing creds. Set AZURE_* env vars OR create ${credsPath}.`);
  }
  const j = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
  return {
    AZURE_TENANT_ID: j.AZURE_TENANT_ID,
    AZURE_CLIENT_ID: j.AZURE_CLIENT_ID,
    AZURE_CLIENT_SECRET: j.AZURE_CLIENT_SECRET,
    ENDPOINT: j.ENDPOINT,
    ACCOUNT_NAME: j.ACCOUNT_NAME,
    CERT_PROFILE: process.env.CLIPPY_SIGN_CERT_PROFILE || j.CERT_PROFILE,
  };
}

// 2) Locate the TrustedSigning DLib. We bundle a copy under build/signing/dlib/.
function dlibPath() {
  const base = path.join(__dirname, 'dlib');
  const candidates = [
    path.join(base, 'bin', 'x64', 'Azure.CodeSigning.Dlib.dll'),
    path.join(base, 'Azure.CodeSigning.Dlib.dll'),
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error(
    `TrustedSigning DLib not found. Run: nuget install Microsoft.Trusted.Signing.Client -OutputDirectory ${base} -ExcludeVersion`,
  );
}

// 3) Locate signtool.exe (ships with Windows SDK).
function signtoolPath() {
  if (process.env.SIGNTOOL_PATH && fs.existsSync(process.env.SIGNTOOL_PATH)) {
    return process.env.SIGNTOOL_PATH;
  }
  // Common locations
  const sdkRoot = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin';
  if (!fs.existsSync(sdkRoot)) throw new Error('Windows 10 SDK not installed (need signtool.exe)');
  // Pick the highest-versioned signtool we can find
  const versions = fs.readdirSync(sdkRoot).filter((d) => /^\d+\.\d+/.test(d)).sort().reverse();
  for (const v of versions) {
    const p = path.join(sdkRoot, v, 'x64', 'signtool.exe');
    if (fs.existsSync(p)) return p;
  }
  // Fallback: bare bin/x64
  const fallback = path.join(sdkRoot, 'x64', 'signtool.exe');
  if (fs.existsSync(fallback)) return fallback;
  throw new Error('signtool.exe not found in Windows SDK');
}

// 4) Per-call metadata file the DLib reads.
function writeMetadata(creds) {
  const meta = {
    Endpoint: creds.ENDPOINT,
    CodeSigningAccountName: creds.ACCOUNT_NAME,
    CertificateProfileName: creds.CERT_PROFILE,
    CorrelationId: `clippyai-build-${Date.now()}`,
  };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-sign-'));
  const metaPath = path.join(tmpDir, 'metadata.json');
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  return { metaPath, cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }) };
}

// 5) electron-builder entry point.
exports.default = async function sign(configuration) {
  const file = configuration.path;
  if (!file) throw new Error('No file path supplied to sign()');

  const creds = loadCreds();
  if (!creds.CERT_PROFILE) {
    throw new Error(
      'CLIPPY_SIGN_CERT_PROFILE is unset. Identity validation must complete in the Azure Portal first, then create a cert profile via:\n' +
      '  az trustedsigning certificate-profile create -g clippy-codesign --account-name clippyai-signing -n clippyai-cert --profile-type PublicTrust --identity-validation-id <id-from-portal>',
    );
  }

  const dlib = dlibPath();
  const signtool = signtoolPath();
  const { metaPath, cleanup } = writeMetadata(creds);

  // Pass credentials to the DLib via env vars (it reads AZURE_*).
  const env = {
    ...process.env,
    AZURE_TENANT_ID: creds.AZURE_TENANT_ID,
    AZURE_CLIENT_ID: creds.AZURE_CLIENT_ID,
    AZURE_CLIENT_SECRET: creds.AZURE_CLIENT_SECRET,
  };

  const args = [
    'sign',
    '/v',
    '/fd', 'SHA256',
    '/tr', 'http://timestamp.acs.microsoft.com',
    '/td', 'SHA256',
    '/dlib', dlib,
    '/dmdf', metaPath,
    file,
  ];

  console.log(`[sign] ${path.basename(file)} via Azure Trusted Signing...`);
  try {
    execFileSync(signtool, args, { stdio: 'inherit', env });
    console.log(`[sign] ${path.basename(file)} signed`);
  } finally {
    cleanup();
  }
};
