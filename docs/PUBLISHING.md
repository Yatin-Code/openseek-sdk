# Publishing openseek-sdk (npm + Maven Central)

Status: **prepared, NOT executed.** Nothing here has been published, no tags
pushed, no accounts created. The `publish-npm` / `publish-maven` workflow jobs
run only on `v*` tags and both refuse to do anything useful until the checklist
below is done.

Target artifacts (both from the v0.2.0 tag, after `feat/contribute` merges):

- npm: `@openseek/sdk` (provisioned name — see step 3, scope may be taken)
- Maven: `tv.openseek:openseek-sdk-jvm` (see `packages/kotlin/publish.gradle.kts`
  for why `tv.openseek`, and the fallback if Sonatype rejects it)

## Checklist — in order, all steps are manual (run by YOU, not the agent)

### Step 0 — Land a Gradle build for the Kotlin SDK (code change, before tagging)

`packages/kotlin/publish.gradle.kts` is a **template only**: the repo has no
Gradle wrapper and no `build.gradle(.kts)` yet. Before the first Maven release:

1. Add a Gradle wrapper (`gradle wrapper`) + a `kotlin("jvm")` module that
   applies `packages/kotlin/publish.gradle.kts` and enables
   `java { withSourcesJar(); withJavadocJar() }` (Central requires both jars).
2. Dry-run locally until green (no secrets needed):
   `./gradlew publishToMavenLocal` then check `~/.m2/repository/tv/openseek/`.
3. Only then proceed — the `publish-maven` job fails fast with a clear error
   until `gradlew` exists at the repo root.

### Step 1 — Create the Sonatype namespace

1. Request/open the `tv.openseek` namespace on Sonatype (OSSRH / Central
   Portal — whichever flow is current when you do this).
2. If Sonatype rejects `tv.openseek`, fall back to `io.github.yatin-code`
   (auto-approved via the `Yatin-Code` GitHub org). Then update:
   `packages/kotlin/publish.gradle.kts` (`group = ...`), this file, and tell
   consumers the coordinates changed.
3. Create a Sonatype user token for CI (username + password). You need these
   for step 4.

### Step 2 — GPG key for artifact signing (Central requires signatures)

```sh
gpg --full-generate-key        # RSA 4096, no expiry or long expiry, YOUR name/email
gpg --list-secret-keys --keyid-format=long
gpg --armor --export <KEY_ID> > openseek-public.asc        # publish to a keyserver
gpg --keyserver keyserver.ubuntu.com --send-keys <KEY_ID>
gpg --armor --export-secret-keys <KEY_ID>                  # -> paste into GPG_PRIVATE_KEY secret
```

Keep the passphrase — it becomes the `GPG_PASSPHRASE` secret. Never commit
any `.asc` / `.key` / `secring` file: `.gitignore` already excludes
`*.pem`, `*.key`, `.env`.

### Step 3 — npm account + `@openseek` scope (MANUAL CHECK — scope may be taken)

1. Create an npm account, then check the scope (do NOT query via the agent):
   open `https://www.npmjs.com/package/@openseek/sdk` in a browser, or run
   `npm view @openseek/sdk version` yourself.
2. **The name `@openseek/sdk` is provisional.** If the scope is taken:
   pick a new name (e.g. `@<your-scope>/openseek-sdk`), update
   `packages/js/package.json` (`name`), `packages/js/README.md`,
   root `README.md` import snippets, and the `publish-npm` verify commands
   below — then re-run the npm dry-run.
3. Create a Classic or Granular **Automation** token for CI
   (`https://www.npmjs.com/` → Access Tokens). It becomes `NPM_TOKEN`.
   If the scope is yours, `npm publish --access public` (already in the
   workflow) is enough; no pre-created package page needed.

### Step 4 — Add the 5 GitHub Secrets (repo → Settings → Secrets → Actions)

| Secret | Value from |
|---|---|
| `NPM_TOKEN` | Step 3 npm token |
| `OSSRH_USERNAME` | Step 1 Sonatype token username |
| `OSSRH_PASSWORD` | Step 1 Sonatype token password |
| `GPG_PRIVATE_KEY` | Step 2 armored private key (whole block incl. headers) |
| `GPG_PASSPHRASE` | Step 2 key passphrase |

The workflow reads secrets **only** via `${{ secrets.* }}` into env vars —
never echoed, never committed. After adding, re-run nothing: they are read
at release time.

### Step 5 — Merge `feat/contribute` (v0.2 track) into `master`

```sh
git checkout master && git pull
gh pr create --base master --head feat/contribute --title "v0.2: contribution half" --body "see CHANGELOG"
# review, merge via the PR. Do NOT push directly to master.
```

### Step 6 — Bump versions, tag, push the tag

```sh
# packages/js/package.json: "0.2.0-unreleased" -> "0.2.0"
# publish.gradle.kts default stays "0.2.0-unreleased" (CI overrides via RELEASE_VERSION)
git commit -am "release 0.2.0" && git push
git tag v0.2.0 && git push origin v0.2.0     # THIS triggers the publish jobs
```

The `publish-npm` job refuses to run if `package.json` still contains
`unreleased` — that guard failing means you forgot the bump; fix, retag
(delete + recreate the tag locally and remotely), push again.

### Step 7 — Watch the workflow

Actions tab → the `v0.2.0` run → `release`, `publish-npm`, `publish-maven`.
Or: `gh run watch` / `gh run view --job <id> --log-failed`.

### Step 8 — Verify on Maven Central + npm

```sh
npm view @openseek/sdk version        # expect 0.2.0
npm view @openseek/sdk dist.tarball   # tarball URL; unpack and check it holds only src/ + README
```

Maven: search `openseek-sdk-jvm` on Central (search.maven.org /
central.sonatype.com), confirm version `0.2.0` with `sources` + `javadoc`
jars attached. Then close/release the staging repository in the Portal UI
(the workflow only uploads to staging; the release click is yours).

Smoke-test both artifacts from a clean machine (real `npm install`,
real Gradle dependency) before announcing.

## When a step fails — dry-runs first, always

1. **npm**: `cd packages/js && npm publish --dry-run` — shows the exact
   file list (`files` allowlist: `src/` + `README.md`) without uploading.
   Auth failures → token wrong/expired or missing `NPM_TOKEN` secret.
   403 name taken → step 3 rename path.
2. **maven**: `./gradlew publishToMavenLocal` — full build + POM + jars,
   zero secrets, zero network. Signature issues → GPG key/passphrase.
   Staging upload works but Portal shows nothing → wrong Sonatype endpoint
   (legacy OSSRH vs new Portal URL — see the comment in
   `publish.gradle.kts`) or wrong `OSSRH_*` credentials.
3. **Workflow red on tag, green locally** → secrets missing/misnamed
   (must be exactly the 5 names in step 4), or the version guard tripped.
4. **Rollback**: npm — `npm deprecate` a bad version (unpublish only works
   within 72h and breaks installs; prefer deprecate + patch forward).
   Sonatype — drop the staging repository before pressing release; after
   release, ship a new version forward, never rewrite.
5. Never paste secrets into issues/logs; never commit them (see `.gitignore`).
