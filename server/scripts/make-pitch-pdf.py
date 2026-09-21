from playwright.sync_api import sync_playwright
import pathlib

src = pathlib.Path('public/pitch.html').resolve()
import sys
out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'src/pitch.pdf')

# Print layout: every slide stacked, one per 1920x1080 page, no scaling and no
# controls. The presenting page shows one slide at a time; a PDF needs them all.
PRINT_CSS = """
  @page { size: 1920px 1080px; margin: 0 }
  html, body { overflow: visible !important; height: auto !important; background: #10233A }
  .viewport { position: static !important; overflow: visible !important }
  .stage { position: static !important; transform: none !important; width: 1920px; height: auto !important }
  .slide { position: relative !important; opacity: 1 !important; visibility: visible !important;
           transition: none !important; page-break-after: always; break-after: page }
  .slide:last-child { page-break-after: auto; break-after: auto }
  .chrome, .tap, .rotate { display: none !important }
"""

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={'width': 1920, 'height': 1080})
    # the Google Fonts request cannot leave this machine; the families are installed locally
    page.route('**/fonts.googleapis.com/**', lambda r: r.abort())
    page.route('**/fonts.gstatic.com/**', lambda r: r.abort())
    page.goto(src.as_uri(), wait_until='load')
    page.add_style_tag(content=PRINT_CSS)
    page.evaluate('document.fonts.ready')

    used = page.evaluate("""() => {
      const pick = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).fontFamily : null; };
      return { heading: pick('.slide h2'), body: pick('.slide p'),
               headingLoaded: document.fonts.check("64px 'Libre Baskerville'"),
               bodyLoaded: document.fonts.check("28px 'IBM Plex Sans'") };
    }""")
    print('fonts:', used)

    page.pdf(path=str(out), width='1920px', height='1080px', print_background=True,
             margin={'top': '0', 'right': '0', 'bottom': '0', 'left': '0'})

    # page images, to look at rather than assume
    for i, el in enumerate(page.query_selector_all('.slide')):
        if i in (0, 3, 5, 12):
            el.screenshot(path=f'/tmp/pdfcheck-{i+1:02d}.png')
    browser.close()
print('written', out, out.stat().st_size // 1024, 'KB')
