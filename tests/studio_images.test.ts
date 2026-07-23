import sharp from 'sharp';
import remark_parse from 'remark-parse';
import { unified as unified_processor } from 'unified';
import { describe, expect, it } from 'vitest';
import {
  build_article_object_key,
  cleanup_created_images,
  prepare_article_images,
  publish_prepared_images,
  rewrite_markdown_images,
  tencent_cos_adapter,
  type cos_adapter,
} from '../src/lib/studio_images';

const png_bytes = async (width = 8, height = 6, alpha = false): Promise<Uint8Array> => (
  new Uint8Array(await sharp({ create: { width, height, channels: alpha ? 4 : 3, background: alpha ? { r: 1, g: 2, b: 3, alpha: 0.5 } : '#102030' } }).png().toBuffer())
);
const jpeg_bytes = async (): Promise<Uint8Array> => new Uint8Array(await sharp({ create: { width: 8, height: 6, channels: 3, background: '#102030' } }).jpeg().toBuffer());

class fake_cos_adapter implements cos_adapter {
  readonly objects = new Map<string, string>();
  readonly uploads: string[] = [];
  readonly deletes: string[] = [];
  readonly delete_failures = new Set<string>();
  async verify_versioning(): Promise<void> {}
  async inspect_object(object_key: string): Promise<{ sha256: string } | undefined> { const sha256 = this.objects.get(object_key); return sha256 === undefined ? undefined : { sha256 }; }
  async upload_object(input: { object_key: string; sha256: string }): Promise<{ version_id: string }> { this.uploads.push(input.object_key); this.objects.set(input.object_key, input.sha256); return { version_id: `version-${this.uploads.length}` }; }
  async delete_object(object_key: string, version_id: string): Promise<void> { if (!version_id) throw new Error('missing version'); this.deletes.push(object_key); if (this.delete_failures.has(object_key)) throw new Error('delete failed'); this.objects.delete(object_key); }
}

