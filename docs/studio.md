# Local Markdown Studio

Markdown Studio is a local authoring helper. It listens only at `127.0.0.1`; it is not part of the public Astro site.

## Start in preview-only mode

Preview-only mode is the safe default. It renders Markdown and KaTeX, but cannot upload an image, write an article, commit, or push.

```bash
npm run studio
```

Open [http://127.0.0.1:4317](http://127.0.0.1:4317). Import `tests/fixtures/studio/article-with-math.md`. Confirm both the inline `$p(y \mid x)$` and the multi-line display equation render, and that the fenced `<script>` remains code. Create its image without contacting any service, then pair it with `./attention-map.png` in the unresolved-images area:

```bash
npx tsx tests/fixtures/studio/create_attention_map.ts /tmp/latent-field-studio-fixture
```

Choose the generated `/tmp/latent-field-studio-fixture/attention-map.png` and select its intent. Use `photo` for photographs, `screenshot` for ordinary UI captures, and `diagram` for diagrams or pixel-exact/transparent artwork. The intent determines whether Studio uses WebP or preserves PNG.

## Enable publication deliberately

Do not enter real credentials for preview-only verification. To enable real publication on a machine that is already authorized for this repository, copy the ignored template and fill only local values:

```bash
cp .env.studio.example .env.studio.local
```

Set `STUDIO_REPOSITORY_ROOT` to this checkout, the intended branch and public URL, plus the existing Tencent COS bucket and its public HTTPS base URL. COS bucket versioning must be enabled. Keep `TENCENT_COS_ROOT_PREFIX=latent-field`; new images are stored beneath `latent-field/articles/<year>/<slug>/` and existing COS objects are never reorganized. `.env.studio.local` is ignored—never commit it or paste real keys into documentation, chat, or the browser.

With every required value configured, restart `npm run studio` and return to [http://127.0.0.1:4317](http://127.0.0.1:4317). A real publish can create immutable COS object versions, write one Markdown article, create a local Git commit, and push it to GitHub. Those are external effects; check the preview, metadata, image pairing, and branch before choosing either publish action.

## New versus Update

`Publish new article` creates a slug that does not already exist. `Update existing article` is intentionally guarded by the source hash recorded when the Markdown file was imported. For an update, import the current article file again immediately before publishing; pasted-only drafts do not have the loaded revision hash. The helper rejects a stale hash instead of overwriting a newer article.

If a push fails after the commit was created, the local commit is retained for inspection. Review `git status`, the commit, remote state, and the local Studio transaction record; resolve the problem and push normally when ready. Do not use force push, destructive reset, or a blind retry to discard the retained commit or transaction evidence.
