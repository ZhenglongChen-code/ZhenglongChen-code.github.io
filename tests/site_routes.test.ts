import { describe, expect, it } from 'vitest';
import { article_path, navigation_items } from '../src/lib/site_routes';

describe('site routes', () => {
  it('exposes the English public navigation contract', () => {
    expect(navigation_items).toEqual([
      { label: 'Home', href: '/', section: 'home' },
      { label: 'Research', href: '/research', section: 'research' },
      { label: 'Projects', href: '/projects', section: 'projects' },
      { label: 'Articles', href: '/articles', section: 'articles' },
      { label: 'About', href: '/about', section: 'about' },
    ]);
  });

  it('creates language-specific, encoded article paths', () => {
    expect(article_path('研究/notes', 'zh')).toBe('/articles/%E7%A0%94%E7%A9%B6%2Fnotes');
    expect(article_path('english essay', 'en')).toBe('/en/articles/english%20essay');
  });
});
