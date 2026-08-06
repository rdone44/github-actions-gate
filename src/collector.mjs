// src/collector.mjs
// SPEC §16 — GitHub collector mode.
// This is the ONLY module allowed to import fetch. It fetches evidence
// from the GitHub REST API and builds a canonical §6 evaluation document,
// then hands it to the same evaluator used by `evaluate`.
//
// Exports exactly three functions (SPEC §16.3):
//   - fetchPage(path, token, { page, perPage })
//   - collectAll(path, token, { perPage })
//   - buildEvaluationDocument(owner, repo, sha, { taskId, report, branch }, api)
//
// CollectorError extends Error with { kind, status, retryAt }.

import { validateInput } from "./evaluator.mjs";

export class CollectorError extends Error {
  constructor(message, { kind = "AMBIGUOUS_EVIDENCE", status = null, retryAt = null } = {}) {
    super(message);
    this.name = "CollectorError";
    this.kind = kind;
    this.status = status;
    this.retryAt = retryAt;
  }
}

const HEX40 = /^[0-9a-f]{40}$/;
const ALL_ZERO_SHA = "0".repeat(40);
const PER_PAGE_DEFAULT = 100;
const GITHUB_API = "https://api.github.com";
const ACCEPT = "application/vnd.github+json";

// Apply minimatch-style glob to artifact name match.
// v0.2.0 supports plain exact-match and simple glob patterns.
function globMatch(pattern, name) {
  // Escape regex special chars except * and ?, then convert those to regex.
  const re = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".") +
      "$"
  );
  return re.test(name);
}

// --- fetchPage -----------------------------------------------------------
// SPEC §16.3, §16.5 — fetch one REST page. Throws CollectorError on non-2xx.
async function fetchPage(path, token, { page = 1, perPage = PER_PAGE_DEFAULT } = {}) {
  const url = new URL(`${GITHUB_API}${path}`);
  if (!url.searchParams.has("page")) url.searchParams.set("page", String(page));
  if (!url.searchParams.has("per_page")) url.searchParams.set("per_page", String(perPage));

  let res;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: ACCEPT,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } catch (e) {
    throw new CollectorError(`network error: ${e.message}`, { kind: "SERVER_ERROR" });
  }

  const status = res.status;

  // 2xx — parse body.
  if (status >= 200 && status < 300) {
    let body;
    try {
      body = await res.json();
    } catch (e) {
      throw new CollectorError(`invalid JSON response from ${path}`, { kind: "AMBIGUOUS_EVIDENCE" });
    }
    return { status, headers: res.headers, body };
  }

  // 403 — rate limit or auth failure.
  if (status === 403) {
    throw classifyHttpError(status, res.headers, path);
  }

  // 404 — let the caller decide: commit endpoint throws COMMIT_NOT_FOUND,
  // check-runs/artifacts endpoint returns [] (empty evidence).
  if (status === 404) {
    return { status, headers: res.headers, body: null };
  }

  // 5xx — server error.
  if (status >= 500) {
    throw classifyHttpError(status, res.headers, path);
  }

  // Any other unexpected status.
  throw new CollectorError(`unexpected status ${status} from ${path}`, { kind: "AMBIGUOUS_EVIDENCE", status });
}

// --- classifyHttpError -----------------------------------------------------
// Shared error classification for non-2xx, non-404 responses. Used by
// fetchPage and by buildEvaluationDocument when the injected stub returns a
// raw status without going through fetchPage's own handling (test scenario).
// `headers` accepts a Headers object or a plain object/Map.
export function classifyHttpError(status, headers, path = "") {
  const get = (key) => {
    if (!headers) return null;
    if (typeof headers.get === "function") return headers.get(key);
    if (headers instanceof Map) return headers.get(key);
    return headers[key];
  };
  if (status === 403) {
    const remaining = get("x-ratelimit-remaining");
    if (remaining === "0") {
      const resetEpoch = get("x-ratelimit-reset");
      const retryAt = resetEpoch ? new Date(Number(resetEpoch) * 1000).toISOString() : null;
      throw new CollectorError(`rate limited; retry at ${retryAt}`, { kind: "RATE_LIMITED", status, retryAt });
    }
    throw new CollectorError(`authentication failed${path ? ` (${path})` : ""}`, { kind: "AUTH_FAILED", status });
  }
  if (status === 401) {
    throw new CollectorError(`authentication failed${path ? ` (${path})` : ""}`, { kind: "AUTH_FAILED", status });
  }
  if (status >= 500) {
    throw new CollectorError(`server error: ${status}${path ? ` (${path})` : ""}`, { kind: "SERVER_ERROR", status });
  }
  throw new CollectorError(`unexpected status ${status} from ${path}`, { kind: "AMBIGUOUS_EVIDENCE", status });
}

