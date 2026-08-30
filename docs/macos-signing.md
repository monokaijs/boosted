# macOS signing and notarization

The release workflow signs the universal macOS app with an Apple **Developer ID Application** certificate, submits it to Apple for notarization, waits for the result, and staples the notarization ticket to the app before creating the DMG. The workflow fails before building if any required secret is missing.

An **Apple Development** certificate is not sufficient for distributing the DMG outside the Mac App Store. Creating a Developer ID Application certificate requires a paid Apple Developer Program membership, and only the team's Account Holder can create one.

## 1. Create and export the certificate

1. In Keychain Access on a Mac, create a certificate signing request using **Certificate Assistant → Request a Certificate From a Certificate Authority**.
2. In the Apple Developer portal, open **Certificates, Identifiers & Profiles**, create a **Developer ID Application** certificate, and upload the request.
3. Download and install the certificate in the login keychain.
4. In **My Certificates**, expand the certificate and confirm that its private key appears below it.
5. Export the certificate and private key together as a password-protected `.p12` file.
6. Encode it without line breaks:

   ```bash
   openssl base64 -A -in /path/to/developer-id-application.p12 \
     -out certificate-base64.txt
   ```

Keep the `.p12` file, its password, and `certificate-base64.txt` private. Do not add them to this repository.

## 2. Create an app-specific password

Sign in at [account.apple.com](https://account.apple.com), open **Sign-In and Security → App-Specific Passwords**, and create a password for Boosted releases. This is the notarization password; do not use the normal Apple account password.

## 3. Add GitHub Actions secrets

From the repository directory, add these six secrets. `gh secret set` prompts without putting the entered value in the command line:

```bash
gh secret set APPLE_CERTIFICATE < certificate-base64.txt
gh secret set APPLE_CERTIFICATE_PASSWORD
gh secret set APPLE_ID
gh secret set APPLE_PASSWORD
gh secret set APPLE_TEAM_ID
gh secret set KEYCHAIN_PASSWORD
```

Use the following values:

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64 contents of the exported `.p12` file |
| `APPLE_CERTIFICATE_PASSWORD` | Password chosen when exporting the `.p12` file |
| `APPLE_ID` | Apple account email used for notarization |
| `APPLE_PASSWORD` | App-specific password created in step 2 |
| `APPLE_TEAM_ID` | Apple Developer Team ID from the Membership page |
| `KEYCHAIN_PASSWORD` | A new strong random password used only for the temporary CI keychain |

Generate the temporary keychain password with a password manager or `openssl rand -base64 32`. It does not need to match any Apple password.

Confirm that all secret names exist without displaying their values:

```bash
gh secret list
```

## 4. Run a release

Open **Actions → Release desktop apps → Run workflow**, select `patch`, `minor`, or `major`, and run it from the default branch. On the macOS runner, the workflow:

1. decodes the certificate into the runner's temporary directory;
2. imports it into an isolated temporary keychain;
3. verifies that it contains a valid Developer ID Application identity;
4. signs the universal app and submits it for notarization;
5. staples the successful notarization ticket; and
6. deletes the temporary keychain even if the build fails.

After the release completes, download the DMG and verify it on a Mac:

```bash
codesign --verify --deep --strict --verbose=2 /Applications/Boosted.app
spctl --assess --type execute --verbose=2 /Applications/Boosted.app
xcrun stapler validate /Applications/Boosted.app
```

The release job publishes only after the Linux, Windows, and signed macOS builds all succeed.
