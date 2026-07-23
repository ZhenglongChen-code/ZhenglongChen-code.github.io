# Local Markdown Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local-only Markdown Studio that previews the site's Markdown and LaTeX, uploads organized images to Tencent COS, and safely commits and pushes one article to the GitHub Pages repository.

**Architecture:** A standalone Vite-powered vanilla TypeScript Studio lives under `studio/` and is excluded from Astro production output. `scripts/studio.ts` binds a small API and static-file server to `127.0.0.1`; focused library modules own article normalization, image publication, Git operations, and transaction orchestration. Real COS and Git implementations sit behind typed adapters so all publication behavior can be tested without cloud credentials or remote mutation.

**Tech Stack:** Astro 7, TypeScript 6, Vite, Node HTTP APIs, `@astrojs/markdown-remark`, `remark-math`, `rehype-katex`, `gray-matter`, `sanitize-html`, `sharp`, `cos-nodejs-sdk-v5`, Vitest.

---

## File Map

- `src/lib/markdown_preview.ts` — shared Markdown/KaTeX preview renderer and safe HTML policy.
- `src/lib/studio_article.ts` — frontmatter parsing, schema normalization, slug rules, local-image discovery, and normalized Markdown serialization.
- `src/lib/studio_images.ts` — deterministic COS keys, image validation/conversion, manifest generation, and Markdown URL rewriting.
- `src/lib/studio_git.ts` — safe repository inspection, one-file staging, commit, and push adapter.
- `src/lib/studio_publish.ts` — idempotent publication transaction and rollback orchestration.
- `src/lib/studio_protocol.ts` — request/response types and runtime validation shared by UI and helper.
- `scripts/studio.ts` — loopback-only HTTP server, session/origin enforcement, API routes, and static Studio serving.
- `studio/index.html` — local Studio document shell.
- `studio/src/main.ts` — DOM state, file import, preview, image pairing, and publish requests.
- `studio/src/studio.css` — Paper Index visual treatment for the local tool.
- `studio/vite.config.ts` — isolated Studio build output under `studio/dist`.
- `tests/markdown_preview.test.ts` — preview fidelity and sanitization tests.
- `tests/studio_article.test.ts` — article parsing and normalization tests.
- `tests/studio_images.test.ts` — image key, conversion, rewrite, and cleanup tests.
- `tests/studio_git.test.ts` — safe Git behavior in temporary repositories.
- `tests/studio_publish.test.ts` — transaction, idempotency, and failure tests with fake adapters.
- `tests/studio_server.test.ts` — binding, token, origin, preview, and publish-route tests.
- `tests/studio_ui.test.ts` — static UI contract and production-exclusion tests.
- `.env.studio.example` — documented non-secret configuration names.
- `.gitignore` — local Studio secrets, build output, and transaction journal.
- `src/content.config.ts` — optional generated asset-manifest schema.
- `astro.config.mjs` — consume the shared Markdown preview plugin configuration.
- `package.json` and `package-lock.json` — Studio commands and dependencies.

### Task 1: Shared article parsing and Markdown/LaTeX preview

**Files:**
- Create: `src/lib/markdown_preview.ts`
- Create: `src/lib/studio_article.ts`
- Create: `tests/markdown_preview.test.ts`
- Create: `tests/studio_article.test.ts`
- Modify: `astro.config.mjs`
- Modify: `src/content.config.ts`

- [ ] **Step 1: Write failing preview and article tests**

Cover frontmatter import, explicit slug validation, current writing fields, optional generated assets, inline/display math, escaped dollars, Markdown emphasis adjacent to math, code fences containing formula-like HTML, and removal of executable raw HTML. Use this minimum contract:

```ts
const source = `---
title: 视觉语言模型评测
description: 一篇包含公式的测试文章。
date: 2026-07-23
tags: [VLM, Evaluation]
language: zh
draft: false
---

行内公式 $p(y \\mid x)$。

$$E = mc^2$$`;

const parsed_article = parse_studio_article(source, 'vlm-evaluation');
expect(parsed_article.metadata.slug).toBe('vlm-evaluation');
expect((await render_markdown_preview(parsed_article.body)).html).toContain('class="katex"');
expect(() => validate_article_slug('视觉模型')).toThrow(/lowercase ASCII/);
```

