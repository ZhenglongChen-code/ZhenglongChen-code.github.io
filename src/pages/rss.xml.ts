import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { getCollection as get_collection } from 'astro:content';
import { get_public_posts } from '../lib/content';

export async function GET(context: APIContext) {
  if (!context.site) {
    throw new Error('RSS generation requires a configured site URL.');
  }

  const writing_entries = await get_collection('writing');
  const chinese_posts = get_public_posts(writing_entries)
    .filter((writing_entry) => writing_entry.data.language === 'zh');

  return rss({
    title: 'ChenZL 的写作',
    description: '关于多模态研究、数学思考、AI 产品与长期实践的中文写作。',
    site: context.site,
    items: chinese_posts.map((writing_entry) => ({
      title: writing_entry.data.title,
      description: writing_entry.data.description,
      pubDate: writing_entry.data.date,
      link: new URL(`/writing/${writing_entry.id}`, context.site).href,
    })),
  });
}
