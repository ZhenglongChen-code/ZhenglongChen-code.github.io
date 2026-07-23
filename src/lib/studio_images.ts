import { createHash } from 'node:crypto';
import cos_sdk from 'cos-nodejs-sdk-v5';
import sharp from 'sharp';
import remark_parse from 'remark-parse';
import { unified as unified_processor } from 'unified';
import { collect_markdown_definitions } from './markdown_preview';

export type image_intent = 'photo' | 'screenshot' | 'diagram';
export type prepared_image = { bytes: Uint8Array; content_type: 'image/webp' | 'image/png'; object_key: string; public_url: string; sha256: string; source_path: string };
export interface cos_adapter { inspect_object(object_key: string): Promise<{ sha256: string } | undefined>; upload_object(input: prepared_image): Promise<void>; delete_object(object_key: string): Promise<void>; }
export type image_source = { source_path: string; bytes: Uint8Array; claimed_content_type: 'image/jpeg' | 'image/png'; intent: image_intent; semantic_name: string };
export type image_preparation_options = { root_prefix: string; public_base_url: string; year: number; slug: string; max_bytes: number; max_pixels: number; max_width: number; max_height: number };
export type image_manifest_entry = { source_path: string; object_key: string; public_url: string };
export type published_image = prepared_image & { status: 'created' | 'reused' };
export type publish_result = { objects: published_image[]; manifest: image_manifest_entry[] };
export type cleanup_result = { deleted: string[]; failures: string[] };
export class studio_image_error extends Error { constructor(readonly code: 'validation' | 'collision' | 'missing_remote_digest', message: string) { super(message); this.name = 'studio_image_error'; } }

