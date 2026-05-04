# Code Signing — Azure Trusted Signing setup

Status: **Infrastructure provisioned. Identity validation and final wiring pending.**

## What's already done (automated)

| Item | Value |
|---|---|
| Azure subscription | `Azure subscription 1` (`88ad48dd-c7c2-4b70-92da-1db6f9b6d893`) |
| Tenant | `8971eb2b-7c4f-4d49-a4b1-0b7cfc69f537` |
| Resource group | `clippy-codesign` (East US) |
| Trusted Signing account | `clippyai-signing` |
| Endpoint | `https://eus.codesigning.azure.net/` |
| Service principal | `clippyai-signer` (appId `aab88fe0-9adf-441b-8b3b-da704199cec9`) |
| Role | `Artifact Signing Certificate Profile Signer` |
| Local creds file | `%USERPROFILE%\.azure\clippyai-signing-creds.json` (NEVER commit) |
| Signing wrapper | `build/signing/sign.js` |

## What you need to do (manual — Microsoft requires it)

### Step 1 — Identity validation (in Azure Portal)

This is the only piece that can't be scripted. Microsoft requires a live photo-ID + verification call to issue a Public Trust certificate.

1. Go to https://portal.azure.com → search "Trusted Signing Accounts" → click **clippyai-signing**.
2. In the left nav, click **Identity Validation** → **+ Add identity validation**.
3. Choose **Public Trust** → **Individual** (since Cloudana isn't yet incorporated).
   - Cert subject will be your legal name (Amr Dabbas). Switch to Organization later when Cloudana has a D-U-N-S number.
4. Fill in:
   - Display name: `Amr Dabbas` (or whatever shows on your ID)
   - Country: your residence
   - Email: `amr_dabbas@hotmail.com`
   - Phone: your number
5. Submit. Microsoft will email you a link to complete photo-ID upload + a 5-minute live identity verification call (typically same-day, sometimes next business day).
6. **Wait for status to flip to "Completed"** in the Portal. Note the `Identity Validation ID` (a GUID).

### Step 2 — Create the certificate profile (one CLI command, after validation)

Run this once Step 1 status = Completed. Replace `<VALIDATION_ID>` with the GUID from the Portal.

```powershell
az trustedsigning certificate-profile create `
  --resource-group clippy-codesign `
  --account-name clippyai-signing `
  --profile-name clippyai-cert `
  --profile-type PublicTrust `
  --identity-validation-id <VALIDATION_ID>
```

### Step 3 — Add cert profile name to the local creds file

Edit `%USERPROFILE%\.azure\clippyai-signing-creds.json` and add (or set) the `CERT_PROFILE` field:

```json
{
  ...existing fields...,
  "CERT_PROFILE": "clippyai-cert"
}
```

### Step 4 — Install the TrustedSigning DLib (one-time)

This is the binary SignTool calls into to talk to Azure. We install via NuGet into `build/signing/dlib/`:

```powershell
# If you don't have nuget.exe yet:
winget install Microsoft.NuGet

# Then in the ClippyAI repo root:
nuget install Microsoft.Trusted.Signing.Client `
  -OutputDirectory build\signing\dlib `
  -ExcludeVersion
```

### Step 5 — Flip on signing in electron-builder.yml

Change the `win:` block to:

```yaml
win:
  target:
    - target: nsis
      arch: x64
  icon: build/icon.ico
  publisherName: Amr Dabbas        # MUST match the cert subject
  legalTrademarks: ClippyAI is a trademark of Cloudana.
  requestedExecutionLevel: asInvoker
  artifactName: ClippyAI-Setup-${version}.${ext}
  signAndEditExecutable: true       # was false
  signingHashAlgorithms:            # was []
    - sha256
  signtoolOptions:
    sign: ./build/signing/sign.js   # invokes our wrapper
  forceCodeSigning: true            # was false — fail the build if signing fails
  verifyUpdateCodeSignature: true   # was false — auto-updater verifies new releases are signed
```

### Step 6 — Build, test, ship

```powershell
npm run dist
```

The wrapper will:
1. Read your creds from `%USERPROFILE%\.azure\clippyai-signing-creds.json`
2. Invoke SignTool with the TrustedSigning DLib
3. Sign every `.exe` electron-builder produces (the inner ClippyAI.exe and the NSIS setup .exe)
4. Time-stamp via `http://timestamp.acs.microsoft.com`

After that, the SmartScreen warning on auto-update should vanish for users (Microsoft propagates trust to your cert subject within ~1-2 weeks of first sign — until then, Windows still shows "Unknown publisher" but with a much milder dialog).

## Cost

| Item | Cost |
|---|---|
| Trusted Signing Basic SKU | $9.99/month |
| Per signature | ~$0.005 (covers 5,000 sigs/mo) |
| Identity validation | $0 |
| Effective | ~$10/mo |

Your $1000 startup credit covers ~100 months / 8+ years.

## Troubleshooting

- **"Identity validation pending"**: it's manual review at Microsoft, average <24h. If stuck >3 days, open a support case via Azure Portal.
- **"signtool not found"**: install Windows 10 SDK (`winget install Microsoft.WindowsSDK.10.0.22621`).
- **"DLib not found"**: re-run the nuget install in Step 4. Path must be exactly `build/signing/dlib/bin/x64/Azure.CodeSigning.Dlib.dll`.
- **"Sign failed: 403"**: the service principal's role assignment hasn't propagated yet (~5 min) or the cert profile name is wrong. Re-check the JSON file.
- **Switching to Cloudana branding later**: register Cloudana as an LLC, get a D-U-N-S number, file a new identity validation as "Public Trust → Organization", create a second cert profile, swap `CERT_PROFILE` in the creds file. The wrapper, the SP, and the account stay the same.
