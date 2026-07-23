export type dated_entry = {
  id: string;
  data: {
    date: Date;
    draft: boolean;
    tags?: string[];
    language?: 'zh' | 'en';
    translation?: string;
  };
};

export type work_entry = {
  id: string;
  data: {
    draft: boolean;
    featured: boolean;
    year: number;
  };
};

export function get_public_posts<T extends dated_entry>(posts: T[]): T[] {
  return [...posts]
    .filter((post) => !post.data.draft)
    .sort((first_post, second_post) => second_post.data.date.getTime() - first_post.data.date.getTime());
}

export function get_public_work<T extends work_entry>(work_entries: readonly T[]): T[] {
  return [...work_entries]
    .filter((work_entry) => !work_entry.data.draft)
    .sort((first_entry, second_entry) => (
      Number(second_entry.data.featured) - Number(first_entry.data.featured)
      || second_entry.data.year - first_entry.data.year
    ));
}

export function find_translation<T extends dated_entry>(post: T, posts: T[]): T | undefined {
  if (!post.data.translation) {
    return undefined;
  }

  return posts.find((candidate_post) => (
    candidate_post.id === post.data.translation
    && !candidate_post.data.draft
    && candidate_post.data.language !== post.data.language
  ));
}

export function validate_translation_pairs<T extends dated_entry>(posts: T[]): void {
  for (const post of posts.filter((entry) => !entry.data.draft && entry.data.translation)) {
    const translation = posts.find((entry) => (
      entry.id === post.data.translation
      && !entry.data.draft
    ));

    if (
      !translation
      || translation.data.translation !== post.id
      || translation.data.language === post.data.language
    ) {
      throw new Error(`Translation link for ${post.id} must be reciprocal and use the other language.`);
    }
  }
}

export function group_posts_by_tag<T extends dated_entry>(posts: T[]): Map<string, T[]> {
  const grouped_posts = new Map<string, T[]>();

  for (const post of get_public_posts(posts)) {
    for (const tag of post.data.tags ?? []) {
      const tagged_posts = grouped_posts.get(tag) ?? [];
      tagged_posts.push(post);
      grouped_posts.set(tag, tagged_posts);
    }
  }

  return grouped_posts;
}
