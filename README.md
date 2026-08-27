# UF Monitor

[![CI](https://github.com/Cribl-Community/cc-uf-monitor/actions/workflows/ci.yml/badge.svg)](https://github.com/Cribl-Community/cc-uf-monitor/actions/workflows/ci.yml)

A Cribl App that discovers **Splunk Universal Forwarders (SUFs)** connecting to your worker
groups and builds a persistent inventory of their versions, operating systems, architectures,
and S2S protocol — without leaving debug logging on permanently.

![The UF Monitor app: the Monitor tab showing a discovered forwarder and its raw debug event](./docs/screenshot-monitor.png)

## Why

Splunk Universal Forwarder information isn't captured in a default configuration. The connection
metadata (UF version, OS, architecture, S2S protocol) is only emitted by the
`input:in_splunk_tcp:forwarders` input channel when it runs at **DEBUG** level. Running that
channel at DEBUG all the time is noisy and expensive, so operators normally never see this data.

UF Monitor automates the whole loop safely: it turns DEBUG on for a short, self-reverting window,
harvests the connection events, and persists a clean inventory you can browse, filter, and export.

## What it does

1. **Select a worker group.** On selection the app reads the current logger config. If DEBUG is
   already active on the forwarders channel, it adopts the remaining window instead of re-enabling.
2. **Enable DEBUG (with confirmation).** Patches `input:in_splunk_tcp:forwarders` to DEBUG with a
   15-minute TTL, then commits and deploys that change so worker processes pick it up.
3. **Read logs live.** Polls the group logs every few seconds, keeping only events that carry a
   `version` field — the reliable signal of a forwarder reporting its relevant metadata.
4. **Reconcile and persist.** Matches each forwarder against the KV-persisted inventory and marks it
   *new*, *updated*, or *unchanged*. The inventory is global across every worker group monitored.
5. **Revert automatically.** The DEBUG log level is set with a TTL, so it expires on its own when the
   window ends — the app doesn't patch the config back. An adopted window is likewise left to its own TTL.

The in-app **Help** tab documents the full workflow, the fields collected, and an FAQ.

## Features

- Worker-group picker with automatic detection/adoption of an in-progress DEBUG window
- Live-updating Monitor table with new/updated/unchanged status
- **Inventory** tab: a durable, global inventory backed by the app KV store
- Per-forwarder show/hide toggle (hidden rows are excluded from the Monitor view and CSV export)
- Per-forwarder delete (a deleted forwarder that is still connecting is re-discovered with a fresh count)
- **Download CSV** export of the visible inventory

## Installation

There are two supported ways to install a released version.

### Upload the packaged release (simplest)

1. Download the latest `cc-uf-monitor-<version>.tgz` from the
   [Releases page](https://github.com/Cribl-Community/cc-uf-monitor/releases/latest).
2. Log in to Cribl and click **Apps -> View All**.
3. Click **Add App -> Upload package** and select the downloaded `.tgz`.
4. Click **Install**.

### Import from Git

> **Import from a release tag, not `main`.** Cribl's "Import from Git" requires
> the repo to contain the *built bundle*. The release workflow commits the built
> `static/` and `default/` layout onto each release tag (and onto the moving
> `latest` tag), so those refs are installable — but `main` holds source only and
> will install an app record that can't load ("App not found").

Point "Import from Git" at this repo and select the `latest` tag or a specific
`vX.Y.Z` release tag as the ref.

## Development

```bash
npm install
npm run dev      # start the Vite dev server
npm run lint     # oxlint
npm run build    # type-check + production build
npm run package  # build + create build/<name>-<version>.tgz
```

## Releasing

Releases are cut by pushing a `v*` tag. The workflow at `.github/workflows/release.yml`
derives the version from the tag (`v1.1.2` → `1.1.2`, and a `-staging` suffix is
stripped), then on that tag:

1. Runs `npm ci`, lints, and packages the app (`build/cc-uf-monitor-<version>.tgz`).
2. **Publishes the pack layout for Git install** — materializes `static/` + `default/`,
   commits them onto the tag, and force-updates the `latest` tag to point at the release.
3. Creates a **GitHub Release** with the `.tgz` attached.
4. **Uploads the pack to the Cribl Packs Dispensary** — the staging dispensary for
   `-staging` tags, the production dispensary otherwise.

The dispensary credentials/endpoints come from org-level Actions secrets and variables
(`PACKS_API_TOKEN{,_STAGING}`, `DISPENSARY_ENDPOINT{,_STAGING}`) and are inherited
automatically.

Keep `package.json` `version` committed in step with the release tag so the packaged
app reports the right version.

### Test on staging first

Append `-staging` to the tag to publish to the **staging** dispensary only, verify, then
push the clean tag for production:

```bash
# 1. Bump package.json (+ lockfile) to the new version and merge to main.
npm version 1.1.3 --no-git-tag-version
# ...commit + PR...

# 2. Staging release — uploads to the staging dispensary only.
git tag v1.1.3-staging
git push origin v1.1.3-staging

# 3. Once verified, production release.
git tag v1.1.3
git push origin v1.1.3
```

> **Note:** the `latest` tag is force-moved on *every* release, staging included, so a
> `-staging` run temporarily points `latest` at the staging build until the next
> production tag moves it back.

`package.json` version and the `v*` tag should agree. To retag, delete the bad tag locally
and on the remote first:

```bash
git tag -d v1.1.3
git push origin :refs/tags/v1.1.3
```

## License

Licensed under the [Apache License 2.0](./LICENSE).
