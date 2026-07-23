import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import sharp from 'sharp';

const image_width = 96;
const image_height = 64;

/** Returns whether candidate resolves to a non-empty descendant of root. */
const is_inside_root = (root: string, candidate: string): boolean => {
  const relative_path = relative(root, candidate);
  return relative_path.length > 0 && !relative_path.startsWith('..') && !isAbsolute(relative_path);
};

/** Rejects symbolic links in an output path before Sharp can create the image. */
const reject_symbolic_links = async (root: string, target: string): Promise<void> => {
  const relative_path = relative(root, target);
  const segments = relative_path.split('/');
  let current_path = root;
  for (const segment of segments) {
    current_path = join(current_path, segment);
    const entry = await lstat(current_path).catch(() => undefined);
    if (entry?.isSymbolicLink()) throw new Error('Fixture output must not traverse a symbolic link.');
  }
};

/** Produces deterministic RGB attention-map pixels without external inputs. */
const attention_map_pixels = (): Uint8Array => {
  const pixels = new Uint8Array(image_width * image_height * 3);
  for (let y_index = 0; y_index < image_height; y_index += 1) {
    for (let x_index = 0; x_index < image_width; x_index += 1) {
      const pixel_index = (y_index * image_width + x_index) * 3;
      const diagonal_distance = Math.abs(x_index * image_height - y_index * image_width);
      const diagonal = Math.max(0, 255 - Math.floor(diagonal_distance / 5));
      const wave = (x_index * 17 + y_index * 29) % 96;
      pixels[pixel_index] = 24 + Math.floor(diagonal * 0.55);
      pixels[pixel_index + 1] = 43 + Math.floor(wave * 0.75);
      pixels[pixel_index + 2] = 72 + Math.floor(diagonal * 0.7);
    }
  }
  return pixels;
};

/** Writes a deterministic PNG inside a caller-owned temporary directory. */
export const create_attention_map = async (temporary_root: string, output_path = join(temporary_root, 'attention-map.png')): Promise<string> => {
  if (!isAbsolute(temporary_root)) throw new Error('Fixture temporary root must be an absolute path.');
  const requested_root = resolve(temporary_root);
  await mkdir(requested_root, { recursive: true });
  const root_entry = await lstat(requested_root);
  if (!root_entry.isDirectory() || root_entry.isSymbolicLink()) throw new Error('Fixture temporary root must be a non-symbolic-link directory.');
  const canonical_root = await realpath(requested_root);
  const requested_target = resolve(output_path);
  if (!is_inside_root(requested_root, requested_target)) throw new Error('Fixture output must remain inside the caller temporary root.');
  const target_path = resolve(canonical_root, relative(requested_root, requested_target));
  await reject_symbolic_links(canonical_root, target_path);
  await sharp(attention_map_pixels(), { raw: { width: image_width, height: image_height, channels: 3 } })
    .png({ adaptiveFiltering: false, compressionLevel: 9, palette: false })
    .toFile(target_path);
  return requested_target;
};

/** Runs the fixture generator from the command line with one optional temporary-root argument. */
const run_generator = async (): Promise<void> => {
  const temporary_root = process.argv[2];
  if (!temporary_root) throw new Error('Usage: npx tsx tests/fixtures/studio/create_attention_map.ts /absolute/temporary/root');
  const output_path = await create_attention_map(temporary_root);
  process.stdout.write(`${output_path}\n`);
};

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  void run_generator().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Fixture generation failed.'}\n`);
    process.exitCode = 1;
  });
}
