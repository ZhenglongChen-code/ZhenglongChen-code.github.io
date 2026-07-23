# Latent Field Personal Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current Jekyll presentation with a locally runnable Astro static site branded as Latent Field, featuring English navigation, research/projects, Markdown articles with LaTeX, and manual social-platform exports.

**Architecture:** Reuse the tested Astro implementation in `/Users/bytedance/Documents/Codex/2026-07-22/xian-z/.worktrees/personal-site` as the baseline. Keep content in Astro Content Collections, render all pages statically, use one `work` collection filtered into Research and Projects, and preserve the existing transactional export pipeline while changing public article URLs to `/articles`.

**Tech Stack:** Astro 7, TypeScript 6, Markdown/MDX, remark-math, rehype-katex, KaTeX, Vitest, sanitize-html, marked.

**Agent routing:** Use `gpt-5.6-terra` with medium reasoning for Tasks 1–6. Use `gpt-5.6-sol` with medium reasoning for Task 7 visual polish and final review. Each coding task receives a fresh worker and is reviewed before the next task starts.

---

## File Map

- `package.json`, `package-lock.json`: Astro runtime, math plugins, scripts, and fixed local port `3002`.
- `astro.config.mjs`: static output, canonical site URL, Markdown math pipeline.
- `src/content.config.ts`: schemas for articles and research/project entries.
- `src/lib/site_routes.ts`: one source of truth for English public navigation and article URLs.
- `src/lib/content.ts`: public filtering, sorting, tags, and translation pairing.
- `src/lib/article_routes.ts`: static Chinese and English article route generation.
- `src/lib/social_export.ts`: platform-specific copy formatting.
- `scripts/export_social.ts`: transactional export publication.
- `src/layouts/base_layout.astro`: metadata and shared document shell.
- `src/layouts/article_layout.astro`: article metadata, tags, translation link, and readable content frame.
- `src/components/site_header.astro`, `site_footer.astro`: Latent Field wordmark, English navigation, social links.
- `src/components/project_list.astro`, `post_list.astro`: compact editorial index rows.
- `src/pages/index.astro`: Paper Index homepage.
- `src/pages/research.astro`, `projects.astro`, `articles/index.astro`: public listing routes.
- `src/pages/articles/[...slug].astro`, `src/pages/en/articles/[...slug].astro`: Markdown article routes.
- `src/pages/about.astro`, `tags/[tag].astro`, `rss.xml.ts`, `404.astro`: supporting pages.
- `src/styles/global.css`: Paper Index tokens, responsive grid, KaTeX, code blocks, focus and reduced-motion states.
- `src/content/writing/*.md`: migrated and sample Markdown articles.
- `src/content/work/*.md`: real research and project entries.
- `tests/*.test.ts`, `tests/site_checker.test.sh`, `scripts/check_site.mjs`: regression and build verification.

### Task 1: Import the tested Astro baseline

**Worker:** `gpt-5.6-terra`, medium reasoning.

**Files:**
- Create: `package.json`, `package-lock.json`, `astro.config.mjs`, `tsconfig.json`, `.nvmrc`
- Create: `src/**`, `scripts/**`, `tests/**`, `vitest.config.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Copy the tested baseline without deleting Jekyll content**

Run:

```bash
rsync -a \
  --exclude='.git' \
  --exclude='docs/superpowers' \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='social_exports' \
  /Users/bytedance/Documents/Codex/2026-07-22/xian-z/.worktrees/personal-site/ ./
