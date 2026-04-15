#!/usr/bin/env python3
"""
Blog Cover Image Generator
==========================
Usage:
    python cover_gen.py "Flow Matching 数学原理"
    python cover_gen.py _posts/2026-04-13-flow-matching.md --upload
    python cover_gen.py _posts/xxx.md --aspect 16:9 --dry-run

Flow:
  1. Read blog title (from arg or MD front-matter)
  2. Call MiniMax Chat to generate image prompt
  3. Call MiniMax Image Gen to create cover
  4. Save locally / upload to OSS / update MD cover_image field
"""

import argparse
import logging
import os
import re
import sys
import time
import yaml
from datetime import datetime
from pathlib import Path

import requests
import oss2


SCRIPT_DIR = Path(__file__).parent.resolve()
SECRETS_FILE = SCRIPT_DIR / ".secrets.yaml"

IMAGE_MODEL = "image-01"
CHAT_BASE_URL = "https://api.minimaxi.com/v1/text/chatcompletion_v2"
IMAGE_BASE_URL = "https://api.minimaxi.com/v1/image_generation"

ASPECT_MAP = {
    "16:9": "16:9",
    "9:16": "9:16",
    "1:1": "1:1",
}

DEFAULT_ASPECT = "16:9"
CHAT_MODEL = "MiniMax-Text-01"


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("cover_gen")


def load_config():
    if not SECRETS_FILE.exists():
        log.error(f"Config file not found: {SECRETS_FILE}")
        sys.exit(1)
    with open(SECRETS_FILE, "r") as f:
        config = yaml.safe_load(f) or {}
    return config


def get_auth_header(config):
    api_key = config.get("MINIMAX_API_KEY", "")
    return {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}


def parse_title_from_md(filepath):
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()
    if content.startswith("---"):
        parts = content.split("---", 2)
        if len(parts) >= 3:
            fm = yaml.safe_load(parts[1]) or {}
            return fm.get("title", Path(filepath).stem)
    return Path(filepath).stem


def generate_prompt(title, config):
    headers = get_auth_header(config)
    system_prompt = (
        "You are a professional prompt engineer for AI image generation. "
        "Generate a detailed, high-quality image prompt for a blog cover image based on the blog title. "
        "Requirements:\n"
        "- Style: clean, modern, minimalist, tech/academic aesthetic (like Microsoft wallpaper or Unsplash)\n"
        "- Colors: harmonious palette, no garish colors\n"
        "- Composition: suitable as a wide banner/cover image\n"
        "- NO text, NO words, NO letters, NO watermark in the image\n"
        "- Output ONLY the image prompt in English, nothing else\n"
        "- Keep it under 150 words"
    )
    payload = {
        "model": CHAT_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": f"Blog title: {title}\nGenerate an image prompt for its cover."},
        ],
        "temperature": 0.8,
        "max_tokens": 300,
    }
    log.info(f"Generating image prompt for: {title}")
    resp = requests.post(CHAT_BASE_URL, json=payload, headers=headers, timeout=30)
    data = resp.json()
    if resp.status_code != 200 or data.get("base_resp", {}).get("status_code", -1) != 0:
        log.error(f"Chat API error: {data}")
        raise RuntimeError(f"Chat API failed: {data.get('base_resp', {}).get('status_msg', 'unknown')}")

    choices = data.get("choices", [])
    if not choices:
        raise RuntimeError(f"No choices in response: {data}")

    prompt = choices[0].get("message", {}).get("content", "").strip()
    log.info(f"Generated prompt: {prompt[:120]}...")
    return prompt


def generate_image(prompt, config, aspect_ratio=DEFAULT_ASPECT):
    headers = get_auth_header(config)
    payload = {
        "model": IMAGE_MODEL,
        "prompt": prompt,
        "aspect_ratio": aspect_ratio,
        "response_format": "url",
        "n": 1,
    }
    log.info(f"Generating image (aspect={aspect_ratio})...")
    resp = requests.post(IMAGE_BASE_URL, json=payload, headers=headers, timeout=60)
    data = resp.json()

    if resp.status_code != 200 or data.get("base_resp", {}).get("status_code", -1) != 0:
        log.error(f"Image gen failed: {data}")
        raise RuntimeError(f"Image API error: {data}")

    images = data.get("data", {}).get("image_urls", [])
    if not images:
        raise RuntimeError(f"No image URLs in response: {data}")

    img_url = images[0]
    log.info(f"Image generated, downloading...")
    img_data = requests.get(img_url, timeout=30).content
    log.info(f"Downloaded: {len(img_data)} bytes")
    return img_data


