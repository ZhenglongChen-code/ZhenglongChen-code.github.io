import { createHash as create_hash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile as read_file,
  readdir,
  rm,
  writeFile as write_file,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { afterEach as after_each, describe, expect, it } from 'vitest';
import { export_social_articles } from '../scripts/export_social';

const temporary_roots: string[] = [];

/** Creates one isolated project root with its writing source directory. */
async function create_temporary_project(): Promise<string> {
  const temporary_root = await mkdtemp(join(tmpdir(), 'social-export-test-'));
  temporary_roots.push(temporary_root);
  await mkdir(resolve(temporary_root, 'src/content/writing'), { recursive: true });
  return temporary_root;
}

/** Writes one complete Markdown content fixture. */
async function write_article(
  project_root: string,
  slug: string,
  frontmatter: string,
  markdown = 'Article body.',
): Promise<void> {
  const article_path = resolve(project_root, 'src/content/writing', `${slug}.md`);
  await write_file(article_path, `---\n${frontmatter.trim()}\n---\n\n${markdown}`, 'utf8');
}

/** Reads every generated file into a deterministic relative-path map. */
async function read_export_tree(project_root: string): Promise<Record<string, string>> {
  const output_path = resolve(project_root, 'social_exports');
  const article_entries = await readdir(output_path, { withFileTypes: true });
  const tree: Record<string, string> = {};

  for (const article_entry of [...article_entries].sort((first_entry, second_entry) => (
    first_entry.name < second_entry.name ? -1 : first_entry.name > second_entry.name ? 1 : 0
  ))) {
    if (!article_entry.isDirectory()) {
      tree[article_entry.name] = await read_file(resolve(output_path, article_entry.name), 'utf8');
      continue;
    }

    const platform_files = await readdir(resolve(output_path, article_entry.name));
    for (const platform_file of [...platform_files].sort()) {
      const relative_path = `${article_entry.name}/${platform_file}`;
      tree[relative_path] = await read_file(resolve(output_path, relative_path), 'utf8');
    }
  }

  return tree;
}

after_each(async () => {
  for (const temporary_root of temporary_roots.splice(0)) {
    await rm(temporary_root, { recursive: true, force: true });
  }
});

describe('export_social_articles', () => {
  it('exports sorted public Chinese articles with platform defaults and disables', async () => {
    const project_root = await create_temporary_project();
    const common_frontmatter = [
      'title: Test article',
      'description: Test description',
      'tags: [Writing]',
      'language: zh',
      'draft: false',
    ].join('\n');

    await write_article(project_root, 'zeta', common_frontmatter);
    await write_article(project_root, 'alpha', `${common_frontmatter}\nsocial:\n  zhihu: false`);
    await write_article(project_root, 'beta', `${common_frontmatter}\nsocial:\n  wechat: false`);
    await write_article(project_root, 'gamma', `${common_frontmatter}\nsocial:\n  xiaohongshu: false`);
    await write_article(project_root, 'draft', common_frontmatter.replace('draft: false', 'draft: true'));
    await write_article(project_root, 'english', common_frontmatter.replace('language: zh', 'language: en'));

    const result = await export_social_articles({
      project_root,
      site_url: 'https://example.test',
    });

    expect(result.map((entry) => entry.slug)).toEqual(['alpha', 'beta', 'gamma', 'zeta']);
    expect(result.find((entry) => entry.slug === 'zeta')?.platforms).toEqual([
      'zhihu',
      'wechat',
      'xiaohongshu',
    ]);

    const first_tree = await read_export_tree(project_root);
    expect(Object.keys(first_tree)).toEqual([
      'alpha/wechat.html',
      'alpha/xiaohongshu.md',
      'beta/xiaohongshu.md',
      'beta/zhihu.md',
      'gamma/wechat.html',
      'gamma/zhihu.md',
      'zeta/wechat.html',
      'zeta/xiaohongshu.md',
      'zeta/zhihu.md',
    ]);
    expect(first_tree['zeta/xiaohongshu.md']).toContain('https://example.test/writing/zeta');
    expect(Object.keys(first_tree).some((path) => path.startsWith('draft/'))).toBe(false);
    expect(Object.keys(first_tree).some((path) => path.startsWith('english/'))).toBe(false);

    await export_social_articles({ project_root, site_url: 'https://example.test' });
    expect(await read_export_tree(project_root)).toEqual(first_tree);
  });

  it('rejects malformed SITE_URL input before creating an output directory', async () => {
    const project_root = await create_temporary_project();
    await write_article(project_root, 'valid', [
      'title: Valid',
      'description: Valid description',
    ].join('\n'));

    await expect(export_social_articles({ project_root, site_url: 'not a url' }))
      .rejects.toThrow(/SITE_URL.*valid absolute/i);
    await expect(readdir(resolve(project_root, 'social_exports')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects the filesystem root before deriving destructive paths', async () => {
    const filesystem_root = parse(await create_temporary_project()).root;

    await expect(export_social_articles({
      project_root: filesystem_root,
      site_url: 'https://example.test',
    })).rejects.toThrow(/unsafe project root/i);
  });

  it('leaves the previous export byte-for-byte intact when later frontmatter is invalid', async () => {
    const project_root = await create_temporary_project();
    const output_path = resolve(project_root, 'social_exports');
    const sentinel_path = resolve(output_path, 'sentinel.txt');
    const sentinel_content = 'previous successful export\n\u0000stable bytes';
    await mkdir(output_path, { recursive: true });
    await write_file(sentinel_path, sentinel_content, 'utf8');
    const original_hash = create_hash('sha256').update(await read_file(sentinel_path)).digest('hex');

    await write_article(project_root, 'a-valid', [
      'title: Valid',
      'description: Valid description',
      'language: zh',
    ].join('\n'));
    await write_article(project_root, 'z-invalid', [
      'title: Invalid',
      'description: 42',
      'language: zh',
    ].join('\n'));

    await expect(export_social_articles({
      project_root,
      site_url: 'https://example.test',
    })).rejects.toThrow(/description.*non-empty string/i);

    const final_hash = create_hash('sha256').update(await read_file(sentinel_path)).digest('hex');
    expect(final_hash).toBe(original_hash);
    expect(await read_file(sentinel_path, 'utf8')).toBe(sentinel_content);
    expect(await readdir(output_path)).toEqual(['sentinel.txt']);

    const project_entries = await readdir(project_root);
    expect(project_entries.some((entry) => entry.startsWith('.social_exports-stage-'))).toBe(false);
    expect(project_entries.some((entry) => entry.startsWith('.social_exports-backup-'))).toBe(false);
  });
});
