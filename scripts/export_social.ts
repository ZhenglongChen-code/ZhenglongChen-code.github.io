import {
  lstat,
  mkdir,
  mkdtemp,
  readFile as read_file,
  readdir,
  rename,
  rm,
  writeFile as write_file,
} from 'node:fs/promises';
import { basename, dirname, parse, resolve } from 'node:path';
import { fileURLToPath as file_url_to_path } from 'node:url';
import matter from 'gray-matter';
import {
  format_wechat_html,
  format_xiaohongshu,
  format_zhihu,
  type social_article,
} from '../src/lib/social_export';

type social_platforms = {
  zhihu: boolean;
  wechat: boolean;
  xiaohongshu: boolean;
};

type social_platform_name = keyof social_platforms;

type export_article = social_article & {
  slug: string;
  platforms: social_platforms;
};

type prepared_file = {
  filename: string;
  content: string;
};

type prepared_article = {
  slug: string;
  platforms: social_platform_name[];
  files: prepared_file[];
};

type export_paths = {
  project_root: string;
  writing_path: string;
  output_path: string;
};

export type social_export_options = {
  project_root: string;
  site_url: string;
};

export type social_export_result = {
  slug: string;
  platforms: social_platform_name[];
};

const stage_prefix = '.social_exports-stage-';
const backup_prefix = '.social_exports-backup-';

/** Narrows unknown values to records without weakening types. */
function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Identifies a missing-path filesystem error. */
function is_missing_path_error(error: unknown): boolean {
  return is_record(error) && error.code === 'ENOENT';
}

