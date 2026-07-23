# Latent Field Local Markdown Studio Design

## Purpose

Add a local, single-author publishing workflow to the Latent Field personal site. Zhenglong Chen writes articles locally, then uploads or pastes Markdown into a browser-based local Studio, verifies the rendered article and LaTeX, and publishes it without manually moving files or editing frontmatter.

The public site remains a conventional static Astro site: Markdown files live in GitHub, GitHub Pages builds and serves the site, and public page requests do not depend on a database or application server.

## Goals

- Accept a local `.md` file or pasted Markdown.
- Render a live preview using the same Markdown and KaTeX conventions as public articles.
- Collect and validate article metadata without requiring manual frontmatter editing.
- Upload local article images to the existing Tencent Cloud COS bucket under a deterministic hierarchy.
- Rewrite local Markdown image references to stable HTTPS image URLs.
- Commit and push the normalized Markdown to GitHub using the author's existing local Git credentials.
- Trigger the existing GitHub Pages deployment workflow through the Git push.
- Avoid a server, Tailscale, application login, user database, and browser-held cloud credentials.

## Non-goals for the First Version

- An internet-hosted CMS or publishing dashboard.
- Publishing from an arbitrary phone or computer without the local repository and credentials.
- Multiple authors, roles, invitations, or account management.
- Collaborative editing, comments, or cross-device draft synchronization.
- A database-backed content store.
- Automatic publication to WeChat, Zhihu, Xiaohongshu, or X. Existing manual social exports remain separate.
- Bulk migration or reorganization of existing COS objects.
- A general-purpose COS file manager.

## Architecture

### Public site

The existing Astro application remains statically generated. Markdown committed under the site's content collection is built into HTML by GitHub Pages. The generated site contains no Studio publishing credentials or private administrative route.

### Local Markdown Studio

Running `npm run studio` starts a local-only Studio and helper process. The helper binds to `127.0.0.1`, opens the Studio in the browser, and issues an ephemeral session token for that process. It is never bound to a public network interface.

The Studio provides:

- drag-and-drop or file-picker import for one `.md` file;
- full-document paste into an editor;
- metadata fields matching the Astro writing collection;
- explicit English slug input for stable article URLs;
- split editor and preview on wide screens;
- tabbed editor and preview on narrow screens;
- inline and display LaTeX preview;
- local image discovery, upload pairing, status, and final URL preview;
- validation errors linked to the affected field or Markdown location;
- explicit `Publish new article` and `Update existing article` actions.

Draft text remains on the local machine. Browser storage may preserve an interrupted draft for the same browser profile, but it is not a shared source of truth.

### Local publishing helper

The TypeScript helper performs operations that a browser cannot safely perform:

- validates metadata, Markdown, LaTeX, image types, and request limits;
- renders the article using the same Markdown rules used by Astro;
- uploads new image objects to Tencent COS;
- writes or updates exactly one Markdown file in the local repository;
- stages only files created or updated by the publication request;
- creates an intentional Git commit and pushes the configured branch;
- returns the commit identifier and push result to Studio;
- emits structured local logs without including secrets or full draft contents.

The helper uses the author's existing Git credential or SSH configuration. Tencent COS credentials are loaded from a local ignored environment file or operating-system credential store and are never sent to the public site or committed.

## Local Security Boundary

The helper accepts requests only on loopback, requires its ephemeral session token, checks the request origin, disables permissive CORS, and applies request-size limits. This is not a user login; it prevents unrelated web pages from silently calling the local publishing endpoint.

The helper exits with the Studio process. Production builds and GitHub Pages output exclude the Studio UI, helper endpoints, environment files, and credentials.

## Content Model

Studio produces Markdown compatible with the existing Astro `writing` collection. It supports these current fields:

- `title`;
- `description`;
- `date` and optional `updated`;
- `tags`;
- `language`;
- optional `translation`;
- `featured` and `draft`;
- per-platform manual social-export settings.

The slug is lowercase ASCII with hyphens. It comes from an explicit English slug field instead of automatic transliteration of a Chinese title. Editing the title does not silently change the URL.

For an update, Studio records the source file revision loaded at the start. The helper rejects a stale update instead of overwriting a newer local or remote article.

## Image Storage and Naming

The existing Tencent COS bucket is reused. Existing objects remain untouched. New Latent Field assets use this prefix structure:

```text
latent-field/
├── articles/<year>/<article_slug>/
│   ├── cover.webp
│   ├── fig-01-<semantic_name>.webp
│   └── fig-02-<semantic_name>.webp
├── projects/<project_slug>/
├── profile/
└── shared/
```

File names use lowercase ASCII, hyphens, a semantic label, and stable figure numbering. Spaces and Chinese characters are not used in object keys.

Studio discovers relative local image references in Markdown and pairs them with dropped or selected files. The helper verifies MIME type and file signatures, applies orientation, removes unnecessary metadata, and creates web-appropriate output. Photographs and ordinary screenshots default to WebP. Pixel-exact diagrams or images requiring transparency may remain PNG.