// --- collectAll -----------------------------------------------------------
// SPEC §16.5.1 — follow Link: rel="next" to completion. One request per page.
// SPEC §16.5.7 — no silent retry.
export async function collectAll(path, token, { perPage = PER_PAGE_DEFAULT } = {}) {
  const items = [];
  let page = 1;
  let nextUrl = null;

  // First page: fetch from `path` directly.
  const first = await fetchPage(path, token, { page: 1, perPage });
  // If first page is a 404 with null body, treat as empty evidence.
  if (first.body === null) return items;

  // Body may be an array (list endpoint) or an object containing an array.
  const extractItems = (body) => {
    if (Array.isArray(body)) return body;
    if (body && Array.isArray(body.check_runs)) return body.check_runs;
    if (body && Array.isArray(body.artifacts)) return body.artifacts;
    if (body && Array.isArray(body.workflow_runs)) return body.workflow_runs;
    return [];
  };

  items.push(...extractItems(first.body));

  // Parse Link header for next page.
  const linkHeader = first.headers.get("link") || "";
  nextUrl = parseNextLink(linkHeader);

  while (nextUrl) {
    // Reuse the path component relative to API base for consistency.
    const relPath = nextUrl.pathname + nextUrl.search;
    const pageRes = await fetchPage(relPath, token, { page: page + 1, perPage });
    if (pageRes.body === null) break; // 404 → no more evidence.
    items.push(...extractItems(pageRes.body));

    const lh = pageRes.headers.get("link") || "";
    const next = parseNextLink(lh);
    if (!next) break;
    nextUrl = next;
    page += 1;
  }

  return items;
}

// Parse `Link: <https://api.github.com/...?page=2>; rel="next"` header.
function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  const links = linkHeader.split(",").map((s) => s.trim());
  for (const l of links) {
    const m = l.match(/^<([^>]+)>;\s*rel="next"/);
    if (m) {
      try {
        return new URL(m[1]);
      } catch {
        return null;
      }
    }
  }
  return null;
}

