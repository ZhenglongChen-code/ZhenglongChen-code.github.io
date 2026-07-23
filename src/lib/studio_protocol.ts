/** The stable, local-only wire protocol used by Markdown Studio. */
export const studio_protocol_version = 1 as const;
export type studio_error = { code: string; field?: string; message: string };
export type studio_image_input = { source_path: string; bytes: Uint8Array; claimed_content_type: 'image/jpeg' | 'image/png'; intent: 'photo' | 'screenshot' | 'diagram'; semantic_name: string };
export type studio_metadata_input = { title: string; description: string; date: string; tags?: string[]; language?: 'zh' | 'en'; featured?: boolean; draft?: boolean };
type studio_request_base = { protocol_version: 1; request_id: string; slug: string; year: number; markdown: string; metadata: studio_metadata_input; images?: studio_image_input[] };
export type studio_preview_request = studio_request_base & { kind: 'preview' };
export type studio_publish_new_request = studio_request_base & { kind: 'publish_new'; commit_message: string };
export type studio_publish_update_request = studio_request_base & { kind: 'publish_update'; commit_message: string; expected_source_hash: string };
export type studio_request = studio_preview_request | studio_publish_new_request | studio_publish_update_request;
export type studio_response = { protocol_version: 1; kind: 'preview'; publishable: boolean; errors: studio_error[] } | { protocol_version: 1; kind: 'published'; public_url: string; commit_sha: string; deployment_advisory?: string } | { protocol_version: 1; kind: 'committed_local'; commit_sha: string; recovery: string } | { protocol_version: 1; kind: 'failed'; errors: studio_error[]; cleanup?: { deleted: string[]; failures: string[] } } | { protocol_version: 1; kind: 'recovery_required'; errors: studio_error[] };
export class studio_protocol_error extends Error { constructor(readonly errors: studio_error[]) { super(errors.map((item) => item.message).join('; ')); this.name = 'studio_protocol_error'; } }
const request_id_pattern = /^(?:[a-f0-9]{32}|[a-f0-9]{64}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/;
const slug_pattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const reject_unknown = (value: Record<string, unknown>, allowed: readonly string[], errors: studio_error[]): void => { for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push({ code: 'invalid_field', field: key, message: `Unknown field: ${key}.` }); };
const string = (value: unknown, field: string, errors: studio_error[], max = 200_000): string | undefined => { if (typeof value !== 'string' || value.length === 0 || value.length > max) { errors.push({ code: 'invalid_field', field, message: `${field} must be a non-empty string within the size limit.` }); return undefined; } return value; };

/** Validates untrusted JSON and snapshots all mutable binary values. */
export const validate_studio_request = (value: unknown): studio_request => {
  const errors: studio_error[] = [];
  if (!record(value)) throw new studio_protocol_error([{ code: 'invalid_request', message: 'Request must be an object.' }]);
  const kind = value.kind;
  if (kind !== 'preview' && kind !== 'publish_new' && kind !== 'publish_update') errors.push({ code: 'invalid_kind', field: 'kind', message: 'kind must be preview, publish_new, or publish_update.' });
  reject_unknown(value, kind === 'publish_update' ? ['protocol_version', 'kind', 'request_id', 'slug', 'year', 'markdown', 'metadata', 'images', 'commit_message', 'expected_source_hash'] : kind === 'publish_new' ? ['protocol_version', 'kind', 'request_id', 'slug', 'year', 'markdown', 'metadata', 'images', 'commit_message'] : ['protocol_version', 'kind', 'request_id', 'slug', 'year', 'markdown', 'metadata', 'images'], errors);
  if (value.protocol_version !== 1) errors.push({ code: 'invalid_version', field: 'protocol_version', message: 'protocol_version must be 1.' });
  const request_id = string(value.request_id, 'request_id', errors, 64);
  if (request_id && !request_id_pattern.test(request_id)) errors.push({ code: 'invalid_request_id', field: 'request_id', message: 'request_id must be lowercase UUID, 32-hex, or 64-hex.' });
  const slug = string(value.slug, 'slug', errors, 100); if (slug && !slug_pattern.test(slug)) errors.push({ code: 'invalid_slug', field: 'slug', message: 'slug must be lowercase ASCII words separated by hyphens.' });
  if (!Number.isInteger(value.year) || (value.year as number) < 2000 || (value.year as number) > 9999) errors.push({ code: 'invalid_year', field: 'year', message: 'year must be an integer from 2000 to 9999.' });
  const markdown = string(value.markdown, 'markdown', errors, 1_000_000);
  if (!record(value.metadata)) errors.push({ code: 'invalid_metadata', field: 'metadata', message: 'metadata must be an object.' });
  const metadata = record(value.metadata) ? value.metadata : {};
  reject_unknown(metadata, ['title', 'description', 'date', 'tags', 'language', 'featured', 'draft'], errors);
  const title = string(metadata.title, 'metadata.title', errors, 300); const description = string(metadata.description, 'metadata.description', errors, 1000); const date = string(metadata.date, 'metadata.date', errors, 10);
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.push({ code: 'invalid_metadata', field: 'metadata.date', message: 'metadata.date must be YYYY-MM-DD.' });
  const tags = metadata.tags === undefined ? undefined : Array.isArray(metadata.tags) && metadata.tags.every((tag) => typeof tag === 'string' && tag.length > 0 && tag.length <= 80) ? [...metadata.tags] as string[] : (errors.push({ code: 'invalid_metadata', field: 'metadata.tags', message: 'metadata.tags must be non-empty strings.' }), undefined);
  if (metadata.language !== undefined && metadata.language !== 'zh' && metadata.language !== 'en') errors.push({ code: 'invalid_metadata', field: 'metadata.language', message: 'metadata.language must be zh or en.' });
  if (metadata.featured !== undefined && typeof metadata.featured !== 'boolean') errors.push({ code: 'invalid_metadata', field: 'metadata.featured', message: 'metadata.featured must be boolean.' });
  if (metadata.draft !== undefined && typeof metadata.draft !== 'boolean') errors.push({ code: 'invalid_metadata', field: 'metadata.draft', message: 'metadata.draft must be boolean.' });
  const raw_images = value.images === undefined ? [] : value.images;
  if (!Array.isArray(raw_images) || raw_images.length > 20) errors.push({ code: 'invalid_images', field: 'images', message: 'images must contain at most 20 items.' });
  const images: studio_image_input[] = [];
  if (Array.isArray(raw_images)) for (const [index, image] of raw_images.entries()) { if (!record(image)) { errors.push({ code: 'invalid_image', field: `images[${index}]`, message: 'image must be an object.' }); continue; } reject_unknown(image, ['source_path', 'bytes', 'claimed_content_type', 'intent', 'semantic_name'], errors); if (!(image.bytes instanceof Uint8Array) || image.bytes.byteLength === 0 || image.bytes.byteLength > 20_000_000 || typeof image.source_path !== 'string' || typeof image.semantic_name !== 'string' || (image.claimed_content_type !== 'image/jpeg' && image.claimed_content_type !== 'image/png') || (image.intent !== 'photo' && image.intent !== 'screenshot' && image.intent !== 'diagram')) { errors.push({ code: 'invalid_image', field: `images[${index}]`, message: 'image fields are invalid or exceed limits.' }); continue; } images.push({ source_path: image.source_path, bytes: new Uint8Array(image.bytes), claimed_content_type: image.claimed_content_type, intent: image.intent, semantic_name: image.semantic_name }); }
  let commit_message: string | undefined; let expected_source_hash: string | undefined;
  if (kind === 'publish_new' || kind === 'publish_update') commit_message = string(value.commit_message, 'commit_message', errors, 200);
  if (kind === 'publish_update') { expected_source_hash = string(value.expected_source_hash, 'expected_source_hash', errors, 64); if (expected_source_hash && !/^[a-f0-9]{64}$/.test(expected_source_hash)) errors.push({ code: 'invalid_hash', field: 'expected_source_hash', message: 'expected_source_hash must be lowercase SHA-256.' }); }
  if (errors.length || !request_id || !slug || markdown === undefined || !title || !description || !date || (kind !== 'preview' && !commit_message) || (kind === 'publish_update' && !expected_source_hash)) throw new studio_protocol_error(errors);
  const normalized_metadata: studio_metadata_input = { title, description, date, ...(tags === undefined ? {} : { tags }), ...(metadata.language === 'zh' || metadata.language === 'en' ? { language: metadata.language } : {}), ...(typeof metadata.featured === 'boolean' ? { featured: metadata.featured } : {}), ...(typeof metadata.draft === 'boolean' ? { draft: metadata.draft } : {}) };
  const base = { protocol_version: 1 as const, request_id, slug, year: value.year as number, markdown, metadata: normalized_metadata, ...(images.length === 0 ? {} : { images }) };
  if (kind === 'preview') return { ...base, kind: 'preview' };
  if (kind === 'publish_new') return { ...base, kind: 'publish_new', commit_message: commit_message! };
  if (kind === 'publish_update') return { ...base, kind: 'publish_update', commit_message: commit_message!, expected_source_hash: expected_source_hash! };
  throw new studio_protocol_error(errors);
};
