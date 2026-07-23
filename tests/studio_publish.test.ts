import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFile as exec_file } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { validate_studio_request } from '../src/lib/studio_protocol';
import { cleanup_studio_transaction, publish_article, reconcile_studio_git_transaction, recover_stale_studio_claim } from '../src/lib/studio_publish';
import { local_git_adapter, type git_command_runner, type git_publish_input } from '../src/lib/studio_git';

const exec_file_async = promisify(exec_file);

/** Runs Git while setting up an isolated publication repository. */
const git = async (cwd: string, ...args: string[]): Promise<string> => (await exec_file_async('git', args, { cwd })).stdout.trim();

describe('studio protocol', () => {
  it('rejects unsafe request ids before publication work', () => {
    expect(() => validate_studio_request({ protocol_version: 1, kind: 'preview', request_id: '../unsafe', markdown: '', slug: 'post', year: 2026, metadata: {} })).toThrow(/request_id/i);
  });
});

describe('studio publication', () => {
  const roots: string[] = [];
  const journal_root = async (): Promise<string> => { const root = await mkdtemp(join(tmpdir(), 'studio-publish-')); roots.push(root); return root; };
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
  const request = { protocol_version: 1 as const, kind: 'publish_new' as const, request_id: 'abcdef1234567890abcdef1234567890', slug: 'post', year: 2026, commit_message: 'Publish post', metadata: { title: 'Post', description: 'Description', date: '2026-01-02' }, markdown: '---\ntitle: Post\ndescription: Description\ndate: 2026-01-02\n---\n\n![a](figure.png)\n', images: [{ source_path: 'figure.png', bytes_base64: 'AQ==', claimed_content_type: 'image/png' as const, intent: 'diagram' as const, semantic_name: 'figure' }] };
  const prepared = { source_path: 'figure.png', object_key: 'site/articles/2026/post/fig-01-figure.png', public_url: 'https://assets.example/site/articles/2026/post/fig-01-figure.png', bytes: new Uint8Array([1]), content_type: 'image/png' as const, sha256: createHash('sha256').update(new Uint8Array([1])).digest('hex') };
  const captured_baseline = { pre_git_head: 'a'.repeat(40), baseline_sha: 'a'.repeat(40) };
  /** Makes test doubles explicitly provide the durable baseline required by every Studio Git publication. */
  const with_baseline = <T extends object>(adapter: T): T & { capture_baseline: () => Promise<typeof captured_baseline> } => ({ capture_baseline: async () => captured_baseline, ...adapter });
  const publication_dependencies = (root: string, cos: { verify_versioning: () => Promise<void>; inspect_object: (object_key: string) => Promise<{ sha256: string; version_id?: string; studio_request_id?: string; etag?: string } | undefined>; upload_object: (image: typeof prepared, studio_request_id: string) => Promise<{ version_id: string }>; replace_object?: (image: typeof prepared, expected_etag: string, studio_request_id?: string) => Promise<{ version_id: string }>; delete_object: (object_key: string, version_id: string) => Promise<void> }, git?: { capture_baseline: () => Promise<typeof captured_baseline>; publish: () => Promise<{ ok: true; path: string; commit_sha: string; push_status: 'pushed' }> }) => ({ journal_root: root, public_site_url: 'https://site.example', image_options: { root_prefix: 'site', public_base_url: 'https://assets.example', max_bytes: 10, max_pixels: 10, max_width: 10, max_height: 10 }, cos, prepare_images: async () => [prepared], git: git ?? with_baseline({ publish: async () => ({ ok: true as const, path: 'src/content/writing/post.md', commit_sha: 'c'.repeat(40), push_status: 'pushed' as const }) }) });
  const request_hash = (input = request): string => createHash('sha256').update(JSON.stringify({ protocol_version: 1, request_id: input.request_id, slug: input.slug, year: input.year, markdown: input.markdown, metadata: input.metadata, images: [{ source_path: 'figure.png', bytes: prepared.sha256, claimed_content_type: 'image/png', intent: 'diagram', semantic_name: 'figure' }], kind: input.kind, commit_message: input.commit_message })).digest('hex');

  /** Creates a real repository and remote used to exercise post-write Git failures. */
  const make_publication_repository = async (root: string, command_runner?: git_command_runner): Promise<{ working: string; adapter: local_git_adapter }> => {
    const remote = join(root, 'remote.git'); const working = join(root, 'working');
    await git(root, 'init', '--bare', remote); await git(root, 'clone', remote, working); await git(working, 'config', 'user.email', 'test@example.com'); await git(working, 'config', 'user.name', 'Studio Test'); await git(working, 'checkout', '-b', 'main'); await mkdir(join(working, 'src/content/writing'), { recursive: true }); await writeFile(join(working, 'README.md'), 'seed\n'); await git(working, 'add', '--', 'README.md'); await git(working, 'commit', '-m', 'seed'); await git(working, 'push', 'origin', 'main');
    return { working, adapter: new local_git_adapter({ repository_root: working, publication_branch: 'main', remote_name: 'origin', writing_directory: 'src/content/writing', ...(command_runner === undefined ? {} : { command_runner }) }) };
  };

  /** Runs a real post-write Git failure through the publisher and records its retained-resource outcome. */
  const run_mutation_failure = async (operation: 'publish_new' | 'publish_update', failure: 'hook' | 'add' | 'commit'): Promise<{ result: Awaited<ReturnType<typeof publish_article>>; replay: Awaited<ReturnType<typeof publish_article>>; uploads: number; deletes: number; target: string }> => {
    const root = await journal_root(); const target_path = 'src/content/writing/post.md';
    const runner: git_command_runner | undefined = failure === 'hook' ? undefined : async (file, args, cwd) => { if (args[0] === failure) throw new Error(`injected ${failure} failure`); const output = await exec_file_async(file, [...args], { cwd }); return { stdout: output.stdout, stderr: output.stderr }; };
    const { working, adapter } = await make_publication_repository(root, runner); const target = join(working, target_path);
    let publication_request: unknown = request;
    if (operation === 'publish_update') { await writeFile(target, 'old article\n'); await git(working, 'add', '--', target_path); await git(working, 'commit', '-m', 'seed article'); await git(working, 'push', 'origin', 'main'); publication_request = { ...request, kind: 'publish_update', expected_source_hash: createHash('sha256').update(await readFile(target)).digest('hex') }; }
    if (failure === 'hook') { const hook = join(working, '.git', 'hooks', 'pre-commit'); await writeFile(hook, '#!/bin/sh\nexit 1\n'); await chmod(hook, 0o755); }
    let uploads = 0; let deletes = 0; const dependencies = { ...publication_dependencies(root, { verify_versioning: async () => undefined, inspect_object: async () => undefined, upload_object: async () => { uploads += 1; return { version_id: 'v1' }; }, delete_object: async () => { deletes += 1; } }), git: adapter };
    const result = await publish_article(publication_request, dependencies); const replay = await publish_article(publication_request, dependencies);
    return { result, replay, uploads, deletes, target };
  };

  it('reconciles a pending upload only when COS metadata names this request and exact version', async () => {
    const root = await journal_root();
    const transactions = join(root, '.studio/transactions'); await mkdir(transactions, { recursive: true });
    await writeFile(join(transactions, `${request.request_id}.json`), JSON.stringify({ protocol_version: 1, request_id: request.request_id, payload_hash: request_hash(), status: 'in_progress', phase: 'pre_commit', target_path: 'src/content/writing/post.md', owned: [], pending_upload: { object_key: prepared.object_key, sha256: prepared.sha256 } }));
    let uploads = 0;
    const result = await publish_article(request, publication_dependencies(root, { verify_versioning: async () => undefined, inspect_object: async () => ({ sha256: prepared.sha256, version_id: 'remote-v1', studio_request_id: request.request_id }), upload_object: async () => { uploads += 1; return { version_id: 'new-v1' }; }, delete_object: async () => undefined }));
    expect(result).toMatchObject({ kind: 'published' }); expect(uploads).toBe(0);
    const journal = await readFile(join(transactions, `${request.request_id}.json`), 'utf8'); expect(journal).toContain('remote-v1');
  });

  it('never deletes images while Git is pending or ambiguous', async () => {
    const root = await journal_root(); const transactions = join(root, '.studio/transactions'); await mkdir(transactions, { recursive: true });
    for (const phase of ['git_pending', 'ambiguous'] as const) {
      const request_id = `${phase === 'git_pending' ? '1' : '2'}`.repeat(32);
      await writeFile(join(transactions, `${request_id}.json`), JSON.stringify({ protocol_version: 1, request_id, payload_hash: 'b'.repeat(64), status: phase === 'ambiguous' ? 'recovery_required' : 'in_progress', phase, target_path: 'src/content/writing/post.md', target_sha256: 'e'.repeat(64), pre_git_head: captured_baseline.pre_git_head, baseline_sha: captured_baseline.baseline_sha, owned: [{ object_key: prepared.object_key, version_id: 'v1', sha256: prepared.sha256 }] }));
      let deletes = 0;
      const result = await cleanup_studio_transaction(root, request_id, { verify_versioning: async () => undefined, inspect_object: async () => undefined, upload_object: async () => ({ version_id: 'unused' }), delete_object: async () => { deletes += 1; } });
      expect(result).toMatchObject({ kind: 'recovery_required' }); expect(deletes).toBe(0);
    }
  });

  it('quarantines only a confirmed-dead claim and retains active or malformed claims', async () => {
    const root = await journal_root(); const transactions = join(root, '.studio/transactions'); await mkdir(transactions, { recursive: true }); const lock = join(transactions, `${request.request_id}.json.lock`);
    await writeFile(lock, JSON.stringify({ token: 'a'.repeat(64), pid: 1234, created_at: '2026-07-23T00:00:00.000Z', payload_hash: 'b'.repeat(64) }));
    await expect(recover_stale_studio_claim(root, request.request_id, { probe_process: () => 'active' })).resolves.toMatchObject({ kind: 'recovery_required' }); expect(await readFile(lock, 'utf8')).toContain('1234');
    await expect(recover_stale_studio_claim(root, request.request_id, { probe_process: () => 'dead' })).resolves.toMatchObject({ kind: 'recovered_stale_claim' });
    await expect(readFile(lock, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('publishes prepared assets once then sends normalized article to Git', async () => {
    let git_calls = 0;
    const result = await publish_article(request, { ...publication_dependencies(await journal_root(), { verify_versioning: async () => undefined, inspect_object: async () => undefined, upload_object: async () => ({ version_id: 'v1' }), delete_object: async () => undefined }), git: with_baseline({ publish: async (input: git_publish_input) => { git_calls += 1; expect(new TextDecoder().decode(input.source)).toContain('https://assets.example/'); return { ok: true as const, path: 'src/content/writing/post.md', commit_sha: 'c'.repeat(40), push_status: 'pushed' as const }; } }) });
    expect(result).toMatchObject({ kind: 'published', public_url: 'https://site.example/articles/post/' });
    expect(git_calls).toBe(1);
  });
  it('normalizes body-only and partial-frontmatter publications from the form metadata', async () => {
    for (const markdown of ['A body without frontmatter.\n', '---\ntitle: Imported title\n---\n\nA body with partial frontmatter.\n']) {
      let source = '';
      const result = await publish_article({ ...request, markdown, images: undefined }, {
        ...publication_dependencies(await journal_root(), { verify_versioning: async () => undefined, inspect_object: async () => undefined, upload_object: async () => ({ version_id: 'unused' }), delete_object: async () => undefined }),
        prepare_images: async () => [],
        git: with_baseline({ publish: async (input: git_publish_input) => { source = new TextDecoder().decode(input.source); return { ok: true as const, path: 'src/content/writing/post.md', commit_sha: 'c'.repeat(40), push_status: 'pushed' as const }; } }),
      });
      expect(result).toMatchObject({ kind: 'published' });
      expect(source).toContain('title: Post');
      expect(source).toContain('description: Description');
      expect(source).toContain("date: '2026-01-02'");
    }
  });
  it('uses the English article route after normalizing form metadata', async () => {
    const result = await publish_article({ ...request, markdown: '---\ntitle: Post\ndescription: Description\ndate: 2026-01-02\n---\n\nEnglish body.\n', metadata: { ...request.metadata, language: 'en' }, images: undefined }, {
      ...publication_dependencies(await journal_root(), { verify_versioning: async () => undefined, inspect_object: async () => undefined, upload_object: async () => ({ version_id: 'unused' }), delete_object: async () => undefined }),
      prepare_images: async () => [],
    });
    expect(result).toMatchObject({ kind: 'published', public_url: 'https://site.example/en/articles/post/' });
  });
  it('rejects a publication year that differs from normalized metadata before COS work', async () => {
    let cos_calls = 0;
    const result = await publish_article({ ...request, year: 2025, markdown: '---\ntitle: Post\ndescription: Description\ndate: 2026-01-02\n---\n\nBody.\n', images: undefined }, {
      ...publication_dependencies(await journal_root(), { verify_versioning: async () => { cos_calls += 1; }, inspect_object: async () => { cos_calls += 1; return undefined; }, upload_object: async () => { cos_calls += 1; return { version_id: 'unused' }; }, delete_object: async () => { cos_calls += 1; } }),
      prepare_images: async () => [],
    });
    expect(result).toMatchObject({ kind: 'failed', errors: [{ code: 'year_date_mismatch', field: 'year' }] });
    expect(cos_calls).toBe(0);
  });
  it('reports an unconfigured publisher without calling side-effect adapters', async () => {
    const result = await publish_article(request, { journal_root: await journal_root() });
    expect(result).toMatchObject({ kind: 'failed', errors: [{ code: 'not_publishable' }] });
  });
  it('replays a completed journal without repeating image or Git effects', async () => {
    const root = await journal_root(); let effects = 0; const dependencies = { ...publication_dependencies(root, { verify_versioning: async () => undefined, inspect_object: async () => undefined, upload_object: async () => { effects += 1; return { version_id: 'v1' }; }, delete_object: async () => undefined }), git: with_baseline({ publish: async () => { effects += 1; return { ok: true as const, path: 'x', commit_sha: 'd'.repeat(40), push_status: 'pushed' as const }; } }) };
    await publish_article(request, dependencies); await publish_article(request, dependencies);
    expect(effects).toBe(2);
    const journal = await (await import('node:fs/promises')).readFile(join(root, '.studio/transactions', `${request.request_id}.json`), 'utf8');
    expect(journal).not.toContain(request.markdown); expect(journal).not.toContain('Description'); expect(journal).toContain('fig-01-figure.png');
  });
  it('retains created images when Git retains a critical post-commit recovery state', async () => {
    let cleanup_calls = 0; let uploads = 0; const result = await publish_article(request, { ...publication_dependencies(await journal_root(), { verify_versioning: async () => undefined, inspect_object: async () => undefined, upload_object: async () => { uploads += 1; return { version_id: 'v1' }; }, delete_object: async () => { cleanup_calls += 1; } }), git: with_baseline({ publish: async () => ({ ok: false as const, code: 'critical_recovery_failed' as const, commit_retained: true as const, message: 'parent changed', commit_sha: 'e'.repeat(40) }) }) });
    expect(result).toMatchObject({ kind: 'committed_local' }); expect(uploads).toBe(1); expect(cleanup_calls).toBe(0);
  });
  it('retains assets and requires recovery when a pre-commit hook rejects new or update publication', async () => {
    for (const operation of ['publish_new', 'publish_update'] as const) {
      const outcome = await run_mutation_failure(operation, 'hook');
      expect(outcome.result).toMatchObject({ kind: 'recovery_required', errors: [{ code: 'git_ambiguous' }] }); expect(outcome.replay).toMatchObject({ kind: 'recovery_required' }); expect(outcome.uploads).toBe(1); expect(outcome.deletes).toBe(0); await expect(readFile(outcome.target, 'utf8')).resolves.toContain('title: Post');
    }
  });
  it('retains assets and requires recovery when Git add or commit fails after Markdown mutation', async () => {
    for (const failure of ['add', 'commit'] as const) {
      for (const operation of ['publish_new', 'publish_update'] as const) {
        const outcome = await run_mutation_failure(operation, failure);
        expect(outcome.result).toMatchObject({ kind: 'recovery_required', errors: [{ code: 'git_ambiguous' }] }); expect(outcome.replay).toMatchObject({ kind: 'recovery_required' }); expect(outcome.uploads).toBe(1); expect(outcome.deletes).toBe(0); await expect(readFile(outcome.target, 'utf8')).resolves.toContain('title: Post');
      }
    }
  });
  it('rejects insecure or malformed publication URLs before any adapter call', async () => {
    for (const public_site_url of ['http://site.example', 'https://user:password@site.example/', 'https://site.example/?query=1', 'https://site.example/#fragment', 'not a URL']) {
      const root = await journal_root(); let calls = 0;
      const result = await publish_article(request, { ...publication_dependencies(root, { verify_versioning: async () => { calls += 1; }, inspect_object: async () => { calls += 1; return undefined; }, upload_object: async () => { calls += 1; return { version_id: 'v1' }; }, delete_object: async () => { calls += 1; } }), public_site_url, prepare_images: async () => { calls += 1; return [prepared]; }, git: { capture_baseline: async () => { calls += 1; return captured_baseline; }, publish: async () => { calls += 1; return { ok: true as const, path: 'x', commit_sha: 'c'.repeat(40), push_status: 'pushed' as const }; } } });
      expect(result).toMatchObject({ kind: 'failed', errors: [{ code: 'not_publishable' }] }); expect(calls).toBe(0); await expect(readFile(join(root, '.studio', 'transactions', `${request.request_id}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });
  it('preserves a GitHub Pages base path in the published article URL', async () => {
    const result = await publish_article(request, { ...publication_dependencies(await journal_root(), { verify_versioning: async () => undefined, inspect_object: async () => undefined, upload_object: async () => ({ version_id: 'v1' }), delete_object: async () => undefined }), public_site_url: 'https://owner.github.io/personal-site/' });
    expect(result).toMatchObject({ kind: 'published', public_url: 'https://owner.github.io/personal-site/articles/post/' });
  });
  it('uses metadata form values when serializing frontmatter', async () => {
    let source = ''; const changed = { ...request, request_id: '11111111111111111111111111111111', metadata: { ...request.metadata, featured: true, translation: 'en-post', social: { zhihu: false, wechat: true, xiaohongshu: false } } };
    await publish_article(changed, { ...publication_dependencies(await journal_root(), { verify_versioning: async () => undefined, inspect_object: async () => undefined, upload_object: async () => ({ version_id: 'v1' }), delete_object: async () => undefined }), prepare_images: async () => [], git: with_baseline({ publish: async (input: git_publish_input) => { source = new TextDecoder().decode(input.source); return { ok: true as const, path: 'x', commit_sha: 'f'.repeat(40), push_status: 'pushed' as const }; } }) });
    expect(source).toContain('translation: en-post'); expect(source).toContain('featured: true'); expect(source).toContain('zhihu: false');
  });
  it('keeps imported assets and replaces a prepared asset by source path during an update', async () => {
    let source = '';
    const existing_assets = [
      { source_path: 'figure.png', object_key: prepared.object_key, public_url: prepared.public_url },
      { source_path: 'retained.png', object_key: 'site/articles/2026/post/fig-02-retained.png', public_url: 'https://assets.example/site/articles/2026/post/fig-02-retained.png' },
    ];
    const updated = {
      ...request,
      kind: 'publish_update' as const,
      request_id: '22222222222222222222222222222222',
      expected_source_hash: 'a'.repeat(64),
      markdown: `---\ntitle: Post\ndescription: Description\ndate: 2026-01-02\nassets:\n  - source_path: figure.png\n    object_key: ${prepared.object_key}\n    public_url: ${prepared.public_url}\n  - source_path: retained.png\n    object_key: site/articles/2026/post/fig-02-retained.png\n    public_url: https://assets.example/site/articles/2026/post/fig-02-retained.png\n---\n\n![a](https://assets.example/site/articles/2026/post/fig-01-figure.png)`,
      metadata: { ...request.metadata, assets: existing_assets },
      images: undefined,
    };
    const replacement = { ...prepared, sha256: createHash('sha256').update(new Uint8Array([2])).digest('hex'), bytes: new Uint8Array([2]), public_url: 'https://assets.example/site/articles/2026/post/fig-01-figure-v2.png' };
    const result = await publish_article(updated, {
      ...publication_dependencies(await journal_root(), { verify_versioning: async () => undefined, inspect_object: async () => undefined, upload_object: async () => ({ version_id: 'v1' }), delete_object: async () => undefined }),
      prepare_images: async () => [replacement],
      git: with_baseline({ publish: async (input: git_publish_input) => { source = new TextDecoder().decode(input.source); return { ok: true as const, path: 'src/content/writing/post.md', commit_sha: 'b'.repeat(40), push_status: 'pushed' as const }; } }),
    });

    expect(result).toMatchObject({ kind: 'published' });
    const serialized = validate_studio_request({ ...updated, images: [] });
    expect(serialized.metadata.assets).toEqual(existing_assets);
    expect(source).toContain('source_path: figure.png');
    expect(source).toContain("public_url: 'https://assets.example/site/articles/2026/post/fig-01-figure-v2.png'");
    expect(source).toContain('source_path: retained.png');
    expect((source.match(/source_path: figure\.png/g) ?? [])).toHaveLength(1);
  });
  it('replaces a changed deterministic asset only for an explicitly imported update manifest', async () => {
    const old_sha256 = createHash('sha256').update(new Uint8Array([9])).digest('hex');
    const updated = {
      ...request,
      kind: 'publish_update' as const,
      request_id: '33333333333333333333333333333333',
      expected_source_hash: 'a'.repeat(64),
      markdown: `---\ntitle: Post\ndescription: Description\ndate: 2026-01-02\nassets:\n  - source_path: figure.png\n    object_key: ${prepared.object_key}\n    public_url: ${prepared.public_url}\n---\n\n![a](figure.png)`,
    metadata: { ...request.metadata },
    images: request.images,
    commit_message: 'Update post',
    year: 2026,
  };
    const replacement = { ...prepared, bytes: new Uint8Array([2]), sha256: createHash('sha256').update(new Uint8Array([2])).digest('hex') };
    let replacements = 0;
    const result = await publish_article(updated, {
      ...publication_dependencies(await journal_root(), {
        verify_versioning: async () => undefined,
        inspect_object: async () => ({ sha256: old_sha256, version_id: 'old-version', etag: 'old-etag' }),
        upload_object: async () => ({ version_id: 'unexpected-create' }),
        replace_object: async (image, expected_etag, studio_request_id) => {
          replacements += 1;
          expect(image.object_key).toBe(prepared.object_key);
          expect(expected_etag).toBe('old-etag');
          expect(studio_request_id).toBe(updated.request_id);
          return { version_id: 'replacement-version' };
        },
        delete_object: async () => undefined,
      }),
      prepare_images: async () => [replacement],
    });
    expect(result).toMatchObject({ kind: 'published' });
    expect(replacements).toBe(1);
  });
  it('rejects a symlinked Studio journal directory before publication or recovery touch it', async () => {
    const root = await journal_root();
    const escaped_root = await mkdtemp(join(tmpdir(), 'studio-escaped-')); roots.push(escaped_root);
    await symlink(escaped_root, join(root, '.studio'));
    let effects = 0;
    const dependencies = {
      ...publication_dependencies(root, { verify_versioning: async () => { effects += 1; }, inspect_object: async () => { effects += 1; return undefined; }, upload_object: async () => { effects += 1; return { version_id: 'unexpected' }; }, delete_object: async () => { effects += 1; } }),
      prepare_images: async () => [],
      git: with_baseline({ publish: async () => { effects += 1; return { ok: true as const, path: 'src/content/writing/post.md', commit_sha: 'c'.repeat(40), push_status: 'pushed' as const }; } }),
    };
    await expect(publish_article({ ...request, markdown: '---\ntitle: Post\ndescription: Description\ndate: 2026-01-02\n---\n\nBody.\n', images: undefined }, dependencies)).resolves.toMatchObject({ kind: 'recovery_required', errors: [{ code: 'unsafe_journal' }] });
    await expect(cleanup_studio_transaction(root, request.request_id, dependencies.cos)).resolves.toMatchObject({ kind: 'recovery_required', errors: [{ code: 'unsafe_journal' }] });
    await expect(reconcile_studio_git_transaction(root, request.request_id, { inspect: async () => ({ state: 'not_committed' }) })).resolves.toMatchObject({ kind: 'recovery_required', errors: [{ code: 'unsafe_journal' }] });
    await expect(recover_stale_studio_claim(root, request.request_id)).resolves.toMatchObject({ kind: 'recovery_required', errors: [{ code: 'unsafe_claim' }] });
    expect(effects).toBe(0);
    await expect(readFile(join(escaped_root, 'transactions', `${request.request_id}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects invalid metadata before any COS side effect', async () => {
    let uploads = 0; let inspections = 0; const invalid = { ...request, metadata: { ...request.metadata, title: '' } };
    const result = await publish_article(invalid, publication_dependencies(await journal_root(), { verify_versioning: async () => undefined, inspect_object: async () => { inspections += 1; return undefined; }, upload_object: async () => { uploads += 1; return { version_id: 'v1' }; }, delete_object: async () => undefined }));
    expect(result).toMatchObject({ kind: 'failed', errors: [{ code: 'invalid_field' }] }); expect(uploads).toBe(0); expect(inspections).toBe(0);
  });
  it('rejects malformed LaTeX before any COS side effect', async () => {
    let uploads = 0; let inspections = 0;
    const invalid_math = { ...request, markdown: '---\ntitle: Post\ndescription: Description\ndate: 2026-01-02\n---\n\n$\\frac{1}{$\n', images: [] };
    const result = await publish_article(invalid_math, publication_dependencies(await journal_root(), { verify_versioning: async () => undefined, inspect_object: async () => { inspections += 1; return undefined; }, upload_object: async () => { uploads += 1; return { version_id: 'v1' }; }, delete_object: async () => undefined }));
    expect(result).toMatchObject({ kind: 'failed', errors: [{ code: 'invalid_math', field: 'markdown.line_2.column_1' }] }); expect(uploads).toBe(0); expect(inspections).toBe(0);
  });
  it('reuses a matching foreign object and never records or deletes it as owned', async () => {
    let uploads = 0; let deletes = 0; const result = await publish_article(request, { ...publication_dependencies(await journal_root(), { verify_versioning: async () => undefined, inspect_object: async () => ({ sha256: prepared.sha256, version_id: 'foreign-v1', studio_request_id: '1'.repeat(32) }), upload_object: async () => { uploads += 1; return { version_id: 'v1' }; }, delete_object: async () => { deletes += 1; } }), git: with_baseline({ publish: async () => ({ ok: false as const, code: 'stale_source' as const, message: 'changed' }) }) });
    expect(result).toMatchObject({ kind: 'failed', cleanup: { deleted: [], failures: [] } }); expect(uploads).toBe(0); expect(deletes).toBe(0);
  });
  it('cleans only the exact created version when Git fails before committing', async () => {
    const deleted: Array<readonly [string, string]> = []; const result = await publish_article(request, { ...publication_dependencies(await journal_root(), { verify_versioning: async () => undefined, inspect_object: async () => undefined, upload_object: async () => ({ version_id: 'created-v1' }), delete_object: async (object_key, version_id) => { deleted.push([object_key, version_id]); } }), git: with_baseline({ publish: async () => ({ ok: false as const, code: 'stale_source' as const, message: 'source changed' }) }) });
    expect(result).toMatchObject({ kind: 'failed', errors: [{ code: 'stale_source' }], cleanup: { deleted: [prepared.object_key], failures: [] } }); expect(deleted).toEqual([[prepared.object_key, 'created-v1']]);
  });
  it('retries pre-commit cleanup with only exact versions that failed previously', async () => {
    const root = await journal_root(); const transactions = join(root, '.studio/transactions'); await mkdir(transactions, { recursive: true });
    const second_key = 'site/articles/2026/post/fig-02-second.png';
    await writeFile(join(transactions, `${request.request_id}.json`), JSON.stringify({ protocol_version: 1, request_id: request.request_id, payload_hash: request_hash(), status: 'in_progress', phase: 'pre_commit', target_path: 'src/content/writing/post.md', owned: [{ object_key: prepared.object_key, version_id: 'v1', sha256: prepared.sha256 }, { object_key: second_key, version_id: 'v2', sha256: prepared.sha256 }] }));
    const delete_calls: string[] = []; let fail_second = true; const adapter = { verify_versioning: async () => undefined, inspect_object: async () => undefined, upload_object: async () => ({ version_id: 'unused' }), delete_object: async (object_key: string) => { delete_calls.push(object_key); if (object_key === second_key && fail_second) throw new Error('transient'); } };
    await expect(cleanup_studio_transaction(root, request.request_id, adapter)).resolves.toMatchObject({ kind: 'failed', cleanup: { deleted: [prepared.object_key], failures: [second_key] } });
    fail_second = false;
    await expect(cleanup_studio_transaction(root, request.request_id, adapter)).resolves.toMatchObject({ kind: 'failed', cleanup: { deleted: [second_key], failures: [] } });
    expect(delete_calls).toEqual([prepared.object_key, second_key, second_key]);
  });
  it('reports deployment failure as advisory after a pushed publication', async () => {
    const result = await publish_article(request, { ...publication_dependencies(await journal_root(), { verify_versioning: async () => undefined, inspect_object: async () => undefined, upload_object: async () => ({ version_id: 'v1' }), delete_object: async () => undefined }), deployment: { report: async () => { throw new Error('offline'); } } });
    expect(result).toMatchObject({ kind: 'published', deployment_advisory: 'Deployment status could not be confirmed.' });
  });
  it('preserves assets when Git throws after the durable git_pending marker', async () => {
    let deletes = 0; const root = await journal_root(); const result = await publish_article(request, { ...publication_dependencies(root, { verify_versioning: async () => undefined, inspect_object: async () => undefined, upload_object: async () => ({ version_id: 'v1' }), delete_object: async () => { deletes += 1; } }), git: with_baseline({ publish: async () => { throw new Error('lost Git response'); } }) });
    expect(result).toMatchObject({ kind: 'recovery_required', errors: [{ code: 'git_ambiguous' }] }); expect(deletes).toBe(0);
    await expect(cleanup_studio_transaction(root, request.request_id, { verify_versioning: async () => undefined, inspect_object: async () => undefined, upload_object: async () => ({ version_id: 'unused' }), delete_object: async () => { deletes += 1; } })).resolves.toMatchObject({ kind: 'recovery_required' }); expect(deletes).toBe(0);
  });
  it('does not call Git when durable baseline capture fails', async () => {
    let git_calls = 0; const result = await publish_article(request, { ...publication_dependencies(await journal_root(), { verify_versioning: async () => undefined, inspect_object: async () => undefined, upload_object: async () => ({ version_id: 'v1' }), delete_object: async () => undefined }), git: { capture_baseline: async () => { throw new Error('baseline unavailable'); }, publish: async () => { git_calls += 1; return { ok: true as const, path: 'x', commit_sha: 'c'.repeat(40), push_status: 'pushed' as const }; } } });
    expect(result).toMatchObject({ kind: 'recovery_required', errors: [{ code: 'baseline_capture_failed' }] }); expect(git_calls).toBe(0);
  });
  it('does not call Git when durable baseline persistence fails', async () => {
    let git_calls = 0; let file_syncs = 0;
    const result = await publish_article(request, { ...publication_dependencies(await journal_root(), { verify_versioning: async () => undefined, inspect_object: async () => undefined, upload_object: async () => ({ version_id: 'v1' }), delete_object: async () => undefined }), prepare_images: async () => [], git: with_baseline({ publish: async () => { git_calls += 1; return { ok: true as const, path: 'x', commit_sha: 'c'.repeat(40), push_status: 'pushed' as const }; } }), runtime: { on_journal_event: async (event) => { if (event === 'before_file_sync' && ++file_syncs === 2) throw new Error('baseline fsync failed'); } } });
    expect(result).toMatchObject({ kind: 'recovery_required', errors: [{ code: 'baseline_persist_failed' }] }); expect(git_calls).toBe(0);
  });
  it('reconciles definite Git states without deleting assets and returns a no-commit state to pre_commit', async () => {
    const root = await journal_root(); const transactions = join(root, '.studio/transactions'); await mkdir(transactions, { recursive: true }); const target_sha256 = 'e'.repeat(64);
    const write_git_journal = async (request_id: string, phase: 'git_pending' | 'ambiguous'): Promise<void> => writeFile(join(transactions, `${request_id}.json`), JSON.stringify({ protocol_version: 1, request_id, payload_hash: 'b'.repeat(64), status: phase === 'ambiguous' ? 'recovery_required' : 'in_progress', phase, target_path: 'src/content/writing/post.md', target_sha256, pre_git_head: captured_baseline.pre_git_head, baseline_sha: captured_baseline.baseline_sha, owned: [{ object_key: prepared.object_key, version_id: 'v1', sha256: prepared.sha256 }] }));
    const no_commit_id = '6'.repeat(32); await write_git_journal(no_commit_id, 'git_pending');
    await expect(reconcile_studio_git_transaction(root, no_commit_id, { inspect: async () => ({ state: 'not_committed' }) })).resolves.toMatchObject({ kind: 'recovery_required' });
    let deletes = 0; await expect(cleanup_studio_transaction(root, no_commit_id, { verify_versioning: async () => undefined, inspect_object: async () => undefined, upload_object: async () => ({ version_id: 'unused' }), delete_object: async () => { deletes += 1; } })).resolves.toMatchObject({ kind: 'failed' }); expect(deletes).toBe(1);
    const local_id = '7'.repeat(32); await write_git_journal(local_id, 'ambiguous');
    await expect(reconcile_studio_git_transaction(root, local_id, { inspect: async () => ({ state: 'committed_local', commit_sha: 'c'.repeat(40) }) })).resolves.toMatchObject({ kind: 'committed_local', commit_sha: 'c'.repeat(40) });
    const pushed_id = '8'.repeat(32); await write_git_journal(pushed_id, 'ambiguous');
    await expect(reconcile_studio_git_transaction(root, pushed_id, { inspect: async () => ({ state: 'pushed', commit_sha: 'd'.repeat(40) }), public_site_url: 'https://site.example' })).resolves.toMatchObject({ kind: 'published', commit_sha: 'd'.repeat(40) });
    const unknown_id = '9'.repeat(32); await write_git_journal(unknown_id, 'git_pending');
    await expect(reconcile_studio_git_transaction(root, unknown_id, { git: { inspect_studio_transaction: async () => ({ state: 'unknown' }) } })).resolves.toMatchObject({ kind: 'recovery_required' });
  });
  it('does not delete a foreign active lock and reports its payload conflict', async () => {
    const root = await journal_root(); const transactions = join(root, '.studio/transactions'); await mkdir(transactions, { recursive: true }); const lock = join(transactions, `${request.request_id}.json.lock`);
    await writeFile(lock, JSON.stringify({ token: 'c'.repeat(64), pid: 1234, created_at: '2026-07-23T00:00:00.000Z', payload_hash: 'd'.repeat(64) }));
    const result = await publish_article(request, publication_dependencies(root, { verify_versioning: async () => undefined, inspect_object: async () => undefined, upload_object: async () => ({ version_id: 'v1' }), delete_object: async () => undefined }));
    expect(result).toMatchObject({ kind: 'failed', errors: [{ code: 'request_id_conflict' }] }); expect(await readFile(lock, 'utf8')).toContain('"token":"' + 'c'.repeat(64));
  });
  it('refuses corrupt completed records and request/file identity mismatch without cleanup', async () => {
    const root = await journal_root(); const transactions = join(root, '.studio/transactions'); await mkdir(transactions, { recursive: true }); let deletes = 0;
    await writeFile(join(transactions, `${request.request_id}.json`), JSON.stringify({ protocol_version: 1, request_id: request.request_id, payload_hash: request_hash(), status: 'completed', phase: 'pre_commit', target_path: 'src/content/writing/post.md', owned: [{ object_key: prepared.object_key, version_id: 'v1', sha256: prepared.sha256 }] }));
    const adapter = { verify_versioning: async () => undefined, inspect_object: async () => undefined, upload_object: async () => ({ version_id: 'unused' }), delete_object: async () => { deletes += 1; } };
    await expect(cleanup_studio_transaction(root, request.request_id, adapter)).resolves.toMatchObject({ kind: 'recovery_required' }); expect(deletes).toBe(0);
    const other_id = '9'.repeat(32); await writeFile(join(transactions, `${other_id}.json`), JSON.stringify({ protocol_version: 1, request_id: request.request_id, payload_hash: request_hash(), status: 'in_progress', phase: 'pre_commit', target_path: 'src/content/writing/post.md', owned: [] }));
    await expect(cleanup_studio_transaction(root, other_id, adapter)).resolves.toMatchObject({ kind: 'recovery_required' }); expect(deletes).toBe(0);
  });
  it('rejects a journal whose target path does not agree with the replayed request', async () => {
    const root = await journal_root(); const transactions = join(root, '.studio/transactions'); await mkdir(transactions, { recursive: true });
    await writeFile(join(transactions, `${request.request_id}.json`), JSON.stringify({ protocol_version: 1, request_id: request.request_id, payload_hash: request_hash(), status: 'completed', phase: 'pushed', target_path: 'src/content/writing/other-post.md', owned: [], commit_sha: 'c'.repeat(40), result: { protocol_version: 1, kind: 'published', public_url: 'https://site.example/articles/post/', commit_sha: 'c'.repeat(40) } }));
    const result = await publish_article(request, publication_dependencies(root, { verify_versioning: async () => undefined, inspect_object: async () => undefined, upload_object: async () => ({ version_id: 'v1' }), delete_object: async () => undefined }));
    expect(result).toMatchObject({ kind: 'recovery_required', errors: [{ code: 'corrupt_journal' }] });
  });
  it('rejects completed journals whose result commit SHA differs from the phase commit SHA', async () => {
    const root = await journal_root(); const transactions = join(root, '.studio/transactions'); await mkdir(transactions, { recursive: true });
    await writeFile(join(transactions, `${request.request_id}.json`), JSON.stringify({ protocol_version: 1, request_id: request.request_id, payload_hash: request_hash(), status: 'completed', phase: 'pushed', target_path: 'src/content/writing/post.md', owned: [], commit_sha: 'c'.repeat(40), result: { protocol_version: 1, kind: 'published', public_url: 'https://site.example/articles/post/', commit_sha: 'd'.repeat(40) } }));
    const result = await publish_article(request, publication_dependencies(root, { verify_versioning: async () => undefined, inspect_object: async () => undefined, upload_object: async () => ({ version_id: 'v1' }), delete_object: async () => undefined }));
    expect(result).toMatchObject({ kind: 'recovery_required', errors: [{ code: 'corrupt_journal' }] });
  });
  it('retains pending ownership across journal write, rename, and fsync faults', async () => {
    for (const fault of ['before_write', 'before_file_sync', 'before_rename', 'before_directory_sync'] as const) {
      const root = await journal_root(); let uploads = 0; let deletes = 0; let events = 0;
      const result = await publish_article({ ...request, request_id: `${events + 3}`.repeat(32) }, { ...publication_dependencies(root, { verify_versioning: async () => undefined, inspect_object: async () => undefined, upload_object: async () => { uploads += 1; return { version_id: 'v1' }; }, delete_object: async () => { deletes += 1; } }), runtime: { on_journal_event: async (event) => { if (event === fault) { events += 1; if (events === 1 || fault !== 'before_write') throw new Error(`fault:${fault}`); } } } });
      expect(['recovery_required', 'failed']).toContain(result.kind); expect(deletes).toBe(0);
      if (uploads > 0) await expect(cleanup_studio_transaction(root, `${events + 3}`.repeat(32), { verify_versioning: async () => undefined, inspect_object: async () => undefined, upload_object: async () => ({ version_id: 'unused' }), delete_object: async () => { deletes += 1; } })).resolves.toMatchObject({ kind: 'recovery_required' });
      expect(deletes).toBe(0);
    }
  });
  it('keeps a remote object when the post-upload ownership fsync fails', async () => {
    const root = await journal_root(); let uploads = 0; let deletes = 0; let file_syncs = 0;
    const result = await publish_article(request, { ...publication_dependencies(root, { verify_versioning: async () => undefined, inspect_object: async () => undefined, upload_object: async () => { uploads += 1; return { version_id: 'created-v1' }; }, delete_object: async () => { deletes += 1; } }), runtime: { on_journal_event: async (event) => { if (event === 'before_file_sync' && ++file_syncs === 3) throw new Error('ownership fsync fault'); } } });
    expect(result).toMatchObject({ kind: 'recovery_required', errors: [{ code: 'pending_upload' }] }); expect(uploads).toBe(1); expect(deletes).toBe(0);
    await expect(cleanup_studio_transaction(root, request.request_id, { verify_versioning: async () => undefined, inspect_object: async () => undefined, upload_object: async () => ({ version_id: 'unused' }), delete_object: async () => { deletes += 1; } })).resolves.toMatchObject({ kind: 'recovery_required' }); expect(deletes).toBe(0);
  });
});
