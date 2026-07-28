# Product Specification: github-actions-gate

## 1. Product summary

`github-actions-gate` is a deterministic Node.js ESM command-line gate that decides whether a GitHub Actions delivery satisfies five required conditions before it may be accepted.

The product reads one JSON evaluation document, applies five explicit rules without probabilistic judgment, prints a human-readable result to the terminal, and emits a machine-readable JSON report.

## 2. Target users

Primary user: a technical founder, engineering lead, or release owner who delegates implementation work and needs objective evidence that a GitHub task was completed rather than merely claimed complete.

Secondary user: a CI workflow author who needs a small, scriptable acceptance gate with stable exit codes and JSON output.

The user is expected to understand Git commits, GitHub Actions checks, task identifiers, and test reports. No graphical interface is required.

## 3. Single workflow

The product supports exactly one workflow:

1. A caller supplies an evaluation JSON document from a local file or standard input.
2. The CLI validates the document shape.
3. The CLI evaluates the five deterministic rules in the fixed order defined below.
4. The CLI creates one JSON report containing the overall verdict and every rule result.
5. The CLI prints a concise terminal summary unless quiet mode is enabled.
6. The CLI optionally writes the JSON report to a file.
7. The process exits with a stable exit code.

v0.1.x is offline-only: the caller supplies a JSON evaluation document; the CLI evaluates it and emits a verdict. A network-enabled GitHub collector mode is planned for v0.2.0 (see §16).

## 4. Non-goals

The MVP does not:

- infer whether code quality is good;
- review source code or use an LLM;
- create, edit, assign, or close tasks;
- create commits, branches, pull requests, or workflow runs;
- repair failed CI or tests;
- support configurable policies or user-defined rules;
- provide a web UI, server, database, queue, or long-running daemon;
- replace GitHub branch protection;
- evaluate deployment health, security posture, coverage percentage, or revenue;
- accept ambiguous free-form text as evidence;
- treat missing evidence as success.

## 5. Runtime and implementation constraints

- Runtime: supported Node.js LTS.
- Module system: native ESM (`"type": "module"`).
- CLI entry point: `bin/github-actions-gate.js`.
- Evaluator: deterministic and side-effect free after input normalization.
- Output encoding: UTF-8 JSON.
- Network access: forbidden (v0.1.x is offline-only; GitHub collector is v0.2.0).
- Dependencies: prefer Node.js standard library. A dependency is allowed only when the platform cannot provide the required behavior directly.

## 6. JSON input contract

### 6.1 Canonical input

```json
{
  "schemaVersion": 1,
  "task": {
    "id": "TASK-123",
    "title": "Add deterministic release gate"
  },
  "change": {
    "commitSha": "0123456789abcdef0123456789abcdef01234567",
    "associatedTaskIds": ["TASK-123"]
  },
  "ci": {
    "checks": [
      {
        "name": "test",
        "status": "completed",
        "conclusion": "success"
      }
    ]
  },
  "testReport": {
    "format": "json",
    "path": "artifacts/test-report.json",
    "exists": true
  },
  "metadata": {
    "repository": "owner/repository",
    "pullRequest": 42
  }
}
```

### 6.2 Required fields

| JSON path | Type | Constraint |
| --- | --- | --- |
| `schemaVersion` | integer | Must equal `1`. |
| `task.id` | string | Non-empty after trimming. |
| `change.commitSha` | string | Exactly 40 hexadecimal characters. |
| `change.associatedTaskIds` | array of strings | May be empty; duplicate values are ignored for evaluation. |
| `ci.checks` | array of objects | Each item requires non-empty `name`, `status`, and `conclusion`. |
| `testReport.path` | string | Non-empty after trimming. |
| `testReport.exists` | boolean | Must be explicitly present. |

`task.title`, `testReport.format`, and `metadata` are optional and do not change the verdict.

Unknown fields are allowed and ignored. Invalid JSON or an invalid required field is an input error, not a failed gate evaluation.

## 7. Five deterministic rules

The evaluator always returns all five rule results. It must not stop after the first failure.

### Rule 1: `task-associated`

PASS when `task.id`, compared as an exact case-sensitive string, appears in `change.associatedTaskIds`.

FAIL otherwise, including when the array is empty.

No task association may be inferred from commit messages, branch names, pull-request text, titles, or partial string matches.

### Rule 2: `commit-exists`

PASS when `change.commitSha` is exactly 40 hexadecimal characters and is not the all-zero SHA `0000000000000000000000000000000000000000`.

FAIL when the SHA is all zero.

A malformed SHA is rejected earlier as an input error.

