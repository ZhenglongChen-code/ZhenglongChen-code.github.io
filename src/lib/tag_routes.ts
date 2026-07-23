export function encode_tag_slug(tag: string): string {
  // Astro 7 applies decodeURI to static path params, so `%XX` escapes cannot remain stable here.
  return encodeURIComponent(tag)
    .replaceAll('_', '%5F')
    .replaceAll('.', '%2E')
    .replaceAll('%', '_');
}
