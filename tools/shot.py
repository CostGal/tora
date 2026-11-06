import sys, asyncio
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--no-sandbox'])
        pg=await b.new_page(viewport={'width':390,'height':844},device_scale_factor=2,has_touch=True)
        errs=[]; pg.on('pageerror',lambda e:errs.append(str(e))); pg.on('console',lambda m: m.type=='error' and errs.append(m.text))
        await pg.goto(''+__import__('sys').argv[1] if len(__import__('sys').argv)>1 else 'file:///home/claude/tora/index.html'+''); await pg.wait_for_timeout(1500)
        await pg.screenshot(path='/tmp/s_now.png')
        await pg.click('[data-tab=week]'); await pg.wait_for_timeout(1200); await pg.screenshot(path='/tmp/s_week.png',full_page=True)
        await pg.click('.bk'); await pg.wait_for_timeout(700); await pg.screenshot(path='/tmp/s_edit.png')
        await pg.click('[data-e=close]'); await pg.click('[data-tab=ins]'); await pg.wait_for_timeout(1300); await pg.screenshot(path='/tmp/s_ins.png',full_page=True)
        await pg.click('[data-tab=now]'); await pg.wait_for_timeout(600); await pg.click('[data-act=done]'); await pg.wait_for_timeout(1000); await pg.screenshot(path='/tmp/s_now2.png')
        print('errors:',errs)
        await b.close()
asyncio.run(main())
