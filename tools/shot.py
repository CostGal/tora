"""Headless screenshots of every view at phone (390x844) and desktop (1440x900).
Usage: python3 tools/shot.py [url] [outdir]   (default: this checkout via file://, /tmp)
Prints page errors; exits 1 if there were any."""
import sys, os, asyncio
from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
URL = sys.argv[1] if len(sys.argv) > 1 else 'file://' + os.path.join(os.path.dirname(HERE), 'index.html')
OUT = sys.argv[2] if len(sys.argv) > 2 else '/tmp'
EXE = next((p for p in ['/usr/bin/google-chrome', '/opt/pw-browsers/chromium'] if os.path.exists(p)), None)

async def run(p, name, vp, touch):
    b = await p.chromium.launch(executable_path=EXE, args=['--no-sandbox'])
    pg = await b.new_page(viewport=vp, device_scale_factor=2, has_touch=touch)
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('console', lambda m: m.type == 'error' and errs.append(m.text))
    await pg.goto(URL); await pg.wait_for_timeout(1500)
    await pg.screenshot(path=f'{OUT}/s_{name}_now.png')
    await pg.click('[data-tab=week]'); await pg.wait_for_timeout(1200)
    await pg.screenshot(path=f'{OUT}/s_{name}_week.png', full_page=True)
    await pg.click('[data-tab=add]'); await pg.wait_for_timeout(800)
    await pg.screenshot(path=f'{OUT}/s_{name}_add.png')
    await pg.keyboard.press('Escape'); await pg.wait_for_timeout(300)
    await pg.click('[data-tab=now]'); await pg.wait_for_timeout(600)
    await pg.click('[data-act=done]'); await pg.wait_for_timeout(1000)
    await pg.screenshot(path=f'{OUT}/s_{name}_now2.png')
    await b.close()
    return errs

async def main():
    async with async_playwright() as p:
        errs = await run(p, 'm', {'width': 390, 'height': 844}, True)
        errs += await run(p, 'd', {'width': 1440, 'height': 900}, False)
    print('errors:', errs)
    sys.exit(1 if errs else 0)

asyncio.run(main())
