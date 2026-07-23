import { readFile as read_file } from 'node:fs/promises';
import { resolve as resolve_path } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  find_translation,
  get_public_posts,
  group_posts_by_tag,
  validate_translation_pairs,
} from '../src/lib/content';

type test_post = {
  id: string;
  data: {
    date: Date;
    draft: boolean;
    language?: 'zh' | 'en';
    tags?: string[];
    translation?: string;
  };
};

describe('get_public_posts', () => {
  it('removes drafts and sorts newest first', () => {
    const posts: test_post[] = [
      { id: 'older', data: { draft: false, date: new Date('2026-01-01') } },
      { id: 'draft', data: { draft: true, date: new Date('2026-07-01') } },
      { id: 'newer', data: { draft: false, date: new Date('2026-06-01') } },
    ];

    expect(get_public_posts(posts).map((post) => post.id)).toEqual(['newer', 'older']);
  });
});

describe('find_translation', () => {
  it('returns the opposite-language public post for reciprocal translation ids', () => {
    const posts: test_post[] = [
      { id: 'essay-zh', data: { date: new Date('2026-01-01'), draft: false, language: 'zh' as const, tags: [], translation: 'essay-en' } },
      { id: 'essay-en', data: { date: new Date('2026-01-01'), draft: false, language: 'en' as const, tags: [], translation: 'essay-zh' } },
    ];

    expect(find_translation(posts[0]!, posts)?.id).toBe('essay-en');
    expect(find_translation(posts[1]!, posts)?.id).toBe('essay-zh');
  });

  it('does not return a draft translation', () => {
    const posts: test_post[] = [
      { id: 'essay-zh', data: { date: new Date('2026-01-01'), draft: false, language: 'zh' as const, tags: [], translation: 'essay-en' } },
      { id: 'essay-en', data: { date: new Date('2026-01-01'), draft: true, language: 'en' as const, tags: [], translation: 'essay-zh' } },
    ];

    expect(find_translation(posts[0]!, posts)).toBeUndefined();
  });
});

describe('validate_translation_pairs', () => {
  it('rejects a one-way translation link', () => {
    const posts: test_post[] = [
      { id: 'zh', data: { draft: false, date: new Date(), language: 'zh' as const, translation: 'en' } },
      { id: 'en', data: { draft: false, date: new Date(), language: 'en' as const } },
    ];

    expect(() => validate_translation_pairs(posts)).toThrow(/reciprocal/i);
  });
});

describe('group_posts_by_tag', () => {
  it('groups public posts by tag in newest-first order', () => {
    const posts: test_post[] = [
      { id: 'one', data: { date: new Date('2026-01-01'), draft: false, language: 'zh' as const, tags: ['AI', '随笔'] } },
      { id: 'two', data: { date: new Date('2026-02-01'), draft: false, language: 'zh' as const, tags: ['AI'] } },
    ];

    const grouped_posts = group_posts_by_tag(posts);

    expect(grouped_posts.get('AI')?.map((post) => post.id)).toEqual(['two', 'one']);
    expect(grouped_posts.get('随笔')?.map((post) => post.id)).toEqual(['one']);
  });
});

describe('public identity source', () => {
  it('uses ChenZL throughout the public Astro and RSS source', async () => {
    const public_source_files = [
      'src/pages/index.astro',
      'src/pages/about.astro',
      'src/pages/work.astro',
      'src/pages/writing/index.astro',
      'src/pages/404.astro',
      'src/pages/tags/[tag].astro',
      'src/components/site_header.astro',
      'src/components/site_footer.astro',
      'src/layouts/base_layout.astro',
      'src/layouts/article_layout.astro',
      'src/pages/rss.xml.ts',
    ];
    const former_public_names = ['陈正龙', 'Zhenglong Chen'];

    const public_sources = await Promise.all(public_source_files.map(async (source_file) => (
      read_file(resolve_path(process.cwd(), source_file), 'utf8')
    )));

    expect(public_sources.join('\n')).toContain('ChenZL');
    for (const former_public_name of former_public_names) {
      expect(public_sources.join('\n')).not.toContain(former_public_name);
    }
  });
});
