import matter from 'gray-matter';
import { studio_validation_error, type studio_validation_issue } from './markdown_preview';

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

const slug_pattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const is_record = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const format_date = (value: unknown, field: string, issues: studio_validation_issue[]): string | undefined => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  issues.push({ code: 'invalid_frontmatter', field, message: `${field} must be a YYYY-MM-DD date.` });
  return undefined;
};

const required_string = (value: unknown, field: string, issues: studio_validation_issue[]): string | undefined => {
  if (typeof value === 'string' && value.trim()) return value.trim();
  issues.push({ code: 'invalid_frontmatter', field, message: `${field} must be a non-empty string.` });
  return undefined;
};

const optional_string = (value: unknown, field: string, issues: studio_validation_issue[]): string | undefined => {
  if (value === undefined) return undefined;
  return required_string(value, field, issues);
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
  const parsed_source = matter(source);
  const data = parsed_source.data as Record<string, unknown>;
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
    body: parsed_source.content,
  };
};

/** Serializes Studio metadata and Markdown body into an editable Markdown document. */
export const serialize_studio_article = (article: studio_article): string => {
  const { slug: _slug, ...frontmatter } = article.metadata;
  return matter.stringify(article.body, frontmatter);
};

/** Finds local image references in Markdown image syntax without following remote URLs. */
export const discover_local_images = (markdown: string): string[] => {
  const image_sources = [...markdown.matchAll(/!\[[^\]]*\]\((?:<)?([^\s>)]+)(?:>)?(?:\s+[^)]*)?\)/g)]
    .map((match) => match[1])
    .filter((source): source is string => Boolean(source));
  return image_sources.filter((source) => !/^(?:https?:|data:|\/)/i.test(source));
};
