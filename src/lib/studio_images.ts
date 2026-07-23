import { createHash } from 'node:crypto';
import cos_sdk from 'cos-nodejs-sdk-v5';
import sharp from 'sharp';
import remark_parse from 'remark-parse';
import { unified as unified_processor } from 'unified';
import { collect_markdown_definitions } from './markdown_preview';

export type image_intent = 'photo' | 'screenshot' | 'diagram';
export type prepared_image = { bytes: Uint8Array; content_type: 'image/webp' | 'image/png'; object_key: string; public_url: string; sha256: string; source_path: string };
export interface cos_adapter { verify_versioning(): Promise<void>; inspect_object(object_key: string): Promise<{ sha256: string } | undefined>; upload_object(input: prepared_image): Promise<{ version_id: string }>; delete_object(object_key: string, version_id: string): Promise<void>; }
export type image_source = { source_path: string; bytes: Uint8Array; claimed_content_type: 'image/jpeg' | 'image/png'; intent: image_intent; semantic_name: string };
export type image_preparation_options = { root_prefix: string; public_base_url: string; year: number; slug: string; max_bytes: number; max_pixels: number; max_width: number; max_height: number; max_images?: number; max_total_input_bytes?: number; max_total_output_bytes?: number };
export type image_manifest_entry = { source_path: string; object_key: string; public_url: string };
export type published_image = prepared_image & ({ status: 'created'; version_id: string } | { status: 'reused' });
export type publish_result = { objects: published_image[]; manifest: image_manifest_entry[] };
export type cleanup_result = { deleted: string[]; failures: string[] };
export class studio_image_error extends Error { constructor(readonly code: 'validation' | 'collision' | 'missing_remote_digest' | 'untracked_create', message: string) { super(message); this.name = 'studio_image_error'; } }
export class studio_image_publish_error extends Error { constructor(readonly code: 'collision' | 'untracked_create' | 'adapter_failure', readonly successful_objects: readonly published_image[], message: string, readonly cause_error?: unknown) { super(message); this.name = 'studio_image_publish_error'; this.successful_objects = Object.freeze([...successful_objects]); } }

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
const decoded_path_segment = (value: string): string | undefined => { try { const decoded = decodeURIComponent(value); return /%(?:[0-9a-f]{2})/i.test(decoded) ? undefined : decoded; } catch { return undefined; } };
const public_url = (base: string, object_key: string): string => {
  let parsed: URL;
  try { parsed = new URL(base); } catch { return invalid('Invalid public base URL.'); }
  const raw_path = base.replace(/^https:\/\/[^/]+/, '');
  const decoded_segments = raw_path.split('/').map(decoded_path_segment);
  if (base.trim() !== base || /[\x00-\x1f\x7f-\x9f]/.test(base) || base.includes('\\') || /%(?:2f|5c|2e)/i.test(base) || decoded_segments.some((segment) => segment === undefined || /[\x00-\x1f\x7f-\x9f]/.test(segment)) || parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || /\/(?:\.{1,2})(?:\/|$)/.test(raw_path) || raw_path.includes('//')) invalid('Invalid public base URL.');
  const base_path = parsed.pathname.replace(/\/$/, '');
  return `${parsed.origin}${base_path}/${object_key.split('/').map(encodeURIComponent).join('/')}`;
};
const valid_source_path = (source_path: string): boolean => {
  if (!source_path || /[\\\x00-\x1f\x7f\s]/.test(source_path) || /[^\x00-\x7f]/.test(source_path) || /[?#]/.test(source_path) || source_path.startsWith('/') || source_path.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(source_path)) return false;
  const decoded = decoded_path_segment(source_path); if (decoded === undefined) return false;
  const normalized = decoded.startsWith('./') ? decoded.slice(2) : decoded;
  if (/%(?:2f|5c|2e)/i.test(source_path) || /[\\\x00-\x1f\x7f\s]/.test(decoded) || /[^\x00-\x7f]/.test(decoded) || !normalized || normalized.split('/').some((part) => part === '' || part === '.' || part === '..')) return false;
  return /^(?:\.?\/?[a-zA-Z0-9][a-zA-Z0-9._/-]*)\.(?:png|jpe?g)$/i.test(source_path);
};
const canonical_local_destination = (value: string): string | undefined => {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/|#|\?)/i.test(value) || /[\\\x00-\x1f\x7f?#]/.test(value)) return undefined;
  if (/%(?:2f|5c)/i.test(value)) return undefined;
  const decoded = decoded_path_segment(value); if (decoded === undefined) return undefined;
  const normalized = decoded.startsWith('./') ? decoded.slice(2) : decoded;
  if (!normalized || normalized.startsWith('./')) return undefined;
  const segments = normalized.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..' && !/[\\\x00-\x1f\x7f]/.test(segment)) ? normalized : undefined;
};

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
  const max_images = options.max_images ?? 20; const max_total_input_bytes = options.max_total_input_bytes ?? options.max_bytes * max_images; const max_total_output_bytes = options.max_total_output_bytes ?? options.max_bytes * max_images;
  if (!Number.isSafeInteger(max_images) || max_images < 1 || !Number.isSafeInteger(max_total_input_bytes) || max_total_input_bytes < 1 || !Number.isSafeInteger(max_total_output_bytes) || max_total_output_bytes < 1 || sources.length > max_images) invalid('Invalid image manifest limits.');
  const source_paths = new Set<string>(); let total_input_bytes = 0;
  for (const source of sources) {
    const decoded_source = decoded_path_segment(source.source_path); const canonical_source = decoded_source?.startsWith('./') ? decoded_source.slice(2) : decoded_source;
    if (!canonical_source || source_paths.has(canonical_source) || !valid_source_path(source.source_path) || !component_pattern.test(source.semantic_name) || !['photo', 'screenshot', 'diagram'].includes(source.intent) || source.bytes.byteLength === 0 || source.bytes.byteLength > options.max_bytes) invalid(`Invalid source image: ${source.source_path}`);
    source_paths.add(canonical_source!); total_input_bytes += source.bytes.byteLength;
  }
  if (total_input_bytes > max_total_input_bytes) invalid('Input image bytes exceed manifest limit.');
  const images: prepared_image[] = [];
  let total_output_bytes = 0;
  for (const [index, source] of sources.entries()) {
    const metadata = await sharp(source.bytes, { limitInputPixels: options.max_pixels, failOn: 'error' }).metadata().catch(() => invalid(`Invalid source image: ${source.source_path}`));
    const detected_content_type = metadata.format === 'jpeg' ? 'image/jpeg' : metadata.format === 'png' ? 'image/png' : undefined;
    const orientation_swaps_dimensions = metadata.orientation !== undefined && metadata.orientation >= 5 && metadata.orientation <= 8;
    const oriented_width = orientation_swaps_dimensions ? metadata.height : metadata.width;
    const oriented_height = orientation_swaps_dimensions ? metadata.width : metadata.height;
    if (!detected_content_type || detected_content_type !== source.claimed_content_type || !oriented_width || !oriented_height || oriented_width > options.max_width || oriented_height > options.max_height || oriented_width * oriented_height > options.max_pixels) invalid(`Invalid source image: ${source.source_path}`);
    const retain_png = source.intent === 'diagram';
    const content_type = retain_png ? 'image/png' : 'image/webp';
    const output = await (retain_png ? sharp(source.bytes, { limitInputPixels: options.max_pixels }).rotate().png({ compressionLevel: 9, palette: false }).toBuffer() : sharp(source.bytes, { limitInputPixels: options.max_pixels }).rotate().webp({ quality: 82, effort: 6 }).toBuffer()).catch(() => invalid(`Unable to normalize image: ${source.source_path}`));
    total_output_bytes += output.byteLength; if (total_output_bytes > max_total_output_bytes) invalid('Output image bytes exceed manifest limit.');
    const extension = content_type === 'image/png' ? 'png' : 'webp';
    const object_key = build_article_object_key({ ...options, figure_number: index + 1, semantic_name: source.semantic_name, extension });
    const bytes = new Uint8Array(output);
    images.push({ bytes, content_type, object_key, public_url: public_url(options.public_base_url, object_key), sha256: sha256(bytes), source_path: source.source_path });
  }
  return { images };
};

const visit = (node: unknown, callback: (node: markdown_node) => void): void => { if (typeof node !== 'object' || node === null) return; const markdown_node = node as markdown_node; callback(markdown_node); if (Array.isArray(markdown_node.children)) for (const child of markdown_node.children) visit(child, callback); };
const offsets = (node: markdown_node): { start: number; end: number } | undefined => { const start = node.position?.start.offset; const end = node.position?.end.offset; return typeof start === 'number' && typeof end === 'number' ? { start, end } : undefined; };
const escaped_end = (source: string, start: number, closing: string): number => { for (let index = start; index < source.length; index += 1) { if (source[index] === '\\') { index += 1; continue; } if (source[index] === closing) return index; } return -1; };
const matching_bracket_end = (source: string, start: number): number => { let depth = 0; for (let index = start; index < source.length; index += 1) { if (source[index] === '\\') { index += 1; continue; } if (source[index] === '[') depth += 1; if (source[index] === ']') { depth -= 1; if (depth === 0) return index; } } return -1; };
const inline_destination_range = (source: string): { start: number; end: number } | undefined => {
  const alt_end = matching_bracket_end(source, 1); if (alt_end < 0 || source[alt_end + 1] !== '(') return undefined;
  const destination_start = alt_end + 2;
  if (source[destination_start] === '<') { const end = escaped_end(source, destination_start + 1, '>'); return end < 0 ? undefined : { start: destination_start + 1, end }; }
  let depth = 0;
  for (let index = destination_start; index < source.length; index += 1) { const character = source[index]!; if (character === '\\') { index += 1; continue; } if (character === '(') { depth += 1; continue; } if (character === ')') { if (depth === 0) return { start: destination_start, end: index }; depth -= 1; continue; } if (/\s/.test(character) && depth === 0) return { start: destination_start, end: index }; }
  return undefined;
};
const definition_destination_range = (source: string): { start: number; end: number } | undefined => {
  const label_end = matching_bracket_end(source, 0); if (label_end < 0 || source[label_end + 1] !== ':') return undefined; let start = label_end + 2; while (/\s/.test(source[start] ?? '')) start += 1;
  if (source[start] === '<') { const end = escaped_end(source, start + 1, '>'); return end < 0 ? undefined : { start: start + 1, end }; }
  let end = start; while (end < source.length && !/\s/.test(source[end]!)) { if (source[end] === '\\') end += 1; end += 1; } return end > start ? { start, end } : undefined;
};

/** Replaces only AST-recognized local image destinations, retaining Markdown syntax and inert code. */
export const rewrite_markdown_images = (markdown: string, urls: ReadonlyMap<string, string>): string => {
  const tree = unified_processor().use(remark_parse).parse(markdown);
  const normalized_urls = new Map<string, string>();
  for (const [source, url] of urls) { const normalized = canonical_local_destination(source); if (normalized !== undefined && !normalized_urls.has(normalized)) normalized_urls.set(normalized, url); }
  const definitions = collect_markdown_definitions(tree);
  const referenced = new Set<string>(); const first_definitions = new Set<markdown_node>(); const known_definitions = new Set<string>(); const replacements: replacement[] = [];
  visit(tree, (node) => {
    if (node.type === 'imageReference' && typeof node.identifier === 'string') referenced.add(node.identifier);
    if (node.type === 'definition' && typeof node.identifier === 'string' && !known_definitions.has(node.identifier)) { known_definitions.add(node.identifier); first_definitions.add(node); }
    if (node.type === 'image' && typeof node.url === 'string') {
      const replacement_url = canonical_local_destination(node.url) === undefined ? undefined : normalized_urls.get(canonical_local_destination(node.url)!); const range = offsets(node);
      if (replacement_url && range) { const source = markdown.slice(range.start, range.end); const destination = inline_destination_range(source); if (destination) replacements.push({ start: range.start, end: range.end, value: source.slice(0, destination.start) + replacement_url + source.slice(destination.end) }); }
    }
  });
  visit(tree, (node) => {
    if (node.type !== 'definition' || typeof node.identifier !== 'string' || typeof node.url !== 'string' || !referenced.has(node.identifier) || !first_definitions.has(node) || definitions.get(node.identifier) === undefined) return;
    const canonical_destination = canonical_local_destination(node.url); const replacement_url = canonical_destination === undefined ? undefined : normalized_urls.get(canonical_destination); const range = offsets(node); if (!replacement_url || !range) return;
    const source = markdown.slice(range.start, range.end); const destination = definition_destination_range(source); if (destination) replacements.push({ start: range.start, end: range.end, value: source.slice(0, destination.start) + replacement_url + source.slice(destination.end) });
  });
  return [...replacements].sort((left, right) => right.start - left.start).reduce((result, replacement) => result.slice(0, replacement.start) + replacement.value + result.slice(replacement.end), markdown);
};

/** Uploads only absent objects, allowing exact-digest idempotent reuse. */
export const publish_prepared_images = async (images: readonly prepared_image[], adapter: cos_adapter): Promise<publish_result> => {
  const objects: published_image[] = [];
  try {
    await adapter.verify_versioning();
    for (const image of images) {
    const owned_bytes = new Uint8Array(image.bytes); const owned_digest = sha256(owned_bytes);
    if (owned_digest !== image.sha256) throw new studio_image_publish_error('untracked_create', objects, `Prepared image bytes changed: ${image.object_key}`);
    const owned_image = { ...image, bytes: owned_bytes };
    const existing = await adapter.inspect_object(image.object_key);
    if (existing && existing.sha256 !== image.sha256) throw new studio_image_publish_error('collision', objects, `Object collision: ${image.object_key}`);
    if (existing) { objects.push({ ...owned_image, status: 'reused' }); continue; }
    try {
      const created = await adapter.upload_object(owned_image);
      if (!created.version_id) throw new studio_image_publish_error('untracked_create', objects, `Created object lacks a version token: ${image.object_key}`);
      objects.push({ ...owned_image, status: 'created', version_id: created.version_id });
    } catch (error: unknown) {
      if (error instanceof studio_image_publish_error) throw error;
      const precondition_failed = typeof error === 'object' && error !== null && 'statusCode' in error && (error as { statusCode?: unknown }).statusCode === 412;
      if (!precondition_failed) throw error;
      const raced = await adapter.inspect_object(image.object_key);
      if (raced?.sha256 === image.sha256) objects.push({ ...owned_image, status: 'reused' });
      else throw new studio_image_publish_error('collision', objects, `Object collision: ${image.object_key}`);
    }
    }
    return { objects, manifest: objects.map(({ source_path, object_key, public_url }) => ({ source_path, object_key, public_url })) };
  } catch (error: unknown) {
    if (error instanceof studio_image_publish_error) throw error;
    const message = error instanceof Error ? error.message : 'Image publication adapter failure.';
    throw new studio_image_publish_error('adapter_failure', objects, message, error);
  }
};

/** Deletes only objects created during the current request and reports all best-effort failures. */
export const cleanup_created_images = async (objects: readonly published_image[], adapter: cos_adapter): Promise<cleanup_result> => {
  const deleted: string[] = []; const failures: string[] = [];
  for (const object of objects) if (object.status === 'created') try { await adapter.delete_object(object.object_key, object.version_id); deleted.push(object.object_key); } catch { failures.push(object.object_key); }
  return { deleted, failures };
};

export type tencent_cos_config = { secret_id: string; secret_key: string; region: string; bucket: string; public_base_url: string; root_prefix: string };
type cos_client = { getBucketVersioning(input: { Bucket: string; Region: string }): Promise<{ VersioningConfiguration: { Status: 'Enabled' | 'Suspended' } }>; headObject(input: { Bucket: string; Region: string; Key: string }): Promise<{ headers?: Record<string, string | undefined> }>; putObject(input: { Bucket: string; Region: string; Key: string; Headers: { 'If-None-Match': '*' }; Body: Buffer; ContentLength: number; ContentType: string; 'x-cos-meta-sha256': string }): Promise<{ VersionId?: string }>; deleteObject(input: { Bucket: string; Region: string; Key: string; VersionId: string }): Promise<unknown> };
type cos_client_factory = (config: tencent_cos_config) => cos_client;
const valid_cos_config = (config: tencent_cos_config): void => {
  if (!config.secret_id.trim() || !config.secret_key.trim() || /[\x00-\x20\x7f-\x9f]/.test(config.secret_id) || /[\x00-\x20\x7f-\x9f]/.test(config.secret_key) || !/^(?:ap|na|eu|sa|cn)-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(config.region) || !/^[a-z0-9]+(?:-[a-z0-9]+)*-\d{10}$/.test(config.bucket)) invalid('Invalid COS configuration.');
  root_prefix(config.root_prefix); public_url(config.public_base_url, 'test');
};
const valid_adapter_key = (object_key: string, prefix: string): void => {
  const prefix_parts = prefix.split('/'); const parts = object_key.split('/'); const tail = parts.slice(prefix_parts.length);
  if (parts.slice(0, prefix_parts.length).join('/') !== prefix || tail.length !== 4 || tail[0] !== 'articles' || !/^[2-9]\d{3}$/.test(tail[1]!) || !component_pattern.test(tail[2]!) || !/^(?:cover\.webp|fig-(?:0[1-9]|[1-9]\d+)-[a-z0-9]+(?:-[a-z0-9]+)*\.(?:webp|png))$/.test(tail[3]!)) invalid('Invalid COS object key.');
};
/** Tencent COS adapter. Construction is local-only and does not initiate network traffic. */
export class tencent_cos_adapter implements cos_adapter {
  private readonly client: cos_client;
  constructor(private readonly config: tencent_cos_config, client_factory: cos_client_factory = (value) => new cos_sdk({ SecretId: value.secret_id, SecretKey: value.secret_key })) {
    valid_cos_config(config);
    this.client = client_factory(config);
  }
  async verify_versioning(): Promise<void> { const result = await this.client.getBucketVersioning({ Bucket: this.config.bucket, Region: this.config.region }); if (result.VersioningConfiguration.Status !== 'Enabled') throw new studio_image_error('validation', 'COS bucket versioning must be enabled.'); }
  async inspect_object(object_key: string): Promise<{ sha256: string } | undefined> { valid_adapter_key(object_key, this.config.root_prefix); try { const result = await this.client.headObject({ Bucket: this.config.bucket, Region: this.config.region, Key: object_key }); const value = result.headers?.['x-cos-meta-sha256']; if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) throw new studio_image_error('missing_remote_digest', `COS object lacks a valid sha256 digest: ${object_key}`); return { sha256: value.toLowerCase() }; } catch (error: unknown) { if (typeof error === 'object' && error !== null && 'statusCode' in error && (error as { statusCode?: unknown }).statusCode === 404) return undefined; throw error; } }
  async upload_object(input: prepared_image): Promise<{ version_id: string }> { valid_adapter_key(input.object_key, this.config.root_prefix); const bytes = new Uint8Array(input.bytes); if (sha256(bytes) !== input.sha256) throw new studio_image_error('untracked_create', `Image bytes changed: ${input.object_key}`); const result = await this.client.putObject({ Bucket: this.config.bucket, Region: this.config.region, Key: input.object_key, Headers: { 'If-None-Match': '*' }, Body: Buffer.from(bytes), ContentLength: bytes.byteLength, ContentType: input.content_type, 'x-cos-meta-sha256': input.sha256 }); if (!result.VersionId) throw new studio_image_error('untracked_create', `COS create returned no version id: ${input.object_key}`); return { version_id: result.VersionId }; }
  async delete_object(object_key: string, version_id: string): Promise<void> { valid_adapter_key(object_key, this.config.root_prefix); if (!version_id) invalid('Invalid COS version id.'); await this.client.deleteObject({ Bucket: this.config.bucket, Region: this.config.region, Key: object_key, VersionId: version_id }); }
}
