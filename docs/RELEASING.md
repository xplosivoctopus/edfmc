# Releasing, signing and provenance

Cutting a release is `git tag v0.1.0 && git push origin v0.1.0`. The rest of this
document is about the harder question: **why should anyone believe the file they
downloaded is the one this repository built?**

## The signing gap

The Windows installers are **not code-signed**. SmartScreen will warn that the
publisher is unrecognised, and the user has to choose *More info → Run anyway*.

This matters more than it looks. "Click through the scary warning" is exactly the
habit malware relies on, and an application that asks users to learn it is
teaching them something harmful. It is the single largest trust gap in
distribution, and nothing below closes it.

## What is shipped instead, and what it is worth

Two mechanisms, neither a substitute for the above.

### SHA-256 checksums

`SHA256SUMS.txt` is published with every release.

```powershell
Get-FileHash -Algorithm SHA256 '.\EDFM Companion_0.1.0_x64_en-US.msi'
```

**What it proves:** the bytes you have match the bytes the workflow produced.

**What it does not prove:** anything about who produced them. A checksum published
next to the file it describes is only as trustworthy as the page hosting both — if
someone can replace the installer, they can replace the list. It catches corruption
and interrupted downloads; it does not catch a compromised release.

### Build attestations

Each binary carries a signed attestation produced by
`actions/attest-build-provenance`, recorded in a public transparency log.

```bash
gh attestation verify "EDFM Companion_0.1.0_x64_en-US.msi" --repo xplosivoctopus/edfmc
```

**What it proves:** this artifact was built by this workflow, from this repository,
at a commit the attestation names. That *is* stronger than a checksum — the
signature is not something an attacker who replaced the file could also forge,
because the signing identity belongs to the GitHub Actions workflow rather than to
the release page.

**What it does not prove:** that Windows will trust the file. SmartScreen does not
consult attestations. A user who downloads the installer and double-clicks it sees
exactly the same warning either way. Verification is an explicit act by someone who
already knows to perform it, which is a much smaller population than "people who
run the app".

### The distinction, stated plainly

| | Checksum | Attestation | Authenticode |
|---|---|---|---|
| Detects a corrupted download | yes | yes | yes |
| Survives a compromised release page | no | yes | yes |
| Identifies the builder | no | yes | yes |
| Removes the SmartScreen warning | **no** | **no** | yes |
| Requires the user to do anything | yes | yes | no |

The last two rows are why signing remains on the list. Provenance is for people
auditing the project; a certificate is for everyone else.

## Realistic signing options

Nothing here is configured, and none should be bought on a maintainer's behalf.

**Standard OV certificate (~$200–400/yr).** Historically the cheap option. Since
June 2023 the CA/Browser Forum has required private keys to live on certified
hardware — a FIPS 140-2 Level 2 token or an approved cloud HSM — so the old
"download a .pfx and sign locally" flow no longer exists. Signing from CI means
either a cloud signing service or a self-hosted runner with the token attached.
An OV certificate **does not** start with SmartScreen reputation; the warning
persists until enough installs accumulate.

**EV certificate (~$400–700/yr).** Same hardware requirement, plus organisation
vetting. Its practical advantage is immediate SmartScreen reputation, which is the
actual thing being bought.

**Azure Trusted Signing (~$10/month).** Microsoft's managed service, by far the
cheapest route, and it handles key custody. Requires a verifiable legal identity —
an organisation, or an individual with three years of verifiable history. This is
the option most worth investigating for a project this size.

**Sigstore / signtool with a self-signed certificate.** Neither helps. Windows
trusts a certificate chain, and neither chains to a root Windows ships.

## What would change in the workflow

`tauri-action` signs via the Tauri bundler, which reads
`WINDOWS_CERTIFICATE` and `WINDOWS_CERTIFICATE_PASSWORD`. With a cloud signing
service the shape is different: build unsigned, then sign the artifacts in a
separate step before upload, and sign the **MSI, NSIS installer and the bare
`.exe`** — signing only the installer leaves the binary it drops on disk unsigned.

Practical notes for whoever does this:

- Add the signing step **after** `tauri-action` and **before** the checksum step,
  or the published hashes will describe unsigned files.
- Secrets must not be exposed to workflows triggered by forks. Release runs on a
  tag push, so this is already the case, but a future `workflow_dispatch` on a
  fork branch would not be.
- Timestamp every signature (`/tr`). Without it, signatures stop validating when
  the certificate expires rather than when it was issued.

## Until then

The README states the gap plainly rather than burying it, and the release notes
tell people what the checksum and attestation do and do not mean. Overstating
either would be worse than the gap itself.
