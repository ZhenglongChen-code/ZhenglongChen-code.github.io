import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { request as node_request } from 'node:http';
import { create_studio_server } from '../scripts/studio';

type server_instance = ReturnType<typeof create_studio_server>;

const valid_markdown = '---\ntitle: Formula\ndescription: A safe preview.\ndate: 2026-07-23\n---\n\n$y = x$\n';
const valid_publish_request = {
  protocol_version: 1,
  kind: 'publish_new',
  request_id: '0123456789abcdef0123456789abcdef',
  slug: 'formula',
  year: 2026,
  markdown: valid_markdown,
  metadata: { title: 'Formula', description: 'A safe preview.', date: '2026-07-23' },
  commit_message: 'content: publish formula',
};

const instances: server_instance[] = [];
const roots: string[] = [];

/** Starts the loopback-only server on a unique test port with minimal built assets. */
const start_server = async (options: Parameters<typeof create_studio_server>[0] = {}): Promise<{ instance: server_instance; base_url: string; dist: string }> => {
  const root = await mkdtemp(join(tmpdir(), 'studio-server-'));
  roots.push(root);
  const dist = join(root, 'studio-dist');
  await mkdir(dist);
  await writeFile(join(dist, 'index.html'), '<!doctype html><title>Studio</title>');
  await writeFile(join(dist, 'app.js'), 'console.log("studio")');
  const instance = create_studio_server({ studio_dist: dist, ...options });
  instances.push(instance);
  await new Promise<void>((resolve_listener, reject_listener) => {
    instance.server.once('error', reject_listener);
    instance.server.listen(0, '127.0.0.1', () => {
      instance.server.off('error', reject_listener);
      resolve_listener();
    });
  });
  const address = instance.server.address() as AddressInfo;
  return { instance, base_url: `http://127.0.0.1:${address.port}`, dist };
};

/** Sends a same-origin request while preserving the explicit local security boundary. */
const request = async (base_url: string, path: string, init: RequestInit = {}): Promise<Response> => fetch(`${base_url}${path}`, {
  ...init,
  headers: { Host: base_url.replace('http://', ''), Origin: base_url, ...(init.headers ?? {}) },
});

