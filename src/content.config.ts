import { defineCollection as define_collection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const writing = define_collection({
  loader: glob({ base: './src/content/writing', pattern: '**/*.{md,mdx}' }),
  schema: z.object({
    title: z.string().trim().min(1),
    description: z.string().trim().min(1),
    date: z.coerce.date(),
    updated: z.coerce.date().optional(),
    tags: z.array(z.string().trim().min(1)).default([]),
    language: z.enum(['zh', 'en']).default('zh'),
    translation: z.string().trim().min(1).optional(),
    featured: z.boolean().default(false),
    draft: z.boolean().default(false),
    social: z.object({
      zhihu: z.boolean().default(true),
      wechat: z.boolean().default(true),
      xiaohongshu: z.boolean().default(true),
    }).default({
      zhihu: true,
      wechat: true,
      xiaohongshu: true,
    }),
  }),
});

const work = define_collection({
  loader: glob({ base: './src/content/work', pattern: '**/*.{md,mdx}' }),
  schema: z.object({
    title: z.string().trim().min(1),
    description: z.string().trim().min(1),
    kind: z.enum(['research', 'project', 'tool']),
    year: z.number().int(),
    url: z.url().optional(),
    tags: z.array(z.string().trim().min(1)).default([]),
    featured: z.boolean().default(false),
    draft: z.boolean().default(false),
  }),
});

export const collections = { writing, work };