### Rule 3: `ci-passes`

PASS when `ci.checks` contains at least one item and every item has both:

- `status` exactly equal to `completed`; and
- `conclusion` exactly equal to `success`.

FAIL when the array is empty or any check is queued, in progress, cancelled, skipped, neutral, timed out, action-required, stale, failed, or uses any value other than the two exact PASS values above.

### Rule 4: `test-report-exists`

PASS when `testReport.exists` is exactly `true` and `testReport.path` is non-empty after trimming.

FAIL otherwise.

The evaluator does not infer report existence from passing CI. In v0.1.x the boolean is authoritative caller-provided evidence.

### Rule 5: `pr-merged`

PASS when `pr.state` is exactly equal to `merged`.

FAIL when `pr` is absent, `null`, or `pr.state` is any value other than `merged` (including `open`, `closed`, or any other string).

The evaluator does not infer merge status from CI success or commit messages. The `pr` field is authoritative caller-provided evidence; its absence is a gate failure, not an input error.

## 8. Overall verdict

`verdict` is `PASS` only when all five rules pass.

`verdict` is `FAIL` when one or more rules fail.

The CLI exits `0` for `PASS`, `1` for `FAIL`, and `2` for invalid usage, invalid JSON, schema violations, unavailable input, authentication failure, or GitHub API collection failure.

## 9. JSON output contract

```json
{
  "schemaVersion": 1,
  "verdict": "PASS",
  "taskId": "TASK-123",
  "commitSha": "0123456789abcdef0123456789abcdef01234567",
  "summary": {
    "passed": 4,
    "failed": 0,
    "total": 4
  },
  "rules": [
    {
      "id": "task-associated",
      "verdict": "PASS",
      "message": "Task TASK-123 is associated with the change."
    },
    {
      "id": "commit-exists",
      "verdict": "PASS",
      "message": "Commit 0123456789abcdef0123456789abcdef01234567 exists."
    },
    {
      "id": "ci-passes",
      "verdict": "PASS",
      "message": "All 1 CI checks completed successfully."
    },
    {
      "id": "test-report-exists",
      "verdict": "PASS",
      "message": "Test report exists at artifacts/test-report.json."
    }
  ]
}
```

Requirements:

- Rule order is always the order in section 7.
- `summary.total` is always `4`.
- `summary.passed + summary.failed` equals `4`.
- Output contains no timestamps, random identifiers, environment-specific absolute paths, or unstable API response fragments.
- Evaluating the same normalized input must produce byte-equivalent JSON when the same indentation option is used.

## 10. Failure report example

Given a change that is not associated with the task, has a pending CI check, and has no test report, the JSON report is:

```json
{
  "schemaVersion": 1,
  "verdict": "FAIL",
  "taskId": "TASK-123",
  "commitSha": "0123456789abcdef0123456789abcdef01234567",
  "summary": {
    "passed": 1,
    "failed": 3,
    "total": 4
  },
  "rules": [
    {
      "id": "task-associated",
      "verdict": "FAIL",
      "message": "Task TASK-123 is not associated with the change."
    },
    {
      "id": "commit-exists",
      "verdict": "PASS",
      "message": "Commit 0123456789abcdef0123456789abcdef01234567 exists."
    },
    {
      "id": "ci-passes",
      "verdict": "FAIL",
      "message": "CI check test is not successful: status=in_progress, conclusion=null."
    },
    {
      "id": "test-report-exists",
      "verdict": "FAIL",
      "message": "Test report does not exist at artifacts/test-report.json."
    }
  ]
}
```

Default terminal output for the same result:

```text
FAIL github-actions-gate: 1/4 rules passed
FAIL task-associated: Task TASK-123 is not associated with the change.
PASS commit-exists: Commit 0123456789abcdef0123456789abcdef01234567 exists.
FAIL ci-passes: CI check test is not successful: status=in_progress, conclusion=null.
FAIL test-report-exists: Test report does not exist at artifacts/test-report.json.
```

## 11. CLI contract

### 11.1 Commands

```text
github-actions-gate evaluate --input <path|-> [--output <path>] [--json] [--quiet]
github-actions-gate collect  --owner <o> --repo <r> --sha <40-hex> [--task <id>] [--report <name>] [--branch <name>] [--output <path>] [--json] [--quiet]
github-actions-gate --help
github-actions-gate --version
```

`evaluate` is the offline command (v0.1.x).
`collect` is the GitHub API collector (v0.2.0); see §16.

### 11.2 Options