// --- buildEvaluationDocument -----------------------------------------------
// SPEC §16.4 — build a canonical §6 evaluation document from GitHub API data.
// Pure after the injected `api` calls are resolved. Calls validateInput on its
// own output before returning; a validation failure becomes CollectorError.
export async function buildEvaluationDocument(
  owner,
  repo,
  sha,
  { taskId = null, report = null, branch = null, prNumber = null } = {},
  api = { fetchPage, collectAll, token: process.env.GITHUB_TOKEN || "" }
) {
  // Validate SHA format early (mirrors evaluator's HEX40).
  if (!HEX40.test(sha) || sha === ALL_ZERO_SHA) {
    throw new CollectorError(`invalid sha: ${sha}`, { kind: "AMBIGUOUS_EVIDENCE" });
  }

  const { fetchPage: fp, collectAll: ca, token } = api;
  if (!token) {
    throw new CollectorError("GITHUB_TOKEN is not set", { kind: "AUTH_MISSING" });
  }

  // 1. Verify commit exists: GET /repos/{owner}/{repo}/commits/{sha}
  // A 404 here → COMMIT_NOT_FOUND (SPEC §16.5.5).
  const commitPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${sha}`;
  const commitRes = await fp(commitPath, token);
  if (commitRes.status === 404) {
    throw new CollectorError(`commit ${sha} not found in ${owner}/${repo}`, {
      kind: "COMMIT_NOT_FOUND",
      status: 404,
    });
  }
  if (commitRes.status >= 400) {
    const headers = commitRes.headers;
    throw classifyHttpError(commitRes.status, headers, `commit ${sha}`);
  }
  if (commitRes.body === null) {
    throw new CollectorError(`commit ${sha} not found in ${owner}/${repo}`, {
      kind: "COMMIT_NOT_FOUND",
      status: 404,
    });
  }

  // 2. Fetch check-runs: paginated.
  const checkRunsPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${sha}/check-runs`;
  const checkRuns = await ca(checkRunsPath, token);

  const checks = checkRuns.map((cr) => ({
    name: cr.name,
    status: cr.status,
    conclusion: cr.conclusion === null || cr.conclusion === undefined ? "null" : String(cr.conclusion),
  }));

  // 3. Fetch artifacts if --report is provided, decide testReport.exists.
  let testReportExists = false;
  let testReportPath = "artifacts/";

  if (report) {
    const artifactsPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/artifacts`;
    const artifacts = await ca(artifactsPath, token);
    for (const a of artifacts) {
      if (a.expired === false && globMatch(report, a.name)) {
        testReportExists = true;
        const basename = String(a.archive_download_url || "").split("/").pop() || a.name;
        testReportPath = `artifacts/${basename}`;
        break;
      }
    }
  }

  // 4. Fetch PR state.
  //    If --pr is provided, use that number directly.
  //    If --pr is NOT provided, auto-backfill: call
  //      GET /repos/{owner}/{repo}/commits/{sha}/pulls
  //    to discover PRs associated with this commit, take the first non-empty
  //    result's .number, then fetch PR state via the existing pulls/{number}
  //    endpoint. If the commits/{sha}/pulls endpoint returns an empty array,
  //    prState stays null (no error — evaluator FAILs pr-merged by design).
  let prState = null;
  let effectivePrNumber = prNumber;

  if (!effectivePrNumber) {
    // Auto-backfill: query commits/{sha}/pulls for associated PRs.
    const pullsForCommitPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${sha}/pulls`;
    const pullsForCommitRes = await fp(pullsForCommitPath, token);
    if (pullsForCommitRes.status === 404) {
      // No associated PRs endpoint — leave prState null.
    } else if (pullsForCommitRes.status >= 400) {
      throw classifyHttpError(pullsForCommitRes.status, pullsForCommitRes.headers, pullsForCommitPath);
    } else if (Array.isArray(pullsForCommitRes.body) && pullsForCommitRes.body.length > 0) {
      effectivePrNumber = pullsForCommitRes.body[0].number;
    }
    // Empty array or null body → effectivePrNumber stays null → prState stays null.
  }

  if (effectivePrNumber) {
    const prPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${effectivePrNumber}`;
    const prRes = await fp(prPath, token);
    if (prRes.status === 404) {
      throw new CollectorError(`PR #${effectivePrNumber} not found in ${owner}/${repo}`, {
        kind: "AMBIGUOUS_EVIDENCE",
        status: 404,
      });
    }
    if (prRes.status >= 400) {
      throw classifyHttpError(prRes.status, prRes.headers, `PR #${effectivePrNumber}`);
    }
    if (prRes.body && typeof prRes.body === "object") {
      // GitHub "pulls" API uses "state" = open|closed; "merged" is a boolean.
      // Map: merged=true → "merged"; else state (open|closed).
      prState = prRes.body.merged_at ? "merged" : prRes.body.state;
    }
  }

  // 5. Build task.id and associatedTaskIds.
  // SPEC §16.4: if --task omitted, task.id = "<none>" (non-empty so validateInput
  // passes), associatedTaskIds = [] → evaluator FAILs rule 1 deterministically.
  const taskIdValue = taskId || "<none>";
  const associatedTaskIds = taskId ? [taskId] : [];

  // 5. Assemble canonical document per §6.1.
  const doc = {
    schemaVersion: 1,
    task: {
      id: taskIdValue,
    },
    change: {
      commitSha: sha,
      associatedTaskIds,
    },
    ci: {
      checks,
    },
    testReport: {
      path: testReportPath,
      exists: testReportExists,
    },
    ...(prState !== null ? { pr: { state: prState } } : {}),
    metadata: {
      repository: `${owner}/${repo}`,
    },
  };

  if (branch) {
    doc.metadata.branch = branch;
  }

  // 6. Validate own output — a validation failure is a CollectorError (SPEC §16.3).
  try {
    validateInput(doc);
  } catch (e) {
    throw new CollectorError(`ambiguous evidence: ${e.message}`, { kind: "AMBIGUOUS_EVIDENCE" });
  }

  return doc;
}

export { fetchPage };
