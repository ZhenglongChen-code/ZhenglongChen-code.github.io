from playwright.sync_api import sync_playwright
import urllib.parse

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    
    # Capture console errors
    errors = []
    page.on("console", lambda msg: errors.append(f"[{msg.type}] {msg.text}") if msg.type == "error" else None)
    
    # Go to the blog post
    url = "http://localhost:8080/" + urllib.parse.quote("机器学习/生成模型/2026/04/13/flow-matching-mathematical-principles.html")
    print(f"Visiting: {url}")
    page.goto(url)
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(2000)
    
    # Screenshot
    page.screenshot(path="/tmp/audio_test.png", full_page=True)
    
    # Check if audio element exists
    audio_exists = page.evaluate("() => document.querySelector('audio') !== null")
    src_value = page.evaluate("() => { const s = document.querySelector('source'); return s ? s.src : 'NOT FOUND'; }")
    print(f"\nAudio element exists: {audio_exists}")
    print(f"Audio source: {src_value}")
    
    # Try to get network errors for the audio URL
    audio_url = "http://reservoir-data.oss-cn-beijing.aliyuncs.com/reservoirpy/podcast/2026-04-15_1776188742.mp3"
    try:
        resp = page.goto(audio_url, timeout=10000)
        print(f"Audio direct access: HTTP {resp.status if resp else 'N/A'}")
    except Exception as e:
        print(f"Audio direct access ERROR: {e}")
    
    # Print console errors
    print(f"\n=== Console Errors ({len(errors)}) ===")
    for e in errors[-10:]:
        print(e)
    
    browser.close()