- [ ] **Step 2: Run the focused tests and confirm the red state**

Run: `npx vitest run tests/markdown_preview.test.ts tests/studio_article.test.ts`

Expected: FAIL because the Studio parsing and preview modules do not exist.

- [ ] **Step 3: Implement the typed article model and renderer**

Define concrete types without `any`:

```ts
export type studio_asset = {
  object_key: string;
  public_url: string;
  source_path: string;
};

export type studio_article_metadata = {
  title: string;
  description: string;
  date: string;
  updated?: string;
  tags: string[];
  language: 'zh' | 'en';
  translation?: string;
  featured: boolean;
  draft: boolean;
  slug: string;
  assets: studio_asset[];
  social: { zhihu: boolean; wechat: boolean; xiaohongshu: boolean };
};
```

Export `parse_studio_article`, `validate_article_slug`, `serialize_studio_article`, `discover_local_images`, and `render_markdown_preview`. Keep the remark/rehype plugin list in `markdown_preview.ts` and import that list from `astro.config.mjs` so Studio and Astro cannot drift. Sanitize preview HTML with an explicit KaTeX-compatible allowlist and reject lossy unsafe markup with a typed validation issue.

Extend the writing schema with an optional `assets` array matching `studio_asset`; default it to `[]`.

- [ ] **Step 4: Run focused and existing math/content tests**

Run: `npx vitest run tests/markdown_preview.test.ts tests/studio_article.test.ts tests/math_rendering.test.ts tests/content.test.ts`

Expected: all selected tests PASS, including rendered `katex` output and content schema validation.

- [ ] **Step 5: Commit Task 1**

```bash
git add astro.config.mjs src/content.config.ts src/lib/markdown_preview.ts src/lib/studio_article.ts tests/markdown_preview.test.ts tests/studio_article.test.ts
git commit -m "feat: share markdown studio rendering"
```

### Task 2: Local Studio interface and preview loop

**Files:**
- Create: `studio/index.html`
- Create: `studio/src/main.ts`
- Create: `studio/src/studio.css`
- Create: `studio/vite.config.ts`
- Create: `tests/studio_ui.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.gitignore`

- [ ] **Step 1: Write the failing Studio UI contract test**

Read the HTML, TypeScript, CSS, Vite config, and Astro build configuration as text. Assert that the Studio contains a labeled `.md` file input, editor textarea, metadata form, preview region, unresolved-image region, and separate new/update publication buttons. Assert that `studio/dist` is ignored and that Astro has no public `/studio` page.

```ts
expect(studio_html).toContain('accept=".md,text/markdown,text/plain"');
expect(studio_html).toContain('aria-label="Markdown source"');
expect(studio_html).toContain('aria-live="polite"');
expect(page_files.some((file_path) => file_path.includes('studio'))).toBe(false);
```

- [ ] **Step 2: Run the contract test and confirm failure**

Run: `npx vitest run tests/studio_ui.test.ts`

Expected: FAIL because `studio/` does not exist.

- [ ] **Step 3: Implement the Paper Index Studio shell**

Use vanilla TypeScript and semantic HTML. Reuse the public site's paper, cobalt, vermilion, serif, and sans tokens without importing the production stylesheet. Implement:

- local `.md` import through `File.text()`;
- paste/edit support in one textarea;
- debounced `POST /api/preview` calls;
- metadata field hydration from the preview response;
- split view above 900 px and Editor/Preview tabs below 900 px;
- keyboard-accessible image pairing and publish controls;
- local draft persistence under the single key `latent_field_studio_draft_v1`;
- visible preview-only state when publishing configuration is unavailable.

All DOM bindings use explicit element types and snake_case names. Do not use `innerHTML` except to assign server-sanitized preview HTML to the dedicated preview container.

- [ ] **Step 4: Add isolated Vite build commands**

Add `vite` as a development dependency and scripts:

```json
{
  "studio:build": "vite build --config studio/vite.config.ts",
  "studio:ui": "vite --config studio/vite.config.ts --host 127.0.0.1 --port 4317"
}
```

