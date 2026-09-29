#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
MedNotes 每日数据生成器（服务端执行，GitHub Actions 每日 11:00 运行）
产出 data/papers.json / data/mednews.json / data/briefing.json，
供客户端打开页面时直接读取（同源静态数据，秒开、稳定，不依赖外部代理）。
结构完全对齐客户端 modules/*.js 的 loadLocal* 读取 schema。
每个数据源独立容错：单源失败不影响整体，至少产出可用 JSON。
"""
import json
import re
import ssl
import urllib.request
import urllib.parse
import html
import datetime
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

UA = {'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36 MedNotes-Daily'}
TIMEOUT = 15
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

def fetch(url, timeout=TIMEOUT):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
        return r.read().decode('utf-8', 'ignore')

def fetch_json(url, timeout=TIMEOUT):
    return json.loads(fetch(url, timeout))

def clean_text(v):
    v = v.replace('<![CDATA[', '').replace(']]>', '')
    v = re.sub(r'\[!--begin:[a-zA-Z]+--\][\s\S]*?\[!--end:[a-zA-Z]+--\]', ' ', v)
    v = re.sub(r'<!--[\s\S]*?-->', ' ', v)
    v = re.sub(r'\[!--[\s\S]*?--\]', ' ', v)
    for a, b in [('&lt;','<'),('&gt;','>'),('&quot;','"'),('&amp;','&'),('&#39;',"'"),('&nbsp;',' ')]:
        v = v.replace(a, b)
    v = re.sub(r'<[^>]+>', ' ', v)
    return re.sub(r'\s+', ' ', v).strip()

def parse_rss(xml_text, source_name, limit, english=False, kw=None):
    """解析 RSS 2.0 (<item>) 与 Atom (<entry>) 混合"""
    items = []
    # RSS 2.0
    for m in re.finditer(r'<item>([\s\S]*?)</item>', xml_text):
        block = m.group(1)
        def tag(n):
            mm = re.search(r'<%s[^>]*>([\s\S]*?)</%s>' % (n, n), block, re.I)
            return clean_text(mm.group(1)) if mm else ''
        title, link = tag('title'), tag('link')
        if not title or not link or not re.match(r'^https?://', link):
            continue
        if re.search(r'news\.google\.com|rsshub', link, re.I):
            continue
        pub = tag('pubDate')
        desc = tag('description')
        if len(desc) > 160:
            desc = desc[:160] + '…'
        items.append({'title': title, 'link': link, 'time': pub, 'source': source_name,
                      'summary': desc, 'english': english})
        if len(items) >= limit:
            break
    if not items:
        # Atom <entry>
        for m in re.finditer(r'<entry>([\s\S]*?)</entry>', xml_text):
            block = m.group(1)
            def atag(n):
                mm = re.search(r'<%s[^>]*>([\s\S]*?)</%s>' % (n, n), block, re.I)
                return clean_text(mm.group(1)) if mm else ''
            title = atag('title')
            link = ''
            lm = re.search(r'<link[^>]*href="([^"]+)"', block)
            if lm:
                link = html.unescape(lm.group(1))
            elif re.search(r'<link[^>]*>([^<]+)</link>', block):
                link = clean_text(re.search(r'<link[^>]*>([^<]+)</link>', block).group(1))
            if not title or not link or not re.match(r'^https?://', link):
                continue
            pub = atag('updated') or atag('published')
            desc = atag('summary')
            if len(desc) > 160:
                desc = desc[:160] + '…'
            items.append({'title': title, 'link': link, 'time': pub, 'source': source_name,
                          'summary': desc, 'english': english})
            if len(items) >= limit:
                break
    if kw:
        items = [it for it in items if any(k in (it['title'] + ' ' + it.get('summary','')) for k in kw)]
    return items

def fetch_rss(url, source_name, limit, english=False, kw=None):
    try:
        xml = fetch(url)
        if not xml or ('<item' not in xml and '<entry' not in xml):
            return []
        return parse_rss(xml, source_name, limit, english, kw)
    except Exception:
        return []

def fetch_rsshub(route, source_name, limit, english=False, kw=None):
    for inst in ('https://rsshub.rssforever.com', 'https://rsshub.app'):
        items = fetch_rss(inst + route, source_name, limit, english, kw)
        if items:
            return items
    return []

# ---------------- papers：PubMed E-utilities ----------------
DEFAULT_FIELDS = ['cardiology', 'immunotherapy', 'Hepatitis', 'Liver cancer']

def parse_pubmed_xml(xml):
    out = []
    for art in re.finditer(r'<PubmedArticle>([\s\S]*?)</PubmedArticle>', xml):
        block = art.group(1)
        def tag(n):
            mm = re.search(r'<%s[^>]*>([\s\S]*?)</%s>' % (n, n), block, re.I)
            return mm.group(1).strip() if mm else ''
        pmid = tag('PMID')
        title = clean_text(tag('ArticleTitle'))
        if not pmid or not title:
            continue
        # 摘要（可能带 Label 分段）
        abs_parts = re.findall(r'<AbstractText[^>]*>([\s\S]*?)</AbstractText>', block, re.I)
        abstract = ' '.join(clean_text(p) for p in abs_parts)
        journal = clean_text(tag('Journal/Title')) or clean_text(tag('Title'))
        year = clean_text(tag('Journal/JournalIssue/PubDate/Year'))
        if not year:
            md = re.search(r'<MedlineDate>([^<]+)</MedlineDate>', block)
            if md:
                year = re.match(r'\d{4}', clean_text(md.group(1)))
                year = year.group(0) if year else ''
        authors = []
        for am in re.finditer(r'<Author[^>]*>([\s\S]*?)</Author>', block, re.I):
            ab = am.group(1)
            ln = clean_text(re.search(r'<LastName>([\s\S]*?)</LastName>', ab).group(1)) if re.search(r'<LastName>', ab) else ''
            fn = clean_text(re.search(r'<ForeName>([\s\S]*?)</ForeName>', ab).group(1)) if re.search(r'<ForeName>', ab) else ''
            coll = clean_text(re.search(r'<CollectiveName>([\s\S]*?)</CollectiveName>', ab).group(1)) if re.search(r'<CollectiveName>', ab) else ''
            name = (fn + ' ' + ln).strip() or coll
            if name:
                authors.append(name)
        doi = ''
        dm = re.search(r"<ELocationID[^>]*EIdType=['\"]doi['\"][^>]*>([\s\S]*?)</ELocationID>", block, re.I)
        if dm:
            doi = clean_text(dm.group(1))
        if not doi:
            dm2 = re.search(r"<ArticleId[^>]*IdType=['\"]doi['\"][^>]*>([\s\S]*?)</ArticleId>", block, re.I)
            if dm2:
                doi = clean_text(dm2.group(1))
        out.append({'pmid': pmid, 'title': title, 'abstract': abstract, 'journal': journal,
                    'year': year, 'authors': authors, 'doi': doi, 'field': ''})
    return out

def gen_papers(fields=None):
    fields = fields or DEFAULT_FIELDS
    id_field, order = {}, []
    for f in fields[:4]:
        try:
            q = urllib.parse.quote(f)
            data = fetch_json('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=%s&retmax=5&sort=date&retmode=json' % q)
            for pid in (data.get('esearchresult') or {}).get('idlist', []) or []:
                if pid not in id_field:
                    id_field[pid] = f
                    order.append(pid)
        except Exception:
            continue
    if not order:
        return {'items': [], 'lastUpdated': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'fields': fields}
    id_list = order[:20]
    try:
        xml = fetch('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=%s&retmode=xml' % ','.join(id_list), 25)
        parsed = parse_pubmed_xml(xml)
    except Exception:
        parsed = []
    by_id = {p['pmid']: p for p in parsed}
    items = []
    for pid in id_list:
        p = by_id.get(pid)
        if p:
            p['field'] = id_field.get(pid, '')
            items.append(p)
    return {'items': items, 'lastUpdated': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'fields': fields}

# ---------------- mednews ----------------
NEWS_FEEDS = [
    {'name': '央视网健康', 'route': '/cctv/health', 'limit': 8},
    {'name': '人民网健康', 'route': '/people/health', 'limit': 8},
    {'name': '澎湃新闻', 'route': '/thepaper/featured', 'limit': 6,
     'kw': ['健康', '医', '药', '病', '疫', '卫生', '医院', '治疗', '防控', '医保', '养生']},
    {'name': 'WHO 新闻', 'url': 'https://www.who.int/rss-feeds/news-english.xml', 'limit': 8, 'english': True},
    {'name': 'BBC Health', 'url': 'https://feeds.bbci.co.uk/news/health/rss.xml', 'limit': 6, 'english': True},
]

def gen_mednews():
    with ThreadPoolExecutor(max_workers=5) as ex:
        futs = []
        for f in NEWS_FEEDS:
            if f.get('route'):
                futs.append(ex.submit(fetch_rsshub, f['route'], f['name'], f['limit'],
                                      f.get('english', False), f.get('kw')))
            else:
                futs.append(ex.submit(fetch_rss, f['url'], f['name'], f['limit'],
                                      f.get('english', False), f.get('kw')))
        items = []
        for fut in futs:
            items.extend(fut.result() or [])
    # 去重
    seen, out = set(), []
    for it in items:
        lk = re.sub(r'^https?://', '', it['link']).rstrip('/').lower()
        if lk in seen:
            continue
        seen.add(lk)
        out.append(it)
    return {'items': out[:40], 'progress': {'disease': [], 'drug': []},
            'lastUpdated': datetime.datetime.now(datetime.timezone.utc).isoformat()}

# ---------------- briefing ----------------
CCTV_FEEDS = [('/cctv/china', 9), ('/cctv/world', 8), ('/cctv/tech', 8)]
CD_SECTIONS = [('china', 8), ('world', 7), ('business', 6), ('culture', 5), ('opinion', 5)]
CD_RE = re.compile(r'<a[^>]+href="(?:https?:)?//www\.chinadaily\.com\.cn/a/(\d{4})(\d{2})/(\d{2})/(WS?[A-Za-z0-9_]+\.html)"[^>]*>([\s\S]*?)</a>', re.I)
GLOBAL_FEEDS = [
    ('BBC World', 'https://feeds.bbci.co.uk/news/world/rss.xml', 4),
    ('卫报国际', 'https://www.theguardian.com/world/rss', 4),
    ('BBC 科技', 'https://feeds.bbci.co.uk/news/technology/rss.xml', 3),
    ('卫报科技', 'https://www.theguardian.com/technology/rss', 3),
    ('BBC 商业', 'https://feeds.bbci.co.uk/news/business/rss.xml', 3),
    ('卫报商业', 'https://www.theguardian.com/uk/business/rss', 3),
    ('NPR 头条', 'https://feeds.npr.org/1001/rss.xml', 3),
    ('半岛电视台', 'https://www.aljazeera.com/xml/rss/all.xml', 3),
]

def fetch_chinadaily_section(sec, limit):
    try:
        h = fetch('https://www.chinadaily.com.cn/%s/' % sec, 16)
        m = {}
        for mm in CD_RE.finditer(h):
            link = 'https://www.chinadaily.com.cn/a/%s%s/%s/%s' % (mm.group(1), mm.group(2), mm.group(3), mm.group(4))
            title = clean_text(mm.group(5))
            if len(title) < 15 or re.match(r'^(Photo|Video|Infographic|Special|Gallery)', title, re.I):
                continue
            m.setdefault(link, {'title': title, 'link': link,
                                'time': '%s-%s-%sT00:00:00Z' % (mm.group(1), mm.group(2), mm.group(3)),
                                'source': 'China Daily', 'english': True})
        return list(m.values())[:limit]
    except Exception:
        return []

def gen_briefing():
    with ThreadPoolExecutor(max_workers=6) as ex:
        def build_cctv():
            items = []
            for route, lim in CCTV_FEEDS:
                items.extend(fetch_rsshub(route, '央视网', lim) or [])
            return {'id': 'cctv', 'label': '央视网', 'items': dedup(items)[:24]}
        def build_cd():
            futs = [ex.submit(fetch_chinadaily_section, s, l) for s, l in CD_SECTIONS]
            items = []
            for f in futs:
                items.extend(f.result() or [])
            return {'id': 'chinadaily', 'label': 'China Daily', 'items': dedup(items)[:24]}
        def build_thepaper():
            return {'id': 'thepaper', 'label': '澎湃新闻', 'items': dedup(fetch_rsshub('/thepaper/featured', '澎湃新闻', 24) or [])[:24]}
        def build_kr36():
            return {'id': 'kr36', 'label': '36氪', 'items': dedup(fetch_rsshub('/36kr/newsflashes', '36氪', 24) or [])[:24]}
        def build_global():
            items = []
            for name, url, lim in GLOBAL_FEEDS:
                for it in fetch_rss(url, name, lim, True) or []:
                    items.append(it)
            return {'id': 'global', 'label': '全球外网', 'items': dedup(items)[:24]}
        cats = [f.result() for f in [ex.submit(b) for b in (build_cctv, build_cd, build_thepaper, build_kr36, build_global)]]
    cats = [c for c in cats if c and c['items']]
    return {'categories': cats, 'lastUpdated': datetime.datetime.now(datetime.timezone.utc).isoformat()}

def dedup(items):
    seen_l, seen_t, out = set(), set(), []
    for it in items:
        if not it or not it.get('link') or not re.match(r'^https?://', it['link']):
            continue
        lk = re.sub(r'^https?://', '', it['link']).rstrip('/').lower()
        tt = re.sub(r'[^\w\u4e00-\u9fff]+', '', (it.get('titleCn') or it.get('title') or '').lower())[:40]
        if lk in seen_l or (tt and tt in seen_t):
            continue
        seen_l.add(lk)
        if tt:
            seen_t.add(tt)
        out.append(it)
    return out

def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else 'data'
    import os
    os.makedirs(out_dir, exist_ok=True)
    results = {}
    with ThreadPoolExecutor(max_workers=3) as ex:
        jobs = {'papers': ex.submit(gen_papers), 'mednews': ex.submit(gen_mednews), 'briefing': ex.submit(gen_briefing)}
        for name, fut in jobs.items():
            try:
                results[name] = fut.result()
            except Exception as e:
                print('[warn] %s 生成失败: %s' % (name, e), flush=True)
                results[name] = {'items': []} if name != 'briefing' else {'categories': []}
    for name in ('papers', 'mednews', 'briefing'):
        path = os.path.join(out_dir, name + '.json')
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(results[name], f, ensure_ascii=False, indent=1)
        n = len(results[name].get('items', [])) if name != 'briefing' else sum(len(c.get('items', [])) for c in results[name].get('categories', []))
        print('OK %s -> %s (%d items)' % (name, path, n), flush=True)

if __name__ == '__main__':
    main()
