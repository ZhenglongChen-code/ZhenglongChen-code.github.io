import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validate_studio_request } from '../src/lib/studio_protocol';
import { cleanup_studio_transaction, publish_article, recover_stale_studio_claim } from '../src/lib/studio_publish';

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
  const publication_dependencies = (root: string, cos: { verify_versioning: () => Promise<void>; inspect_object: (object_key: string) => Promise<{ sha256: string; version_id?: string; studio_request_id?: string } | undefined>; upload_object: (image: typeof prepared, studio_request_id: string) => Promise<{ version_id: string }>; delete_object: (object_key: string, version_id: string) => Promise<void> }, git?: { publish: () => Promise<{ ok: true; path: string; commit_sha: string; push_status: 'pushed' }> }) => ({ journal_root: root, public_site_url: 'https://site.example', image_options: { root_prefix: 'site', public_base_url: 'https://assets.example', max_bytes: 10, max_pixels: 10, max_width: 10, max_height: 10 }, cos, prepare_images: async () => [prepared], git: git ?? { publish: async () => ({ ok: true as const, path: 'src/content/writing/post.md', commit_sha: 'c'.repeat(40), push_status: 'pushed' as const }) } });
  const request_hash = (input = request): string => createHash('sha256').update(JSON.stringify({ protocol_version: 1, request_id: input.request_id, slug: input.slug, year: input.year, markdown: input.markdown, metadata: input.metadata, images: [{ source_path: 'figure.png', bytes: prepared.sha256, claimed_content_type: 'image/png', intent: 'diagram', semantic_name: 'figure' }], kind: input.kind, commit_message: input.commit_message })).digest('hex');

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
      await writeFile(join(transactions, `${request_id}.json`), JSON.stringify({ protocol_version: 1, request_id, payload_hash: 'b'.repeat(64), status: phase === 'ambiguous' ? 'recovery_required' : 'in_progress', phase, target_path: 'src/content/writing/post.md', owned: [{ object_key: prepared.object_key, version_id: 'v1', sha256: prepared.sha256 }] }));
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
    const result = await publish_article(request, { ...publication_dependencies(await journal_root(), { verify_versioning: async () => undefined, inspect_object: async () => undefined, upload_object: async () => ({ version_id: 'v1' }), delete_object: async () => undefined }), git: { publish: async (input) => { git_calls += 1; expect(new TextDecoder().decode(input.source)).toContain('https://assets.example/'); return { ok: true as const, path: 'src/content/writing/post.md', commit_sha: 'c'.repeat(40), push_status: 'pushed' as const }; } } });
    expect(result).toMatchObject({ kind: 'published', public_url: 'https://site.example/articles/post/' });
    expect(git_calls).toBe(1);
  });
  it('reports an unconfigured publisher without calling side-effect adapters', async () => {
    const result = await publish_article(request, { journal_root: await journal_root() });
    expect(result).toMatchObject({ kind: 'failed', errors: [{ code: 'not_publishable' }] });
  });
  it('replays a completed journal without repeating image or Git effects', async () => {
    const root = await journal_root(); let effects = 0; const dependencies = { ...publication_dependencies(root, { verify_versioning: async () => undefined, inspect_object: async () => undefined, upload_object: async () => { effects += 1; return { version_id: 'v1' }; }, delete_object: async () => undefined }), git: { publish: async () => { effects += 1; return { ok: true as const, path: 'x', commit_sha: 'd'.repeat(40), push_status: 'pushed' as const }; } } };
    await publish_article(request, dependencies); await publish_article(request, dependencies);
    expect(effects).toBe(2);
    const journal = await (await import('node:fs/promises')).readFile(join(root, '.studio/transactions', `${request.request_id}.json`), 'utf8');
    expect(journal).not.toContain(request.markdown); expect(journal).not.toContain('Description'); expect(journal).toContain('fig-01-figure.png');
  });
  it('retains created images when Git reports a retained local commit', async () => {
    let cleanup_calls = 0; const result = await publish_article(request, { ...publication_dependencies(await journal_root(), { verify_versioning: async () => undefined, inspect_object: async () => undefined, upload_object: async () => ({ version_id: 'v1' }), delete_object: async () => { cleanup_calls += 1; } }), prepare_images: async () => [], git: { publish: async () => ({ ok: false as const, code: 'push_failed' as const, commit_retained: true as const, message: 'push failed', commit_sha: 'e'.repeat(40), committed_paths: ['x'], recovery: 'push later' }) } });
    expect(result).toMatchObject({ kind: 'committed_local' }); expect(cleanup_calls).toBe(0);
  });
  it('uses metadata form values when serializing frontmatter', async () => {
    let source = ''; const changed = { ...request, request_id: '11111111111111111111111111111111', metadata: { ...request.metadata, featured: true, translation: 'en-post', social: { zhihu: false, wechat: true, xiaohongshu: false } } };
    await publish_article(changed, { ...publication_dependencies(await journal_root(), { verify_versioning: async () => undefined, inspect_object: async () => undefined, upload_object: async () => ({ version_id: 'v1' }), delete_object: async () => undefined }), prepare_images: async () => [], git: { publish: async (input) => { source = new TextDecoder().decode(input.source); return { ok: true as const, path: 'x', commit_sha: 'f'.repeat(40), push_status: 'pushed' as const }; } } });
    expect(source).toContain('translation: en-post'); expect(source).toContain('featured: true'); expect(source).toContain('zhihu: false');
  });
  it('rejects invalid metadata before any COS side effect', async () => {
    let uploads = 0; let inspections = 0; const invalid = { ...request, metadata: { ...request.metadata, title: '' } };
    const result = await publish_article(invalid, publication_dependencies(await journal_root(), { verify_versioning: async () => undefined, inspect_object: async () => { inspections += 1; return undefined; }, upload_object: async () => { uploads += 1; return { version_id: 'v1' }; }, delete_object: async () => undefined }));
    expect(result).toMatchObject({ kind: 'failed', errors: [{ code: 'invalid_field' }] }); expect(uploads).toBe(0); expect(inspections).toBe(0);
  });
  it('reuses a matching foreign object and never records or deletes it as owned', async () => {
    let uploads = 0; let deletes = 0; const result = await publish_article(request, { ...publication_dependencies(await journal_root(), { verify_versioning: async () => undefined, inspect_object: async () => ({ sha256: prepared.sha256, version_id: 'foreign-v1', studio_request_id: '1'.repeat(32) }), upload_object: async () => { uploads += 1; return { version_id: 'v1' }; }, delete_object: async () => { deletes += 1; } }), git: { publish: async () => ({ ok: false as const, code: 'stale_source' as const, message: 'changed' }) } });
    expect(result).toMatchObject({ kind: 'failed', cleanup: { deleted: [], failures: [] } }); expect(uploads).toBe(0); expect(deletes).toBe(0);
  });
  it('cleans only the exact created version when Git fails before committing', async () => {
    const deleted: Array<readonly [string, string]> = []; const result = await publish_article(request, { ...publication_dependencies(await journal_root(), { verify_versioning: async () => undefined, inspect_object: async () => undefined, upload_object: async () => ({ version_id: 'created-v1' }), delete_object: async (object_key, version_id) => { deleted.push([object_key, version_id]); } }), git: { publish: async () => ({ ok: false as const, code: 'stale_source' as const, message: 'source changed' }) } });
    expect(result).toMatchObject({ kind: 'failed', errors: [{ code: 'stale_source' }], cleanup: { deleted: [prepared.object_key], failures: [] } }); expect(deleted).toEqual([[prepared.object_key, 'created-v1']]);
  });
  it('reports deployment failure as advisory after a pushed publication', async () => {
    const result = await publish_article(request, { ...publication_dependencies(await journal_root(), { verify_versioning: async () => undefined, inspect_object: async () => undefined, upload_object: async () => ({ version_id: 'v1' }), delete_object: async () => undefined }), deployment: { report: async () => { throw new Error('offline'); } } });
    expect(result).toMatchObject({ kind: 'published', deployment_advisory: 'Deployment status could not be confirmed.' });
  });
  it('preserves assets when Git throws after the durable git_pending marker', async () => {
    let deletes = 0; const root = await journal_root(); const result = await publish_article(request, { ...publication_dependencies(root, { verify_versioning: async () => undefined, inspect_object: async () => undefined, upload_object: async () => ({ version_id: 'v1' }), delete_object: async () => { deletes += 1; } }), git: { publish: async () => { throw new Error('lost Git response'); } } });
    expect(result).toMatchObject({ kind: 'recovery_required', errors: [{ code: 'git_ambiguous' }] }); expect(deletes).toBe(0);
    await expect(cleanup_studio_transaction(root, request.request_id, { verify_versioning: async () => undefined, inspect_object: async () => undefined, upload_object: async () => ({ version_id: 'unused' }), delete_object: async () => { deletes += 1; } })).resolves.toMatchObject({ kind: 'recovery_required' }); expect(deletes).toBe(0);
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
