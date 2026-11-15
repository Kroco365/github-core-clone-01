[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Kroco365/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Kroco365/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# git-core-clone

A GitHub-compatible git forge in one stdlib-only Node 22 process. No dependencies, no install step: run `node main.ts` (Node strips the erasable TypeScript types).

Entry for the [make.fun github-core-clone-01 bounty](https://make.fun/bounty/github-core-clone-01): build a GitHub-compatible git forge.

## What it serves

- **Git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol v2 (`ls-refs`, `fetch` with `thin-pack`/`ofs-delta`/`deepen`/shallow boundaries) and v0, receive-pack v0 with fast-forward enforcement and `report-status` over sideband. Packs are plain objects (no deltas) with a verified SHA-1 trailer.
- **REST v3** under `/api/v3` — repos (CRUD, pagination with `Link` headers), branches, commits, git refs, contents (create/update/delete with real commits), labels, issues (with comments), pull requests (files diff, squash merge with conflict detection).
- **GraphQL v4** at `/api/graphql` — `viewer`, `repository`, `node`, mutations (`createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest`, `addComment`), cursor pagination, and `__type` introspection. Batched requests (JSON arrays) are answered in order.
- **MCP** at `/mcp` — Streamable HTTP, modern `2026-07-28` era (`server/discover`) with a legacy `initialize` fallback; tools `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`, `get_issue`, `close_issue`, all acting on the same store as REST.
- **`GET /healthz`** — `200 {"ok": true}`.

## Auth

Every API call carries `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>`. Missing or wrong token is `401`; `/healthz` takes none. The token names the scenario viewer (`adaiversen`, id 1000); the scenario is fixed by the kit's seed, so the viewer identity is a constant, not parsed from the token.

## Lifecycle

`main.ts` binds an ephemeral port, POSTs `{"port": N}` to `$MAKEFUN_ENV_URL/register`, then polls `$MAKEFUN_ENV_URL/done` until `{"done": true}` and exits 0.

## Layout

- `main.ts` — entry/env lifecycle (kept as the kit starter ships it).
- `app.ts` — the whole forge: store, git object layer, pack codec, git HTTP, REST, GraphQL, MCP.

## License

MIT — see `LICENSE`.
