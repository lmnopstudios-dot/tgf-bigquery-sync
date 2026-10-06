#!/usr/bin/env python3
"""Local chart acceptance only. Requires the environment's Playwright and Chromium."""
import asyncio
import functools
import http.server
import json
from pathlib import Path
import shutil
import sys
import tempfile
import threading
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = Path(sys.argv[1] if len(sys.argv) > 1 else '/tmp/oracle-chart-browser')
OUTPUT.mkdir(parents=True, exist_ok=True)
HTML = '''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><style>body{padding:24px}main{max-width:900px;margin:auto}</style></head><body><main><h1>Oracle chart acceptance</h1></main><script type="module">
import {renderInlineChart} from '/inline-chart.js';
const chart={version:1,kind:'line',id:'acceptance',title:'Mobile and desktop conversion',period:'January–April 2026',metric:'Conversion',unit:'percent',source:'Governed native evidence',definition:'Completed-checkout sessions / sessions.',accessible_label:'Native conversion; March missing.',period_axis:['2026-01','2026-02','2026-03','2026-04'],series:[{period:'2026-01',label:'mobile',value:2.23456789},{period:'2026-02',label:'mobile',value:3},{period:'2026-04',label:'mobile',value:4},{period:'2026-01',label:'desktop',value:5},{period:'2026-02',label:'desktop',value:6},{period:'2026-04',label:'desktop',value:7}],table:{columns:['Period','Series','Label','Unit','Value'],rows:[['2026-01','mobile','mobile','percent',2.23456789],['2026-02','mobile','mobile','percent',3],['2026-03','mobile','mobile','percent',null],['2026-04','mobile','mobile','percent',4]]}};
document.querySelector('main').append(renderInlineChart(chart));document.body.dataset.check=JSON.stringify({lines:document.querySelectorAll('polyline').length,dots:document.querySelectorAll('circle').length,table:document.querySelector('table').textContent,columns:document.querySelectorAll('th').length,scroll:document.documentElement.scrollWidth<=innerWidth});
</script></body></html>'''

async def check(base):
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path='/usr/bin/chromium', headless=True,
                                         args=['--no-sandbox', '--disable-dev-shm-usage'], timeout=15000)
        try:
            for name, width, height in [('desktop', 1280, 900), ('mobile', 390, 844)]:
                page = await browser.new_page(viewport={'width': width, 'height': height})
                await page.goto(base, wait_until='domcontentloaded', timeout=15000)
                await page.wait_for_selector('table', timeout=10000)
                facts = await page.evaluate('JSON.parse(document.body.dataset.check)')
                assert facts['lines'] == 4 and facts['dots'] == 6, facts
                assert '2.23' in facts['table'] and '2.23456789' not in facts['table'], facts
                assert facts['columns'] == 3 and facts['scroll'], facts
                await page.screenshot(path=str(OUTPUT / f'{name}.png'))
                print(name, json.dumps(facts))
                await page.close()
        finally:
            await browser.close()

with tempfile.TemporaryDirectory(prefix='oracle-chart-') as directory:
    path = Path(directory)
    for name in ['app.css', 'inline-chart.js']:
        shutil.copy(ROOT / 'public' / 'oracle' / name, path / name)
    (path / 'index.html').write_text(HTML)
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=directory)
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        asyncio.run(check(f'http://127.0.0.1:{server.server_port}/'))
    finally:
        server.shutdown()
        server.server_close()
