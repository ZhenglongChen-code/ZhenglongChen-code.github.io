export type site_section = 'home' | 'research' | 'projects' | 'articles' | 'about';

export type navigation_item = {
  label: string;
  href: string;
  section: site_section;
};

export const navigation_items: readonly navigation_item[] = [
  { label: 'Home', href: '/', section: 'home' },
  { label: 'Research', href: '/research', section: 'research' },
  { label: 'Projects', href: '/projects', section: 'projects' },
  { label: 'Articles', href: '/articles', section: 'articles' },
  { label: 'About', href: '/about', section: 'about' },
];

export function article_path(slug: string, language: 'zh' | 'en'): string {
  const encoded_slug = encodeURIComponent(slug);
  return language === 'en'
    ? `/en/articles/${encoded_slug}`
    : `/articles/${encoded_slug}`;
}
