import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { discover_local_images, parse_studio_article } from '../src/lib/studio_article';
import { render_markdown_preview } from '../src/lib/markdown_preview';
import { tencent_cos_adapter } from '../src/lib/studio_images';
import { local_git_adapter } from '../src/lib/studio_git';
import { publish_article, type studio_publish_dependencies } from '../src/lib/studio_publish';
import { validate_studio_request, type studio_request, type studio_response } from '../src/lib/studio_protocol';

const default_request_max_bytes = 25_000_000;
const default_image_max_bytes = 20_000_000;
const studio_port = 4317;
const loopback_host = '127.0.0.1';
const safe_branch_pattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const safe_bucket_pattern = /^[a-z0-9][a-z0-9-]{1,62}-[0-9]+$/;
const safe_region_pattern = /^[a-z0-9-]{3,64}$/;
const safe_prefix_pattern = /^[a-z0-9]+(?:[a-z0-9_-]*[a-z0-9])?(?:\/[a-z0-9]+(?:[a-z0-9_-]*[a-z0-9])?)*$/;

export type studio_configuration = {
  repository_root: string;
  publication_branch: string;
  public_site_url: string;
  image_max_bytes: number;
  cos_region: string;
  cos_bucket: string;
  cos_secret_id: string;
  cos_secret_key: string;
  cos_public_base_url: string;
  cos_root_prefix: string;
  request_max_bytes: number;
};

type preview_response = { preview_html: string; metadata: ReturnType<typeof parse_studio_article>['metadata']; unresolved_images: string[]; publish_configured: boolean };
type preview_service = (input: { markdown: string; slug: string }) => Promise<Omit<preview_response, 'publish_configured'>>;
type publish_service = (input: unknown) => Promise<studio_response>;
type public_config = Pick<studio_configuration, 'repository_root' | 'publication_branch'>;

export type studio_server_options = {
  host?: string;
  studio_dist?: string;
  request_max_bytes?: number;
  image_max_bytes?: number;
  config?: Partial<public_config> | studio_configuration;
  preview?: preview_service;
  publish?: publish_service;
};

export type studio_server = { server: Server; session_token: string };

const is_record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const is_positive_integer = (value: string | undefined, maximum: number): value is string => value !== undefined && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0 && Number(value) <= maximum;
const is_safe_branch = (value: string): boolean => safe_branch_pattern.test(value) && !value.includes('//') && !value.includes('..') && !value.startsWith('-') && !value.endsWith('.lock');
const is_https_url = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
};

/** Distinguishes a complete validated publishing configuration from test-only partial settings. */
const is_studio_configuration = (value: studio_server_options['config']): value is studio_configuration => value !== undefined && typeof value.repository_root === 'string' && typeof value.publication_branch === 'string' && typeof (value as Partial<studio_configuration>).public_site_url === 'string' && typeof (value as Partial<studio_configuration>).image_max_bytes === 'number' && typeof (value as Partial<studio_configuration>).cos_region === 'string' && typeof (value as Partial<studio_configuration>).cos_bucket === 'string' && typeof (value as Partial<studio_configuration>).cos_secret_id === 'string' && typeof (value as Partial<studio_configuration>).cos_secret_key === 'string' && typeof (value as Partial<studio_configuration>).cos_public_base_url === 'string' && typeof (value as Partial<studio_configuration>).cos_root_prefix === 'string' && typeof (value as Partial<studio_configuration>).request_max_bytes === 'number';