describe('studio_images', () => {
  it('builds a stable lower-case COS key under the configured prefix', () => {
    expect(build_article_object_key({ root_prefix: 'latent-field', year: 2026, slug: 'vlm-evaluation', figure_number: 1, semantic_name: 'attention-map', extension: 'webp' })).toBe('latent-field/articles/2026/vlm-evaluation/fig-01-attention-map.webp');
  });

  it('rejects unsafe key components and public bases', () => {
    for (const semantic_name of ['../x', 'a\\b', '/a', 'a//b', 'attention map', '注意力图', 'a\u0000b']) expect(() => build_article_object_key({ root_prefix: 'latent-field', year: 2026, slug: 'vlm-evaluation', figure_number: 1, semantic_name, extension: 'webp' })).toThrow(/invalid/i);
    expect(() => build_article_object_key({ root_prefix: 'latent field', year: 2026, slug: 'vlm-evaluation', figure_number: 1, semantic_name: 'map', extension: 'gif' })).toThrow(/invalid/i);
  });

  it('normalizes photos to deterministic webp and retains intentional transparent diagrams as png', async () => {
    const sources = [
      { source_path: 'photo.jpg', bytes: await jpeg_bytes(), claimed_content_type: 'image/jpeg' as const, intent: 'photo' as const, semantic_name: 'attention-map' },
      { source_path: 'diagram.png', bytes: await png_bytes(8, 6, true), claimed_content_type: 'image/png' as const, intent: 'diagram' as const, semantic_name: 'model-diagram' },
    ];
    const options = { root_prefix: 'latent-field', public_base_url: 'https://cdn.example.com/images', year: 2026, slug: 'vlm-evaluation', max_bytes: 1_000_000, max_pixels: 1_000_000, max_width: 1000, max_height: 1000 };
    const first = await prepare_article_images(sources, options);
    const second = await prepare_article_images(sources, options);
    expect(first.images.map((image) => image.object_key)).toEqual(['latent-field/articles/2026/vlm-evaluation/fig-01-attention-map.webp', 'latent-field/articles/2026/vlm-evaluation/fig-02-model-diagram.png']);
    expect(first.images[0]!.bytes).toEqual(second.images[0]!.bytes);
    expect(first.images[0]!.content_type).toBe('image/webp');
    expect(first.images[1]!.content_type).toBe('image/png');
    expect((await sharp(first.images[1]!.bytes).metadata()).hasAlpha).toBe(true);
  });

  it('rejects MIME mismatch, corrupted files, unsupported input, and resource-limit violations', async () => {
    const valid_png = await png_bytes();
    const options = { root_prefix: 'latent-field', public_base_url: 'https://cdn.example.com', year: 2026, slug: 'vlm-evaluation', max_bytes: valid_png.length - 1, max_pixels: 10, max_width: 1000, max_height: 1000 };
    await expect(prepare_article_images([{ source_path: 'x.png', bytes: valid_png, claimed_content_type: 'image/jpeg', intent: 'screenshot', semantic_name: 'x' }], options)).rejects.toMatchObject({ code: 'validation' });
    await expect(prepare_article_images([{ source_path: 'x.png', bytes: new Uint8Array([1, 2, 3]), claimed_content_type: 'image/png', intent: 'screenshot', semantic_name: 'x' }], { ...options, max_bytes: 1000, max_pixels: 1000 })).rejects.toMatchObject({ code: 'validation' });
    await expect(prepare_article_images([{ source_path: 'x.gif', bytes: valid_png, claimed_content_type: 'image/png', intent: 'screenshot', semantic_name: 'x' }], { ...options, max_bytes: 1000, max_pixels: 1000 })).rejects.toMatchObject({ code: 'validation' });
    await expect(prepare_article_images([{ source_path: 'x.png', bytes: valid_png, claimed_content_type: 'image/png', intent: 'screenshot', semantic_name: 'x' }], options)).rejects.toMatchObject({ code: 'validation' });
  });

  it('rewrites only local image destinations, honoring definitions and Markdown syntax', () => {
    const markdown = '![one](images/a(1).png) ![two](<images/a b.png>) ![ref][figure] ![again][FIGURE]\n\n[figure]: images/ref.png\n[figure]: ignored.png\n\n`![code](images/no.png)`\n\n```md\n![fence](images/nope.png)\n```';
    const result = rewrite_markdown_images(markdown, new Map([
      ['images/a(1).png', 'https://cdn.example.com/a.webp'], ['images/a b.png', 'https://cdn.example.com/b.webp'], ['images/ref.png', 'https://cdn.example.com/ref.webp'],
    ]));
    expect(result).toContain('![one](https://cdn.example.com/a.webp)');
    expect(result).toContain('![two](<https://cdn.example.com/b.webp>)');
    expect(result).toContain('[figure]: https://cdn.example.com/ref.webp');
    expect(result).toContain('[figure]: ignored.png');
    expect(result).toContain('`![code](images/no.png)`');
    expect(result).toContain('![fence](images/nope.png)');
  });

  it('publishes immutable manifest entries, reuses matching objects, detects collisions, and cleans up only created keys', async () => {
    const prepared = (await prepare_article_images([{ source_path: 'shot.png', bytes: await png_bytes(), claimed_content_type: 'image/png', intent: 'screenshot', semantic_name: 'screen' }], { root_prefix: 'latent-field', public_base_url: 'https://cdn.example.com/base', year: 2026, slug: 'vlm-evaluation', max_bytes: 1_000_000, max_pixels: 1_000_000, max_width: 1000, max_height: 1000 })).images;
    const cos = new fake_cos_adapter();
    const published = await publish_prepared_images(prepared, cos);
    expect(published.manifest).toEqual([{ source_path: 'shot.png', object_key: prepared[0]!.object_key, public_url: prepared[0]!.public_url }]);
    expect(published.objects[0]!.status).toBe('created');
    const reused = await publish_prepared_images(prepared, cos);
    expect(reused.objects[0]!.status).toBe('reused');
    cos.objects.set(prepared[0]!.object_key, 'different');
    await expect(publish_prepared_images(prepared, cos)).rejects.toMatchObject({ code: 'collision' });
    cos.delete_failures.add(prepared[0]!.object_key);
    const cleanup = await cleanup_created_images(published.objects, cos);
    expect(cleanup.deleted).toEqual([]);
    expect(cleanup.failures).toEqual([prepared[0]!.object_key]);
  });

  it('rejects unsafe paired source paths before image decoding', async () => {
    const bytes = await png_bytes();
    const options = { root_prefix: 'latent-field', public_base_url: 'https://cdn.example.com', year: 2026, slug: 'vlm-evaluation', max_bytes: 1_000_000, max_pixels: 1_000_000, max_width: 1000, max_height: 1000 };
    for (const source_path of ['../x.png', '%2e%2e/x.png', 'a%2fb.png', '/x.png', '//host/x.png', 'a\\b.png', 'a b.png', '图.png', 'a.png?x=1', 'a.png#x', 'a.gif']) {
      await expect(prepare_article_images([{ source_path, bytes, claimed_content_type: 'image/png', intent: 'diagram', semantic_name: 'map' }], options)).rejects.toMatchObject({ code: 'validation' });
    }
  });

  it('preserves opaque diagrams as PNG and rejects dimensions beyond separate limits', async () => {
    const options = { root_prefix: 'latent-field', public_base_url: 'https://cdn.example.com', year: 2026, slug: 'vlm-evaluation', max_bytes: 1_000_000, max_pixels: 1_000_000, max_width: 20, max_height: 20 };
    const result = await prepare_article_images([{ source_path: 'diagram.png', bytes: await png_bytes(), claimed_content_type: 'image/png', intent: 'diagram', semantic_name: 'map' }], options);
    expect(result.images[0]!.content_type).toBe('image/png');
    await expect(prepare_article_images([{ source_path: 'wide.png', bytes: await png_bytes(21, 1), claimed_content_type: 'image/png', intent: 'screenshot', semantic_name: 'wide' }], options)).rejects.toMatchObject({ code: 'validation' });
  });

  it('rewrites local destinations with titles, only the effective definition, and never a remote map match', () => {
    const result = rewrite_markdown_images('![one](./a.png "caption") ![ref][FIG]\n![remote](https://x/a.png)\n\n[fig]: ref.png "title"\n[FIG]: ref.png', new Map([['./a.png', 'https://cdn.example.com/a.webp'], ['ref.png', 'https://cdn.example.com/ref.webp'], ['https://x/a.png', 'https://cdn.example.com/no.webp']]));
    expect(result).toContain('![one](https://cdn.example.com/a.webp "caption")');
    expect(result).toContain('[fig]: https://cdn.example.com/ref.webp "title"');
    expect(result).toContain('[FIG]: ref.png');
    expect(result).toContain('![remote](https://x/a.png)');
  });

  it('treats missing remote digests as a safe COS failure and only 404 as absent', async () => {
    const valid_config = { secret_id: 'id', secret_key: 'key', region: 'ap-guangzhou', bucket: 'bucket-1234567890', root_prefix: 'latent-field', public_base_url: 'https://cdn.example.com' };
    const missing_digest_client = { getBucketVersioning: async () => ({ VersioningConfiguration: { Status: 'Enabled' as const } }), headObject: async () => ({ headers: {} }), putObject: async () => ({ VersionId: 'v' }), deleteObject: async () => ({}) };
    const missing_digest_adapter = new tencent_cos_adapter(valid_config, () => missing_digest_client);
    await expect(missing_digest_adapter.inspect_object('latent-field/articles/2026/vlm-evaluation/fig-01-map.webp')).rejects.toMatchObject({ code: 'missing_remote_digest' });
    const absent_client = { getBucketVersioning: async () => ({ VersioningConfiguration: { Status: 'Enabled' as const } }), headObject: async () => { throw { statusCode: 404 }; }, putObject: async () => ({ VersionId: 'v' }), deleteObject: async () => ({}) };
    await expect(new tencent_cos_adapter(valid_config, () => absent_client).inspect_object('latent-field/articles/2026/vlm-evaluation/fig-01-map.webp')).resolves.toBeUndefined();
  });

  it('rejects invalid COS config and object keys before creating or calling a client', async () => {
    let factory_calls = 0;
    const factory = () => { factory_calls += 1; return { getBucketVersioning: async () => ({ VersioningConfiguration: { Status: 'Enabled' as const } }), headObject: async () => ({ headers: { 'x-cos-meta-sha256': 'x' } }), putObject: async () => ({ VersionId: 'v' }), deleteObject: async () => ({}) }; };
    expect(() => new tencent_cos_adapter({ secret_id: ' ', secret_key: 'key', region: 'bad region', bucket: 'bucket', root_prefix: '../x', public_base_url: 'http://user:pass@example.com' }, factory)).toThrow(/invalid/i);
    expect(factory_calls).toBe(0);
    const adapter = new tencent_cos_adapter({ secret_id: 'id', secret_key: 'key', region: 'ap-guangzhou', bucket: 'bucket-1234567890', root_prefix: 'latent-field', public_base_url: 'https://cdn.example.com' }, factory);
    await expect(adapter.delete_object('../unsafe', 'v')).rejects.toMatchObject({ code: 'validation' });
  });

  it('locates destinations without changing matching alt text, labels, escapes, or titles', () => {
    const result = rewrite_markdown_images('![images/a.png](images/a.png "images/a.png") ![images/a.png][images/a.png]\n\n[images/a.png]: images/a\\(1\\).png "images/a.png"', new Map([['images/a.png', 'https://cdn.example.com/plain.webp'], ['images/a(1).png', 'https://cdn.example.com/escaped.webp']]));
    expect(result).toBe('![images/a.png](https://cdn.example.com/plain.webp "images/a.png") ![images/a.png][images/a.png]\n\n[images/a.png]: https://cdn.example.com/escaped.webp "images/a.png"');
  });

  it('rewrites only canonical local Markdown paths', () => {
    const result = rewrite_markdown_images('![a](a//b.png) ![b](./b.png) ![c](../c.png) ![d](a\\d.png) ![e](<a b.png>)', new Map([['a//b.png', 'https://x/no'], ['./b.png', 'https://x/b'], ['../c.png', 'https://x/no'], ['a\\d.png', 'https://x/no'], ['a b.png', 'https://x/space']]));
    expect(result).toBe('![a](a//b.png) ![b](https://x/b) ![c](../c.png) ![d](a\\d.png) ![e](<https://x/space>)');
  });

  it('applies width limits after EXIF orientation and rejects noncanonical public bases', async () => {
    const oriented = new Uint8Array(await sharp({ create: { width: 10, height: 30, channels: 3, background: '#102030' } }).withMetadata({ orientation: 6 }).jpeg().toBuffer());
    await expect(prepare_article_images([{ source_path: 'rotated.jpg', bytes: oriented, claimed_content_type: 'image/jpeg', intent: 'photo', semantic_name: 'rotated' }], { root_prefix: 'latent-field', public_base_url: 'https://cdn.example.com/', year: 2026, slug: 'vlm-evaluation', max_bytes: 1_000_000, max_pixels: 1_000_000, max_width: 20, max_height: 40 })).rejects.toMatchObject({ code: 'validation' });
    for (const public_base_url of [' https://cdn.example.com', 'https://cdn.example.com/a//b', 'https://cdn.example.com/a/../b', 'https://cdn.example.com/a%2fb', 'https://cdn.example.com/a%2eb']) {
      await expect(prepare_article_images([{ source_path: 'x.png', bytes: await png_bytes(), claimed_content_type: 'image/png', intent: 'diagram', semantic_name: 'x' }], { root_prefix: 'latent-field', public_base_url, year: 2026, slug: 'vlm-evaluation', max_bytes: 1_000_000, max_pixels: 1_000_000, max_width: 100, max_height: 100 })).rejects.toMatchObject({ code: 'validation' });
    }
  });

  it('rejects invalid adapter keys before all SDK operations', async () => {
    let calls = 0;
    const client = { getBucketVersioning: async () => ({ VersioningConfiguration: { Status: 'Enabled' as const } }), headObject: async () => { calls += 1; return { headers: { 'x-cos-meta-sha256': 'a'.repeat(64) } }; }, putObject: async () => { calls += 1; return { VersionId: 'v' }; }, deleteObject: async () => { calls += 1; return {}; } };
    const adapter = new tencent_cos_adapter({ secret_id: 'id', secret_key: 'key', region: 'ap-shanghai', bucket: 'bucket-1234567890', root_prefix: 'latent-field', public_base_url: 'https://cdn.example.com' }, () => client);
    const bad_key = 'latent-field/articles/2026/vlm-evaluation/fig-1-bad.webp';
    await expect(adapter.inspect_object(bad_key)).rejects.toMatchObject({ code: 'validation' });
    await expect(adapter.upload_object({ bytes: new Uint8Array(), content_type: 'image/webp', object_key: bad_key, public_url: 'https://cdn.example.com/x', sha256: 'a'.repeat(64), source_path: 'x.png' })).rejects.toMatchObject({ code: 'validation' });
    await expect(adapter.delete_object(bad_key, 'v')).rejects.toMatchObject({ code: 'validation' });
    expect(calls).toBe(0);
  });

  it('rewrites nested inline labels and escaped definition labels without touching labels or titles', () => {
    const result = rewrite_markdown_images('![a [b]](images/a.png "title") ![ref][a\\]:b]\n\n[a\\]:b]: images/b.png "t"', new Map([['images/a.png', 'https://x/a'], ['images/b.png', 'https://x/b']]));
    expect(result).toBe('![a [b]](https://x/a "title") ![ref][a\\]:b]\n\n[a\\]:b]: https://x/b "t"');
  });

  it('does not rewrite malformed or percent-encoded unsafe local destinations', () => {
    const result = rewrite_markdown_images('![dot](%2e%2e/a.png) ![slash](a%2fb.png) ![bad](bad%zz.png) ![good](images/a.png)', new Map([['%2e%2e/a.png', 'https://x/no'], ['a%2fb.png', 'https://x/no'], ['bad%zz.png', 'https://x/no'], ['images/a.png', 'https://x/good']]));
    expect(result).toBe('![dot](%2e%2e/a.png) ![slash](a%2fb.png) ![bad](bad%zz.png) ![good](https://x/good)');
  });

  it('accepts every builder key at the COS boundary and rejects hierarchy near misses', async () => {
    const client = { getBucketVersioning: async () => ({ VersioningConfiguration: { Status: 'Enabled' as const } }), headObject: async () => ({ headers: { 'x-cos-meta-sha256': 'a'.repeat(64) } }), putObject: async () => ({ VersionId: 'v' }), deleteObject: async () => ({}) };
    const adapter = new tencent_cos_adapter({ secret_id: 'id', secret_key: 'key', region: 'ap-shanghai', bucket: 'bucket-1234567890', root_prefix: 'latent-field', public_base_url: 'https://cdn.example.com' }, () => client);
    const built = build_article_object_key({ root_prefix: 'latent-field', year: 2026, slug: 'vlm-evaluation', figure_number: 100, semantic_name: 'map', extension: 'webp' });
    await expect(adapter.inspect_object(built)).resolves.toEqual({ sha256: 'a'.repeat(64) });
    for (const key of ['latent-field/articles/0000/vlm-evaluation/fig-100-map.webp', 'latent-field/articles/2026/vlm-evaluation/cover.png', 'latent-field/articles/2026/vlm-evaluation/fig-100-map.jpg']) await expect(adapter.inspect_object(key)).rejects.toMatchObject({ code: 'validation' });
  });

  it('rejects raw backslashes in public bases and credential controls before client construction', () => {
    let calls = 0;
    const factory = () => { calls += 1; return { getBucketVersioning: async () => ({ VersioningConfiguration: { Status: 'Enabled' as const } }), headObject: async () => ({ headers: {} }), putObject: async () => ({ VersionId: 'v' }), deleteObject: async () => ({}) }; };
    expect(() => new tencent_cos_adapter({ secret_id: 'id\n', secret_key: 'key', region: 'ap-shanghai', bucket: 'bucket-1234567890', root_prefix: 'latent-field', public_base_url: 'https://cdn.example.com\\evil' }, factory)).toThrow(/invalid/i);
    expect(calls).toBe(0);
  });

  it('rejects recursively encoded traversal in rewrite and paired source paths', async () => {
    const bytes = await png_bytes();
    const options = { root_prefix: 'latent-field', public_base_url: 'https://cdn.example.com', year: 2026, slug: 'vlm-evaluation', max_bytes: 1_000_000, max_pixels: 1_000_000, max_width: 100, max_height: 100 };
    expect(rewrite_markdown_images('![x](%252e%252e/a.png) ![ok](a.png)', new Map([['%252e%252e/a.png', 'https://x/no'], ['a.png', 'https://x/ok']]))).toBe('![x](%252e%252e/a.png) ![ok](https://x/ok)');
    await expect(prepare_article_images([{ source_path: '%252e%252e/a.png', bytes, claimed_content_type: 'image/png', intent: 'diagram', semantic_name: 'map' }], options)).rejects.toMatchObject({ code: 'validation' });
  });

  it('accepts exactly builder-shaped figure sequences at the adapter boundary', async () => {
    const client = { getBucketVersioning: async () => ({ VersioningConfiguration: { Status: 'Enabled' as const } }), headObject: async () => ({ headers: { 'x-cos-meta-sha256': 'a'.repeat(64) } }), putObject: async () => ({ VersionId: 'v' }), deleteObject: async () => ({}) };
    const adapter = new tencent_cos_adapter({ secret_id: 'id', secret_key: 'key', region: 'ap-shanghai', bucket: 'bucket-1234567890', root_prefix: 'latent-field', public_base_url: 'https://cdn.example.com' }, () => client);
    for (const figure of [1, 9, 10, 100]) await expect(adapter.inspect_object(build_article_object_key({ root_prefix: 'latent-field', year: 2026, slug: 'vlm-evaluation', figure_number: figure, semantic_name: 'map', extension: 'webp' }))).resolves.toBeDefined();
    for (const sequence of ['00', '0001', '010']) await expect(adapter.inspect_object(`latent-field/articles/2026/vlm-evaluation/fig-${sequence}-map.webp`)).rejects.toMatchObject({ code: 'validation' });
  });

  it('rejects raw and encoded C0/C1 controls in public bases and credentials', async () => {
    const bytes = await png_bytes();
    const options = { root_prefix: 'latent-field', year: 2026, slug: 'vlm-evaluation', max_bytes: 1_000_000, max_pixels: 1_000_000, max_width: 100, max_height: 100 };
    for (const public_base_url of ['https://cdn.example.com/\u0001x', 'https://cdn.example.com/%00x', 'https://cdn.example.com/%80x']) await expect(prepare_article_images([{ source_path: 'x.png', bytes, claimed_content_type: 'image/png', intent: 'diagram', semantic_name: 'x' }], { ...options, public_base_url })).rejects.toMatchObject({ code: 'validation' });
    expect(() => new tencent_cos_adapter({ secret_id: 'id\u0080', secret_key: 'key', region: 'ap-shanghai', bucket: 'bucket-1234567890', root_prefix: 'latent-field', public_base_url: 'https://cdn.example.com' })).toThrow(/invalid/i);
  });

  it('normalizes valid uppercase remote digests before idempotent reuse', async () => {
    const prepared = (await prepare_article_images([{ source_path: 'x.png', bytes: await png_bytes(), claimed_content_type: 'image/png', intent: 'diagram', semantic_name: 'map' }], { root_prefix: 'latent-field', public_base_url: 'https://cdn.example.com', year: 2026, slug: 'vlm-evaluation', max_bytes: 1_000_000, max_pixels: 1_000_000, max_width: 100, max_height: 100 })).images;
    const image = prepared[0]!;
    const client = { getBucketVersioning: async () => ({ VersioningConfiguration: { Status: 'Enabled' as const } }), headObject: async () => ({ headers: { 'x-cos-meta-sha256': image.sha256.toUpperCase() } }), putObject: async () => ({ VersionId: 'v' }), deleteObject: async () => ({}) };
    const adapter = new tencent_cos_adapter({ secret_id: 'id', secret_key: 'key', region: 'ap-shanghai', bucket: 'bucket-1234567890', root_prefix: 'latent-field', public_base_url: 'https://cdn.example.com' }, () => client);
    await expect(publish_prepared_images(prepared, adapter)).resolves.toMatchObject({ objects: [{ status: 'reused' }] });
  });

  it('uses versioned create-only ownership and cleanup tokens', async () => {
    const image = (await prepare_article_images([{ source_path: 'x.png', bytes: await png_bytes(), claimed_content_type: 'image/png', intent: 'diagram', semantic_name: 'map' }], { root_prefix: 'latent-field', public_base_url: 'https://cdn.example.com', year: 2026, slug: 'vlm-evaluation', max_bytes: 1_000_000, max_pixels: 1_000_000, max_width: 100, max_height: 100 })).images[0]!;
    const calls: unknown[] = [];
    const client = { getBucketVersioning: async () => ({ VersioningConfiguration: { Status: 'Enabled' as const } }), headObject: async () => { throw { statusCode: 404 }; }, putObject: async (input: unknown) => { calls.push(input); return { VersionId: 'version-1' }; }, deleteObject: async (input: unknown) => { calls.push(input); return {}; } };
    const adapter = new tencent_cos_adapter({ secret_id: 'id', secret_key: 'key', region: 'ap-shanghai', bucket: 'bucket-1234567890', root_prefix: 'latent-field', public_base_url: 'https://cdn.example.com' }, () => client);
    const published = await publish_prepared_images([image], adapter);
    expect(published.objects[0]).toMatchObject({ status: 'created', version_id: 'version-1' });
    await cleanup_created_images(published.objects, adapter);
    expect(calls).toEqual(expect.arrayContaining([expect.objectContaining({ Headers: { 'If-None-Match': '*' } }), expect.objectContaining({ VersionId: 'version-1' })]));
  });

  it('preserves the version-owned success ledger when a later upload has a network failure', async () => {
    const images = (await prepare_article_images([
      { source_path: 'a.png', bytes: await png_bytes(), claimed_content_type: 'image/png', intent: 'diagram', semantic_name: 'a' },
      { source_path: 'b.png', bytes: await png_bytes(), claimed_content_type: 'image/png', intent: 'diagram', semantic_name: 'b' },
    ], { root_prefix: 'latent-field', public_base_url: 'https://cdn.example.com', year: 2026, slug: 'vlm-evaluation', max_bytes: 1_000_000, max_pixels: 1_000_000, max_width: 100, max_height: 100 })).images;
    let upload_count = 0;
    const adapter: cos_adapter = {
      verify_versioning: async () => {},
      inspect_object: async () => undefined,
      upload_object: async () => { upload_count += 1; if (upload_count === 2) throw new Error('network down'); return { version_id: 'version-a' }; },
      delete_object: async () => {},
    };
    await expect(publish_prepared_images(images, adapter)).rejects.toMatchObject({ name: 'studio_image_publish_error', successful_objects: [expect.objectContaining({ status: 'created', version_id: 'version-a' })], cause_error: expect.objectContaining({ message: 'network down' }) });
  });

  it('encodes public-base path delimiters before Markdown rewrite', async () => {
    const prepared = await prepare_article_images([{ source_path: 'x.png', bytes: await png_bytes(), claimed_content_type: 'image/png', intent: 'diagram', semantic_name: 'x' }], { root_prefix: 'latent-field', public_base_url: 'https://cdn.example.com/a)b', year: 2026, slug: 'vlm-evaluation', max_bytes: 1_000_000, max_pixels: 1_000_000, max_width: 100, max_height: 100 });
    const rewritten = rewrite_markdown_images('![x](x.png)', new Map([['x.png', prepared.images[0]!.public_url]]));
    const tree = unified_processor().use(remark_parse).parse(rewritten) as { children: Array<{ children?: Array<{ url?: string }> }> };
    expect(rewritten).toBe('![x](https://cdn.example.com/a%29b/latent-field/articles/2026/vlm-evaluation/fig-01-x.png)');
    expect(tree.children[0]!.children![0]!.url).toBe('https://cdn.example.com/a%29b/latent-field/articles/2026/vlm-evaluation/fig-01-x.png');
  });

  it('rejects invalid manifest keys before source processing', async () => {
    await expect(prepare_article_images([], { root_prefix: 'latent-field', public_base_url: 'https://cdn.example.com', year: 1, slug: '../bad', max_bytes: 1_000, max_pixels: 1_000, max_width: 10, max_height: 10 })).rejects.toMatchObject({ code: 'validation' });
  });

  it('uses a snapshot when caller mutates an image while inspection is pending', async () => {
    const image = (await prepare_article_images([{ source_path: 'x.png', bytes: await png_bytes(), claimed_content_type: 'image/png', intent: 'diagram', semantic_name: 'map' }], { root_prefix: 'latent-field', public_base_url: 'https://cdn.example.com', year: 2026, slug: 'vlm-evaluation', max_bytes: 1_000_000, max_pixels: 1_000_000, max_width: 100, max_height: 100 })).images[0]!;
    let release_inspect: (() => void) | undefined;
    const inspected = new Promise<void>((resolve) => { release_inspect = resolve; });
    const uploaded: string[] = [];
    const adapter: cos_adapter = { verify_versioning: async () => {}, inspect_object: async () => { await inspected; return undefined; }, upload_object: async (input) => { uploaded.push(input.object_key); return { version_id: 'v' }; }, delete_object: async () => {} };
    const publishing = publish_prepared_images([image], adapter);
    image.object_key = 'mutated'; image.sha256 = '0'.repeat(64); image.bytes[0] = 0; release_inspect!();
    await expect(publishing).resolves.toMatchObject({ objects: [expect.objectContaining({ object_key: 'latent-field/articles/2026/vlm-evaluation/fig-01-map.png' })] });
    expect(uploaded).toEqual(['latent-field/articles/2026/vlm-evaluation/fig-01-map.png']);
  });
});