type key_input = { root_prefix: string; year: number; slug: string; figure_number: number; semantic_name: string; extension: string };
type markdown_node = { type?: unknown; url?: unknown; identifier?: unknown; children?: unknown; position?: { start: { offset?: number }; end: { offset?: number } } };
type replacement = { start: number; end: number; value: string };
const component_pattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const object_key_pattern = /^[a-z0-9]+(?:[a-z0-9/_-]*[a-z0-9])?\.(?:webp|png)$/;

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const invalid = (message: string): never => { throw new studio_image_error('validation', message); };
const root_prefix = (value: string): string => {
  if (!value || value.startsWith('/') || value.endsWith('/') || value.includes('\\') || value.split('/').some((part) => !component_pattern.test(part))) invalid('Invalid root prefix.');
  return value;
};
const public_url = (base: string, object_key: string): string => {
  let parsed: URL;
  try { parsed = new URL(base); } catch { return invalid('Invalid public base URL.'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) invalid('Invalid public base URL.');
  const base_path = parsed.pathname.replace(/\/$/, '');
  return `${parsed.origin}${base_path}/${object_key.split('/').map(encodeURIComponent).join('/')}`;
};
const valid_source_path = (source_path: string): boolean => {
  if (!source_path || /[\\\x00-\x1f\x7f\s]/.test(source_path) || /[^\x00-\x7f]/.test(source_path) || /[?#]/.test(source_path) || source_path.startsWith('/') || source_path.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(source_path)) return false;
  let decoded: string;
  try { decoded = decodeURIComponent(source_path); } catch { return false; }
  if (/%2f/i.test(source_path) || /[\\\x00-\x1f\x7f\s]/.test(decoded) || /[^\x00-\x7f]/.test(decoded) || decoded.split('/').some((part) => part === '..')) return false;
  return /^(?:\.?\/?[a-zA-Z0-9][a-zA-Z0-9._/-]*)\.(?:png|jpe?g)$/i.test(source_path);
};
const local_destination = (value: string): boolean => !/^(?:[a-z][a-z0-9+.-]*:|\/|#|\?)/i.test(value);

/** Creates an ASCII-only deterministic image object key. */
export const build_article_object_key = (input: key_input): string => {
  const prefix = root_prefix(input.root_prefix);
  if (!Number.isInteger(input.year) || input.year < 2000 || input.year > 9999 || !component_pattern.test(input.slug) || !component_pattern.test(input.semantic_name) || !Number.isInteger(input.figure_number) || input.figure_number < 1 || !['webp', 'png'].includes(input.extension)) invalid('Invalid image object key component.');
  const key = `${prefix}/articles/${input.year}/${input.slug}/fig-${String(input.figure_number).padStart(2, '0')}-${input.semantic_name}.${input.extension}`;
  if (!object_key_pattern.test(key)) invalid('Invalid image object key.');
  return key;
};

/** Validates and normalizes local source images without performing network I/O. */
export const prepare_article_images = async (sources: readonly image_source[], options: image_preparation_options): Promise<{ images: prepared_image[] }> => {
  root_prefix(options.root_prefix); public_url(options.public_base_url, 'test');
  if (!Number.isSafeInteger(options.max_bytes) || options.max_bytes < 1 || !Number.isSafeInteger(options.max_pixels) || options.max_pixels < 1 || !Number.isSafeInteger(options.max_width) || options.max_width < 1 || !Number.isSafeInteger(options.max_height) || options.max_height < 1) invalid('Invalid image limits.');
  const images: prepared_image[] = [];
  for (const [index, source] of sources.entries()) {
    if (source.bytes.byteLength === 0 || source.bytes.byteLength > options.max_bytes || !valid_source_path(source.source_path)) invalid(`Invalid source image: ${source.source_path}`);
    const metadata = await sharp(source.bytes, { limitInputPixels: options.max_pixels, failOn: 'error' }).metadata().catch(() => invalid(`Invalid source image: ${source.source_path}`));
    const detected_content_type = metadata.format === 'jpeg' ? 'image/jpeg' : metadata.format === 'png' ? 'image/png' : undefined;
    if (!detected_content_type || detected_content_type !== source.claimed_content_type || !metadata.width || !metadata.height || metadata.width > options.max_width || metadata.height > options.max_height || metadata.width * metadata.height > options.max_pixels) invalid(`Invalid source image: ${source.source_path}`);
    const retain_png = source.intent === 'diagram';
    const content_type = retain_png ? 'image/png' : 'image/webp';
    const output = await (retain_png ? sharp(source.bytes, { limitInputPixels: options.max_pixels }).rotate().png({ compressionLevel: 9, palette: false }).toBuffer() : sharp(source.bytes, { limitInputPixels: options.max_pixels }).rotate().webp({ quality: 82, effort: 6 }).toBuffer()).catch(() => invalid(`Unable to normalize image: ${source.source_path}`));
    const extension = content_type === 'image/png' ? 'png' : 'webp';
    const object_key = build_article_object_key({ ...options, figure_number: index + 1, semantic_name: source.semantic_name, extension });
    const bytes = new Uint8Array(output);
    images.push({ bytes, content_type, object_key, public_url: public_url(options.public_base_url, object_key), sha256: sha256(bytes), source_path: source.source_path });
  }
  return { images };
};

const visit = (node: unknown, callback: (node: markdown_node) => void): void => { if (typeof node !== 'object' || node === null) return; const markdown_node = node as markdown_node; callback(markdown_node); if (Array.isArray(markdown_node.children)) for (const child of markdown_node.children) visit(child, callback); };
const offsets = (node: markdown_node): { start: number; end: number } | undefined => { const start = node.position?.start.offset; const end = node.position?.end.offset; return typeof start === 'number' && typeof end === 'number' ? { start, end } : undefined; };

/** Replaces only AST-recognized local image destinations, retaining Markdown syntax and inert code. */
export const rewrite_markdown_images = (markdown: string, urls: ReadonlyMap<string, string>): string => {
  const tree = unified_processor().use(remark_parse).parse(markdown);
  const definitions = collect_markdown_definitions(tree);
  const referenced = new Set<string>(); const first_definitions = new Set<markdown_node>(); const known_definitions = new Set<string>(); const replacements: replacement[] = [];
  visit(tree, (node) => {
    if (node.type === 'imageReference' && typeof node.identifier === 'string') referenced.add(node.identifier);
    if (node.type === 'definition' && typeof node.identifier === 'string' && !known_definitions.has(node.identifier)) { known_definitions.add(node.identifier); first_definitions.add(node); }
    if (node.type === 'image' && typeof node.url === 'string') {
      const replacement_url = local_destination(node.url) ? urls.get(node.url) : undefined; const range = offsets(node);
      if (replacement_url && range) { const source = markdown.slice(range.start, range.end); const destination_start = source.indexOf(node.url); if (destination_start >= 0) replacements.push({ start: range.start, end: range.end, value: source.slice(0, destination_start) + replacement_url + source.slice(destination_start + node.url.length) }); }
    }
  });
  visit(tree, (node) => {
    if (node.type !== 'definition' || typeof node.identifier !== 'string' || typeof node.url !== 'string' || !referenced.has(node.identifier) || !first_definitions.has(node) || definitions.get(node.identifier) === undefined) return;
    const replacement_url = local_destination(node.url) ? urls.get(node.url) : undefined; const range = offsets(node); if (!replacement_url || !range) return;
    const source = markdown.slice(range.start, range.end); const destination_start = source.indexOf(node.url); if (destination_start >= 0) replacements.push({ start: range.start, end: range.end, value: source.slice(0, destination_start) + replacement_url + source.slice(destination_start + node.url.length) });
  });
  return [...replacements].sort((left, right) => right.start - left.start).reduce((result, replacement) => result.slice(0, replacement.start) + replacement.value + result.slice(replacement.end), markdown);
};

/** Uploads only absent objects, allowing exact-digest idempotent reuse. */
export const publish_prepared_images = async (images: readonly prepared_image[], adapter: cos_adapter): Promise<publish_result> => {
  const objects: published_image[] = [];
  for (const image of images) { const existing = await adapter.inspect_object(image.object_key); if (existing && existing.sha256 !== image.sha256) throw new studio_image_error('collision', `Object collision: ${image.object_key}`); if (!existing) await adapter.upload_object(image); objects.push({ ...image, status: existing ? 'reused' : 'created' }); }
  return { objects, manifest: objects.map(({ source_path, object_key, public_url }) => ({ source_path, object_key, public_url })) };
};

/** Deletes only objects created during the current request and reports all best-effort failures. */
export const cleanup_created_images = async (objects: readonly published_image[], adapter: cos_adapter): Promise<cleanup_result> => {
  const deleted: string[] = []; const failures: string[] = [];
  for (const object of objects) if (object.status === 'created') try { await adapter.delete_object(object.object_key); deleted.push(object.object_key); } catch { failures.push(object.object_key); }
  return { deleted, failures };
};

export type tencent_cos_config = { secret_id: string; secret_key: string; region: string; bucket: string; public_base_url: string; root_prefix: string };
type cos_client = { headObject(input: { Bucket: string; Region: string; Key: string }): Promise<{ headers?: Record<string, string | undefined> }>; putObject(input: { Bucket: string; Region: string; Key: string; Body: Buffer; ContentLength: number; ContentType: string; 'x-cos-meta-sha256': string }): Promise<unknown>; deleteObject(input: { Bucket: string; Region: string; Key: string }): Promise<unknown> };
type cos_client_factory = (config: tencent_cos_config) => cos_client;
const valid_cos_config = (config: tencent_cos_config): void => {
  if (!config.secret_id.trim() || !config.secret_key.trim() || !/^(?:ap|na|eu|sa|cn)-[a-z0-9-]+$/.test(config.region) || !/^[a-z0-9][a-z0-9-]{0,54}-\d{10}$/.test(config.bucket)) invalid('Invalid COS configuration.');
  root_prefix(config.root_prefix); public_url(config.public_base_url, 'test');
};
const valid_adapter_key = (object_key: string, prefix: string): void => { if (!object_key_pattern.test(object_key) || !object_key.startsWith(`${prefix}/articles/`)) invalid('Invalid COS object key.'); };
/** Tencent COS adapter. Construction is local-only and does not initiate network traffic. */
export class tencent_cos_adapter implements cos_adapter {
  private readonly client: cos_client;
  constructor(private readonly config: tencent_cos_config, client_factory: cos_client_factory = (value) => new cos_sdk({ SecretId: value.secret_id, SecretKey: value.secret_key })) {
    valid_cos_config(config);
    this.client = client_factory(config);
  }
  async inspect_object(object_key: string): Promise<{ sha256: string } | undefined> { valid_adapter_key(object_key, this.config.root_prefix); try { const result = await this.client.headObject({ Bucket: this.config.bucket, Region: this.config.region, Key: object_key }); const value = result.headers?.['x-cos-meta-sha256']; if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) throw new studio_image_error('missing_remote_digest', `COS object lacks a valid sha256 digest: ${object_key}`); return { sha256: value }; } catch (error: unknown) { if (typeof error === 'object' && error !== null && 'statusCode' in error && (error as { statusCode?: unknown }).statusCode === 404) return undefined; throw error; } }
  async upload_object(input: prepared_image): Promise<void> { valid_adapter_key(input.object_key, this.config.root_prefix); await this.client.putObject({ Bucket: this.config.bucket, Region: this.config.region, Key: input.object_key, Body: Buffer.from(input.bytes), ContentLength: input.bytes.byteLength, ContentType: input.content_type, 'x-cos-meta-sha256': input.sha256 }); }
  async delete_object(object_key: string): Promise<void> { valid_adapter_key(object_key, this.config.root_prefix); await this.client.deleteObject({ Bucket: this.config.bucket, Region: this.config.region, Key: object_key }); }
}