/** Returns a complete, syntactically safe local configuration, or undefined for preview-only mode. */
export const read_studio_configuration = (environment: NodeJS.ProcessEnv = process.env): studio_configuration | undefined => {
  const repository_root = environment.STUDIO_REPOSITORY_ROOT;
  const publication_branch = environment.STUDIO_PUBLICATION_BRANCH;
  const public_site_url = environment.STUDIO_PUBLIC_SITE_URL;
  const image_max_bytes = environment.STUDIO_IMAGE_MAX_BYTES;
  const cos_region = environment.TENCENT_COS_REGION;
  const cos_bucket = environment.TENCENT_COS_BUCKET;
  const cos_secret_id = environment.TENCENT_COS_SECRET_ID;
  const cos_secret_key = environment.TENCENT_COS_SECRET_KEY;
  const cos_public_base_url = environment.TENCENT_COS_PUBLIC_BASE_URL;
  const cos_root_prefix = environment.TENCENT_COS_ROOT_PREFIX;
  const request_max_bytes = environment.STUDIO_REQUEST_MAX_BYTES ?? String(default_request_max_bytes);
  if (!repository_root || !isAbsolute(repository_root) || !existsSync(repository_root) || !publication_branch || !is_safe_branch(publication_branch) || !public_site_url || !is_https_url(public_site_url) || !is_positive_integer(image_max_bytes, default_image_max_bytes) || !cos_region || !safe_region_pattern.test(cos_region) || !cos_bucket || !safe_bucket_pattern.test(cos_bucket) || !cos_secret_id || !cos_secret_key || !cos_public_base_url || !is_https_url(cos_public_base_url) || !cos_root_prefix || !safe_prefix_pattern.test(cos_root_prefix) || !is_positive_integer(request_max_bytes, 30_000_000)) return undefined;
  let canonical_root: string;
  try {
    canonical_root = realpathSync(repository_root);
  } catch {
    return undefined;
  }
  return { repository_root: canonical_root, publication_branch, public_site_url, image_max_bytes: Number(image_max_bytes), cos_region, cos_bucket, cos_secret_id, cos_secret_key, cos_public_base_url, cos_root_prefix, request_max_bytes: Number(request_max_bytes) };
};

/** Converts a complete local configuration into the real COS and Git publication service. */
const configured_publish_service = (configuration: studio_configuration): publish_service => {
  const dependencies: studio_publish_dependencies = {
    journal_root: configuration.repository_root,
    public_site_url: configuration.public_site_url,
    image_options: {
      root_prefix: configuration.cos_root_prefix,
      public_base_url: configuration.cos_public_base_url,
      max_bytes: configuration.image_max_bytes,
      max_pixels: 40_000_000,
      max_width: 10_000,
      max_height: 10_000,
      max_total_input_bytes: configuration.image_max_bytes * 20,
      max_total_output_bytes: configuration.image_max_bytes * 20,
    },
    cos: new tencent_cos_adapter({ secret_id: configuration.cos_secret_id, secret_key: configuration.cos_secret_key, region: configuration.cos_region, bucket: configuration.cos_bucket, public_base_url: configuration.cos_public_base_url, root_prefix: configuration.cos_root_prefix }),
    git: new local_git_adapter({ repository_root: configuration.repository_root, publication_branch: configuration.publication_branch, remote_name: 'origin', writing_directory: 'src/content/writing' }),
  };
  return async (input: unknown): Promise<studio_response> => publish_article(input, dependencies);
};

/** Renders a Studio preview through the shared Markdown renderer without trusting client HTML. */
const default_preview_service: preview_service = async ({ markdown, slug }) => {
  const article = parse_studio_article(markdown, slug);
  const preview_html = await render_markdown_preview(article.body);
  return { preview_html, metadata: article.metadata, unresolved_images: discover_local_images(article.body) };
};

/** Writes a JSON response with private-safe generic error messages. */
const send_json = (response: ServerResponse, status: number, body: unknown): void => {
  const source = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(source), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(source);
};

/** Removes adapter-controlled error text and storage keys before a browser receives a publish result. */
const safe_publish_response = (result: studio_response): studio_response => {
  if (result.kind !== 'failed' && result.kind !== 'recovery_required') return result;
  const errors = result.errors.map((error) => ({ code: error.code, ...(error.field === undefined ? {} : { field: error.field }), message: 'Publishing could not be completed safely.' }));
  return { protocol_version: 1, kind: result.kind, errors };
};

