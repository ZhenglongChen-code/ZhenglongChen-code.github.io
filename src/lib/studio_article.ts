import matter from 'gray-matter';
import remark_parse from 'remark-parse';
import { unified as unified_processor } from 'unified';
import { collect_markdown_definitions, studio_validation_error, type studio_validation_issue } from './markdown_preview';

export type studio_asset = {
  object_key: string;
  public_url: string;
  source_path: string;
};

export type studio_article_metadata = {
  title: string;
  description: string;
  date: string;
  updated?: string;
  tags: string[];
  language: 'zh' | 'en';
  translation?: string;
  featured: boolean;
  draft: boolean;
  slug: string;
  assets: studio_asset[];
  social: { zhihu: boolean; wechat: boolean; xiaohongshu: boolean };
};

export type studio_article = {
  metadata: studio_article_metadata;
  body: string;
};

export type studio_article_source = {
  metadata: Record<string, unknown>;
  body: string;
};

const slug_pattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const date_scalar_pattern = /^(date|updated):[ \t]*(\d{4}-\d{2}-\d{2})(\s*(?:#.*)?)$/gm;

const is_record = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const format_date = (value: unknown, field: string, issues: studio_validation_issue[]): string | undefined => {
  if (typeof value === 'string') {
    const date_match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (date_match) {
      const year = Number(date_match[1]);
      const month = Number(date_match[2]);
      const day = Number(date_match[3]);
      const calendar_date = new Date(Date.UTC(year, month - 1, day));
      if (calendar_date.getUTCFullYear() === year && calendar_date.getUTCMonth() === month - 1 && calendar_date.getUTCDate() === day) {
        return value;
      }
    }
  }
  issues.push({ code: 'invalid_frontmatter', field, message: `${field} must be a YYYY-MM-DD date.` });
  return undefined;
};

const preserve_date_scalars = (source: string): string => source.replace(
  /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/,
  (_match, opening, frontmatter, closing) => `${opening}${frontmatter.replace(date_scalar_pattern, '$1: "$2"$3')}${closing}`,
);

const required_string = (value: unknown, field: string, issues: studio_validation_issue[]): string | undefined => {
  if (typeof value === 'string' && value.trim()) return value.trim();
  issues.push({ code: 'invalid_frontmatter', field, message: `${field} must be a non-empty string.` });
  return undefined;
};

const optional_string = (value: unknown, field: string, issues: studio_validation_issue[]): string | undefined => {
  if (value === undefined) return undefined;
  return required_string(value, field, issues);
};

/** Parses Markdown frontmatter without requiring every publish-time metadata field. */
export const parse_studio_article_source = (source: string): studio_article_source => {
  let parsed_source: ReturnType<typeof matter>;
  try {
    parsed_source = matter(preserve_date_scalars(source));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to parse frontmatter.';
    throw new studio_validation_error([{
      code: 'invalid_frontmatter',
      message: `Unable to parse frontmatter: ${message}`,
    }]);
  }
  if (!is_record(parsed_source.data)) {
    throw new studio_validation_error([{
      code: 'invalid_frontmatter',
      message: 'Frontmatter must be an object.',
    }]);
  }
  return { metadata: parsed_source.data, body: parsed_source.content };
};

/** Validates a content-collection-compatible slug for locally edited articles. */
export const validate_article_slug = (slug: string): void => {
  if (!slug_pattern.test(slug)) {
    throw new studio_validation_error([{
      code: 'invalid_slug',
      field: 'slug',
      message: 'slug must use lowercase ASCII letters, digits, and hyphens.',
    }]);
  }
};

const parse_assets = (value: unknown, issues: studio_validation_issue[]): studio_asset[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push({ code: 'invalid_frontmatter', field: 'assets', message: 'assets must be an array.' });
    return [];
  }

  return value.flatMap((asset, index) => {
    if (!is_record(asset)) {
      issues.push({ code: 'invalid_frontmatter', field: `assets[${index}]`, message: 'Each asset must be an object.' });
      return [];
    }
    const object_key = required_string(asset.object_key, `assets[${index}].object_key`, issues);
    const public_url = required_string(asset.public_url, `assets[${index}].public_url`, issues);
    const source_path = required_string(asset.source_path, `assets[${index}].source_path`, issues);
    return object_key && public_url && source_path ? [{ object_key, public_url, source_path }] : [];
  });
};

/** Imports a Markdown document into the stable Studio article representation. */
export const parse_studio_article = (source: string, slug: string): studio_article => {
  validate_article_slug(slug);
  const parsed_source = parse_studio_article_source(source);
  const data = parsed_source.metadata;
  const issues: studio_validation_issue[] = [];
  const title = required_string(data.title, 'title', issues);
  const description = required_string(data.description, 'description', issues);
  const date = format_date(data.date, 'date', issues);
  const updated = data.updated === undefined ? undefined : format_date(data.updated, 'updated', issues);
  const tags = data.tags === undefined ? [] : Array.isArray(data.tags) && data.tags.every((tag) => typeof tag === 'string' && tag.trim())
    ? data.tags.map((tag) => (tag as string).trim())
    : (issues.push({ code: 'invalid_frontmatter', field: 'tags', message: 'tags must be an array of non-empty strings.' }), []);
  const language = data.language === 'zh' || data.language === 'en' ? data.language : 'zh';
  if (data.language !== undefined && data.language !== 'zh' && data.language !== 'en') {
    issues.push({ code: 'invalid_frontmatter', field: 'language', message: 'language must be zh or en.' });
  }
  const translation = optional_string(data.translation, 'translation', issues);
  const featured = data.featured === undefined ? false : data.featured;
  const draft = data.draft === undefined ? false : data.draft;
  if (typeof featured !== 'boolean') issues.push({ code: 'invalid_frontmatter', field: 'featured', message: 'featured must be a boolean.' });
  if (typeof draft !== 'boolean') issues.push({ code: 'invalid_frontmatter', field: 'draft', message: 'draft must be a boolean.' });
  const assets = parse_assets(data.assets, issues);
  const social_data = data.social === undefined ? {} : data.social;
  const social_is_valid = is_record(social_data) && [social_data.zhihu, social_data.wechat, social_data.xiaohongshu]
    .every((value) => value === undefined || typeof value === 'boolean');
  const social = {
    zhihu: is_record(social_data) && typeof social_data.zhihu === 'boolean' ? social_data.zhihu : true,
    wechat: is_record(social_data) && typeof social_data.wechat === 'boolean' ? social_data.wechat : true,
    xiaohongshu: is_record(social_data) && typeof social_data.xiaohongshu === 'boolean' ? social_data.xiaohongshu : true,
  };
  if (!social_is_valid) {
    issues.push({ code: 'invalid_frontmatter', field: 'social', message: 'social must contain boolean platform settings.' });
  }

  if (issues.length > 0 || !title || !description || !date || typeof featured !== 'boolean' || typeof draft !== 'boolean') {
    throw new studio_validation_error(issues);
  }

  return {
    metadata: { title, description, date, updated, tags, language, translation, featured, draft, slug, assets, social },
    body: parsed_source.body,
  };
};

/** Serializes Studio metadata and Markdown body into an editable Markdown document. */
export const serialize_studio_article = (article: studio_article): string => {
  const { metadata } = article;
  const frontmatter = {
    title: metadata.title,
    description: metadata.description,
    date: metadata.date,
    tags: metadata.tags,
    language: metadata.language,
    featured: metadata.featured,
    draft: metadata.draft,
    assets: metadata.assets,
    social: metadata.social,
    ...(metadata.updated === undefined ? {} : { updated: metadata.updated }),
    ...(metadata.translation === undefined ? {} : { translation: metadata.translation }),
  };
  return matter.stringify(article.body, frontmatter);
};

type markdown_node = {
  children?: unknown;
  identifier?: unknown;
  type?: unknown;
  url?: unknown;
};

type image_reference = {
  identifier?: string;
  url?: string;
};

const collect_image_references = (node: unknown, images: image_reference[]): void => {
  if (typeof node !== 'object' || node === null) return;
  const markdown_node = node as markdown_node;
  if (markdown_node.type === 'image' && typeof markdown_node.url === 'string') images.push({ url: markdown_node.url });
  if (markdown_node.type === 'imageReference' && typeof markdown_node.identifier === 'string') {
    images.push({ identifier: markdown_node.identifier });
  }
  if (Array.isArray(markdown_node.children)) {
    for (const child of markdown_node.children) collect_image_references(child, images);
  }
};

const is_local_image = (source: string): boolean => !/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(source);

/** Finds unique local image references through Markdown AST image nodes and definitions. */
export const discover_local_images = (markdown: string): string[] => {
  const markdown_tree = unified_processor().use(remark_parse).parse(markdown);
  const definitions = collect_markdown_definitions(markdown_tree);
  const images: image_reference[] = [];
  collect_image_references(markdown_tree, images);
  const discovered_images: string[] = [];
  const seen_images = new Set<string>();
  for (const image of images) {
    const source = image.url ?? (image.identifier === undefined ? undefined : definitions.get(image.identifier));
    if (source && is_local_image(source) && !seen_images.has(source)) {
      seen_images.add(source);
      discovered_images.push(source);
    }
  }
  return discovered_images;
};