Configure Vite with root `studio`, output `studio/dist`, `emptyOutDir: true`, and no public-base dependency.

- [ ] **Step 5: Build and test the isolated UI**

Run: `npm run studio:build && npx vitest run tests/studio_ui.test.ts`

Expected: Vite build succeeds, the contract test passes, and `npm run build` still emits no public Studio page.

- [ ] **Step 6: Commit Task 2**

```bash
git add .gitignore package.json package-lock.json studio tests/studio_ui.test.ts
git commit -m "feat: add local markdown studio interface"
```

### Task 3: Image preparation, COS hierarchy, and Markdown rewriting

**Files:**
- Create: `src/lib/studio_images.ts`
- Create: `tests/studio_images.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Write failing image-pipeline tests**

Use generated in-memory PNG and JPEG fixtures. Cover:

- `latent-field/articles/2026/vlm-evaluation/fig-01-attention-map.webp` key generation;
- rejection of paths with spaces, Chinese characters, traversal, or unsupported extensions;
- MIME/file-signature mismatch rejection;
- JPEG and ordinary PNG conversion to WebP;
- transparent diagram preservation as PNG;
- replacement of `![结果](./images/result.png)` without changing code fences;
- manifest generation with source path, object key, and public URL;
- collision behavior when an existing object has a different SHA-256 digest.

```ts
expect(build_article_object_key({
  year: 2026,
  slug: 'vlm-evaluation',
  sequence: 1,
  semantic_name: 'attention-map',
  extension: 'webp',
})).toBe('latent-field/articles/2026/vlm-evaluation/fig-01-attention-map.webp');
```

- [ ] **Step 2: Run the focused image tests and confirm failure**

Run: `npx vitest run tests/studio_images.test.ts`

Expected: FAIL because the image module does not exist.

- [ ] **Step 3: Implement adapters and deterministic preparation**

Add `sharp` and `cos-nodejs-sdk-v5`. Define:

```ts
export interface cos_adapter {
  inspect_object(object_key: string): Promise<{ sha256: string } | undefined>;
  upload_object(input: prepared_image): Promise<void>;
  delete_object(object_key: string): Promise<void>;
}

export type prepared_image = {
  bytes: Uint8Array;
  content_type: 'image/webp' | 'image/png';
  object_key: string;
  public_url: string;
  sha256: string;
};
```

Implement `prepare_article_images`, `rewrite_markdown_images`, and a real `tencent_cos_adapter`. Store the SHA-256 digest as COS object metadata. Reuse an object only when its digest matches; otherwise return a collision error. Never delete an object that was present before the current request.

- [ ] **Step 4: Run image and article tests**

Run: `npx vitest run tests/studio_images.test.ts tests/studio_article.test.ts`

Expected: all selected tests PASS without network access.

- [ ] **Step 5: Commit Task 3**

```bash
git add package.json package-lock.json src/lib/studio_images.ts tests/studio_images.test.ts
git commit -m "feat: prepare studio images for cos"
```

### Task 4: Safe local Git publication adapter

**Files:**
- Create: `src/lib/studio_git.ts`
- Create: `tests/studio_git.test.ts`

- [ ] **Step 1: Write failing Git adapter tests in temporary repositories**

Create a bare remote and working clone under a test temporary directory. Cover:

- new article creation;
- explicit update with matching source hash;
- rejection when the target article is dirty;
- rejection during merge or rebase;
- preservation of unrelated modified and staged files;
- staging and committing only the requested article path;
- rejection of a non-fast-forward push without reset, force push, stash, or checkout;
- rejection of content paths outside `src/content/writing`.

```ts
const result = await git_publisher.publish({
  article_path: 'src/content/writing/vlm-evaluation.md',
  article_source,
  commit_message: 'content: publish vlm-evaluation',
  expected_source_hash: undefined,
});
expect(result.committed_paths).toEqual(['src/content/writing/vlm-evaluation.md']);
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npx vitest run tests/studio_git.test.ts`

Expected: FAIL because the Git adapter does not exist.

- [ ] **Step 3: Implement the adapter with argument-safe commands**

Use `execFile`/`spawn` argument arrays, never shell interpolation. Define a `git_adapter` interface and `local_git_adapter`. Before writing, resolve the repository root, validate the configured branch, check unmerged paths and Git-operation markers, compare the target source hash, and ensure the target is inside the writing directory. Write atomically, run `git add -- <exact_path>`, verify the staged path set, commit, and push without `--force`.

If push fails, keep the local commit and return a typed `push_failed` result containing recovery guidance; do not reset or discard it.

- [ ] **Step 4: Run Git tests**

Run: `npx vitest run tests/studio_git.test.ts`

Expected: all tests PASS using only temporary local repositories.

- [ ] **Step 5: Commit Task 4**

```bash
git add src/lib/studio_git.ts tests/studio_git.test.ts
git commit -m "feat: publish one article with local git"
```

### Task 5: Transactional publication service

**Files:**
- Create: `src/lib/studio_publish.ts`
- Create: `src/lib/studio_protocol.ts`
- Create: `tests/studio_publish.test.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Write failing transaction tests with fake adapters**

