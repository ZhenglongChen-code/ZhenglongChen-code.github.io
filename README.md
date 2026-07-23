# Zhenglong Chen — Latent Field

This repository contains the static Astro site and its local Markdown Studio authoring helper.

```bash
npm install
npm run dev
```

Use `npm run build` for the production static-site build and validation. Studio is never part of that output.

## Local Markdown Studio

Run the local helper with:

```bash
npm run studio
```

It serves only [http://127.0.0.1:4317](http://127.0.0.1:4317). Without a complete ignored `.env.studio.local`, it remains preview-only and cannot upload, write, commit, or push. For the complete setup, fixture verification, image-intent guidance, and safe Git recovery instructions, see [docs/studio.md](docs/studio.md).