/** Reads one bounded request body and refuses it before JSON parsing when the limit is exceeded. */
const read_json_body = async (request: IncomingMessage, max_bytes: number): Promise<unknown> => {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) throw new Error('invalid_json');
  const declared_length = request.headers['content-length'];
  if (typeof declared_length === 'string' && (!/^\d+$/.test(declared_length) || Number(declared_length) > max_bytes)) {
    request.resume();
    throw new Error('body_too_large');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  await new Promise<void>((resolve_body, reject_body) => {
    request.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > max_bytes) {
        request.resume();
        reject_body(new Error('body_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    request.once('end', resolve_body);
    request.once('error', reject_body);
  });
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new Error('invalid_json');
  }
};

/** Validates one exact incoming Host or Origin header instead of trusting DNS aliases. */
const exact_header = (request: IncomingMessage, name: 'host' | 'origin', expected: string): boolean => {
  const values = request.rawHeaders.flatMap((value, index) => index % 2 === 0 && value.toLowerCase() === name ? [request.rawHeaders[index + 1] ?? ''] : []);
  return values.length === 1 && values[0] === expected;
};

/** Performs constant-time comparison after rejecting non-token-shaped input. */
const valid_token = (candidate: string | undefined, session_token: string): boolean => {
  if (!candidate || !/^[a-f0-9]{64}$/.test(candidate)) return false;
  const provided = Buffer.from(candidate, 'hex');
  const expected = Buffer.from(session_token, 'hex');
  return provided.byteLength === expected.byteLength && timingSafeEqual(provided, expected);
};

/** Resolves a built asset while rejecting traversal and every symlink in its path. */
const static_asset = async (studio_dist: string, pathname: string): Promise<{ bytes: Buffer; content_type: string } | undefined> => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (!decoded.startsWith('/') || decoded.includes('\\') || decoded.includes('\0')) return undefined;
  const segments = decoded === '/' ? ['index.html'] : decoded.slice(1).split('/');
  if (!segments.length || segments.some((segment) => !segment || segment === '.' || segment === '..')) return undefined;
  const root = await realpath(studio_dist).catch(() => undefined);
  if (!root) return undefined;
  const target = resolve(root, ...segments);
  const target_relative = relative(root, target);
  if (!target_relative || target_relative.startsWith('..') || isAbsolute(target_relative)) return undefined;
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    const entry = await lstat(current).catch(() => undefined);
    if (!entry || entry.isSymbolicLink()) return undefined;
  }
  const entry = await lstat(target).catch(() => undefined);
  if (!entry?.isFile()) return undefined;
  const bytes = await readFile(target).catch(() => undefined);
  if (!bytes) return undefined;
  const extension = segments.at(-1)?.split('.').at(-1)?.toLowerCase();
  const content_type = extension === 'html' ? 'text/html; charset=utf-8' : extension === 'js' ? 'text/javascript; charset=utf-8' : extension === 'css' ? 'text/css; charset=utf-8' : extension === 'svg' ? 'image/svg+xml' : extension === 'json' ? 'application/json; charset=utf-8' : 'application/octet-stream';
  return { bytes, content_type };
};