- `--input <path>` reads UTF-8 JSON from a file.
- `--input -` reads UTF-8 JSON from standard input.
- `--output <path>` writes the machine-readable report, creating parent directories when necessary.
- `--json` writes the JSON report to standard output instead of the human summary.
- `--quiet` suppresses standard output; errors still use standard error.
- `--help` prints usage and exits `0`.
- `--version` prints the package version and exits `0`.

`--json` and `--quiet` are mutually exclusive. Unknown flags, missing values, duplicate singleton flags, and extra positional arguments exit `2`.

### 11.3 Standard streams

- Human summaries go to standard output.
- JSON requested with `--json` goes to standard output.
- Usage and operational errors go to standard error.
- When `--output` is supplied, the JSON file is written regardless of human or JSON terminal mode.
- A gate failure is not printed as an operational error and therefore does not use standard error.

### 11.4 Exit codes

| Code | Meaning |
| --- | --- |
| `0` | All five deterministic rules pass, or help/version completed. |
| `1` | Valid input evaluated; one or more gate rules failed. |
| `2` | Usage, input, schema, or filesystem error. |

## 12. v0.1.x scope boundary

v0.1.x implements offline `evaluate` only. The following are explicitly out of scope for v0.1.x and deferred to v0.2.0 (now fully specified in §16):

- the `collect` command and `--owner/--repo/--sha/--task/--report/--branch` flags;
- network access of any kind;
- `GITHUB_TOKEN` handling;
- GitHub API collection, pagination, or rate-limit handling;
- the `src/collector.mjs` module and `CollectorError` type.

## 16. v0.2.0 — GitHub collector mode

v0.2.0 adds a `collect` subcommand that fetches live evidence from the GitHub
REST API and feeds it — without reimplementation — into the same v0.1.x
evaluator used by `evaluate`. The offline contract in §6–§11 is unchanged.

### 16.1 CLI signature

```text
github-actions-gate collect --owner <o> --repo <r> --sha <40-hex>
                             [--task <id>] [--report <artifact-name>]
                             [--branch <name>] [--output <path>] [--json] [--quiet]
```

| Flag | Required | Type | Constraint |
| --- | --- | --- | --- |
| `--owner` | yes | string | Non-empty; GitHub org/user slug (URL-safe). |
| `--repo` | yes | string | Non-empty; GitHub repo slug. |
| `--sha` | yes | string | Exactly 40 hex chars, not all-zero. |
| `--task` | no | string | Task ID for `task-associated`. Omitted ⇒ no rule-1 PASS possible (array empty). |
| `--report` | no | string | Artifact name pattern (exact or glob). Omitted ⇒ `testReport.exists = false`. |
| `--branch` | no | string | Branch name, purely informational; written to `metadata.branch` if present. |
| `--output` | no | path | Same semantics as `evaluate --output`. |
| `--json` | no | flag | Same semantics as `evaluate --json`. |
| `--quiet` | no | flag | Same semantics as `evaluate --quiet`. |

`--json` and `--quiet` remain mutually exclusive. Unknown flags, missing
required flags, duplicate singletons, and extra positionals exit `2` —
identical to `evaluate`'s usage contract.

### 16.2 Authentication

1. The token is read **only** from the `GITHUB_TOKEN` environment variable.
2. The token is sent **only** to `https://api.github.com` via the
   `Authorization: Bearer <token>` header.
3. A missing or empty `GITHUB_TOKEN` is a usage error (exit `2`), not a gate
   failure. No prompt, no interactive entry.
4. The token is never echoed, logged, written to `--output`, printed in error
   messages, or persisted to disk. `CollectorError` messages must redact the
   token even in debug output.

### 16.3 Collector module contract

`src/collector.mjs` exports exactly three functions. No other module in the
project may import Node's `https`/`fetch` except `collector.mjs`.

```js
// Fetch a single REST page. Throws CollectorError on non-2xx.
// Never returns partial data — a page is either complete or throws.
export async function fetchPage(path, token, { page = 1, perPage = 100 } = {})
  // → { status: 200, headers: Headers, body: any }

// Drive full pagination to completion across the named endpoint.
// Throws CollectorError if any page fetch fails or if the server signals
// an incomplete traverse (e.g. a page returns fewer than perPage items
// but also includes a `next` Link that is unreachable).
export async function collectAll(path, token, { perPage = 100 } = {})
  // → any[]   // concatenated items, stable order

// Build a canonical §6 evaluation document from GitHub API data.
// Does NOT evaluate — returns the raw object shaped per §6.1.
// Throws CollectorError on any ambiguous/missing evidence.
export function buildEvaluationDocument(owner, repo, sha, {
  taskId   = null,
  report   = null,
  branch   = null,
} = {}, api = { fetchPage, collectAll, token })
  // → { schemaVersion:1, task, change, ci, testReport, metadata }
```