After upload, the helper rewrites local image references to HTTPS URLs under the configured image domain. The normalized article records a generated asset manifest containing the object keys and final URLs. The content schema is extended to accept this optional generated manifest.

New objects use deterministic keys. Existing objects are not overwritten unless the request is an explicit update of the same article asset and the prior manifest identifies that object. If the Git operation fails, the helper attempts to remove only objects created by that request and reports cleanup failures.

## Publication Flow

1. The author runs `npm run studio` inside the local repository.
2. The author uploads or pastes Markdown.
3. Studio separates recognized frontmatter from the body and populates metadata fields.
4. The browser renders a preview and reports Markdown, frontmatter, link, image, and LaTeX errors.
5. The author pairs unresolved local image references with image files.
6. The author selects `Publish new article` or `Update existing article`.
7. The helper repeats validation and rendering independently.
8. The helper uploads new images to the article's COS prefix and rewrites local references.
9. The helper writes the normalized article to the configured content directory.
10. The helper stages only the intended article file, creates a commit, and pushes the configured publication branch.
11. GitHub Pages builds the static site from that push.
12. Studio shows the commit identifier, push result, and public article URL. A later GitHub Pages failure does not lose the committed article or editor content.

The helper refuses to publish during an unresolved merge or rebase. Unrelated working-tree changes remain unstaged and untouched. Publication is idempotent through a request identifier so a timed-out retry cannot create duplicate image objects or commits.

## Preview Fidelity and LaTeX

The Studio renderer and Astro build share a rendering module or a common tested configuration. Both support:

- inline math such as `$p(y \mid x)$`;
- display math delimited by `$$`;
- escaped dollar signs;
- multiline display equations;
- Markdown emphasis adjacent to formulas;
- code spans and fenced code containing formula-like or HTML-like examples;
- horizontal scrolling for wide display equations on small screens.

The preview treats Markdown as untrusted input. Raw HTML is disabled or sanitized with an explicit allowlist. Publication fails with a precise error when content cannot be represented safely without loss.

## Failure Handling

- Invalid metadata or Markdown returns field-level errors and uploads no images.
- Missing local image files block publication and list every unresolved reference.
- Missing COS configuration permits preview but disables publication with a clear setup message.
- COS failure prevents the Git commit and preserves the editor content.
- A dirty target article, unresolved Git operation, stale revision, or non-fast-forward push stops publication without overwriting work.
- Git failure triggers best-effort cleanup of objects created by that request.
- GitHub Pages failure is reported separately from commit and push success.
- Network interruption preserves local editor state and permits an idempotent retry.

## Local Configuration

Ignored local configuration provides:

- repository root, publication branch, content path, commit-message template, and public site base URL;
- Tencent COS region, bucket, secret identifier, secret key, root prefix, and public image base URL;
- image size limits and Studio request limits.

The repository includes a safe example environment file containing names and documentation but no secret values. Studio starts in preview-only mode when publication credentials are absent. It fails closed for publish actions and explains the missing configuration.

## Testing

### Unit tests

- frontmatter parsing and normalization;
- slug and content-schema validation;
- identical Markdown and KaTeX behavior between Studio and site rendering;
- local-image discovery and deterministic COS key generation;
- MIME and file-signature validation;
- Markdown rewrite and asset-manifest generation;
- stale revision and idempotency handling.

### Integration tests

- publish a new article against fake Git and COS adapters;
- update an existing article with a matching revision;
- reject a dirty or stale target article;
- stage only the intended publication files while unrelated changes exist;
- reject a non-fast-forward push without destructive recovery;
- clean up newly created image objects after a Git failure;
- reject a missing or invalid local session token.

### Browser tests

- upload a Markdown fixture and verify metadata import;
- paste Markdown and preview inline and display formulas;
- pair local image references with files and inspect rewritten URLs;
- publish through fake adapters and display commit feedback;
- preserve content across a simulated network failure;
- verify wide and narrow layouts and keyboard accessibility.

## Delivery Sequence

1. Finish and verify the existing public static site.
2. Implement local Studio import, metadata editing, preview, and validation.
3. Implement the loopback publishing helper with fake Git and COS adapters.
4. Implement real local Git and Tencent COS adapters behind the tested interfaces.
5. Verify the full workflow locally without real remote mutations.
6. After explicit approval, configure local credentials and perform one controlled publication to a non-production branch.
7. Only after that succeeds, enable the production GitHub Pages publication branch.

## Acceptance Criteria

- A local Markdown article with LaTeX can be uploaded or pasted and previewed accurately.
- Local images can be associated, uploaded under the deterministic COS hierarchy, and rewritten to stable HTTPS URLs.
- One local publish action writes the correct article, stages no unrelated changes, commits it, and pushes the configured GitHub branch.
- GitHub Pages can update the public static site without an application server.
- Production output contains no Studio helper, session token, Git credential, or COS credential.
- Conflicts, validation failures, upload failures, Git failures, and deployment failures are distinguishable and recoverable.
- Existing COS objects, unrelated working-tree changes, and existing public article routes are not reorganized or overwritten.