def save_local(img_data, title, output_dir=None):
    if output_dir is None:
        output_dir = SCRIPT_DIR / "_site" / "assets" / "img" / "covers"
    else:
        output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    safe_name = re.sub(r'[^\w\s-]', '', title)[:30].strip().replace(' ', '-').lower()
    date_str = datetime.now().strftime("%Y%m%d")
    filename = f"{date_str}_{safe_name}.png"
    filepath = output_dir / filename

    with open(filepath, "wb") as f:
        f.write(img_data)
    log.info(f"Saved locally: {filepath}")
    return filepath


def upload_to_oss(img_data, config):
    auth = oss2.Auth(config["OSS_ACCESS_KEY_ID"], config["OSS_ACCESS_KEY_SECRET"])
    bucket = oss2.Bucket(auth, config["OSS_ENDPOINT"], config["OSS_BUCKET_NAME"])

    date_str = datetime.now().strftime("%Y-%m-%d")
    ts = int(time.time())
    key = f"{config.get('OSS_PREFIX', '')}covers/{date_str}_{ts}.png"

    result = bucket.put_object(key, img_data)
    if result.status != 200:
        raise RuntimeError(f"OSS upload failed: {result.status}")

    endpoint_domain = config['OSS_ENDPOINT'].replace('https://', '').replace('http://', '')
    url = f"http://{config['OSS_BUCKET_NAME']}.{endpoint_domain}/{key}"
    log.info(f"Uploaded to OSS: {url}")
    return url


def update_md_cover(filepath, cover_url):
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()

    if "cover_image:" in content:
        content = re.sub(
            r'cover_image:\s*\S+',
            f'cover_image: {cover_url}',
            content,
        )
        log.info(f"Updated existing cover_image in: {filepath}")
    else:
        content = re.sub(
            r'(categories:\s*\[[^\]]*\])',
            rf'\1\ncover_image: {cover_url}',
            content,
        )
        log.info(f"Inserted cover_image into: {filepath}")

    with open(filepath, "w", encoding="utf-8") as f:
        f.write(content)


def main(target, aspect=DEFAULT_ASPECT, upload=False, dry_run=False, output_dir=None):
    config = load_config()

    target_path = Path(target)
    if target_path.exists() and target_path.suffix == ".md":
        title = parse_title_from_md(target_path)
        md_file = target_path
    else:
        title = target
        md_file = None

    log.info(f"Title: {title}")

    if dry_run:
        log.info("[DRY RUN] Would generate cover for: {title}")
        log.info(f"  Aspect ratio: {aspect}")
        log.info(f"  Upload to OSS: {upload}")
        log.info(f"  MD file: {md_file or 'N/A'}")
        return

    prompt = generate_prompt(title, config)
    img_data = generate_image(prompt, config, aspect_ratio=aspect)

    local_path = save_local(img_data, title, output_dir)

    cover_url = None
    if upload:
        cover_url = upload_to_oss(img_data, config)
        if md_file:
            update_md_cover(md_file, cover_url)

    log.info("=" * 50)
    log.info("Done!")
    log.info(f"   Local: {local_path}")
    if cover_url:
        log.info(f"   OSS:   {cover_url}")
    if not upload and md_file is None:
        log.info(f"   Tip: Use --upload to upload to OSS, or set as cover_image manually")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Blog Cover Image Generator")
    parser.add_argument(
        "target",
        help='Blog title string, or path to .md file (reads title from front-matter)',
    )
    parser.add_argument(
        "--aspect",
        default=DEFAULT_ASPECT,
        choices=list(ASPECT_MAP.keys()),
        help=f"Aspect ratio (default: {DEFAULT_ASPECT})",
    )
    parser.add_argument("--upload", action="store_true", help="Upload to OSS and update MD")
    parser.add_argument("--output-dir", default=None, help="Local output directory")
    parser.add_argument("--dry-run", action="store_true", help="Preview only, no API calls")
    args = parser.parse_args()

    try:
        main(args.target, aspect=args.aspect, upload=args.upload,
             dry_run=args.dry_run, output_dir=args.output_dir)
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as e:
        log.error(f"Error: {e}")
        sys.exit(1)
