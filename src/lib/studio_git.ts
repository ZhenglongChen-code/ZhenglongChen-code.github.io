import { createHash } from 'node:crypto';
import { execFile as exec_file } from 'node:child_process';
import { constants as fs_constants } from 'node:fs';
import { access, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec_file_async = promisify(exec_file);
const slug_pattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const token_pattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const remote_pattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const commit_message_pattern = /^[^\x00-\x1f\x7f-][^\x00-\x1f\x7f]{0,199}$/;
const writing_directory_pattern = /^src\/content\/writing(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

export type git_publish_input = {
  operation: 'publish_new' | 'publish_update';
  slug: string;
  source: Uint8Array;
  expected_source_hash?: string;
  commit_message: string;
};

export type git_publish_failure_code = 'validation' | 'unsafe_path' | 'article_exists' | 'article_missing' | 'stale_source' | 'target_dirty' | 'repository_busy' | 'wrong_branch' | 'git_failed';
export type git_publish_failure = { ok: false; code: git_publish_failure_code; message: string };
export type git_publish_success = { ok: true; path: string; commit_sha: string; push_status: 'pushed' | 'failed'; recovery?: string };
export type git_publish_result = git_publish_failure | git_publish_success;

export interface git_adapter { publish(input: git_publish_input): Promise<git_publish_result>; }
export type git_command_runner = (file: string, args: readonly string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;
export type local_git_adapter_options = { repository_root: string; publication_branch: string; remote_name: string; writing_directory: string; command_runner?: git_command_runner };

const default_runner: git_command_runner = async (file, args, cwd) => {
  const output = await exec_file_async(file, [...args], { cwd, encoding: 'utf8' });
  return { stdout: output.stdout, stderr: output.stderr };
};
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const is_inside = (root: string, value: string): boolean => { const value_relative = relative(root, value); return value_relative !== '' && !value_relative.startsWith('..') && !isAbsolute(value_relative); };

/** Publishes one verified Markdown article without changing unrelated Git state. */
export class local_git_adapter implements git_adapter {
  private readonly repository_root: string;
  private readonly publication_branch: string;
  private readonly remote_name: string;
  private readonly writing_directory: string;
  private readonly command_runner: git_command_runner;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: local_git_adapter_options) {
    this.repository_root = resolve(options.repository_root);
    this.publication_branch = options.publication_branch;
    this.remote_name = options.remote_name;
    this.writing_directory = options.writing_directory;
    this.command_runner = options.command_runner ?? default_runner;
  }

  async publish(input: git_publish_input): Promise<git_publish_result> {
    const source = new Uint8Array(input.source);
    const queued = this.queue.then(() => this.publish_locked({ ...input, source }));
    this.queue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  private async run_git(...args: string[]): Promise<string> {
    const output = await this.command_runner('git', args, this.repository_root);
    return output.stdout.trim();
  }

  private async publish_locked(input: git_publish_input): Promise<git_publish_result> {
    if (!slug_pattern.test(input.slug) || !commit_message_pattern.test(input.commit_message) || input.commit_message.startsWith('-') || !token_pattern.test(this.publication_branch) || this.publication_branch.includes('..') || !remote_pattern.test(this.remote_name) || !writing_directory_pattern.test(this.writing_directory)) return { ok: false, code: 'validation', message: 'Invalid publication input or configuration.' };
    if (input.operation === 'publish_update' && (!input.expected_source_hash || !/^[a-f0-9]{64}$/.test(input.expected_source_hash))) return { ok: false, code: 'validation', message: 'An update requires a SHA-256 expected_source_hash.' };
    try {
      const configured_root = await realpath(this.repository_root);
      const git_root = await realpath(await this.run_git('rev-parse', '--show-toplevel'));
      if (configured_root !== git_root) return { ok: false, code: 'unsafe_path', message: 'Configured repository root does not match Git root.' };
      const branch = await this.run_git('symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => '');
      if (branch !== this.publication_branch) return { ok: false, code: 'wrong_branch', message: 'Repository is not on the configured publication branch.' };
      const git_dir_raw = await this.run_git('rev-parse', '--git-dir');
      const git_dir = resolve(configured_root, git_dir_raw);
      for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-apply', 'rebase-merge']) if (await this.exists(join(git_dir, marker))) return { ok: false, code: 'repository_busy', message: 'Repository has an unfinished Git operation.' };
      if ((await this.run_git('ls-files', '-u')).trim()) return { ok: false, code: 'repository_busy', message: 'Repository has unresolved paths.' };

      const writing_root = resolve(configured_root, this.writing_directory);
      const writing_real = await realpath(writing_root);
      if (!is_inside(configured_root, writing_root) || writing_real !== writing_root) return { ok: false, code: 'unsafe_path', message: 'Writing directory is unsafe.' };
      const relative_path = `${this.writing_directory}/${input.slug}.md`;
      const target = resolve(configured_root, relative_path);
      if (!is_inside(writing_real, target) || basename(target) !== `${input.slug}.md`) return { ok: false, code: 'unsafe_path', message: 'Article path is unsafe.' };
      const target_stat = await lstat(target).catch(() => undefined);
      if (target_stat?.isSymbolicLink()) return { ok: false, code: 'unsafe_path', message: 'Article path must not be a symbolic link.' };
      const exists = target_stat !== undefined;
      if (input.operation === 'publish_new' && exists) return { ok: false, code: 'article_exists', message: 'Article already exists.' };
      if (input.operation === 'publish_update' && !exists) return { ok: false, code: 'article_missing', message: 'Article does not exist.' };
      if (exists && (await this.path_dirty(relative_path))) return { ok: false, code: 'target_dirty', message: 'Target article has uncommitted changes.' };
      if (exists) {
        const current = await import('node:fs/promises').then(({ readFile }) => readFile(target));
        if (sha256(current) !== input.expected_source_hash) return { ok: false, code: 'stale_source', message: 'Target article changed since it was read.' };
      }
      await this.atomic_write(target, input.source);
      await this.run_git('add', '--', relative_path);
      await this.run_git('commit', '--only', '-m', input.commit_message, '--', relative_path);
      const commit_sha = await this.run_git('rev-parse', 'HEAD');
      const changed = (await this.run_git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD')).split('\n').filter(Boolean);
      if (changed.length !== 1 || changed[0] !== relative_path) return { ok: false, code: 'git_failed', message: 'Commit did not contain exactly the target article.' };
      try { await this.run_git('push', this.remote_name, this.publication_branch); return { ok: true, path: relative_path, commit_sha, push_status: 'pushed' }; }
      catch { return { ok: true, path: relative_path, commit_sha, push_status: 'failed', recovery: 'Local commit was kept. Fetch the remote branch, resolve the divergence, then push normally without force.' }; }
    } catch { return { ok: false, code: 'git_failed', message: 'Git publication failed; inspect the local repository state and retry.' }; }
  }

  private async path_dirty(relative_path: string): Promise<boolean> {
    try {
      if (await this.run_git('status', '--porcelain=v1', '--untracked-files=all', '--', relative_path)) return true;
      await this.run_git('diff', '--quiet', '--', relative_path);
      await this.run_git('diff', '--cached', '--quiet', '--', relative_path);
      return false;
    } catch { return true; }
  }

  private async exists(path: string): Promise<boolean> { try { await access(path, fs_constants.F_OK); return true; } catch { return false; } }

  private async atomic_write(target: string, source: Uint8Array): Promise<void> {
    await mkdir(dirname(target), { recursive: true });
    const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(source); await handle.sync(); } finally { await handle.close(); }
    try { await rename(temporary, target); } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
  }
}
