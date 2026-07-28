---
title: Doctor and upgrades
description: Diagnose installations and perform recoverable migrations.
---

`cms doctor` verifies Node, framework package, config, API/editor/preview routes, registry,
server-only GitHub variables, session and machine-token strength, complete S3/R2 configuration,
full registry digest, paired publication hooks, translation configuration and generated Actions.

```bash
pnpm cms doctor
```

Each failed check prints a repair action and exits non-zero, so the same command is safe in CI.
Adapter runtimes may append live checks for GitHub permissions, storage access and deployment
headers.

`cms upgrade` creates:

- a filesystem backup under `.cms/backups/<timestamp>`;
- a recoverable Git branch named `cms/backup/upgrade-<timestamp>`;
- updated config through the ordered migration chain;
- generated route/config codemods without overwriting user-owned files.

Review the resulting diff and keep the backup branch until production verification succeeds.
