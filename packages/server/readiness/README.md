# Readiness

Code that tells an app author, before they submit, what the BUSY Apps Catalog would say about their app, and prepares
what the catalog's pull request needs. The command line's `check` and `submit` (`../cli/commands/`) are thin over it.
Node's standard library only; nothing here starts git, npm or the project's code.

| File | What it is |
|---|---|
| `rules.mjs` | The catalog's 66 checks (id, stage, a title in the emulator's words, blocking or a warning), its limits, the rules of an id, a name and a version, its categories, the license texts it recognizes. Taken from the catalog's tools at the commit `RULES_COMMIT`; the file carries their MIT notice. |
| `catalog-registry.json` | A copy of the catalog's check registry: its own titles and texts ("problem", "how to fix") for the same 65 ids, pinned to a catalog commit. Refreshed by `emulator/tools/catalog-registry/` (a maintainers' tool, outside the server because it starts git and Python). Published and shipped with the permission of the catalog's owner (11 November 2026). |
| `facts.mjs` | What a project folder holds that the checks look at: the app's manifest, the built package, `catalog.json`, the screenshots, icons, license and lock files, the git repository around it. Reads only. |
| `package-file.mjs` | The built app, `dist/<id>.tgz` or the folder `dist/<id>/`, read in memory as a general tar reader reads it. |
| `git-folder.mjs` | The repository's top, the commit checked out, the remote, whether this copy saw the commit there, and the files git keeps (its index), from the repository's own files; no git is started. |
| `import-probe.mjs` | What each script of the build imports: parsed, never run, in a short process of the Node the command line was given. |
| `check.mjs` | The answer to every check (`checkProject`), the report for a person (`reportText`), the catalog's Markdown subset. |
| `texts.mjs` | The four texts of `catalog.json` checked field by field by the same rules (`textProblems`): the command line's `catalog-texts` and the window's form use it; it imports only `rules.mjs` and `markdown.mjs`, so the window loads it as it is. |
| `markdown.mjs` | The catalog's Markdown rule for a description and a changelog, touching no file. |
| `submission.mjs` | The catalog manifest's YAML, the pull request's text, `SUBMIT.md`, and the writing of `submission/`. |

## The three answers

Every check gets `pass`, `fail` or `unchecked`. A failing check carries `found` (what is here) and `change` (what to
do), and the catalog's own `problem` and `fix` where the registry copy is there. An unchecked one carries `why`, and
`change` when there is something to do about it; `waits: true` marks one that only waits for a failing check, the
build or the author's texts (the report names these in one line). `blocking: false` marks the catalog's warnings: it shows them and
still takes the app, and they do not fail `check`. `applies: false` marks the seven checks that say nothing about an
app being submitted (faults of the catalog's own run; requests to remove an app).

A defect is reported once, under the check that names it most closely; where the catalog's bot would name a broader
check first, the finding says so. For a project that is built, has its texts, a screenshot and a GitHub remote, 54
checks are decided here (53 when this copy has not seen the commit on the remote), and these stay open:

- `pr_scope`, `author_attestation`: they are about the pull request itself.
- `build`: the catalog builds the commit itself, in a container without network and without install scripts.
- `version_not_newer`: needs the version published in the catalog.
- `source_commit`, unless a remote branch of this copy points at the commit: only GitHub knows whether it is there.

What git keeps is read from its index (`git-folder.mjs`; versions 2 to 4, no git started): a screenshot, a license,
a lock file or `src/appmeta/manifest.json` that is in the folder and was never added to git fails its check, since
the catalog reads the commit; a path that git has under another letter case fails too; of two lock files, one of
which git does not keep, the catalog sees one. Whether what is added is also committed is not claimed (an index
does not say), nor anything where the index is not read (no commit yet, a split or sparse index): `SUBMIT.md` tells
the author to look.

## Where the catalog and its tools differ, and what `check` says then

Found by running `check` and the catalog's own tools on the apps of the dev catalog and on the submissions it
refused (11 November 2026):

- The catalog's rule for an id allows 63 characters; busy-cli, which the catalog builds with, and the bar take 32. An
  id of 33 to 63 characters passes the catalog's `app_id_format` and fails its `build`; `check` fails `build`.
- busy-cli builds an app whose manifest is `appmeta/manifest.json` at the top of the project; the catalog reads the
  id from `src/appmeta/manifest.json` only. `check` fails `app_id_match` for the first layout.
- The Markdown rule goes over the text as the catalog's parser (Python-Markdown) does: blocks, lists and what is
  nested in them, then the inside of a line. `test/markdown-cases.json` holds texts with the catalog's own answers;
  record it again when the rules move (the test compares the commit).


## Where the author's texts are

The catalog manifest's `category`, `short_description`, `description` and `changelog` are the author's and are never
made up: they are read from `catalog.json` in the project, which `submit` creates, empty, when it is not there.
`screenshots` and `back_screenshots` there may list PNG files of the project, the cover first; without them
`screenshots/front-<n>.png` and `back-<n>.png` are taken in the order of their numbers, the names `busy-emulator
screenshot` gives (an enlarged copy, `front-1@8x.png`, is not one). The catalog reads the screenshots from the app's
repository at the commit, so `submission/` holds no copies of them, and it ignores itself in git.

## Without the registry copy or the PNG checker

A copy of the emulator that lacks `catalog-registry.json` runs the same 66 checks and names them in the emulator's
words (`rules.catalog_texts: false`, and the report says so). One that lacks `../capture/catalog-png.mjs` leaves the
five checks of screenshots and icons unchecked and says why. A test compares `rules.mjs` with the registry copy: a
check the catalog adds, drops or re-weighs fails it, and so does a copy taken at another commit than `RULES_COMMIT`.

## Tests

```sh
node --test emulator/packages/server/readiness/test/check.test.mjs
```

`test/project-fixture.mjs` writes a project as the official template makes it and an author finishes it; the tests
plant one defect at a time and run the command line in their own process, without an emulator, the network or git.
The manifest's YAML is read back with PyYAML where Python has it, as the catalog reads it.