`buildEvaluationDocument` must call `validateInput` (from `evaluator.mjs`)
on its own output before returning. A validation failure there is a
`CollectorError` (ambiguous evidence), not an `InputError`.

### 16.4 API endpoints and mapping

| Canonical field (§6.1) | GitHub API call | Mapping rule |
| --- | --- | --- |
| `change.commitSha` | `GET /repos/{owner}/{repo}/commits/{sha}` | Echo the SHA; a 404 here throws `CollectorError("commit not found")`. The commit existing is the sole source of truth — no heuristics from branch or PR. |
| `ci.checks[].name` | `GET /repos/{owner}/{repo}/commits/{sha}/check-runs` (paginated via `collectAll`) | `check_runs[].name`. |
| `ci.checks[].status` | same | `check_runs[].status` verbatim (`queued`, `in_progress`, `completed`, …). |
| `ci.checks[].conclusion` | same | `check_runs[].conclusion` verbatim (`success`, `failure`, `neutral`, `cancelled`, `skipped`, `timed_out`, `action_required`, `stale`, `null`). A literal JSON `null` becomes string `"null"` to satisfy §6.2's non-empty-string constraint; the evaluator's rule 3 then FAILs on it (not an input error). |
| `change.associatedTaskIds` | derived | If `--task` is provided: `[taskId]`. If omitted: `[]`. **No** inference from commit messages, branch names, PR titles, or partial matches. This is the only supported linkage mechanism in v0.2.0. |
| `task.id` | from `--task` | Echo verbatim. If `--task` omitted, `task.id` is `""` — which `validateInput` rejects as non-empty, so the collector must set `task.id` to the literal `"<none>"` and `associatedTaskIds` to `[]`, letting the evaluator FAIL rule 1 deterministically rather than short-circuiting. |
| `testReport.exists` | `GET /repos/{owner}/{repo}/actions/artifacts?name={report}` (paginated) | `true` only if ≥1 artifact whose `name` matches `--report` (exact or glob via minimatch-style) has `expired === false`. Otherwise `false`. If `--report` omitted → `false`. The actual artifact **content** is never downloaded — §6 treats `exists` as authoritative boolean evidence, and v0.1.x/v0.2.0 do not parse report internals. |
| `testReport.path` | from `--report` or fixed default | If `--report` provided: `"artifacts/" + matchedArtifact.archive_download_url` basename. If omitted: `"artifacts/"` (non-empty placeholder so §6.2 passes; `exists=false` still FAILs rule 4). |
| `metadata.repository` | from `--owner`/`--repo` | `"{owner}/{repo}"`. |
| `metadata.branch` | from `--branch` | Echoed if provided; omitted otherwise. `metadata.pullRequest` is **not** populated in v0.2.0 (no PR API call is made). |

### 16.5 Pagination and rate limiting

1. `collectAll` follows `Link: rel="next"` headers only. No out-of-band
   cursor guessing.
2. On HTTP 403 with `X-RateLimit-Remaining: 0`: throw
   `CollectorError("rate limited; retry at {reset}", { retryAt })`. Exit 2.
3. On HTTP 403/401 without rate-limit header: throw
   `CollectorError("authentication failed")`. Exit 2.
4. On any HTTP 5xx: throw `CollectorError("server error: {status}")`. Exit 2.
5. On HTTP 404 for the commit SHA endpoint specifically: throw
   `CollectorError("commit {sha} not found in {owner}/{repo}")`. Exit 2.
6. On HTTP 404 for a non-commit endpoint (e.g. check-runs): return `[]`
   (empty array) and let the evaluator FAIL the gate normally — a missing
   CI check page is evidence of CI failure, not a collection error.
7. `collectAll` must not retry silently. One request per page, throw on
   failure. The caller (CLI layer) is responsible for any retry policy, and
   v0.2.0 does NOT implement retry — it fails fast and exits 2.

### 16.6 Error model and exit codes

`CollectorError` extends `Error` with `{ kind, status, retryAt }`. The CLI
catches `CollectorError` and exits `2` with a message on stderr that
**never** includes the token. Specific kinds:

