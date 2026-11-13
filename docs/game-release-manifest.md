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
      "url": "releases/1.0.0/index.html",
      "size": 15,
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    },
    "cover.svg": {
      "url": "releases/1.0.0/cover.svg",
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
- Every `files` value has a download `url`, exact nonnegative integer byte
  `size`, and lowercase hexadecimal SHA-256. URLs may be relative to the
  requested manifest URL, root-relative on its host, or absolute HTTPS URLs.
  For a manifest at `https://game.example/store/demo/manifest.json`, `1/files/a.js`
  resolves to `https://game.example/store/demo/1/files/a.js`, while `/releases/1/a.js`
  resolves to `https://game.example/releases/1/a.js`. Parent-relative paths work
  using normal URL resolution, not installed-file path rules. Absolute download
  hosts may differ from the manifest host. The resolved transport must be HTTPS.
  Protocol-relative URLs (`//host/path`), redirects, URL credentials/fragments,
  backslashes, whitespace/control characters, malformed escapes, and encoded
  controls/backslashes fail. URL-encode spaces and Unicode in remote references.
  Relative references require the source manifest URL; they never use the
  catalog origin or process working directory. Legacy schema-1 `package.url`
  supports the same download-reference rules.
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

### Right-sized discovery media

Registry entries may add an optional `media` object with `thumbnail`, `artwork`,
and/or `attract` derivatives. Each value is `{ "url": "https://…", "size": 1234,
"sha256": "<64 lowercase hex>", "source_sha256": "<original asset digest>" }`.
Only those three keys are supported. Sizes are positive integers bounded to
64 KiB for thumbnails, 512 KiB for artwork, and 8 MiB for trailers. URLs must be
absolute HTTPS. The required top-level `artwork` and optional top-level `attract`
remain original, backwards-compatible fallbacks. This metadata is **not** part
of a release manifest or game inventory and does not change installed game bytes.

The shared hub uses these variants on the RG353V: 192×144-bounded shelf images,
640×480-bounded hero images, and 320×240 VP9 WebM trailers. Desktop/browser hosts
keep original-size media. A failed derivative falls back once to its original;
rapid browsing still delays opening trailers until the selection settles.

The device host attaches catalog derivatives to an installed Library entry only
when `source_sha256` matches that entry's original artwork/trailer inventory
hash. It serves those derivatives through a separate content-addressed media
cache under the device state directory, outside immutable game releases. Cache
downloads are lazy, exact-size/hash verified, and range-served for video seeking.
Cached derivatives work offline; uncached failures keep the original local
artwork/trailer available. The disposable cache has a 64 MiB shared byte budget
and evicts oldest derivatives only. A feed refresh upgrades Library pictures
without moving focus or restarting a playing trailer; a future selection uses
the new trailer. Other hosts' installed Libraries continue using their existing
offline package assets.

Prepare derivatives from the **exact discovery originals**, not a different
marketing edit, and record both original and derivative hashes. Current registry
variants use Publitio URL transformations. Prewarm a new video transformation
and inspect its decoded content before recording its hash: Publitio can initially
return an HTTP-200 “processing” placeholder instead of the requested game video.

## Native installation and transition

The desktop installer accepts both the existing schema-1 ZIP release and the
new schema-2 file release at the same registry `manifest_url`. Downloads and
updates remain free; the native launcher charges only for game launches.

The hub every host mounts (browser, desktop and handheld) checks installed games'
stable manifests on hub entry, every five minutes in the hub, and on
visibility/connectivity recovery.
Unchanged identities fetch no payload files. Browser updates download the complete
new file inventory into a private Cache Storage release and atomically select it
in IndexedDB; retained release URLs keep games already open in other tabs pinned
to their original bytes. Navigating away cancels the hub's update work. Offline
or failed checks retain the active release and retry at a later check. Browser
timers can be throttled, and there is no updater running after the hub closes.

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
desktop clients support schema 1 only. Desktop 0.3.0 supports schema 2 with
absolute URLs but rejects relative download URLs; install **desktop 0.4.0 or
newer** before changing a stable manifest to use them. The format
remains schema 2, and absolute URLs stay supported. Cubby's legacy manifest
forwarding endpoint resolves relative references at the upstream publisher URL
before forwarding, so moving metadata does not change its meaning.
Checksums prove byte integrity, not
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
  --base-url "/releases/$RELEASE_VERSION/" \
  --output dist/release-manifest.json
```

Add `--screenshot screenshots/example.png` for each screenshot. Hashes, sizes,
and safely URL-encoded file names come from the exact build output. The output
manifest must be **outside** the payload directory; `manifest.json` is reserved
inside a game installation. Existing payload manifests, symlinks, special files,
unsafe paths, and oversized releases fail before publication.

### Game-owned phone companions

A game may declare its own grown-up phone app in its release manifest:

```json
"companion": {
  "url": "../companion/",
  "title": "My game for grown-ups",
  "artwork": "../companion/icon.png"
}
```

Only `url` is required. `title` is nonempty text up to 120 characters; `artwork`
is an optional public image URL. Both URLs must be HTTPS or relative to the
**final release manifest URL**, never to Cubby's catalog or device origin.
Credentials, fragments, protocol-relative URLs, unsafe schemes, and malformed
references are rejected. Hosts persist resolved public URLs in the installed
inventory. For a ZIP release, put absolute companion metadata in the package's
own `manifest.json`; if the outer release also declares it, the metadata must
agree with the package before activation.

The standalone generator accepts `--companion ../companion/`, optionally
`--companion-title "My game for grown-ups"` and
`--companion-artwork ../companion/icon.png`. Host and release the companion from
the game's repository/site; its UI, assets, offline behavior and logic are game
owned. It may also be included in the game's published build output. A URL is a
discovery link, not an integrity inventory for an independently hosted phone app.

Cubby's generic phone dashboard discovers companions from the **installed
version's manifest**, advertised by each paired Cubby. This works for custom
feeds without public-catalog entries, Cubby releases, or per-game hosting routes.
Adding, removing, or changing companion metadata requires a new game version;
changing it under an already-installed version is an immutable-release conflict.
Manifests without this optional field continue to install and play normally.

Opening a companion embeds its game-owned HTTPS URL inside the parent app.
Use the [embedded companion SDK](companion-app.md#embedded-game-sdk) so the game
uses the parent's existing pairing through a game-and-device-scoped bridge.
Do not add a separate game pairing or transport. Raw pairing secrets are never
passed to the game. Publisher pages must permit framing and use a distinct origin
from the Cubby parent app so they cannot access Cubby's pairing storage.

`--base-url` is optional and defaults to `./`: generated file references then
point beside the hosted manifest. Supply a relative version directory when
publishing a stable manifest elsewhere, or a root-relative version directory
when identical metadata is served at several paths on the same domain. No
deployment hostname is needed. An explicit absolute HTTPS base is still allowed.

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
