# GitHub Actions Node 20 deprecation on release workflow

- Status: open
- Date: 2026-08-07
- Diagnostic ID: —
- Report: —
- Area: other

## Symptom

Successful Release CI for `v0.3.10` (run `31199503293`) printed a GitHub annotation:

> Node.js 20 is deprecated. The following actions target Node.js 20 but are being forced to run on Node.js 24: `actions/checkout@v4`, `actions/setup-node@v4`.

The job still completed green (install, tests, VSIX, GitHub Release, Open VSX). This is a forward-looking breakage risk, not a current failure.

## Repro

1. Push a `v*` tag that triggers `.github/workflows/release.yml`.
2. Open the Actions run summary → Annotations on **Build and release VSIX**.

Observed on release of **v0.3.10** (2026-08-07).

## Evidence

- Workflow still pins:
  - `actions/checkout@v4` (`.github/workflows/release.yml` ~L27)
  - `actions/setup-node@v4` with `node-version: 22` (~L30–33)
- GitHub changelog: [Deprecation of Node 20 on GitHub Actions runners](https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/)
- Annotation path reported as `.github#2` on the failed-to-upgrade actions (warning only).

## Likely cause

`checkout@v4` / `setup-node@v4` still ship action runtimes targeting Node 20. GitHub is forcing Node 24 on runners and will eventually remove Node 20 support, so these major versions need a bump (typically `@v5` once stable and compatible).

## Suggested fix (not applied)

1. Bump in `.github/workflows/release.yml`:
   - `actions/checkout@v4` → `@v5` (or current recommended major).
   - `actions/setup-node@v4` → `@v5` (keep `node-version: 22` unless docs require otherwise).
2. Re-run Release via `workflow_dispatch` or next patch tag and confirm the annotation is gone.
3. Scan the repo for any other workflows using `@v4` of those actions (currently only `release.yml`).

## Out of scope / follow-ups

- Not related to the Nexus / `html-to-image` lockfile E401 fix (that was resolved in 0.3.9 / 0.3.10 `.npmrc`).
- No change to app runtime Node version required solely for this warning.