| `kind` | HTTP status | Exit | stderr message template |
| --- | --- | --- | --- |
| `AUTH_MISSING` | — | 2 | `GITHUB_TOKEN is not set` |
| `AUTH_FAILED` | 401/403 (non-rate-limit) | 2 | `authentication failed` |
| `RATE_LIMITED` | 403 + `X-RateLimit-Remaining: 0` | 2 | `rate limited; retry at {retryAt}` |
| `COMMIT_NOT_FOUND` | 404 on commit endpoint | 2 | `commit {sha} not found in {owner}/{repo}` |
| `SERVER_ERROR` | 5xx | 2 | `GitHub API server error: {status}` |
| `PAGINATION_INCOMPLETE` | any | 2 | `pagination incomplete at {endpoint}` |
| `AMBIGUOUS_EVIDENCE` | — | 2 | `ambiguous evidence: {detail}` |

Gate verdict exit codes are unchanged from §11.4:
`collect` exits `0` on PASS, `1` on rule failure, `2` on any collector or
usage error. A collector error **never** produces exit 0 or 1.

### 16.7 Streaming and determinism

1. `collect` calls `buildEvaluationDocument` (sync build + validate) then
   `evaluate` — the same function `evaluate` uses. No separate evaluator.
2. `--json` and `--output` output the exact §9 JSON schema. The source
   (`collect` vs `evaluate`) is not recorded in the report; the report is
   identical whether the input doc came from a file or from the API.
3. Network fetches are the only non-deterministic part. The **evaluation**
   is deterministic given the collected document. `collect` does not cache
   or memoize across invocations.

### 16.8 Offline-acceptance guarantee

`npm test` must continue to pass with zero network access and no
`GITHUB_TOKEN`. All collector logic is unit-testable via dependency injection:
`buildEvaluationDocument` accepts an `api` object (§16.3) so tests inject
stub `fetchPage`/`collectAll` without touching the real GitHub API. A smoke
test with a live token is permitted as an opt-in `npm run test:collect`
script but must be skipped automatically when `GITHUB_TOKEN` is absent.

Offline acceptance must not require a GitHub token or network connection.

## 13. Acceptance checklist

### Product specification

- [ ] `PRODUCT_SPEC.md` exists and is non-empty.
- [ ] The specification defines one target user, one workflow, and explicit non-goals.
- [ ] The specification defines canonical JSON input and output.
- [ ] Exactly five deterministic rules are defined.
- [ ] A complete failure report example is included.
- [ ] CLI commands, options, streams, and exit codes are defined.

### Implementation

- [ ] `package.json` declares `"type": "module"`.
- [ ] The executable CLI is implemented in Node.js ESM.
- [ ] Offline evaluation uses no network access.
- [ ] The evaluator reports every rule even when earlier rules fail.
- [ ] The same normalized input produces deterministic output.
- [ ] Missing evidence fails closed.
- [ ] Invalid input exits `2` and never produces `PASS`.

### Rule tests

- [ ] `task-associated` passes on an exact task ID match.
- [ ] `task-associated` fails on absent, partial, or case-different matches.
- [ ] `commit-exists` passes on a non-zero 40-character hexadecimal SHA.
- [ ] `commit-exists` fails on the all-zero SHA.
- [ ] A malformed SHA is rejected as an input error.
- [ ] `ci-passes` passes only when at least one check exists and all checks are completed successfully.
- [ ] `ci-passes` fails on empty, pending, skipped, cancelled, neutral, or failed checks.
- [ ] `test-report-exists` passes only when `exists` is `true` and `path` is non-empty.
- [ ] `test-report-exists` fails when evidence is absent or false.
- [ ] Overall verdict passes only when all five rules pass.

### CLI tests

- [ ] `--input <fixture>` evaluates a local file.
- [ ] `--input -` evaluates standard input.
- [ ] `--json` emits valid JSON only.
- [ ] `--output` creates a report file containing the documented schema.
- [ ] PASS exits `0`.
- [ ] Rule failure exits `1`.
- [ ] Invalid JSON, schema, or CLI usage exits `2`.
- [ ] `--help` and `--version` exit `0`.
- [ ] Unknown and conflicting flags exit `2`.

### Demonstration and packaging

- [ ] `npm test` passes from a clean checkout.
- [ ] `npm run example:offline` runs without credentials or network access and demonstrates both PASS and FAIL fixtures.
- [ ] Example output matches the documented rule order and exit codes.
- [ ] A Dockerfile runs the same CLI without changing its contract.
- [ ] A GitHub Actions example invokes the CLI and preserves exit code `1` as a failed gate.
- [ ] README usage agrees with this specification.
- [ ] No secret, generated report, dependency directory, or local credential is committed.

## 14. Definition of done

The MVP is done only when the repository contains this specification, a minimal Node.js ESM implementation, fixtures, automated tests for every rule and exit code, an offline example, Docker packaging, and a GitHub Actions usage example; all documented verification commands pass from a clean checkout.
