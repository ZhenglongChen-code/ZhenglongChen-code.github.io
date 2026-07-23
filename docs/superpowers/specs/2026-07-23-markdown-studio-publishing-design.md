# Latent Field Markdown Studio and Publishing Design

## Purpose

Add a private, single-author publishing workflow to the Latent Field personal site. Zhenglong Chen writes articles locally, then uploads or pastes Markdown into a browser-based Studio, verifies the rendered article and LaTeX, and publishes it without manually editing repository files.

The public site remains statically generated. The Studio and publishing API are private operational tools and are not part of the public navigation.

## Goals

- Accept a local `.md` file or pasted Markdown.
- Render a live preview using the same Markdown, syntax highlighting, and KaTeX conventions as public articles.
- Collect and validate article metadata without requiring manual frontmatter editing.
- Publish the article source to GitHub with reviewable version history.
- Upload local article images to the existing Tencent Cloud COS bucket under a deterministic hierarchy.
- Keep GitHub and COS credentials off the browser.
- Avoid an application-level user database or login screen.
- Keep the public site fast, static, and independent of publishing API availability.

## Non-goals for the First Version

- Multiple authors, roles, invitations, or account management.
- Collaborative editing, comments, or browser-to-browser draft synchronization.
- A database-backed CMS.
- Automatic publication to WeChat, Zhihu, Xiaohongshu, or X. Existing manual social exports remain separate.
- Bulk migration or reorganization of objects already present in the COS bucket.
- A general-purpose file manager for COS.

## Architecture

### Public site

The existing Astro application remains a static site. Markdown committed to the configured GitHub repository is built into HTML by the deployment workflow. Public page requests never depend on the Studio API or Tencent COS credentials.

### Markdown Studio

The Studio is a private page served separately from the public navigation. It provides:

- drag-and-drop or file-picker import for one `.md` file;
- full-document paste into an editor;
- metadata fields for title, description, date, language, tags, draft state, and slug;
- split editor and rendered preview on wide screens;
- tabbed editor and preview on narrow screens;
- inline and display LaTeX preview;
- local image discovery, upload status, and final URL preview;
- validation errors linked to the affected field or Markdown location;
- explicit `Publish new article` and `Update existing article` actions.

Draft text stays in the browser until the author publishes. Browser storage may preserve an interrupted local draft on the same device, but it is not treated as a shared source of truth.

### Publishing API

A small TypeScript Node service provides the publishing boundary. It runs on the user's 2-core, 2-GB server and is exposed only through Tailscale Serve. The service does not implement accounts, passwords, OAuth, or a user database.

The API:

- accepts Studio publication requests only over the private Tailscale network;
- validates request size, metadata, Markdown, LaTeX, image types, and image sizes;
- renders the article server-side using the same Markdown rules used by Astro;
- uploads new image objects to Tencent COS;
- writes or updates one Markdown article in GitHub;
- returns the Git commit URL and publication/deployment status;
- emits structured logs without including secrets or full draft contents.

GitHub and Tencent COS credentials are provided only as server environment variables. The browser never receives them.

## Private Access Model

The public website is internet-accessible. The Studio and publishing API bind to a private service and are reachable only from devices joined to the owner's Tailscale network.

This device-level access replaces an application login screen. The server still enforces origin checks, request-size limits, content validation, and rate limits as defense in depth. The publishing service must not be exposed through Tailscale Funnel or a public reverse-proxy route.

## Content Model

Studio produces Markdown compatible with the existing Astro content collection. Required fields are validated against the site's content schema before publication.

The slug is lowercase ASCII with hyphens. It is generated from an explicit English slug field rather than transliterating a Chinese title automatically. This keeps URLs predictable and avoids destructive slug changes when a title is edited.

When updating an article, Studio submits the Git blob or commit revision that it originally loaded. The server rejects stale updates with a conflict response instead of overwriting newer repository content.

## Image Storage and Naming

The existing Tencent COS bucket is reused. Existing objects are left untouched. New Latent Field assets use this prefix structure:

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

For article publication, Studio identifies local image references and pairs them with selected or dropped files. The server verifies MIME type and file signatures, applies orientation, removes unnecessary metadata, and converts ordinary photographic or screenshot inputs to a web-friendly format when doing so is lossless enough for the intended content. Diagrams requiring transparency or pixel-exact preservation may remain PNG.

After upload, the service rewrites local Markdown image references to stable HTTPS URLs on the configured image domain. The resulting article frontmatter contains a generated asset manifest with object keys and final URLs. The manifest supports later inspection and cleanup without scanning the entire bucket.

