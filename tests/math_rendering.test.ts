import { readFile as read_file } from 'node:fs/promises';
import { resolve as resolve_path } from 'node:path';
import { describe, expect, it } from 'vitest';
import astro_config from '../astro.config.mjs';

const read_source = async (relative_path: string): Promise<string> => (
  read_file(resolve_path(process.cwd(), relative_path), 'utf8')
);

describe('Markdown math rendering', () => {
  it('renders the public formula fixture with the configured Astro processor', async () => {
    const [astro_config_source, article_layout, global_css, fixture, package_json] = await Promise.all([
      read_source('astro.config.mjs'),
      read_source('src/layouts/article_layout.astro'),
      read_source('src/styles/global.css'),
      read_source('src/content/writing/math-rendering-check.md'),
      read_source('package.json'),
    ]);
    const fixture_body = fixture.split('---\n').slice(2).join('---\n');
    const renderer = await astro_config.markdown?.processor?.createRenderer({});
    const rendered_fixture = await renderer?.render(fixture_body);
    const dependencies = JSON.parse(package_json) as { dependencies: Record<string, string> };

    expect(astro_config_source).toContain("import { unified as unified_processor } from '@astrojs/markdown-remark';");
    expect(astro_config_source).toContain("import remark_math from 'remark-math';");
    expect(astro_config_source).toContain("import rehype_katex from 'rehype-katex';");
    expect(astro_config_source).toContain('processor: unified_processor({');
    expect(article_layout).toContain("import 'katex/dist/katex.min.css';");
    expect(global_css).not.toContain("katex/dist/katex.min.css");
    expect(dependencies.dependencies.katex).toBe('0.16.47');
    expect(fixture).toContain('$p(y \\mid x, I)$');
    expect(fixture).toMatch(/\$\$[\s\S]*?\$\$/);
    expect(fixture).toContain('zhihu: false');
    expect(fixture).toContain('wechat: false');
    expect(fixture).toContain('xiaohongshu: false');
    expect(rendered_fixture?.code).toContain('class="katex"');
    expect(rendered_fixture?.code).toContain('<math');
    expect(rendered_fixture?.code).not.toContain('$$');
  });
});
