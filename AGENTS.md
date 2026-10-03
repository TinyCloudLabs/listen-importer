# AGENTS.md

## Versioning

Never write a `major` changeset or raise a package's major version. Use `minor` for features and `patch` for fixes, even when a change breaks compatibility, and say what breaks in the changeset. A major release is a human decision: a maintainer approves it with an empty commit on the PR, and agents never write that commit:

```sh
git commit --allow-empty -m "approve-major-release: <package>"
```

The `Major release guard` check fails a PR that adds a `major` changeset or raises a major version without that sign-off (TC-615).