/** Reads a required non-empty string field from frontmatter. */
function read_required_string(frontmatter: Record<string, unknown>, key: string, slug: string): string {
  const value = frontmatter[key];

  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${slug}: frontmatter field "${key}" must be a non-empty string.`);
  }

  return value.trim();
}

/** Reads an optional boolean frontmatter field with a deterministic default. */
function read_optional_boolean(
  frontmatter: Record<string, unknown>,
  key: string,
  default_value: boolean,
  slug: string,
): boolean {
  const value = frontmatter[key];

  if (value === undefined) {
    return default_value;
  }

  if (typeof value !== 'boolean') {
    throw new TypeError(`${slug}: frontmatter field "${key}" must be a boolean.`);
  }

  return value;
}

/** Validates tags as an ordered list of non-empty strings. */
function read_tags(frontmatter: Record<string, unknown>, slug: string): string[] {
  const value = frontmatter.tags;

  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value) || value.some((tag) => typeof tag !== 'string' || !tag.trim())) {
    throw new TypeError(`${slug}: frontmatter field "tags" must contain only non-empty strings.`);
  }

  return value.map((tag) => tag.trim());
}

/** Validates per-platform switches, defaulting omitted settings to enabled. */
function read_platforms(frontmatter: Record<string, unknown>, slug: string): social_platforms {
  const value = frontmatter.social;

  if (value === undefined) {
    return { zhihu: true, wechat: true, xiaohongshu: true };
  }

  if (!is_record(value)) {
    throw new TypeError(`${slug}: frontmatter field "social" must be an object.`);
  }

  return {
    zhihu: read_optional_boolean(value, 'zhihu', true, slug),
    wechat: read_optional_boolean(value, 'wechat', true, slug),
    xiaohongshu: read_optional_boolean(value, 'xiaohongshu', true, slug),
  };
}

/** Accepts only credential-free HTTP(S) site origins. */
function parse_site_url(raw_site_url: string): URL {
  let site_url: URL;

  try {
    site_url = new URL(raw_site_url);
  } catch {
    throw new TypeError('SITE_URL must be a valid absolute HTTP(S) URL.');
  }

  if (
    !['http:', 'https:'].includes(site_url.protocol)
    || !site_url.hostname
    || site_url.username
    || site_url.password
    || site_url.search
    || site_url.hash
  ) {
    throw new TypeError('SITE_URL must be a credential-free HTTP(S) URL without a query or fragment.');
  }

  return site_url;
}

/** Resolves the fixed source and output paths for one safe project root. */
function resolve_export_paths(raw_project_root: string): export_paths {
  if (!raw_project_root.trim()) {
    throw new TypeError('Project root must be a non-empty path.');
  }

  const project_root = resolve(raw_project_root);
  if (project_root === parse(project_root).root) {
    throw new Error('Refusing to use an unsafe project root.');
  }

  const writing_path = resolve(project_root, 'src/content/writing');
  const output_path = resolve(project_root, 'social_exports');
  assert_safe_output_path(project_root, output_path);

  return { project_root, writing_path, output_path };
}

/** Guards the one exact generated directory that publication may replace. */
function assert_safe_output_path(project_root: string, target_path: string): void {
  if (
    !target_path
    || target_path === project_root
    || dirname(target_path) !== project_root
    || basename(target_path) !== 'social_exports'
  ) {
    throw new Error('Refusing to replace an unsafe social export path.');
  }
}

/** Guards a generated sibling temporary path by its exact prefix. */
function assert_safe_temporary_path(
  project_root: string,
  target_path: string,
  expected_prefix: string,
): void {
  const target_name = basename(target_path);

  if (
    !target_path
    || dirname(target_path) !== project_root
    || !target_name.startsWith(expected_prefix)
    || target_name.length === expected_prefix.length
  ) {
    throw new Error(`Refusing unsafe temporary social export path for ${expected_prefix}.`);
  }
}

/** Constructs a canonical writing URL with an encoded single-segment slug. */
function build_canonical_url(site_url: URL, slug: string): string {
  if (!slug || basename(slug) !== slug) {
    throw new TypeError('Article slug must be one non-empty path segment.');
  }

  return new URL(`/writing/${encodeURIComponent(slug)}`, site_url).toString();
}

/** Parses and validates one Markdown article without trusting raw frontmatter types. */
function parse_article(source: string, slug: string, site_url: URL): export_article | undefined {
  const parsed_article = matter(source);
  const raw_frontmatter: unknown = parsed_article.data;

  if (!is_record(raw_frontmatter)) {
    throw new TypeError(`${slug}: frontmatter must be an object.`);
  }

  const draft = read_optional_boolean(raw_frontmatter, 'draft', false, slug);
  const raw_language = raw_frontmatter.language;
  if (raw_language !== undefined && raw_language !== 'zh' && raw_language !== 'en') {
    throw new TypeError(`${slug}: frontmatter field "language" must be "zh" or "en".`);
  }

  if (draft || (raw_language ?? 'zh') !== 'zh') {
    return undefined;
  }

  return {
    slug,
    title: read_required_string(raw_frontmatter, 'title', slug),
    description: read_required_string(raw_frontmatter, 'description', slug),
    tags: read_tags(raw_frontmatter, slug),
    canonical_url: build_canonical_url(site_url, slug),
    markdown: parsed_article.content,
    platforms: read_platforms(raw_frontmatter, slug),
  };
}

/** Formats every enabled platform copy before publication begins. */
function prepare_article(article: export_article): prepared_article {
  const files: prepared_file[] = [];
  const platforms: social_platform_name[] = [];

  if (article.platforms.zhihu) {
    files.push({ filename: 'zhihu.md', content: format_zhihu(article) });
    platforms.push('zhihu');
  }

  if (article.platforms.wechat) {
    files.push({ filename: 'wechat.html', content: `${format_wechat_html(article)}\n` });
    platforms.push('wechat');
  }

  if (article.platforms.xiaohongshu) {
    files.push({ filename: 'xiaohongshu.md', content: `${format_xiaohongshu(article)}\n` });
    platforms.push('xiaohongshu');
  }

  return { slug: article.slug, platforms, files };
}

/** Reads, validates, filters, and formats every source in deterministic order. */
async function prepare_articles(writing_path: string, site_url: URL): Promise<prepared_article[]> {
  const directory_entries = await readdir(writing_path, { withFileTypes: true });
  const markdown_files = directory_entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name);
  const sorted_markdown_files = [...markdown_files].sort((first_name, second_name) => {
    if (first_name === second_name) {
      return 0;
    }

    return first_name < second_name ? -1 : 1;
  });
  const prepared_articles: prepared_article[] = [];

  for (const filename of sorted_markdown_files) {
    const slug = filename.slice(0, -'.md'.length);
    const source_path = resolve(writing_path, filename);

    if (dirname(source_path) !== writing_path) {
      throw new Error(`Refusing unsafe source path for ${filename}.`);
    }

    const source = await read_file(source_path, 'utf8');
    const article = parse_article(source, slug, site_url);

    if (article) {
      const prepared_article = prepare_article(article);
      if (prepared_article.files.length > 0) {
        prepared_articles.push(prepared_article);
      }
    }
  }

  return prepared_articles;
}

/** Reports whether an exact filesystem path currently exists. */
async function path_exists(target_path: string): Promise<boolean> {
  try {
    await lstat(target_path);
    return true;
  } catch (error: unknown) {
    if (is_missing_path_error(error)) {
      return false;
    }

    throw error;
  }
}

/** Removes one validated temporary sibling and nothing broader. */
async function remove_temporary_path(
  project_root: string,
  target_path: string,
  expected_prefix: string,
): Promise<void> {
  assert_safe_temporary_path(project_root, target_path, expected_prefix);
  await rm(target_path, { recursive: true, force: true });
}

/** Writes the complete prepared export tree to an isolated staging directory. */
async function write_staged_exports(stage_path: string, prepared_articles: prepared_article[]): Promise<void> {
  for (const article of prepared_articles) {
    const article_path = resolve(stage_path, article.slug);

    if (dirname(article_path) !== stage_path) {
      throw new Error(`Refusing unsafe staged article path for ${article.slug}.`);
    }

    await mkdir(article_path, { recursive: true });
    for (const file of article.files) {
      const file_path = resolve(article_path, file.filename);
      if (dirname(file_path) !== article_path) {
        throw new Error(`Refusing unsafe staged platform path for ${article.slug}.`);
      }

      await write_file(file_path, file.content, 'utf8');
    }
  }
}

/** Publishes prepared exports through a guarded stage and restorable backup. */
async function publish_exports(paths: export_paths, prepared_articles: prepared_article[]): Promise<void> {
  const stage_path = await mkdtemp(resolve(paths.project_root, stage_prefix));
  assert_safe_temporary_path(paths.project_root, stage_path, stage_prefix);
  let stage_is_present = true;
  let backup_path: string | undefined;
  let backup_has_previous_output = false;

  try {
    await write_staged_exports(stage_path, prepared_articles);

    backup_path = await mkdtemp(resolve(paths.project_root, backup_prefix));
    assert_safe_temporary_path(paths.project_root, backup_path, backup_prefix);
    await remove_temporary_path(paths.project_root, backup_path, backup_prefix);

    if (await path_exists(paths.output_path)) {
      await rename(paths.output_path, backup_path);
      backup_has_previous_output = true;
    }

    try {
      await rename(stage_path, paths.output_path);
      stage_is_present = false;
    } catch (swap_error: unknown) {
      if (backup_has_previous_output) {
        try {
          await rename(backup_path, paths.output_path);
          backup_has_previous_output = false;
        } catch (restore_error: unknown) {
          throw new AggregateError(
            [swap_error, restore_error],
            `Failed to publish social exports and restore backup at ${backup_path}.`,
          );
        }
      }

      throw swap_error;
    }

    if (backup_has_previous_output) {
      await remove_temporary_path(paths.project_root, backup_path, backup_prefix);
      backup_has_previous_output = false;
    }
  } finally {
    if (stage_is_present) {
      await remove_temporary_path(paths.project_root, stage_path, stage_prefix);
    }

    if (
      backup_path
      && !backup_has_previous_output
      && await path_exists(backup_path)
    ) {
      await remove_temporary_path(paths.project_root, backup_path, backup_prefix);
    }
  }
}

/** Regenerates platform copies transactionally from one explicit project root. */
export async function export_social_articles(
  options: social_export_options,
): Promise<social_export_result[]> {
  const paths = resolve_export_paths(options.project_root);
  const site_url = parse_site_url(options.site_url);
  const prepared_articles = await prepare_articles(paths.writing_path, site_url);

  await publish_exports(paths, prepared_articles);

  return prepared_articles.map((article) => ({
    slug: article.slug,
    platforms: [...article.platforms],
  }));
}

const script_path = file_url_to_path(import.meta.url);
const invoked_path = process.argv[1] ? resolve(process.argv[1]) : undefined;

if (invoked_path === script_path) {
  const script_project_root = resolve(file_url_to_path(new URL('..', import.meta.url)));
  const results = await export_social_articles({
    project_root: script_project_root,
    site_url: process.env.SITE_URL ?? 'http://106.14.173.234',
  });

  for (const result of results) {
    console.log(`Exported ${result.slug}: ${result.platforms.join(', ')}`);
  }
}