Cover preview-only configuration, metadata failure before image upload, successful image upload and Git publication, cleanup after Git failure, preservation of pre-existing COS objects, request-id replay, restart-safe journal replay, stale update rejection, and a Pages-status failure that does not change publication success.

```ts
const first_result = await publish_article(request, dependencies);
const replay_result = await publish_article(request, dependencies);
expect(replay_result).toEqual(first_result);
expect(fake_git.publish_calls).toHaveLength(1);
expect(fake_cos.upload_calls).toHaveLength(1);
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npx vitest run tests/studio_publish.test.ts`

Expected: FAIL because the protocol and publication modules do not exist.

- [ ] **Step 3: Implement protocol validation and the transaction journal**

Define discriminated request/response unions for `preview`, `publish_new`, and `publish_update`. Validate every unknown JSON value before use. Store a small ignored journal under `.studio/transactions/<request_id>.json` containing status, created object keys, target path, and final result; never store credentials or full draft contents.

Order the transaction as validate → prepare images → upload new objects → serialize normalized Markdown → Git publish → record success. On Git failure, delete only the request's newly created objects. Treat deployment status as advisory after a successful push.

- [ ] **Step 4: Run transaction and adapter suites**

Run: `npx vitest run tests/studio_publish.test.ts tests/studio_images.test.ts tests/studio_git.test.ts`

Expected: all selected tests PASS.

- [ ] **Step 5: Commit Task 5**

```bash
git add .gitignore src/lib/studio_protocol.ts src/lib/studio_publish.ts tests/studio_publish.test.ts
git commit -m "feat: orchestrate studio publication"
```

### Task 6: Loopback server, session boundary, and local configuration

**Files:**
- Create: `scripts/studio.ts`
- Create: `tests/studio_server.test.ts`
- Create: `.env.studio.example`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Write failing server-security and API tests**

Start the server on port `0` in tests and assert:

- it rejects any configured host other than `127.0.0.1`;
- `/api/session` is readable only from the Studio origin;
- mutation requests require the ephemeral `x-studio-token` header;
- foreign origins and missing tokens return `403`;
- oversized JSON/image payloads return `413`;
- `/api/preview` returns sanitized KaTeX HTML and parsed metadata;
- `/api/publish` calls the injected fake publication service;
- missing COS settings make `/api/config` report `preview_only: true`;
- built Studio assets are served with no-store headers.

- [ ] **Step 2: Run server tests and confirm failure**

Run: `npx vitest run tests/studio_server.test.ts`

Expected: FAIL because `scripts/studio.ts` does not exist.

- [ ] **Step 3: Implement the local server**

Use Node HTTP APIs with explicit route dispatch and typed JSON parsing. Export `create_studio_server` for tests. Generate the session token with `crypto.randomBytes(32)`, compare tokens with `timingSafeEqual`, validate the exact `Host` and `Origin`, and cap request bodies before parsing. Serve only `studio/dist` and the defined `/api/*` routes.