Objects are uploaded with unique final keys before the Git commit. If the Git operation fails, the service attempts to remove only objects created by that request and reports cleanup failures for manual inspection. Existing objects are never overwritten implicitly.

## Publication Flow

1. The author uploads or pastes Markdown.
2. Studio separates recognized frontmatter from the body and populates editable metadata fields.
3. The browser renders a preview and reports Markdown, frontmatter, link, image, and LaTeX errors.
4. The author associates unresolved local image references with image files.
5. The author selects `Publish new article` or `Update existing article`.
6. The server repeats all validation and renders the content independently.
7. The server uploads new images to the article's COS prefix and rewrites local references.
8. The server commits the normalized Markdown to the configured GitHub branch using a fine-grained repository token.
9. The repository deployment workflow builds the static site.
10. Studio displays the commit link and polls a bounded deployment-status endpoint. A deployment failure does not lose the committed article or local editor content.

Publication is idempotent through a request identifier. Retrying a timed-out request cannot create duplicate image objects or duplicate commits.

## Preview Fidelity and LaTeX

The Studio renderer and Astro build share a rendering module or a common, tested configuration. Both support:

- inline math such as `$p(y \mid x)$`;
- display math delimited by `$$`;
- escaped dollar signs;
- multiline display equations;
- Markdown emphasis adjacent to formulas;
- code spans and fenced code containing formula-like or HTML-like examples;
- horizontal scrolling for wide display equations on small screens.

The preview is treated as untrusted content. Raw HTML is disabled or sanitized with an explicit allowlist. Publication fails with a precise error when content cannot be represented safely without loss.

## Failure Handling

- Invalid metadata or Markdown returns field-level errors and does not upload images.
- Missing local image files block publication and list every unresolved reference.
- COS failure prevents the Git commit and leaves the editor content intact.
- Git conflict returns the current repository revision and requires an explicit reload or merge.
- Git failure triggers best-effort cleanup of objects created by that request.
- Deployment failure is reported separately from publication success because the Git commit remains authoritative.
- Network interruption keeps the local editor state and allows an idempotent retry.

## Operational Configuration

Configuration uses environment variables for:

- GitHub owner, repository, publication branch, content path, and fine-grained token;
- Tencent COS region, bucket, secret identifier, secret key, root prefix, and public image base URL;
- allowed Studio origin, request limits, and deployment workflow identifier.

Secrets are never committed. Production startup fails fast when required configuration is missing. Health endpoints reveal readiness but no credential or repository details.

## Testing

### Unit tests

- frontmatter parsing and normalization;
- slug and metadata validation;
- identical Markdown/KaTeX behavior between Studio and site rendering;
- local-image reference discovery and deterministic object-key generation;
- MIME and file-signature validation;
- Markdown rewrite and asset-manifest generation;
- stale revision and idempotency handling.

### Integration tests

- publish a new article against fake GitHub and COS adapters;
- update an existing article with a matching revision;
- reject a stale update;
- roll back newly created image objects after a Git failure;
- preserve a committed article when deployment reporting fails;
- reject requests that do not come through the configured private access boundary.

### Browser tests

- upload a Markdown fixture and verify metadata import;
- paste Markdown and preview inline and display formulas;
- pair local image references with files and inspect rewritten URLs;
- publish and display commit/deployment feedback;
- preserve content across a simulated network failure;
- verify wide and narrow responsive layouts and keyboard accessibility.

## Delivery Sequence

1. Finish and verify the existing public static site.
2. Implement Studio preview and validation locally with fake publishing adapters.
3. Implement the private publishing API and GitHub/COS adapters behind tests.
4. Test the complete workflow locally without real credentials.
5. Configure Tailscale and production secrets on the server only after local approval.
6. Perform one controlled publication to a non-production branch before enabling the production workflow.

## Acceptance Criteria

- A local Markdown article with LaTeX can be uploaded or pasted and previewed accurately.
- Local images can be associated, uploaded under the deterministic COS hierarchy, and rewritten to stable HTTPS URLs.
- One private publish action creates or updates the correct GitHub Markdown file without exposing credentials.
- A GitHub build can update the public static site while the public site remains independent of API availability.
- Unauthorized public internet clients cannot reach the Studio publishing service.
- Conflicts, validation failures, upload failures, and deployment failures are distinguishable and recoverable.
- Existing COS objects and existing public article routes are not reorganized or broken.
