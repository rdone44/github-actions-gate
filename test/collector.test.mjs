import { test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";

import {
  buildEvaluationDocument,
  CollectorError,
  collectAll,
} from "../src/collector.mjs";
import { evaluate } from "../src/evaluator.mjs";

const BIN_PATH = fileURLToPath(new URL("../bin/gate.mjs", import.meta.url));

const runGate = (args, env = {}) => {
  try {
    const stdout = execFileSync(process.execPath, [BIN_PATH, ...args], {
      encoding: "utf8",
      maxBuffer: 1 << 20,
      env: { ...process.env, ...env },
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (e) {
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.status ?? -1 };
  }
};

const VALID_SHA = "0123456789abcdef0123456789abcdef01234567";

// ---------- §16.3 — buildEvaluationDocument with injected stubs ----------

function makeApi({ commitBody = {}, checkRuns = [], artifacts = [], prBody = null, prStatus = 200, commitsPulls = null, token = "tok" } = {}) {
  const calls = [];
  const fetchPage = async (path) => {
    calls.push({ fetchPage: path });
    if (path === `/repos/owner/repo/commits/${VALID_SHA}`) {
      if (commitBody === null) return { status: 404, headers: new Map(), body: null };
      return { status: 200, headers: new Map(), body: commitBody };
    }
    if (path === `/repos/owner/repo/commits/${VALID_SHA}/check-runs`) {
      if (checkRuns === null) return { status: 404, headers: new Map(), body: null };
      return {
        status: 200,
        headers: new Map([["link", ""]]),
        body: { check_runs: checkRuns, total: checkRuns.length },
      };
    }
    if (path === `/repos/owner/repo/commits/${VALID_SHA}/pulls`) {
      if (commitsPulls === null) return { status: 404, headers: new Map(), body: null };
      return { status: 200, headers: new Map(), body: commitsPulls };
    }
    if (path === `/repos/owner/repo/actions/artifacts`) {
      if (artifacts === null) return { status: 404, headers: new Map(), body: null };
      return {
        status: 200,
        headers: new Map([["link", ""]]),
        body: { artifacts, total_count: artifacts.length },
      };
    }
    // PR fetch: GET /repos/{owner}/{repo}/pulls/{pr_number}
    if (path.startsWith("/repos/owner/repo/pulls/")) {
      if (prBody === null) return { status: 404, headers: new Map(), body: null };
      return { status: prStatus, headers: new Map(), body: prBody };
    }
    return { status: 404, headers: new Map(), body: null };
  };
  const collectAll = async (path) => {
    calls.push({ collectAll: path });
    const page = await fetchPage(path);
    if (page.body === null) return [];
    if (path === `/repos/owner/repo/commits/${VALID_SHA}/check-runs`) return page.body.check_runs ?? [];
    if (path === `/repos/owner/repo/actions/artifacts`) return page.body.artifacts ?? [];
    return [];
  };
  return { fetchPage, collectAll, token, calls };
}

test("§16 collect: full PASS pipeline via stubs", async () => {
  const api = makeApi({
    commitBody: { sha: VALID_SHA },
    checkRuns: [{ name: "test", status: "completed", conclusion: "success" }],
    artifacts: [{ name: "test-report", expired: false, archive_download_url: "https://x/y/test-report.zip" }],
    prBody: { state: "closed", merged_at: "2026-01-01T00:00:00Z" },
  });
  const doc = await buildEvaluationDocument("owner", "repo", VALID_SHA, {
    taskId: "TASK-1",
    report: "test-report",
    branch: "main",
    prNumber: 42,
  }, api);

  expect(doc.schemaVersion).toBe(1);
  expect(doc.task.id).toBe("TASK-1");
  expect(doc.change.commitSha).toBe(VALID_SHA);
  expect(doc.change.associatedTaskIds).toEqual(["TASK-1"]);
  expect(doc.ci.checks.length).toBe(1);
  expect(doc.ci.checks[0].name).toBe("test");
  expect(doc.testReport.exists).toBe(true);
  expect(doc.pr.state).toBe("merged");
  expect(doc.metadata.repository).toBe("owner/repo");
  expect(doc.metadata.branch).toBe("main");

  // Evaluator should PASS on this doc.
  const r = evaluate(doc);
  expect(r.verdict).toBe("PASS");
});

test("§16 collect: missing --task → task.id='<none>', rule 1 FAILs", async () => {
  const api = makeApi({
    commitBody: { sha: VALID_SHA },
    checkRuns: [{ name: "test", status: "completed", conclusion: "success" }],
    artifacts: [{ name: "test-report", expired: false, archive_download_url: "https://x/y/test-report.zip" }],
  });
  const doc = await buildEvaluationDocument("owner", "repo", VALID_SHA, {
    report: "test-report",
  }, api);

  expect(doc.task.id).toBe("<none>");
  expect(doc.change.associatedTaskIds).toEqual([]);
  const r = evaluate(doc);
  const rule = r.rules.find((x) => x.id === "task-associated");
  expect(rule.verdict).toBe("FAIL");
});

test("§16 collect: null conclusion → string 'null' → rule 3 FAILs (not input err)", async () => {
  const api = makeApi({
    commitBody: { sha: VALID_SHA },
    checkRuns: [{ name: "test", status: "completed", conclusion: null }],
  });
  const doc = await buildEvaluationDocument("owner", "repo", VALID_SHA, { taskId: "T1" }, api);
  expect(doc.ci.checks[0].conclusion).toBe("null");
  const r = evaluate(doc);
  const rule = r.rules.find((x) => x.id === "ci-passes");
  expect(rule.verdict).toBe("FAIL");
});

test("§16 collect: no --report → testReport.exists=false", async () => {
  const api = makeApi({
    commitBody: { sha: VALID_SHA },
    checkRuns: [{ name: "test", status: "completed", conclusion: "success" }],
    artifacts: [{ name: "other", expired: false }],
  });
  const doc = await buildEvaluationDocument("owner", "repo", VALID_SHA, { taskId: "T1" }, api);
  expect(doc.testReport.exists).toBe(false);
  expect(doc.testReport.path).toBe("artifacts/");
});

test("§16 collect: glob pattern matches artifact name", async () => {
  const api = makeApi({
    commitBody: { sha: VALID_SHA },
    checkRuns: [{ name: "test", status: "completed", conclusion: "success" }],
    artifacts: [{ name: "test-report-2024.zip", expired: false, archive_download_url: "https://x/y/test-report-2024.zip" }],
  });
  const doc = await buildEvaluationDocument("owner", "repo", VALID_SHA, {
    taskId: "T1",
    report: "test-report-*",
  }, api);
  expect(doc.testReport.exists).toBe(true);
  expect(doc.testReport.path).toBe("artifacts/test-report-2024.zip");
});

test("§16 collect: commit 404 → CollectorError COMMIT_NOT_FOUND", async () => {
  const api = makeApi({ commitBody: null });
  await expect(() => buildEvaluationDocument("owner", "repo", VALID_SHA, {}, api)).rejects.toMatchObject({ kind: "COMMIT_NOT_FOUND" });
});

test("§16 collect: no GITHUB_TOKEN → CollectorError AUTH_MISSING", async () => {
  const api = makeApi({ token: "" });
  await expect(() => buildEvaluationDocument("owner", "repo", VALID_SHA, {}, api)).rejects.toMatchObject({ kind: "AUTH_MISSING" });
});

test("§16 collect: invalid sha → CollectorError AMBIGUOUS_EVIDENCE", async () => {
  const api = makeApi();
  await expect(() => buildEvaluationDocument("owner", "repo", "short", {}, api)).rejects.toMatchObject({ kind: "AMBIGUOUS_EVIDENCE" });
});

test("§16 collect: 401 → CollectorError AUTH_FAILED", async () => {
  const api = makeApi();
  api.fetchPage = async () => ({ status: 401, headers: new Map(), body: null });
  await expect(() => buildEvaluationDocument("owner", "repo", VALID_SHA, {}, api)).rejects.toMatchObject({ kind: "AUTH_FAILED" });
});

test("§16 collect: 403 + X-RateLimit-Remaining:0 → RATE_LIMITED", async () => {
  const api = makeApi();
  const headers = new Map([["x-ratelimit-remaining", "0"], ["x-ratelimit-reset", "1700000000"]]);
  api.fetchPage = async () => ({ status: 403, headers, body: null });
  await expect(() => buildEvaluationDocument("owner", "repo", VALID_SHA, {}, api)).rejects.toMatchObject({ kind: "RATE_LIMITED", retryAt: expect.anything() });
});

test("§16 collect: 5xx → CollectorError SERVER_ERROR", async () => {
  const api = makeApi();
  api.fetchPage = async () => ({ status: 503, headers: new Map(), body: null });
  await expect(() => buildEvaluationDocument("owner", "repo", VALID_SHA, {}, api)).rejects.toMatchObject({ kind: "SERVER_ERROR", status: 503 });
});

test("§16 collect: 404 on check-runs → empty array (not error)", async () => {
  const api = makeApi({
    commitBody: { sha: VALID_SHA },
    checkRuns: null,
  });
  const doc = await buildEvaluationDocument("owner", "repo", VALID_SHA, { taskId: "T1" }, api);
  expect(doc.ci.checks.length).toBe(0);
  const r = evaluate(doc);
  expect(r.rules.find((x) => x.id === "ci-passes").verdict).toBe("FAIL");
});

// ---------- §16.8 — CLI collect usage errors ----------

test("CLI: collect without GITHUB_TOKEN exits 2", () => {
  const { exitCode, stderr } = runGate(
    ["collect", "--owner", "o", "--repo", "r", "--sha", VALID_SHA],
    { GITHUB_TOKEN: "" }
  );
  expect(exitCode).toBe(2);
  expect(stderr).toMatch(/GITHUB_TOKEN is not set/);
});

test("CLI: collect missing --owner exits 2", () => {
  const { exitCode } = runGate(
    ["collect", "--repo", "r", "--sha", VALID_SHA],
    { GITHUB_TOKEN: "x" }
  );
  expect(exitCode).toBe(2);
});

test("CLI: collect missing --repo exits 2", () => {
  const { exitCode } = runGate(
    ["collect", "--owner", "o", "--sha", VALID_SHA],
    { GITHUB_TOKEN: "x" }
  );
  expect(exitCode).toBe(2);
});

test("CLI: collect missing --sha exits 2", () => {
  const { exitCode } = runGate(
    ["collect", "--owner", "o", "--repo", "r"],
    { GITHUB_TOKEN: "x" }
  );
  expect(exitCode).toBe(2);
});

test("CLI: --help now mentions collect command", () => {
  const { stdout, exitCode } = runGate(["--help"]);
  expect(exitCode).toBe(0);
  expect(stdout).toMatch(/collect/);
  expect(stdout).toMatch(/--owner/);
  expect(stdout).toMatch(/--sha/);
});

test("CLI: missing both evaluate and collect command exits 2", () => {
  const file = new URL("../fixtures/pass.json", import.meta.url).pathname;
  const { exitCode } = runGate(["--input", file]);
  expect(exitCode).toBe(2);
});

// ---------- §16.10 — CLI collect end-to-end integration with stubbed fetch ----------
//
// These tests spawn the real `node bin/gate.mjs collect ...` subprocess and inject
// a stubbed globalThis.fetch via Node's --import flag pointing at a temporary preload
// script. The preload intercepts requests to api.github.com (the collector uses the
// global fetch, see src/collector.mjs) and returns fabricated commit / check-runs /
// artifacts JSON, so the full collect->evaluate pipeline runs end-to-end without
// touching the network. GATE_STUB_VERDICT selects whether the stub returns all-pass or
// a failing CI check, so the only variable between the two tests is CI evidence.

const FETCH_STUB_PRELOAD = [
  "globalThis.fetch = async (input, init) => {",
  '  const u = typeof input === "string" ? new URL(input) : input;',
  "  const path = u.pathname;",
  "  const [owner, repo] = [process.env.GATE_OWNER, process.env.GATE_REPO];",
  "  const sha = process.env.GATE_SHA;",
  '  const verdict = process.env.GATE_STUB_VERDICT || "PASS";',
  "  let body;",
  "  // GET /repos/{owner}/{repo}/commits/{sha} - commit existence proof.",
  '  if (path === `/repos/${owner}/${repo}/commits/${sha}`) {',
  "    body = { sha };",
  "  // GET /repos/{owner}/{repo}/commits/{sha}/check-runs - CI evidence.",
  '  } else if (path === `/repos/${owner}/${repo}/commits/${sha}/check-runs`) {',
  '    const checks = verdict === "PASS"',
  '      ? [{ name: "ci/test", status: "completed", conclusion: "success" }]',
  '      : [',
  '          { name: "ci/test", status: "completed", conclusion: "success" },',
  '          { name: "ci/build", status: "completed", conclusion: "failure" },',
  "        ];",
  "    body = { check_runs: checks, total: checks.length };",
  "  // GET /repos/{owner}/{repo}/actions/artifacts - test report existence.",
  '  } else if (path === `/repos/${owner}/${repo}/actions/artifacts`) {',
  "    body = {",
  '      artifacts: [{ name: process.env.GATE_REPORT, expired: false,',
  '        archive_download_url: "https://x/y/" + process.env.GATE_REPORT + ".zip" }],',
  "      total_count: 1,",
  "    };",
  "  // GET /repos/{owner}/{repo}/pulls/{n} - PR merged state.",
  '  } else if (path.startsWith(`/repos/${owner}/${repo}/pulls/`)) {',
  '    body = { state: "closed", merged_at: "2026-01-01T00:00:00Z" };',
  "  } else {",
  "    body = [];",
  "  }",
  "  return {",
  "    status: 200,",
  '    headers: { get: (k) => (k === "link" ? "" : null) },',
  "    async json() { return body; },",
  "  };",
  "};",
  "",
].join("\n");

function runCollectWithStubbedFetch({ verdict, sha }) {
  // Write the preload shim to a temp dir and spawn the CLI with --import.
  const tmpDir = mkdtempSync(pathJoin(tmpdir(), "gate-stub-"));
  const preloadPath = pathJoin(tmpDir, "fetch-stub.mjs");
  writeFileSync(preloadPath, FETCH_STUB_PRELOAD, "utf8");
  try {
    const env = {
      ...process.env,
      GITHUB_TOKEN: "ghp_test_stub_xxx",
      GATE_SHA: sha,
      GATE_OWNER: "o",
      GATE_REPO: "r",
      GATE_REPORT: "test-report",
      GATE_STUB_VERDICT: verdict,
    };
    try {
      const stdout = execFileSync(
        process.execPath,
        ["--import", preloadPath, BIN_PATH, "collect",
         "--owner", "o", "--repo", "r", "--sha", sha,
         "--task", "TASK-1", "--report", "test-report", "--branch", "main",
         "--pr", "42",
         "--json"],
        { encoding: "utf8", maxBuffer: 1 << 20, env }
      );
      return { stdout, stderr: "", exitCode: 0 };
    } catch (e) {
      return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.status ?? -1 };
    }
  } finally {
    try { rmSync(preloadPath, { force: true }); } catch {}
    try { rmdirSync(tmpDir); } catch {}
  }
}

test("CLI integration: collect \u2192 verdict PASS (exit 0)", () => {
  const { stdout, exitCode } = runCollectWithStubbedFetch({ verdict: "PASS", sha: VALID_SHA });
  expect(exitCode).toBe(0, `expected exit 0, got ${exitCode}; stdout: ${stdout}`);
  let result;
  expect(() => { result = JSON.parse(stdout); }).not.toThrow();
  expect(result.verdict).toBe("PASS", `expected PASS verdict, got ${result.verdict}`);
});

test("CLI integration: collect \u2192 verdict FAIL (exit 1)", () => {
  const { stdout, exitCode } = runCollectWithStubbedFetch({ verdict: "FAIL", sha: VALID_SHA });
  expect(exitCode).toBe(1, `expected exit 1, got ${exitCode}; stdout: ${stdout}`);
  let result;
  expect(() => { result = JSON.parse(stdout); }).not.toThrow();
  expect(result.verdict).toBe("FAIL", `expected FAIL verdict, got ${result.verdict}`);
});

// ---------- v1.0.4 — commits/{sha}/pulls auto-backfill ----------

test("§16 collect: auto-backfill pr via commits/{sha}/pulls returns [{number:42}] → doc.pr.state='merged'", async () => {
  const api = makeApi({
    commitBody: { sha: VALID_SHA },
    checkRuns: [{ name: "test", status: "completed", conclusion: "success" }],
    commitsPulls: [{ number: 42 }],
    prBody: { state: "closed", merged_at: "2026-01-01T00:00:00Z" },
  });
  // prNumber NOT passed — auto-backfill should trigger
  const doc = await buildEvaluationDocument("owner", "repo", VALID_SHA, {
    taskId: "TASK-1",
    report: "test-report",
    artifacts: [{ name: "test-report", expired: false, archive_download_url: "https://x/y/test-report.zip" }],
  }, api);

  expect(doc.pr).toBeDefined();
  expect(doc.pr.state).toBe("merged");
  // Verify commits/{sha}/pulls was called
  const callsPath = api.calls.map((c) => c.fetchPage).filter(Boolean);
  expect(callsPath.some((p) => p === `/repos/owner/repo/commits/${VALID_SHA}/pulls`)).toBe(true);
  // Verify the backfilled PR number 42 fetched pulls/42
  expect(callsPath.some((p) => p === "/repos/owner/repo/pulls/42")).toBe(true);
});

test("§16 collect: commits/{sha}/pulls returns [] empty → prState null, no pr field in doc", async () => {
  const api = makeApi({
    commitBody: { sha: VALID_SHA },
    checkRuns: [{ name: "test", status: "completed", conclusion: "success" }],
    commitsPulls: [],
  });
  // prNumber NOT passed — auto-backfill returns empty array
  const doc = await buildEvaluationDocument("owner", "repo", VALID_SHA, {
    taskId: "TASK-1",
  }, api);

  expect(doc.pr).toBeUndefined();
  // Verify commits/{sha}/pulls was called
  const callsPath = api.calls.map((c) => c.fetchPage).filter(Boolean);
  expect(callsPath.some((p) => p === `/repos/owner/repo/commits/${VALID_SHA}/pulls`)).toBe(true);
  // Verify no pulls/{number} call happened
  expect(callsPath.some((p) => p.startsWith("/repos/owner/repo/pulls/"))).toBe(false);
});

test("§16 collect: explicit prNumber does NOT call commits/{sha}/pulls", async () => {
  const api = makeApi({
    commitBody: { sha: VALID_SHA },
    checkRuns: [{ name: "test", status: "completed", conclusion: "success" }],
    commitsPulls: [{ number: 99 }], // would be wrong to use this
    prBody: { state: "closed", merged_at: "2026-01-01T00:00:00Z" },
  });
  // prNumber explicitly passed — should use it directly, NOT auto-backfill
  const doc = await buildEvaluationDocument("owner", "repo", VALID_SHA, {
    taskId: "TASK-1",
    prNumber: 42,
  }, api);

  expect(doc.pr).toBeDefined();
  expect(doc.pr.state).toBe("merged");
  const callsPath = api.calls.map((c) => c.fetchPage).filter(Boolean);
  // commits/{sha}/pulls must NOT be called when prNumber is explicit
  expect(callsPath.some((p) => p === `/repos/owner/repo/commits/${VALID_SHA}/pulls`)).toBe(false);
  // pulls/42 should be called (the explicit number)
  expect(callsPath.some((p) => p === "/repos/owner/repo/pulls/42")).toBe(true);
});
