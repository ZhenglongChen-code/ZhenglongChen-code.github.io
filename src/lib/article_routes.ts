import type { CollectionEntry } from 'astro:content';
import {
  find_translation,
  get_public_posts,
  validate_translation_pairs,
  type dated_entry,
} from './content';
import { article_path as get_public_article_path } from './site_routes';

export type article_language = 'zh' | 'en';

export type article_route_props = {
  writing_entry: CollectionEntry<'writing'>;
  translation_url?: string;
};

type article_path<T extends dated_entry> = {
  params: { slug: string };
  props: {
    writing_entry: T;
    translation_url?: string;
  };
};

function get_article_url<T extends dated_entry>(writing_entry: T): string {
  return get_public_article_path(
    writing_entry.id,
    writing_entry.data.language === 'en' ? 'en' : 'zh',
  );
}

export function create_article_paths<T extends dated_entry>(
  writing_entries: T[],
  language: article_language,
): article_path<T>[] {
  validate_translation_pairs(writing_entries);

  return get_public_posts(writing_entries)
    .filter((writing_entry) => writing_entry.data.language === language)
    .map((writing_entry) => {
      const translation_entry = find_translation(writing_entry, writing_entries);
      const translation_url = translation_entry
        ? get_article_url(translation_entry)
        : undefined;

      return {
        params: { slug: writing_entry.id },
        props: translation_url
          ? { writing_entry, translation_url }
          : { writing_entry },
      };
    });
}

export async function get_article_static_paths(
  language: article_language,
): Promise<article_path<CollectionEntry<'writing'>>[]> {
  const { getCollection: get_collection } = await import('astro:content');
  const writing_entries = await get_collection('writing');
  return create_article_paths(writing_entries, language);
}