```

Expected: Astro source, tests, scripts, and lockfile appear; existing `assets/`, Markdown biography pages, and `.git/` remain intact.

- [ ] **Step 2: Ignore generated Astro artifacts**

Append these exact lines to `.gitignore`:

```gitignore
node_modules/
dist/
.astro/
social_exports/
.social_exports-stage-*/
.social_exports-backup-*/
```

- [ ] **Step 3: Install the locked dependencies**

Run: `npm ci`

Expected: exit code `0` and `node_modules/` created without changing `package-lock.json`.

- [ ] **Step 4: Run the imported baseline tests**

Run: `npm test`

Expected: all imported Vitest and shell tests pass before route or brand changes.

- [ ] **Step 5: Commit the baseline import**

```bash
git add .gitignore package.json package-lock.json astro.config.mjs tsconfig.json .nvmrc vitest.config.ts src scripts tests
git commit -m "chore: import tested Astro site baseline"
```

### Task 2: Establish English public routes and navigation

**Worker:** `gpt-5.6-terra`, medium reasoning.

**Files:**
- Create: `src/lib/site_routes.ts`
- Create: `tests/site_routes.test.ts`
- Create: `src/pages/research.astro`
- Create: `src/pages/projects.astro`
- Create: `src/pages/articles/index.astro`
- Create: `src/pages/articles/[...slug].astro`
- Create: `src/pages/en/articles/[...slug].astro`
- Modify: `src/components/site_header.astro`
- Modify: `src/lib/article_routes.ts`
- Modify: `src/pages/tags/[tag].astro`
- Modify: `src/pages/rss.xml.ts`
- Remove after replacements pass: `src/pages/work.astro`, `src/pages/writing/**`, `src/pages/en/writing/**`

- [ ] **Step 1: Write failing route tests**

Create `tests/site_routes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { article_path, navigation_items } from '../src/lib/site_routes';

describe('navigation_items', () => {
  it('uses the approved English information architecture', () => {
    expect(navigation_items).toEqual([
      { label: 'Home', href: '/', section: 'home' },
      { label: 'Research', href: '/research', section: 'research' },
      { label: 'Projects', href: '/projects', section: 'projects' },
      { label: 'Articles', href: '/articles', section: 'articles' },
      { label: 'About', href: '/about', section: 'about' },
    ]);
  });
});

describe('article_path', () => {
  it('creates language-specific article URLs', () => {
    expect(article_path('visual-reasoning', 'zh')).toBe('/articles/visual-reasoning');
    expect(article_path('visual-reasoning', 'en')).toBe('/en/articles/visual-reasoning');
  });
});
```

- [ ] **Step 2: Run the test and confirm failure**

Run: `npx vitest run tests/site_routes.test.ts`

Expected: FAIL because `src/lib/site_routes.ts` does not exist.

- [ ] **Step 3: Implement the route contract**

Create `src/lib/site_routes.ts`:

```ts
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
  const prefix = language === 'en' ? '/en/articles' : '/articles';
  return `${prefix}/${encodeURIComponent(slug)}`;
}
```

- [ ] **Step 4: Replace public route consumers**

Update `site_header.astro`, article path generation, tags, RSS, canonical links, and the social exporter to import `navigation_items` or `article_path`. Build `research.astro` by filtering `work` entries with `kind === 'research'`; build `projects.astro` with `kind === 'project' || kind === 'tool'`. Copy the tested listing and article page structures from the reference project, changing only route names and collection filters.

The current-section resolver in `site_header.astro` must be:

```ts
const current_section = pathname === '/'
  ? 'home'
  : pathname === '/research' || pathname.startsWith('/research/')
    ? 'research'
    : pathname === '/projects' || pathname.startsWith('/projects/')
      ? 'projects'
      : pathname === '/about' || pathname.startsWith('/about/')
        ? 'about'
        : pathname === '/articles' || pathname.startsWith('/articles/')
            || pathname === '/en/articles' || pathname.startsWith('/en/articles/')
            || pathname === '/tags' || pathname.startsWith('/tags/')
          ? 'articles'
          : '';
```

- [ ] **Step 5: Run route and existing tests**

Run: `npx vitest run tests/site_routes.test.ts tests/article_routes.test.ts tests/tag_routes.test.ts`

Expected: all tests pass and translation URLs use `/articles` or `/en/articles`.

- [ ] **Step 6: Commit route migration**

```bash
git add src tests
git commit -m "feat: add English research and article routes"
```

### Task 3: Add build-time Markdown LaTeX rendering

**Worker:** `gpt-5.6-terra`, medium reasoning.

**Files:**
- Modify: `package.json`, `package-lock.json`
- Modify: `astro.config.mjs`
- Create: `tests/math_rendering.test.ts`
- Create: `src/content/writing/math-rendering-check.md`
- Modify: `src/styles/global.css`

- [ ] **Step 1: Write the failing configuration and fixture test**

Create `tests/math_rendering.test.ts`:

```ts
import { readFile as read_file } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Markdown math pipeline', () => {
  it('configures remark-math, rehype-katex, and the KaTeX stylesheet', async () => {
    const [config, stylesheet, fixture] = await Promise.all([
      read_file(resolve('astro.config.mjs'), 'utf8'),
      read_file(resolve('src/styles/global.css'), 'utf8'),
      read_file(resolve('src/content/writing/math-rendering-check.md'), 'utf8'),
    ]);

    expect(config).toContain("from 'remark-math'");
    expect(config).toContain("from 'rehype-katex'");
    expect(config).toContain('remarkPlugins: [remark_math]');
    expect(config).toContain('rehypePlugins: [rehype_katex]');
    expect(stylesheet).toContain("katex/dist/katex.min.css");
    expect(fixture).toContain('$p(y \\mid x, I)$');
    expect(fixture).toContain('$$');
  });
});
```

- [ ] **Step 2: Run the test and confirm failure**

Run: `npx vitest run tests/math_rendering.test.ts`

Expected: FAIL because math dependencies, configuration, and fixture are absent.

- [ ] **Step 3: Install math dependencies**

Run: `npm install remark-math rehype-katex katex`

Expected: `package.json` and `package-lock.json` include all three packages.

- [ ] **Step 4: Configure Astro Markdown**

Replace `astro.config.mjs` with:

```js
import { defineConfig as define_config } from 'astro/config';
import rehype_katex from 'rehype-katex';
import remark_math from 'remark-math';

export default define_config({
  output: 'static',
  site: 'https://zhenglongchen-code.github.io',
  trailingSlash: 'never',
  markdown: {
    remarkPlugins: [remark_math],
    rehypePlugins: [rehype_katex],
  },
});
```

Add to the first line of `src/styles/global.css`:

```css
@import "katex/dist/katex.min.css";
```

Add these rules near the article styles:

```css
.article_body .katex-display {
  max-width: 100%;
  margin: 1.75rem 0;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 0.25rem 0;
}

.article_body pre {
  max-width: 100%;
  overflow-x: auto;
}
```

- [ ] **Step 5: Add the public math fixture article**

Create `src/content/writing/math-rendering-check.md` with valid frontmatter and these exact checks:

```markdown
---
title: Markdown 中的数学公式
description: 验证行内公式、块级公式与代码排版。
date: 2026-07-23
tags: [Mathematics, VLM]
language: zh
featured: false
draft: false
social:
  zhihu: true
  wechat: true
  xiaohongshu: false
---

行内概率可以写成 $p(y \mid x, I)$。

块级自回归分解为：

$$
p(y \mid x, I) = \prod_{t=1}^{T} p(y_t \mid y_{<t}, x, I).
$$
```

- [ ] **Step 6: Verify math in the production output**

Run: `npm run build`

Expected: build passes; `dist/articles/math-rendering-check/index.html` or the equivalent trailing-slash-free output contains `class="katex"` and does not expose unprocessed `$$` delimiters in the rendered article body.

- [ ] **Step 7: Commit math support**

```bash
git add package.json package-lock.json astro.config.mjs src/styles/global.css src/content/writing/math-rendering-check.md tests/math_rendering.test.ts
git commit -m "feat: render LaTeX in Markdown articles"
```

### Task 4: Migrate truthful personal content

**Worker:** `gpt-5.6-terra`, medium reasoning.

**Files:**
- Create/Modify: `src/content/work/*.md`
- Modify: `src/pages/about.astro`
- Modify: `src/pages/index.astro`
- Create: `tests/personal_content.test.ts`
- Reuse assets: `assets/img/avatar.png`, `assets/files/curriculum_vitae.pdf`

- [ ] **Step 1: Write a failing source-of-truth test**

Create `tests/personal_content.test.ts`:

```ts
import { readFile as read_file } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('migrated personal content', () => {
  it('uses the approved public identity and existing factual sources', async () => {
    const [home, about, research, project] = await Promise.all([
      read_file(resolve('src/pages/index.astro'), 'utf8'),
      read_file(resolve('src/pages/about.astro'), 'utf8'),
      read_file(resolve('src/content/work/multimodal-research.md'), 'utf8'),
      read_file(resolve('src/content/work/generative-reservoir-characterization.md'), 'utf8'),
    ]);

    expect(home).toContain('VLM Algorithm Engineer');
    expect(home).toContain('Zhenglong Chen');
    expect(about).toContain('Shandong University');
    expect(research).toContain('kind: research');
    expect(project).toContain('Generative Characterization of Oil-Gas Reservoirs');
  });
});
```

- [ ] **Step 2: Run the test and confirm failure**

Run: `npx vitest run tests/personal_content.test.ts`

Expected: FAIL until the files contain the approved identity and migrated content.

- [ ] **Step 3: Migrate only verified content**

Use `_config.yml`, `index.md`, `education.md`, `internship.md`, `projects.md`, `_data/publications.yml`, and `assets/files/curriculum_vitae.pdf` as sources. Preserve organization names, dates, awards, email, GitHub, Zhihu, and project titles exactly. Do not add publications or employment claims absent from those sources.

Create `src/content/work/multimodal-research.md`:

```markdown
---
title: Multimodal Learning and Visual Reasoning
description: Research notes on vision-language models, mathematical reasoning, evaluation, and reliable multimodal systems.
kind: research
year: 2026
tags: [VLM, Multimodal, Reasoning]
featured: true
draft: false
---
```

Create `src/content/work/generative-reservoir-characterization.md`:

```markdown
---
title: Generative Characterization of Oil-Gas Reservoirs
description: A generative modeling project developed with the Chinese Academy of Sciences.
kind: project
year: 2025
tags: [Generative Models, Scientific AI]
featured: true
draft: false
---
```

- [ ] **Step 4: Run content tests**

Run: `npx vitest run tests/personal_content.test.ts tests/content.test.ts`

Expected: both files pass; no test requires a fabricated paper, employer, or award.

- [ ] **Step 5: Commit migrated content**

```bash
git add src/content src/pages/index.astro src/pages/about.astro tests/personal_content.test.ts
git commit -m "content: migrate verified research and biography"
```

### Task 5: Implement the Latent Field Paper Index design

**Worker:** `gpt-5.6-terra`, medium reasoning.

**Files:**
- Modify: `src/components/site_header.astro`, `src/components/site_footer.astro`
- Modify: `src/components/project_list.astro`, `src/components/post_list.astro`
- Modify: `src/layouts/base_layout.astro`, `src/layouts/article_layout.astro`
- Modify: `src/pages/index.astro`, `src/pages/research.astro`, `src/pages/projects.astro`, `src/pages/articles/index.astro`, `src/pages/about.astro`
- Modify: `src/styles/global.css`
- Create: `tests/brand_contract.test.ts`

- [ ] **Step 1: Write the failing brand contract test**

Create `tests/brand_contract.test.ts`:

```ts
import { readFile as read_file } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Latent Field brand contract', () => {
  it('uses the approved wordmark, identity, palette, and navigation', async () => {
    const [header, home, stylesheet] = await Promise.all([
      read_file(resolve('src/components/site_header.astro'), 'utf8'),
      read_file(resolve('src/pages/index.astro'), 'utf8'),
      read_file(resolve('src/styles/global.css'), 'utf8'),
    ]);

    expect(header).toContain('LATENT FIELD');
    expect(header).toContain('ZHENGLONG CHEN · RESEARCH NOTES');
    expect(home).toContain('Zhenglong Chen');
    expect(home).toContain('VLM Algorithm Engineer');
    expect(stylesheet).toContain('--paper: #f3efe6');
    expect(stylesheet).toContain('--cobalt: #1649c2');
    expect(stylesheet).toContain('--vermilion: #b53325');
  });
});
```

- [ ] **Step 2: Run the test and confirm failure**

Run: `npx vitest run tests/brand_contract.test.ts`

Expected: FAIL on the new wordmark and palette.

- [ ] **Step 3: Implement the header wordmark**

The header must use this semantic structure:

```astro
<header class="site_header shell" lang="en">
  <a class="site_brand" href="/" aria-label="Latent Field, return home">
    <span class="site_brand__title">LATENT FIELD</span>
    <span class="site_brand__note">ZHENGLONG CHEN · RESEARCH NOTES</span>
  </a>
  <nav class="primary_nav" aria-label="Primary navigation">
    <ul>
      {navigation_items.map((navigation_item) => (
        <li>
          <a
            href={navigation_item.href}
            aria-current={current_section === navigation_item.section ? 'page' : undefined}
          >
            {navigation_item.label}
          </a>
        </li>
      ))}
    </ul>
  </nav>
</header>
```

- [ ] **Step 4: Apply the approved visual system**

Start `global.css` with these tokens and retain focused, accessible base rules from the reference implementation:

```css
:root {
  color-scheme: light;
  --paper: #f3efe6;
  --ink: #181815;
  --muted: #716b61;
  --rule: #c9c0b1;
  --cobalt: #1649c2;
  --vermilion: #b53325;
  --serif: "Iowan Old Style", "Palatino Linotype", Palatino, Baskerville, Georgia, serif;
  --sans: "Avenir Next", Avenir, "Gill Sans", system-ui, sans-serif;
  --mono: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  --content_width: 1440px;
}
```

Implement the selected A mockup's asymmetrical hero, vertical marginal note, indexed research rows, featured Chinese article, cobalt/vermilion accents, and fine rules. Do not add generic rounded cards, decorative blobs, purple gradients, or external stock imagery.

- [ ] **Step 5: Add responsive and reduced-motion rules**

The final stylesheet must include:

```css
@media (max-width: 900px) {
  .site_header,
  .hero,
  .section_header,
  .editorial_grid {
    grid-template-columns: 1fr;
  }

  .shell {
    width: min(calc(100% - 40px), var(--content_width));
  }
}

@media (prefers-reduced-motion: reduce) {
  html {
    scroll-behavior: auto;
  }

  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

- [ ] **Step 6: Run brand tests and build**

Run: `npx vitest run tests/brand_contract.test.ts tests/personal_content.test.ts`

Expected: PASS.

Run: `npm run build`

Expected: PASS with all public routes generated.

- [ ] **Step 7: Commit the visual implementation**

```bash
git add src tests/brand_contract.test.ts
git commit -m "feat: apply Latent Field editorial design"
```

### Task 6: Preserve formulas and `/articles` URLs in social exports

**Worker:** `gpt-5.6-terra`, medium reasoning.

**Files:**
- Modify: `scripts/export_social.ts`
- Modify: `src/lib/social_export.ts`
- Modify: `tests/export_social.test.ts`
- Modify: `tests/social_export.test.ts`

- [ ] **Step 1: Add failing export assertions**

Add to the existing export tests:

```ts
it('keeps LaTeX source and uses the public articles URL', async () => {
  const article = {
    title: '公式测试',
    description: '包含数学公式',
    tags: ['VLM'],
    canonical_url: 'https://example.test/articles/formula-test',
    markdown: '行内 $p(y \\mid x)$。\n\n$$E = mc^2$$',
  };

  expect(format_zhihu(article)).toContain('$$E = mc^2$$');
  expect(format_wechat_html(article)).toContain('E = mc^2');
  expect(format_xiaohongshu(article)).toContain('E = mc^2');
});
```

Change the existing canonical assertion to:

```ts
expect(first_tree['zeta/xiaohongshu.md'])
  .toContain('https://example.test/articles/zeta');
```

- [ ] **Step 2: Run export tests and confirm failure**

Run: `npx vitest run tests/export_social.test.ts tests/social_export.test.ts`

Expected: FAIL because canonical URLs still use `/writing` and HTML sanitization may discard formula delimiters.

- [ ] **Step 3: Use the shared route function**

In `scripts/export_social.ts`, import `article_path` and replace the canonical URL builder return value with:

```ts
return new URL(article_path(slug, 'zh'), site_url).toString();
```

Keep raw LaTeX text intact during Markdown-to-plain-text conversion. For WeChat HTML, preserve formula source as readable text if the platform editor does not support KaTeX; do not silently drop a formula or inject executable scripts.

- [ ] **Step 4: Run export tests and transactional checks**

Run: `npx vitest run tests/export_social.test.ts tests/social_export.test.ts`

Expected: PASS, including previous-export preservation on malformed frontmatter.

- [ ] **Step 5: Generate real local exports**

Run: `npm run export:social`

Expected: `social_exports/<slug>/` contains only enabled platform files; Chinese public articles are present, English articles and drafts are absent.

- [ ] **Step 6: Commit export changes**

```bash
git add scripts/export_social.ts src/lib/social_export.ts tests/export_social.test.ts tests/social_export.test.ts
git commit -m "feat: update article social exports"
```

### Task 7: Sol visual polish, full verification, and local handoff

**Worker:** `gpt-5.6-sol`, medium reasoning.

**Required skills:** `impeccable-design-polish`, `verification-before-completion`, and `requesting-code-review`.

**Files:**
- Modify only files implicated by verified polish or correctness findings.
- Do not deploy or push.

- [ ] **Step 1: Start the site on the documented port**

Run: `npm run dev`

Expected: the development server reports `http://localhost:3002` and remains running.

- [ ] **Step 2: Run the automated verification suite**

Run: `npm test`

Expected: all unit and shell tests pass.

Run: `npm run check`

Expected: Astro and TypeScript report no errors.

Run: `npm run build`

Expected: production build, social export, and static-site checks all pass.

- [ ] **Step 3: Perform one Impeccable polish pass**

Audit the running pages at desktop and mobile widths for hierarchy, typography, spacing, formula overflow, code overflow, navigation focus, reduced motion, contrast, and obvious AI-design tropes. Fix only high-impact findings while preserving the approved Paper Index direction and factual content.

Required pages:

```text
http://localhost:3002/
http://localhost:3002/research
http://localhost:3002/projects
http://localhost:3002/articles
http://localhost:3002/articles/math-rendering-check
http://localhost:3002/about
```

- [ ] **Step 4: Request an independent Sol code review**

The reviewer checks correctness, route consistency, content truthfulness, formula rendering, export safety, responsive behavior, and whether unrelated Jekyll assets or the user's untracked `CLAUDE.md` were modified. Address only actionable findings.

- [ ] **Step 5: Re-run verification after review fixes**

Run: `npm test`

Expected: PASS.

Run: `npm run check`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

- [ ] **Step 6: Commit final polish**

```bash
git add package.json package-lock.json astro.config.mjs src scripts tests .gitignore
git commit -m "fix: polish and verify Latent Field site"
```

- [ ] **Step 7: Handoff locally without remote mutation**

Report the local URL, implemented routes, verification results, remaining factual-content gaps, and the exact deployment options. Do not push to GitHub, modify DNS, or write to the server until the user approves the locally running site.

---

## Plan Self-Review

- Spec coverage: Astro reuse, English navigation, Latent Field branding, A visual direction, truthful content, Research/Projects split, Markdown LaTeX, manual social exports, responsive/accessibility work, tests, and local-only handoff are all mapped to tasks.
- Placeholder scan: no `TBD`, `TODO`, or unspecified implementation step remains; visual work is constrained by exact tokens, structures, prohibited patterns, required pages, and verification criteria.
- Type consistency: public routes use `site_section`, `navigation_item`, `navigation_items`, and `article_path`; article language remains `'zh' | 'en'`; existing `writing` and `work` collection names remain stable internally while public routes change.
