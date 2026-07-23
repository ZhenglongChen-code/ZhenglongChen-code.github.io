import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validate_studio_request } from '../src/lib/studio_protocol';
import { publish_article } from '../src/lib/studio_publish';

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
  it('publishes prepared assets once then sends normalized article to Git', async () => {
    let git_calls = 0;
    const result = await publish_article(request, { journal_root: await journal_root(), public_site_url: 'https://site.example', image_options: { root_prefix: 'site', public_base_url: 'https://assets.example', max_bytes: 10, max_pixels: 10, max_width: 10, max_height: 10 }, prepare_images: async () => [{ source_path: 'figure.png', object_key: 'site/articles/2026/post/fig-01-figure.png', public_url: 'https://assets.example/site/articles/2026/post/fig-01-figure.png', bytes: new Uint8Array([1]), content_type: 'image/png', sha256: 'a'.repeat(64) }], publish_images: async () => ({ objects: [{ source_path: 'figure.png', object_key: 'site/articles/2026/post/fig-01-figure.png', public_url: 'https://assets.example/site/articles/2026/post/fig-01-figure.png', bytes: new Uint8Array([1]), content_type: 'image/png', sha256: 'a'.repeat(64), status: 'created' as const, version_id: 'v1' }], manifest: [{ source_path: 'figure.png', object_key: 'site/articles/2026/post/fig-01-figure.png', public_url: 'https://assets.example/site/articles/2026/post/fig-01-figure.png' }] }), git: { publish: async (input) => { git_calls += 1; expect(new TextDecoder().decode(input.source)).toContain('https://assets.example/'); return { ok: true, path: 'src/content/writing/post.md', commit_sha: 'c'.repeat(40), push_status: 'pushed' }; } } });
    expect(result).toMatchObject({ kind: 'published', public_url: 'https://site.example/articles/post/' });
    expect(git_calls).toBe(1);
  });
  it('reports an unconfigured publisher without calling side-effect adapters', async () => {
    const result = await publish_article(request, { journal_root: await journal_root() });
    expect(result).toMatchObject({ kind: 'failed', errors: [{ code: 'not_publishable' }] });
  });
  it('replays a completed journal without repeating image or Git effects', async () => {
    const root = await journal_root(); let effects = 0; const dependencies = { journal_root: root, public_site_url: 'https://site.example', image_options: { root_prefix: 'site', public_base_url: 'https://assets.example', max_bytes: 10, max_pixels: 10, max_width: 10, max_height: 10 }, prepare_images: async () => [{ source_path: 'figure.png', object_key: 'site/articles/2026/post/fig-01-figure.png', public_url: 'https://assets.example/site/articles/2026/post/fig-01-figure.png', bytes: new Uint8Array([1]), content_type: 'image/png' as const, sha256: 'a'.repeat(64) }], publish_images: async () => { effects += 1; return { objects: [], manifest: [] }; }, git: { publish: async () => { effects += 1; return { ok: true as const, path: 'x', commit_sha: 'd'.repeat(40), push_status: 'pushed' as const }; } } };
    await publish_article(request, dependencies); await publish_article(request, dependencies);
    expect(effects).toBe(2);
    const journal = await (await import('node:fs/promises')).readFile(join(root, '.studio/transactions', `${request.request_id}.json`), 'utf8');
    expect(journal).not.toContain(request.markdown); expect(journal).not.toContain('Description'); expect(journal).not.toContain('figure.png');
  });
  it('retains created images when Git reports a retained local commit', async () => {
    let cleanup_calls = 0; const result = await publish_article(request, { journal_root: await journal_root(), public_site_url: 'https://site.example', image_options: { root_prefix: 'site', public_base_url: 'https://assets.example', max_bytes: 10, max_pixels: 10, max_width: 10, max_height: 10 }, prepare_images: async () => [], publish_images: async () => ({ objects: [], manifest: [] }), cleanup_images: async () => { cleanup_calls += 1; return { deleted: [], failures: [] }; }, git: { publish: async () => ({ ok: false as const, code: 'push_failed' as const, message: 'push failed', commit_sha: 'e'.repeat(40), committed_paths: ['x'], recovery: 'push later' }) } });
    expect(result).toMatchObject({ kind: 'committed_local' }); expect(cleanup_calls).toBe(0);
  });
  it('uses metadata form values when serializing frontmatter', async () => {
    let source = ''; const changed = { ...request, request_id: '11111111111111111111111111111111', metadata: { ...request.metadata, featured: true, translation: 'en-post', social: { zhihu: false, wechat: true, xiaohongshu: false } } };
    await publish_article(changed, { journal_root: await journal_root(), public_site_url: 'https://site.example', image_options: { root_prefix: 'site', public_base_url: 'https://assets.example', max_bytes: 10, max_pixels: 10, max_width: 10, max_height: 10 }, prepare_images: async () => [], publish_images: async () => ({ objects: [], manifest: [] }), git: { publish: async (input) => { source = new TextDecoder().decode(input.source); return { ok: true as const, path: 'x', commit_sha: 'f'.repeat(40), push_status: 'pushed' as const }; } } });
    expect(source).toContain('translation: en-post'); expect(source).toContain('featured: true'); expect(source).toContain('zhihu: false');
  });
});
