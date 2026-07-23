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
import { cleanup_published_backup, export_social_articles } from '../scripts/export_social';

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
  it('warns without rejecting when published backup cleanup fails', async () => {
    const warnings: string[] = [];

    await expect(cleanup_published_backup(
      async () => {
        throw new Error('backup cleanup failed');
      },
      (warning) => warnings.push(warning),
    )).resolves.toBeUndefined();

    expect(warnings).toEqual([
      'Social export published, but backup cleanup failed; remove the backup manually.',
    ]);
  });

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
    expect(first_tree['zeta/xiaohongshu.md']).toContain('https://example.test/articles/zeta');
    expect(Object.keys(first_tree).some((path) => path.startsWith('draft/'))).toBe(false);
    expect(Object.keys(first_tree).some((path) => path.startsWith('english/'))).toBe(false);

    await export_social_articles({ project_root, site_url: 'https://example.test' });
    expect(await read_export_tree(project_root)).toEqual(first_tree);
  });

  it('exports Chinese formulas for every enabled platform while excluding draft, English, and disabled copies', async () => {
    const project_root = await create_temporary_project();
    const enabled_frontmatter = [
      'title: 数学导出',
      'description: 保留公式源代码。',
      'tags: [数学]',
      'language: zh',
      'draft: false',
    ].join('\n');
    const math_markdown = '行内 $p(y \\mid x)$。\n\n$$E = mc^2$$';

    await write_article(project_root, 'math-export', enabled_frontmatter, math_markdown);
    await write_article(project_root, 'math-draft', enabled_frontmatter.replace('draft: false', 'draft: true'), math_markdown);
    await write_article(project_root, 'math-english', enabled_frontmatter.replace('language: zh', 'language: en'), math_markdown);
    await write_article(project_root, 'math-disabled', `${enabled_frontmatter}\nsocial:\n  zhihu: false\n  wechat: false\n  xiaohongshu: false`, math_markdown);

    const result = await export_social_articles({
      project_root,
      site_url: 'https://example.test',
    });
    const export_tree = await read_export_tree(project_root);
    const xiaohongshu_output = export_tree['math-export/xiaohongshu.md'] ?? '';

    expect(result).toEqual([{ slug: 'math-export', platforms: ['zhihu', 'wechat', 'xiaohongshu'] }]);
    expect(export_tree['math-export/zhihu.md']).toContain('$p(y \\mid x)$');
    expect(export_tree['math-export/zhihu.md']).toContain('$$E = mc^2$$');
    expect(export_tree['math-export/wechat.html']).toContain('$p(y \\mid x)$');
    expect(export_tree['math-export/wechat.html']).toContain('$$E = mc^2$$');
    expect(xiaohongshu_output).toContain('p(y \\mid x)');
    expect(xiaohongshu_output).toContain('E = mc^2');
    expect(Array.from(xiaohongshu_output).length).toBeLessThanOrEqual(1000);
    expect(Object.values(export_tree).every((content) => content.includes('https://example.test/articles/math-export'))).toBe(true);
    expect(Object.keys(export_tree).some((path) => path.startsWith('math-draft/'))).toBe(false);
    expect(Object.keys(export_tree).some((path) => path.startsWith('math-english/'))).toBe(false);
    expect(Object.keys(export_tree).some((path) => path.startsWith('math-disabled/'))).toBe(false);
  });

  it('rejects unclosed unsafe raw Markdown before publishing exports', async () => {
    const project_root = await create_temporary_project();
    const frontmatter = [
      'title: 不安全公式',
      'description: 验证可信来源链接隔离。',
      'tags: [数学]',
      'language: zh',
      'draft: false',
    ].join('\n');
    const markdown = [
      '$$E = mc^2$$',
      '',
      '<iframe src="https://unsafe.example">unclosed unsafe content',
      '$p(y \\mid x)$',
    ].join('\n');

    await write_article(project_root, 'unsafe-math', frontmatter, markdown);

    await expect(export_social_articles({
      project_root,
      site_url: 'https://example.test',
    })).rejects.toThrow(/unsafe-math.*unclosed.*iframe/i);
    await expect(readdir(resolve(project_root, 'social_exports')))
      .rejects.toMatchObject({ code: 'ENOENT' });
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
