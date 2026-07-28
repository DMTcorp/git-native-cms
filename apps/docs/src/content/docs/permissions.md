---
title: GitHub teams and CMS permissions
description: Provision organization members and review custom role mappings through Git.
---

GitHub owns organization membership and teams. The CMS maps those teams to product roles from the
versioned `.cms/permissions.yaml` file. The browser never receives an organization token.

Open **Team & permissions** to:

- inspect organization members and teams;
- invite a user through the GitHub App;
- add an existing member to a GitHub team;
- propose team-to-role mappings in an auditable pull request.

Built-in roles are `viewer`, `author`, `editor`, `translator`, `reviewer`, `publisher`,
`developer` and `administrator`. Custom roles contain an explicit allowlist of CMS actions:

```yaml
version: 1
customRoles:
  - name: legal-reviewer
    actions:
      - project.read
      - change.review
mappings:
  - team: example/legal
    roles:
      - legal-reviewer
```

The runtime reads this file from `main`; environment mappings are only a bootstrap fallback.
Invalid actions fail closed. Resource policies can further deny actions, restrict content types
or require ownership.

GitHub login proves identity but does not grant publication rights. The application layer checks
every command independently. A Change owner cannot self-approve; publishing and rollback require
publisher permission plus an actor/action-bound confirmation token.
