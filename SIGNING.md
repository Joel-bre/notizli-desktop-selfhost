# macOS signing & notarization

The Windows build ships unsigned today (users click through the SmartScreen
"More info → Run anyway" prompt). The macOS build is **skipped** in CI until
the five secrets below are present, because Apple requires a Developer ID
certificate to sign and notarize. Once these repository secrets exist, the
`macos` job in `.github/workflows/release.yml` runs automatically and produces
a signed, notarized `Notizli-SelfHosted.zip` (+ `.dmg`).

## Required GitHub repository secrets

Add these under **Settings → Secrets and variables → Actions** on
`Joel-bre/notizli-desktop-selfhost`:

| Secret | What it is |
| --- | --- |
| `APPLE_ID` | The Apple Developer account email used for notarization. |
| `APPLE_APP_SPECIFIC_PASSWORD` | An app-specific password for that Apple ID (create at appleid.apple.com → Sign-In and Security → App-Specific Passwords). **Not** your account password. |
| `APPLE_TEAM_ID` | Your 10-character Apple Developer Team ID (Apple Developer → Membership). |
| `CSC_LINK` | Base64 of your Developer ID Application `.p12` certificate: `base64 -i cert.p12 \| pbcopy`. |
| `CSC_KEY_PASSWORD` | The password that protects the `.p12` file. |

## How it's wired

- `.github/workflows/release.yml` has a `check-signing` job that sets
  `mac=true` only when **all five** secrets are non-empty. The `macos` job has
  `if: needs.check-signing.outputs.mac == 'true'`, so it is *skipped* (not
  failed) while the secrets are missing.
- electron-builder reads `CSC_LINK` / `CSC_KEY_PASSWORD` to sign, and
  `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` to notarize
  (`mac.notarize: true` in `package.json`).
- Signing entitlements live in `build/entitlements.mac.plist` (hardened
  runtime + microphone access).

No certificate or password is ever committed to the repo — they live only in
GitHub Actions secrets.
