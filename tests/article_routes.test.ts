import { describe, expect, it } from 'vitest';
import { create_article_paths } from '../src/lib/article_routes';

type test_post = {
  id: string;
  data: {
    date: Date;
    draft: boolean;
    language: 'zh' | 'en';
    translation?: string;
  };
};

describe('create_article_paths', () => {
  it('creates language-specific props without copying the collection into each page', () => {
    const posts: test_post[] = [
      {
        id: 'essay-zh',
        data: {
          date: new Date('2026-02-01'),
          draft: false,
          language: 'zh',
          translation: 'essay-en',
        },
      },
      {
        id: 'essay-en',
        data: {
          date: new Date('2026-02-01'),
          draft: false,
          language: 'en',
          translation: 'essay-zh',
        },
      },
      { id: 'note', data: { date: new Date('2026-01-01'), draft: false, language: 'zh' } },
      { id: 'draft', data: { date: new Date('2026-03-01'), draft: true, language: 'zh' } },
    ];

    const paths = create_article_paths(posts, 'zh');

    expect(paths.map((path) => path.params.slug)).toEqual(['essay-zh', 'note']);
    expect(paths[0]?.props.translation_url).toBe('/en/writing/essay-en');
    expect(paths[1]?.props.translation_url).toBeUndefined();
    expect(paths[0]?.props).not.toHaveProperty('writing_entries');
  });
});
