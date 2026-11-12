"""Export the adult-facing site, separately from the wordless native launcher."""
from html import escape
from pathlib import Path
import re
import shutil

HERE = Path(__file__).resolve().parent.parent


def _inline(text):
    # Only repository-authored Markdown is rendered. Escape text before allowing
    # the small subset needed by the public specifications; never inject HTML.
    tokens = re.split(r'(`[^`]+`|\[[^\]]+\]\([^\s)]+\))', text)
    result = []
    for token in tokens:
        if token.startswith('`') and token.endswith('`'):
            result.append('<code>' + escape(token[1:-1]) + '</code>')
        elif match := re.fullmatch(r'\[([^\]]+)\]\(([^\s)]+)\)', token):
            label, url = match.groups()
            if url.startswith(('/', 'https://', '#')) and not url.startswith('//'):
                result.append('<a href="' + escape(url, quote=True) + '">' + escape(label) + '</a>')
            else:
                result.append(escape(label))
        else:
            result.append(escape(token))
    return ''.join(result)


def _markdown(text):
    """Small, escaped renderer for our headings, paragraphs, lists and fences."""
    blocks, paragraph, code = [], [], None
    list_type = None

    def flush():
        if paragraph:
            blocks.append('<p>' + _inline(' '.join(paragraph)) + '</p>')
            paragraph.clear()

    def close_list():
        nonlocal list_type
        if list_type:
            blocks.append('</' + list_type + '>')
            list_type = None

    for line in text.splitlines():
        if line.startswith('```'):
            flush()
            close_list()
            if code is None:
                code = []
            else:
                blocks.append('<pre><code>' + escape('\n'.join(code)) + '</code></pre>')
                code = None
            continue
        if code is not None:
            code.append(line)
            continue
        if not line.strip():
            flush()
            close_list()
        elif heading := re.fullmatch(r'(#{1,4})\s+(.*)', line):
            flush()
            close_list()
            level = str(len(heading[1]))
            blocks.append('<h' + level + '>' + _inline(heading[2]) + '</h' + level + '>')
        elif item := re.match(r'^(?:([-*])|\d+\.)\s+(.*)', line):
            flush()
            kind = 'ul' if item[1] else 'ol'
            if list_type != kind:
                close_list()
                blocks.append('<' + kind + '>')
                list_type = kind
            blocks.append('<li>' + _inline(item[2]) + '</li>')
        elif line.startswith(' ') and list_type and blocks[-1].endswith('</li>'):
            blocks[-1] = blocks[-1][:-5] + ' ' + _inline(line.strip()) + '</li>'
        else:
            close_list()
            paragraph.append(line.strip())
    flush()
    close_list()
    return '\n'.join(blocks)


# Same smiling cubby-house mark as the launcher and landing page.
LOGO = ('<svg class="logo" viewBox="0 0 48 48" aria-hidden="true">'
        '<path class="logo-roof" d="M24 3.5 44 18.5V39a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V18.5Z"/>'
        '<rect class="logo-door" x="11" y="20" width="26" height="18" rx="6"/>'
        '<g class="logo-face"><circle cx="19" cy="27.5" r="2.4"/><circle cx="29" cy="27.5" r="2.4"/>'
        '<path d="M19.5 32.5q4.5 3.4 9 0"/></g></svg>')


def build(output):
    output = Path(output)
    shutil.copytree(HERE / 'website', output / 'site')
    (output / 'native').mkdir()
    shutil.copyfile(output / 'index.html', output / 'native/index.html')
    (output / 'docs').mkdir()
    for slug in ('game-authoring', 'game-release-manifest'):
        source = HERE / 'docs' / (slug + '.md')
        text = source.read_text(encoding='utf-8')
        title = escape(text.splitlines()[0].lstrip('# '))
        raw = '/docs/' + slug + '.md'
        page = ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
                '<meta name="viewport" content="width=device-width,initial-scale=1">'
                '<title>' + title + ' — Cubby Arcade</title>'
                '<link rel="stylesheet" href="/site/style.css">'
                '<link rel="icon" href="/favicon.ico" sizes="any"><link rel="icon" href="/site/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/site/apple-touch-icon.png">'
                '<script src="https://www.saasco.com/sdk/saasco-sdk.js" data-projectId="cmwdybu1l001lpsp73l6cljit" async></script>'
                '<meta name="theme-color" content="#2a1f3d"></head><body>'
                '<header><a class="brand" href="/">' + LOGO + '<span>Cubby Arcade</span></a>'
                '<nav aria-label="Documentation">'
                + ''.join('<a href="/docs/' + key + '.html"' + (' aria-current="page"' if key == slug else '') + '>' + label + '</a>'
                          for key, label in (('game-authoring', 'Game-author guide'), ('game-release-manifest', 'Manifest spec')))
                + '</nav></header>'
                '<main class="document"><p><a href="' + raw + '">Raw Markdown ↗</a> · '
                '<a href="/tools/cubby_manifest.py">Manifest generator ↓</a></p>'
                + _markdown(text) + '</main></body></html>')
        (output / 'docs' / (slug + '.html')).write_text(page, encoding='utf-8')
        shutil.copyfile(source, output / 'docs' / source.name)
    (output / 'tools').mkdir()
    shutil.copyfile(HERE / 'runtime/file_manifest.py', output / 'tools/cubby_manifest.py')