/** Creates the explicit-route, loopback-only local Studio server for CLI use and isolated tests. */
export const create_studio_server = (options: studio_server_options = {}): studio_server => {
  if ((options.host ?? loopback_host) !== loopback_host) throw new Error('Studio must bind to 127.0.0.1.');
  const configuration = is_studio_configuration(options.config) ? options.config : undefined;
  const request_max_bytes = options.request_max_bytes ?? configuration?.request_max_bytes ?? default_request_max_bytes;
  const image_max_bytes = options.image_max_bytes ?? configuration?.image_max_bytes ?? default_image_max_bytes;
  if (!Number.isSafeInteger(request_max_bytes) || request_max_bytes < 1 || request_max_bytes > 30_000_000 || !Number.isSafeInteger(image_max_bytes) || image_max_bytes < 1 || image_max_bytes > default_image_max_bytes) throw new Error('Studio request limits are invalid.');
  const publish = options.publish ?? (configuration ? configured_publish_service(configuration) : undefined);
  const preview = options.preview ?? default_preview_service;
  const studio_dist = options.studio_dist ?? resolve(process.cwd(), 'studio', 'dist');
  const session_token = randomBytes(32).toString('hex');
  const server = createServer(async (request, response) => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : undefined;
    const host = port === undefined ? '' : `${loopback_host}:${port}`;
    const origin = port === undefined ? '' : `http://${host}`;
    const same_host = exact_header(request, 'host', host);
    const same_origin = exact_header(request, 'origin', origin);
    const pathname = new URL(request.url ?? '/', origin || 'http://invalid').pathname;
    if (!same_host) {
      send_json(response, 403, { error: 'Forbidden.' });
      return;
    }
    if (pathname === '/api/session' && request.method === 'GET') {
      if (!same_origin) send_json(response, 403, { error: 'Forbidden.' });
      else send_json(response, 200, { token: session_token });
      return;
    }
    if (pathname === '/api/config' && request.method === 'GET') {
      if (!same_origin) send_json(response, 403, { error: 'Forbidden.' });
      else send_json(response, 200, { preview_only: publish === undefined });
      return;
    }
    if (pathname === '/api/preview' && request.method === 'POST') {
      if (!same_origin) {
        send_json(response, 403, { error: 'Forbidden.' });
        return;
      }
      try {
        const input = await read_json_body(request, request_max_bytes);
        if (!is_record(input) || typeof input.markdown !== 'string' || input.markdown.length > 1_000_000) throw new Error('invalid_preview');
        const requested_slug = typeof input.slug === 'string' ? input.slug : is_record(input.metadata) && typeof input.metadata.slug === 'string' ? input.metadata.slug : '';
        const result = await preview({ markdown: input.markdown, slug: requested_slug || 'preview' });
        send_json(response, 200, { ...result, metadata: { ...result.metadata, slug: requested_slug }, publish_configured: publish !== undefined });
      } catch (cause: unknown) {
        send_json(response, cause instanceof Error && cause.message === 'body_too_large' ? 413 : 422, { error: 'Preview is invalid.' });
      }
      return;
    }
    if (pathname === '/api/publish' && request.method === 'POST') {
      const supplied_token = Array.isArray(request.headers['x-studio-token']) ? undefined : request.headers['x-studio-token'];
      if (!same_origin || !valid_token(supplied_token, session_token)) {
        send_json(response, 403, { error: 'Forbidden.' });
        return;
      }
      if (!publish) {
        send_json(response, 409, { error: 'Publishing is not configured locally.' });
        return;
      }
      try {
        const input = await read_json_body(request, request_max_bytes);
        const publication_request: studio_request = validate_studio_request(input);
        if ((publication_request.images ?? []).some((image) => image.bytes.byteLength > image_max_bytes)) {
          send_json(response, 413, { error: 'Request exceeds local limits.' });
          return;
        }
        send_json(response, 200, safe_publish_response(await publish(input)));
      } catch (cause: unknown) {
        send_json(response, cause instanceof Error && cause.message === 'body_too_large' ? 413 : 422, { error: 'Publication request is invalid.' });
      }
      return;
    }
    if (pathname.startsWith('/api/')) {
      send_json(response, 404, { error: 'Not found.' });
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      send_json(response, 405, { error: 'Method not allowed.' });
      return;
    }
    const asset = await static_asset(studio_dist, pathname);
    if (!asset) {
      send_json(response, 404, { error: 'Not found.' });
      return;
    }
    response.writeHead(200, { 'content-type': asset.content_type, 'content-length': asset.bytes.byteLength, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : asset.bytes);
  });
  return { server, session_token };
};

/** Loads non-overriding dotenv settings and starts the fixed-port local Studio process. */
const run_studio = async (): Promise<void> => {
  dotenv.config({ path: resolve(process.cwd(), '.env.studio.local'), override: false, quiet: true });
  const configuration = read_studio_configuration();
  const instance = create_studio_server({ ...(configuration ? { config: configuration } : {}) });
  await new Promise<void>((resolve_listener, reject_listener) => {
    instance.server.once('error', reject_listener);
    instance.server.listen(studio_port, loopback_host, () => {
      instance.server.off('error', reject_listener);
      resolve_listener();
    });
  }).catch((cause: unknown) => {
    const occupied = is_record(cause) && cause.code === 'EADDRINUSE';
    throw new Error(occupied ? `Studio port ${studio_port} is already in use; choose no alternate port and stop the existing process.` : 'Studio could not start on 127.0.0.1.');
  });
  process.stdout.write(`Studio is available at http://${loopback_host}:${studio_port}\n`);
  if (!configuration) process.stdout.write('Studio is in preview-only mode; complete .env.studio.local to enable publishing.\n');
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void run_studio().catch((cause: unknown) => {
    process.stderr.write(`${cause instanceof Error ? cause.message : 'Studio could not start.'}\n`);
    process.exitCode = 1;
  });
}
