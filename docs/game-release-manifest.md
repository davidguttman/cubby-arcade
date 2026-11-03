# Game-owned releases

The Cubby registry lists a stable `manifest_url`. A game's own repository and
HTTPS domain own that release manifest and its files. A game release does not
require a Cubby registry edit or a second GitHub release to insert checksums.

## File release manifest: schema 2

```json
{
  "schema_version": 2,
  "id": "example-game",
  "version": "1.0.0",
  "runtime": "web",
  "entrypoint": "index.html",
  "artwork": "cover.svg",
  "files": {
    "index.html": {
      "url": "https://example.com/releases/1.0.0/index.html",
      "size": 15,
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    },
    "cover.svg": {
      "url": "https://example.com/releases/1.0.0/cover.svg",
      "size": 6,
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    }
  }
}
```

This example uses **illustrative** byte sizes and hashes. Generate actual values
from the exact build files before uploading; the manifest is not self-hashed.

- `schema_version: 2`, stable registry-matching `id`, distinct `version`, and
  `runtime: "web"` identify the release. IDs contain lowercase letters, digits,
  and hyphens, beginning with a letter/digit (maximum 80 characters).
- `entrypoint` and `artwork` are required relative installed file paths. Optional
  `attract` names the trailer file; optional `screenshots` is an array of up to
  12 relative file paths. All must occur in `files`.
- Every `files` value has an absolute HTTPS `url`, exact nonnegative integer
  byte `size`, and lowercase hexadecimal SHA-256. Download hosts may differ
  from the manifest host. Redirects, URL credentials, and URL fragments fail.
- Files are regular files only: no absolute/traversal/backslash/NUL/empty path
  segments, file/directory prefix collisions, or `manifest.json` payload. That
  filename is reserved for Cubby's installed inventory. Paths also reject `%`,
  `?`, `#`, ASCII control characters, and a trailing space because installed asset URLs cannot
  represent them unambiguously. Ordinary spaces and Unicode are supported. Subdirectories are
  implicit, not extra download entries.
- Limits: 256 KiB release manifest; 1,000 payload files; 128 MiB aggregate payload
  bytes. Each file must match both its declared size and hash. A schema-2
  manifest must not also contain a ZIP `package` field.
- Keep file URLs immutable and versioned. Any changed payload or game metadata
  requires a distinct release version. Changing only download URLs does not
  change the installed game. Keep the game ID stable to preserve saves.

## One release workflow

1. Build all offline game files, using local relative references for assets.
2. Generate the manifest's sizes and hashes directly from that build directory.
3. Upload those exact files under immutable versioned HTTPS paths.
4. Verify they are available, then replace the stable manifest **last**.
5. Publish the GitHub release in the same workflow. No second release, manually
   entered hash, or Cubby release is needed for subsequent game updates.

The registry's artwork/trailer/screenshots are discovery URLs, separate from
installed relative asset paths. Browsing does not follow the release manifest.
An adult metadata title is allowed; this does not change the wordless child UI.

## Native installation and transition

The desktop installer accepts both the existing schema-1 ZIP release and the
new schema-2 file release at the same registry `manifest_url`. Downloads and
updates remain free; the native launcher charges only for game launches.

For file updates it reuses matching active-version files only after checking
their actual size/hash and rejecting symlinked sources. Reused bytes are copied,
not hard-linked. Missing, changed, or corrupt files download independently.
The entire new version is staged before atomic activation, and activation waits
until no game is running. Failed or interrupted installation leaves the active
version and saves unchanged; a retry may redownload staged files from the failed
attempt. Previous versions remain on disk.

On disk, Cubby generates its existing schema-1 digest-only `manifest.json` so
the offline host and save namespaces do not change. A same-version ZIP-to-files
migration is accepted when its payload inventory and game metadata are identical.
Different bytes/metadata at an existing version are rejected. URL relocation alone
is accepted. No version-ordering/downgrade policy is introduced by this contract.

Existing desktop bundles still seed from their ZIP archives without a network
dependency. Games publishing schema 2 require an updated native installer; old
desktop clients support schema 1 only. Checksums prove byte integrity, not
publisher identity; the registry remains a trusted-developer list.

## Generate in the game's repository

`runtime/file_manifest.py` is a standalone Python 3.11+ standard-library tool.
Copy that one file into a game's release tooling (for example
`tools/cubby_manifest.py`); it does not import Cubby or need its registry,
installed application, ZIP tooling, or Python dependencies.

After building your game's offline output into `dist/game/`, a single release
job can run:

```sh
uv run python tools/cubby_manifest.py dist/game \
  --id line-cutter --version "$RELEASE_VERSION" \
  --entrypoint play.html --artwork cover.png \
  --attract trailer.webm \
  --base-url "https://linecutter.david.app/releases/$RELEASE_VERSION/" \
  --output dist/release-manifest.json
```

Add `--screenshot screenshots/example.png` for each screenshot. Hashes, sizes,
and safely URL-encoded file names come from the exact build output. The output
manifest must be **outside** the payload directory; `manifest.json` is reserved
inside a game installation. Existing payload manifests, symlinks, special files,
unsafe paths, and oversized releases fail before publication.

Then, in that same CI job, use the game's hosting deploy command to upload
`dist/game/` to the versioned URL, verify the files, and publish
`dist/release-manifest.json` at the stable store manifest URL **last**. Finally
create the GitHub release with that same version/tag (or use a GitHub release
as the job trigger). The hosting command is game-specific; this generator does
not upload or create a second release. Do not rebuild files between hashing and
uploading. Keep previous versioned files available.

The adult `runtime.catalog` CLI also accepts this schema through existing
registry entries. Its update command is an explicit administrator operation:
stop that game first. Unlike the native desktop scheduler, the standalone CLI
cannot observe whether gameplay is active. Legacy ZIP commands remain available
for existing releases; new game repositories do not need to use them.
