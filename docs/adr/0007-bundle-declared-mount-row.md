# 0007. Ship the mount row inside the package (`dsh.bundle`)

Date: 2026-09-10

## Context

Installing this plugin took two manual steps: `dsh plugin --profile web add
github:Pheobe-Southwood/dsh-better-workspaces` installed the dependency, and
the user then hand-wrote the plugin row into
`$DSH_HOME/profiles/web/cordis.patch.yml` before the next boot would mount
anything. The row was not optional — without it `apply()` never runs, so the
host routes never register and every GUI surface (hero control, badges, diff
page) is silently absent.

The dsh CLI already automates that wiring for packages that declare it:
`runPlugin` forwards to pnpm and then `reconcilePlugins` appends every
dependency whose manifest declares `dsh.bundle` to the profile's
`dsh.profile.bundles`, while a bundle-less dependency only earns a warning
(`lib/plugin-Ddi42qoW.js:46-78`, `:57-58`). A listed bundle contributes its
`dsh.bundle.patch` file as one patch layer over the empty root
(`@deepseek-ai/dsh-app-boot/lib/index.js:849-860`). This package declared only
`dsh.client`, so the automatic path was unavailable and the manual step was
structural, not incidental.

Verified on this machine inside a throwaway `DSH_HOME` (no change to the real
profile): with `dsh.bundle.patch` and a root `cordis.patch.yml` added,

```
$ DSH_HOME=/tmp/dsh-probe-home dsh plugin --profile web add link:/tmp/bw-probe
$ DSH_HOME=/tmp/dsh-probe-home dsh --profile web --dump-config
# == dsh-better-workspaces
- id: better-workspaces
  name: dsh-better-workspaces
```

— one command installed the package *and* mounted the row.

The migration cost is real and was mis-stated elsewhere as harmless. The
include's patch algorithm pushes insert entries verbatim and never dedupes by
id (`@deepseek-ai/cordis-plugin-include/lib/index.js:83`), and the Loader
throws on a repeated entry id
(`@deepseek-ai/cordis-plugin-loader/lib/index.js:88-92`:
`TypeError: duplicate loader entry id`). dsh boots fail-loud, so an upgraded
profile that keeps its hand-written row next to the new bundle layer does not
boot at all. A dump with both sources present does render two rows with the
same id, which is how the collision was confirmed.

## Decision

The package ships its own mount row:

- `package.json` declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`
  alongside the existing `dsh.client` block — two independent keys, one for
  the host mount and one for the browser half;
- the repository-root `cordis.patch.yml` contributes exactly one row,
  `id: better-workspaces` (the `name` the host half exports) and
  `name: dsh-better-workspaces` (the package name the Loader resolves);
- `files` includes `cordis.patch.yml`, so a future npm publish cannot drop the
  only mount row;
- upgrading installs must delete the hand-written row, and README, CONTEXT and
  this ADR all state the failure symptom instead of calling it harmless;
- `test/mount-check.mjs` guards the wiring: the bundle declaration, the single
  row, `name`/`id` parity, the `files` entry, and the README's upgrade note.

## Consequences

- A fresh device installs and mounts with one command plus one restart; the
  only remaining manual edit in the install path disappears.
- Uninstall is symmetric: `dsh plugin --profile web remove
  dsh-better-workspaces` also drops the bundle from `dsh.profile.bundles`
  (`@deepseek-ai/dsh-app-boot/lib/index.js:60-68`).
- The pre-bundle upgrade path is a breaking change with a loud symptom
  (`duplicate loader entry id: better-workspaces`). It is a one-time manual
  deletion, and it is why the README documents the removal rather than
  tolerating the duplicate.
- Removing the `dsh.bundle` declaration reverts to a silent no-mount — the
  package still installs, still prints no error, and simply never appears.
  That is exactly the failure the mount guard now catches.
- Editing the package's `cordis.patch.yml` takes effect on restart, not on
  `patchReload: live`: the boot sequence snapshots the bundle patches and only
  re-reads the profile and home patch layers
  (`lib/profile-boot-Dk-7KqJc.js:305-310`).
- No runtime code changed: how the row is delivered is independent of what the
  plugin does once mounted.