Load local settings from `.env.studio.local` without overriding existing environment variables. Validate these names:

```text
STUDIO_REPOSITORY_ROOT
STUDIO_PUBLICATION_BRANCH
STUDIO_PUBLIC_SITE_URL
STUDIO_IMAGE_MAX_BYTES
TENCENT_COS_REGION
TENCENT_COS_BUCKET
TENCENT_COS_SECRET_ID
TENCENT_COS_SECRET_KEY
TENCENT_COS_PUBLIC_BASE_URL
TENCENT_COS_ROOT_PREFIX
```

Add `dotenv` and script:

```json
{
  "studio": "npm run studio:build && tsx scripts/studio.ts"
}
```

Use port `4317` as the documented Studio port and exit with a clear error if occupied; do not drift to another port.

- [ ] **Step 4: Run server and full unit tests**

Run: `npx vitest run tests/studio_server.test.ts && npm test`

Expected: server tests and the complete existing suite PASS.

- [ ] **Step 5: Commit Task 6**

```bash
git add .env.studio.example package.json package-lock.json scripts/studio.ts tests/studio_server.test.ts
git commit -m "feat: serve markdown studio locally"
```

### Task 7: End-to-end local verification and documentation

**Files:**
- Create: `docs/studio.md`
- Create: `tests/fixtures/studio/article-with-math.md`
- Create: `tests/fixtures/studio/create_attention_map.ts`
- Modify: `README.md`
- Modify: `tests/studio_ui.test.ts`
- Modify: `scripts/check_site.mjs`

- [ ] **Step 1: Add end-to-end fixtures and production-exclusion assertions**

The Markdown fixture must include frontmatter, `$p(y \\mid x)$`, a multiline display equation, escaped currency, a code fence containing `<script>` and formula-like text, and `![注意力图](./attention-map.png)`. Add a typed Sharp-based fixture generator that writes a deterministic PNG to a caller-supplied temporary directory; it must refuse output paths outside that directory. Extend tests to assert the Astro output contains no Studio HTML, API route, token, `.env.studio.local`, or transaction journal.

- [ ] **Step 2: Document the exact local workflow**

`docs/studio.md` must include:

1. copy `.env.studio.example` to `.env.studio.local` and fill local-only values;
2. configure the existing COS bucket and `latent-field` prefix;
3. run `npm run studio` and open `http://127.0.0.1:4317`;
4. import the fixture, confirm formulas, pair its image, and use preview-only mode;
5. explain that real upload/push requires explicit credentials and affects COS/GitHub;
6. explain push-failure recovery without force push or destructive reset.

- [ ] **Step 3: Run all automated verification**

Run:

```bash
npm test
npm run check
npm run studio:build
npm run build
npm run export:social
git diff --check
```

Expected: every command exits `0`; Astro check reports zero errors; the public build contains no Studio artifacts.

- [ ] **Step 4: Run local browser verification with fake adapters**

Start `npm run studio` on fixed port `4317`. In a real browser:

- run `npx tsx tests/fixtures/studio/create_attention_map.ts /tmp/latent-field-studio-fixture` to create the local image fixture;
- import `tests/fixtures/studio/article-with-math.md`;
- confirm inline and display KaTeX rendering;
- confirm code-fence content remains code;
- pair the fixture image and confirm the deterministic preview URL;
- verify preview-only mode blocks real publication with a clear message;
- test 1440 px and 390 px layouts;
- verify keyboard navigation and inspect console errors.

Expected: all flows work, no uncaught console errors appear, and no external mutation occurs.

- [ ] **Step 5: Commit Task 7**

```bash
git add README.md docs/studio.md scripts/check_site.mjs tests/fixtures/studio tests/studio_ui.test.ts
git commit -m "docs: verify local markdown studio workflow"
```

## Final Review Gate

- [ ] Run a specification review against `docs/superpowers/specs/2026-07-23-markdown-studio-publishing-design.md`.
- [ ] Run a code-quality and security review of the complete Studio diff.
- [ ] Run the full verification commands again after every review fix.
- [ ] Do not configure real COS secrets, push a publication commit, deploy, or expose a service without explicit user approval.
