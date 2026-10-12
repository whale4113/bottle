# GitHub Stars imports

The import page shows 10 repositories at a time. GitHub GraphQL’s `viewer.starredRepositories.totalCount` supplies the total used for pagination and selection counts, without requesting repository nodes. Repository details are fetched through the paginated REST Stars endpoint as needed.

**Select all repositories** immediately selects all Stars, including repositories on unseen pages. This action does not fetch additional pages. Users can exclude individual repositories, deselect a page, or clear the selection. Exclusions persist when navigating between pages.

The browser submits the selection to `POST /api/github/stars/sync`:

```json
{"selectAll": true, "excludedRepositoryIds": [12345]}
```

For an explicit selection, it submits:

```json
{"repositoryIds": [12345, 67890]}
```

For an all-repositories import, the worker reads the total count, fetches one GitHub page, and processes its repositories before fetching the next page. Repositories with a valid index for the current embedding configuration are skipped. Missing or incompatible indexes are rebuilt. Progress is retrieved over HTTP (every 2 seconds during imports, every 15 seconds when idle); cancellation stops subsequent page requests and indexing work. If the configured page limit is reached, the job reports a partial import failure. Retrying skips indexes that were successfully created.

A completed import saves the actual selected repository IDs for scheduled refreshes. Scheduled refreshes continue refreshing that saved selection.

GitHub API references: [GraphQL User](https://docs.github.com/en/graphql/reference/objects#user) and [REST Stars](https://docs.github.com/en/rest/activity/starring#list-repositories-starred-by-the-authenticated-user).