/** Sends raw headers so Host validation is not normalized by the Fetch client. */
const raw_status = async (base_url: string, path: string, headers: Record<string, string>): Promise<number> => new Promise((resolve_status, reject_status) => {
  const url = new URL(`${base_url}${path}`);
  const raw_request = node_request({ hostname: url.hostname, port: url.port, path, headers }, (response) => {
    response.resume();
    response.once('end', () => resolve_status(response.statusCode ?? 0));
  });
  raw_request.once('error', reject_status);
  raw_request.end();
});

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => new Promise<void>((resolve_close) => instance.server.close(() => resolve_close()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('local Markdown Studio server', () => {
  it('rejects any non-loopback host configuration', () => {
    expect(() => create_studio_server({ host: '0.0.0.0' })).toThrow(/127\.0\.0\.1/);
  });

  it('returns a session only to the exact Studio origin', async () => {
    const { base_url } = await start_server();

    await expect(request(base_url, '/api/session')).resolves.toMatchObject({ status: 200 });
    await expect(fetch(`${base_url}/api/session`, { headers: { Host: base_url.replace('http://', ''), Origin: 'http://localhost:4317' } })).resolves.toMatchObject({ status: 403 });
  });

  it('accepts a browser-style same-origin session request without Origin', async () => {
    const { base_url } = await start_server();
    const host = base_url.replace('http://', '');

    await expect(raw_status(base_url, '/api/session', { Host: host, 'Sec-Fetch-Site': 'same-origin', Referer: `${base_url}/` })).resolves.toBe(200);
    await expect(raw_status(base_url, '/api/session', { Host: host, 'Sec-Fetch-Site': 'cross-site', Referer: `${base_url}/` })).resolves.toBe(403);
  });

  it('rejects foreign origins and missing mutation tokens', async () => {
    const { base_url, instance } = await start_server();

    await expect(request(base_url, '/api/publish', { method: 'POST', body: JSON.stringify(valid_publish_request), headers: { 'Content-Type': 'application/json' } })).resolves.toMatchObject({ status: 403 });
    await expect(fetch(`${base_url}/api/publish`, { method: 'POST', body: JSON.stringify(valid_publish_request), headers: { Host: base_url.replace('http://', ''), Origin: 'http://localhost:4317', 'Content-Type': 'application/json', 'x-studio-token': instance.session_token } })).resolves.toMatchObject({ status: 403 });
  });

  it('caps request bodies before JSON parsing', async () => {
    const { base_url } = await start_server({ request_max_bytes: 96 });

    await expect(request(base_url, '/api/preview', { method: 'POST', body: JSON.stringify({ markdown: 'x'.repeat(200), slug: 'formula' }), headers: { 'Content-Type': 'application/json' } })).resolves.toMatchObject({ status: 413 });
  });

  it('returns sanitized KaTeX preview HTML and parsed metadata', async () => {
    const { base_url } = await start_server();

    const response = await request(base_url, '/api/preview', { method: 'POST', body: JSON.stringify({ markdown: valid_markdown, slug: 'formula' }), headers: { 'Content-Type': 'application/json' } });
    const body = await response.json() as { preview_html: string; metadata: { title: string; slug: string } };
    expect(response.status).toBe(200);
    expect(body.preview_html).toContain('class="katex"');
    expect(body.preview_html).not.toContain('<script');
    expect(body.metadata).toMatchObject({ title: 'Formula', slug: 'formula' });
  });

  it('accepts the Studio UI preview shape before the author has supplied a slug', async () => {
    const { base_url } = await start_server();

    const response = await request(base_url, '/api/preview', { method: 'POST', body: JSON.stringify({ markdown: valid_markdown, metadata: { slug: '' } }), headers: { 'Content-Type': 'application/json' } });
    expect(response.status).toBe(200);
    expect((await response.json() as { metadata: { slug: string } }).metadata.slug).toBe('');
  });

  it('merges valid UI metadata into preview responses without rolling edits back', async () => {
    const { base_url } = await start_server();
    const response = await request(base_url, '/api/preview', { method: 'POST', body: JSON.stringify({
      markdown: valid_markdown,
      metadata: { title: 'Edited title', description: 'Edited description', date: '2026-07-24', tags: ['studio', 'latex'], language: 'en', featured: true, draft: false, slug: 'formula', assets: [], social: { zhihu: true, wechat: false, xiaohongshu: true } },
    }), headers: { 'Content-Type': 'application/json' } });
    expect(response.status).toBe(200);
    expect((await response.json() as { metadata: { title: string; date: string; tags: string[] } }).metadata).toMatchObject({ title: 'Edited title', date: '2026-07-24', tags: ['studio', 'latex'] });
  });

  it('delegates authenticated publication requests to the injected service', async () => {
    let received: unknown;
    const { base_url, instance } = await start_server({ publish: async (input) => {
      received = input;
      return { protocol_version: 1, kind: 'failed', errors: [{ code: 'fake', message: 'Fake publisher called.' }] };
    } });

    const response = await request(base_url, '/api/publish', { method: 'POST', body: JSON.stringify(valid_publish_request), headers: { 'Content-Type': 'application/json', 'x-studio-token': instance.session_token } });
    expect(response.status).toBe(200);
    expect(received).toMatchObject({ kind: 'publish_new', slug: 'formula' });
  });

  it('scrubs publisher error text before returning it to the browser', async () => {
    const { base_url, instance } = await start_server({ publish: async () => ({
      protocol_version: 1,
      kind: 'failed',
      errors: [{ code: 'fake', message: 'secret-key /private/draft.md' }],
      cleanup: { deleted: ['private/key'], failures: [] },
    }) });

    const response = await request(base_url, '/api/publish', { method: 'POST', body: JSON.stringify(valid_publish_request), headers: { 'Content-Type': 'application/json', 'x-studio-token': instance.session_token } });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).not.toContain('secret-key');
    expect(body).not.toContain('/private/draft.md');
    expect(body).not.toContain('private/key');
  });

  it('reports preview-only configuration without exposing local settings', async () => {
    const { base_url } = await start_server({ config: { repository_root: '/private/repository', publication_branch: 'main' } });

    const response = await request(base_url, '/api/config');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ preview_only: true, image_max_bytes: 20_000_000, request_max_bytes: 25_000_000, max_images: 20 });
  });

  it('rejects oversized base64 image input before protocol image decoding', async () => {
    const { base_url, instance } = await start_server({ request_max_bytes: 29_000_000, image_max_bytes: 20_000_000, publish: async () => ({ protocol_version: 1, kind: 'failed', errors: [] }) });
    const bytes_base64 = Buffer.alloc(20_000_001).toString('base64');
    const response = await request(base_url, '/api/publish', { method: 'POST', body: JSON.stringify({ ...valid_publish_request, images: [{ source_path: 'figure.png', bytes_base64, claimed_content_type: 'image/png', intent: 'diagram', semantic_name: 'figure' }] }), headers: { 'Content-Type': 'application/json', 'x-studio-token': instance.session_token } });
    expect(response.status).toBe(413);
  });

  it('uses canonical base64 decoded length at the image limit boundary', async () => {
    const publish = async () => ({ protocol_version: 1 as const, kind: 'failed' as const, errors: [] });
    const { base_url, instance } = await start_server({ request_max_bytes: 512, image_max_bytes: 1, publish });
    const request_with = async (bytes_base64: string): Promise<Response> => request(base_url, '/api/publish', { method: 'POST', body: JSON.stringify({ ...valid_publish_request, images: [{ source_path: 'figure.png', bytes_base64, claimed_content_type: 'image/png', intent: 'diagram', semantic_name: 'figure' }] }), headers: { 'Content-Type': 'application/json', 'x-studio-token': instance.session_token } });
    expect((await request_with('AQ==')).status).toBe(200);
    expect((await request_with('AQI=')).status).toBe(413);
  });

  it('rejects a DNS-rebinding Host header even with a local URL target', async () => {
    const { base_url } = await start_server();

    await expect(raw_status(base_url, '/', { Host: 'localhost:4317', Origin: base_url })).resolves.toBe(403);
  });

  it('serves only regular built assets with no-store headers', async () => {
    const { base_url } = await start_server();

    const response = await request(base_url, '/app.js');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(request(base_url, '/../../package.json')).resolves.toMatchObject({ status: 404 });
  });

  it('rejects a Studio dist root supplied through a symbolic link', async () => {
    const { dist } = await start_server();
    const link = `${dist}-link`;
    await symlink(dist, link);
    const linked = await start_server({ studio_dist: link });
    await expect(request(linked.base_url, '/')).resolves.toMatchObject({ status: 404 });
  });
});
