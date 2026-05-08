/**
 * GitHub API tools (PAT-based, no OAuth)
 * Requires GitHub Personal Access Token stored via keytar
 */

import { getSecret } from './secrets';
import type { ToolResult } from '../types/tool-result';

async function getOctokit() {
  const pat = await getSecret('clippy.github', 'pat');
  if (!pat) return null;

  try {
    const { Octokit } = await import('@octokit/rest');
    return new Octokit({ auth: pat });
  } catch (err) {
    console.warn('[github] Failed to load @octokit/rest:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

export async function githubCreateIssue(params: Record<string, unknown>): Promise<ToolResult> {
  const owner = String(params.owner || '');
  const repo = String(params.repo || '');
  const title = String(params.title || '');
  const body = String(params.body || '');

  if (!owner || !repo || !title) {
    return { text: '(error:GITHUB_MISSING_PARAMS) owner, repo, and title are required' };
  }

  const octokit = await getOctokit();
  if (!octokit) {
    return { text: '(error:GITHUB_NO_TOKEN) Add a GitHub PAT in Clippy settings to enable GitHub tools.' };
  }

  try {
    const { data } = await octokit.issues.create({
      owner,
      repo,
      title,
      body,
    });
    return { text: `Created issue #${data.number}: ${data.title}\n${data.html_url}` };
  } catch (err) {
    return { text: `(error:GITHUB_CREATE_FAILED) ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function githubListIssues(params: Record<string, unknown>): Promise<ToolResult> {
  const owner = String(params.owner || '');
  const repo = String(params.repo || '');
  const state = String(params.state || 'open');

  if (!owner || !repo) {
    return { text: '(error:GITHUB_MISSING_PARAMS) owner and repo are required' };
  }

  const octokit = await getOctokit();
  if (!octokit) {
    return { text: '(error:GITHUB_NO_TOKEN) Add a GitHub PAT in Clippy settings to enable GitHub tools.' };
  }

  try {
    const { data } = await octokit.issues.listForRepo({
      owner,
      repo,
      state: state as 'open' | 'closed' | 'all',
      per_page: 20,
    });

    if (data.length === 0) {
      return { text: `No ${state} issues in ${owner}/${repo}` };
    }

    const lines = [`${data.length} ${state} issue(s) in ${owner}/${repo}:`];
    for (const issue of data) {
      lines.push(`  #${issue.number} — ${issue.title}`);
    }
    return { text: lines.join('\n') };
  } catch (err) {
    return { text: `(error:GITHUB_LIST_FAILED) ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function githubGetPr(params: Record<string, unknown>): Promise<ToolResult> {
  const owner = String(params.owner || '');
  const repo = String(params.repo || '');
  const prNumber = Number(params.pr_number);

  if (!owner || !repo || !Number.isFinite(prNumber)) {
    return { text: '(error:GITHUB_MISSING_PARAMS) owner, repo, and pr_number are required' };
  }

  const octokit = await getOctokit();
  if (!octokit) {
    return { text: '(error:GITHUB_NO_TOKEN) Add a GitHub PAT in Clippy settings to enable GitHub tools.' };
  }

  try {
    const { data } = await octokit.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });

    const status = data.merged ? 'merged' : data.state;
    const lines = [
      `PR #${data.number}: ${data.title}`,
      `Status: ${status}`,
      `Author: ${data.user?.login}`,
      data.html_url,
    ];
    return { text: lines.join('\n') };
  } catch (err) {
    return { text: `(error:GITHUB_GET_PR_FAILED) ${err instanceof Error ? err.message : String(err)}` };
  }
}
