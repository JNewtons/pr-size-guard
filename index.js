// index.js
import * as core from "@actions/core";
import * as github from "@actions/github";
import { Minimatch } from "minimatch";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

// ---------- utils ----------
function csvList(s) {
  return (s || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function isUnderAnyTestDir(filePath, testDirs) {
  const parts = filePath.split("/");
  return parts.some((seg) => testDirs.includes(seg));
}

function isExcluded(filePath, excludeGlobs) {
  if (!excludeGlobs.length) return false;
  return excludeGlobs.some((g) => new Minimatch(g).match(filePath));
}

function asInt(v, fallback) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function loadYamlConfig(cwd) {
  try {
    const p1 = path.join(cwd, ".pr_guard.yml");
    const p2 = path.join(cwd, ".pr_guard.yaml");
    const p = fs.existsSync(p1) ? p1 : fs.existsSync(p2) ? p2 : null;
    if (!p) return {};
    const raw = fs.readFileSync(p, "utf8");
    const doc = yaml.load(raw) || {};
    const cfg = {};
    if (doc.max_lines != null) cfg.max_lines = asInt(doc.max_lines, undefined);
    if (doc.max_files != null) cfg.max_files = asInt(doc.max_files, undefined);
    if (doc.mode) cfg.mode = String(doc.mode).toLowerCase();
    if (doc.retries != null) cfg.retries = asInt(doc.retries, undefined);
    if (doc.test_paths) {
      cfg.test_paths = Array.isArray(doc.test_paths)
        ? doc.test_paths.map(String)
        : csvList(String(doc.test_paths));
    }
    if (doc.exclude) {
      cfg.exclude = Array.isArray(doc.exclude)
        ? doc.exclude.map(String)
        : csvList(String(doc.exclude));
    }
    return cfg;
  } catch (e) {
    core.warning(`Failed to read .pr_guard.yml: ${e?.message || e}`);
    return {};
  }
}

async function withRetry(fn, retries) {
  let attempt = 0;
  let lastErr;
  while (attempt <= retries) {
    try {
      return await fn();
    } catch (e) {
      const status = e?.status || e?.response?.status;
      const transient = status === 429 || (status >= 500 && status < 600);
      if (!transient || attempt === retries) {
        lastErr = e;
        break;
      }
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      attempt += 1;
    }
  }
  throw lastErr;
}

// ---------- main ----------
async function run() {
  try {
    const token =
      process.env.GITHUB_TOKEN ||
      process.env.GH_TOKEN ||
      core.getInput("token") ||
      "";

    if (!token) {
      core.setFailed(
        "Missing GITHUB_TOKEN. Add `env: { GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}}` and ensure workflow permissions."
      );
      return;
    }

    const octo = github.getOctokit(token);
    const { owner, repo } = github.context.repo;
    const pr = github.context.payload.pull_request;
    if (!pr) {
      core.setFailed("No pull request found. Use `on: pull_request`.");
      return;
    }

    // Config precedence: inputs > .pr_guard.yml > defaults
    const fileCfg = loadYamlConfig(process.cwd());
    const maxLines = asInt(core.getInput("max_lines"), fileCfg.max_lines ?? 400);
    const maxFiles = asInt(core.getInput("max_files"), fileCfg.max_files ?? 25);
    const mode = (core.getInput("mode") || fileCfg.mode || "warn").toLowerCase();
    const retries = Math.max(
      0,
      asInt(core.getInput("retries"), fileCfg.retries ?? 2)
    );
    const testDirs =
      csvList(core.getInput("test_paths")) ||
      fileCfg.test_paths ||
      ["test", "tests", "__tests__"];
    const excludeGlobs =
      csvList(core.getInput("exclude")) || fileCfg.exclude || [];

    // Preflight: confirm token works on this PR
    await withRetry(
      () => octo.rest.pulls.get({ owner, repo, pull_number: pr.number }),
      retries
    );

    // List changed files with pagination
    const files = await withRetry(
      () =>
        octo.paginate(
          octo.rest.pulls.listFiles,
          { owner, repo, pull_number: pr.number, per_page: 100 },
          (resp) => resp.data
        ),
      retries
    );

    if (!files.length) {
      core.notice("No changed files detected in this PR.");
      return;
    }

    // Filter excluded patterns first
    const considered = files.filter((f) => !isExcluded(f.filename, excludeGlobs));

    if (!considered.length) {
      core.notice("All changed files are excluded by configuration.");
      return;
    }

    // Prefer API 'changes' when present; fallback to additions + deletions
    const lineDelta = (f) =>
      typeof f.changes === "number"
        ? f.changes
        : Number(f.additions || 0) + Number(f.deletions || 0);

    // Treat pure renames with zero changes as size-neutral
    const effective = considered.filter(
      (f) => !(f.status === "renamed" && lineDelta(f) === 0)
    );

    const totalFiles = effective.length;
    const totalChanges = effective.reduce((n, f) => n + lineDelta(f), 0);
    const touchedTests = effective.some((f) =>
      isUnderAnyTestDir(f.filename, testDirs)
    );

    const problems = [];
    if (totalChanges > maxLines) {
      problems.push(`Too many changed lines: ${totalChanges}. Limit is ${maxLines}.`);
    }
    if (totalFiles > maxFiles) {
      problems.push(`Too many changed files: ${totalFiles}. Limit is ${maxFiles}.`);
    }
    if (!touchedTests) {
      problems.push("No test files changed. Consider adding or updating a test.");
    }

    const summary = `Files considered: ${totalFiles}. Changes: ${totalChanges}. Tests touched: ${
      touchedTests ? "yes" : "no"
    }.`;

    if (problems.length) {
      const body =
        "PR Size Guard report:\n\n" +
        problems.map((p) => `- ${p}`).join("\n") +
        "\n\n" +
        summary +
        "\n\n" +
        "Tips: Adjust limits via `.pr_guard.yml` or action inputs. Exclude globs with `exclude` input.";

      try {
        await withRetry(
          () =>
            octo.rest.issues.createComment({
              owner,
              repo,
              issue_number: pr.number,
              body
            }),
          retries
        );
      } catch (e) {
        const status = e?.status || e?.response?.status;
        if (status === 403) {
          core.error(
            "Could not comment on the PR. Check workflow token permissions: `pull-requests: write`. If this is from a fork, consider a maintainer-only workflow to add comments."
          );
        } else {
          core.error(`Failed to comment on the PR. Status: ${status || "unknown"}.`);
        }
      }

      if (mode === "fail") core.setFailed("PR Size Guard policy failed.");
      else core.notice("PR Size Guard posted warnings.");
    } else {
      core.notice("PR Size Guard found no issues. " + summary);
    }
  } catch (e) {
    const msg = e && (e.message || e.toString()) ? String(e.message || e) : "Unknown error";
    core.setFailed(`Error: ${msg}`);
  }
}

run();