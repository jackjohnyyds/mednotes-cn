#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
MedNotes 每日数据生成器（服务端执行，GitHub Actions 每日 11:00 运行）
产出 data/papers.json / data/mednews.json / data/briefing.json / data/douban.json，
供客户端打开页面时直接读取（同源静态数据，秒开、稳定，不依赖外部代理）。
结构完全对齐客户端 modules/*.js 的 loadLocal* 读取 schema。
每个数据源独立容错：单源失败不影响整体，至少产出可用 JSON。
"""
import json
import re
import ssl
import time
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
    # RSS 2.0 / RDF(RSS 1.0，item 可带 rdf:about 等属性)
    for m in re.finditer(r'<item(?:\s[^>]*)?>([\s\S]*?)</item>', xml_text):
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
        for m in re.finditer(r'<entry(?:\s[^>]*)?>([\s\S]*?)</entry>', xml_text):
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

# RSSHub 公共实例（按响应速度与可用性排序；rssforever/rsshub.app 不稳定，作为后备）
RSSHUB_INSTANCES = ('https://rsshub.woodland.cafe', 'https://rsshub.ktachibana.party',
                    'https://rsshub.rssforever.com', 'https://rsshub.app')

def fetch_rsshub(route, source_name, limit, english=False, kw=None):
    """并行尝试多个 RSSHub 实例，取最先成功的返回（任一实例稳定可达即成功）"""
    with ThreadPoolExecutor(max_workers=len(RSSHUB_INSTANCES)) as ex:
        futs = [ex.submit(fetch_rss, inst + route, source_name, limit, english, kw)
                for inst in RSSHUB_INSTANCES]
        for fut in as_completed(futs):
            try:
                items = fut.result()
                if items:
                    return items
            except Exception:
                continue
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
        # 期刊（XML 为嵌套标签，需按层级提取；开标签可能带属性）
        jm = re.search(r'<Journal[^>]*>([\s\S]*?)</Journal>', block, re.I)
        journal = ''
        if jm:
            tm = re.search(r'<Title[^>]*>([\s\S]*?)</Title>', jm.group(1), re.I)
            if tm:
                journal = clean_text(tm.group(1))
        if not journal:
            journal = clean_text(tag('Title'))
        # 年份：JournalIssue > PubDate > Year（或 MedlineDate）
        year = ''
        jjm = re.search(r'<JournalIssue[^>]*>([\s\S]*?)</JournalIssue>', block, re.I)
        if jjm:
            pdm = re.search(r'<PubDate[^>]*>([\s\S]*?)</PubDate>', jjm.group(1), re.I)
            if pdm:
                ym = re.search(r'<Year[^>]*>([^<]+)</Year>', pdm.group(1), re.I)
                if ym:
                    year = clean_text(ym.group(1))
        if not year:
            md = re.search(r'<MedlineDate>([^<]+)</MedlineDate>', block)
            if md:
                ym2 = re.match(r'\d{4}', clean_text(md.group(1)))
                year = ym2.group(0) if ym2 else ''
        if not year:
            dm = re.search(r'<ArticleDate[^>]*>([\s\S]*?)</ArticleDate>', block, re.I)
            if dm:
                ym3 = re.search(r'<Year[^>]*>([^<]+)</Year>', dm.group(1), re.I)
                if ym3:
                    year = clean_text(ym3.group(1))
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

def esearch_ids(field):
    """NCBI E-utilities esearch，带限流规避与重试（无 key 限流约 3 req/s）"""
    q = urllib.parse.quote(field)
    url = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=%s&retmax=5&sort=date&retmode=json' % q
    for attempt in range(3):
        try:
            data = fetch_json(url)
            ids = (data.get('esearchresult') or {}).get('idlist', []) or []
            if ids:
                return ids
        except Exception:
            pass
        time.sleep(1.5 * (attempt + 1))
    return []

def gen_papers(fields=None):
    fields = fields or DEFAULT_FIELDS
    id_field, order = {}, []
    for f in fields[:4]:
        for pid in esearch_ids(f):
            if pid not in id_field:
                id_field[pid] = f
                order.append(pid)
        time.sleep(1.2)  # 避免连续请求触发限流
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
            p['link'] = 'https://pubmed.ncbi.nlm.nih.gov/%s/' % pid
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
    return {'items': out[:40], 'progress': gen_progress(),
            'lastUpdated': datetime.datetime.now(datetime.timezone.utc).isoformat()}

# ---------------- 临床医讯进展栏目（疾病治疗 / 药物进展）：中文互联网医学资讯 ----------------
# 每日固定时间由 GitHub Actions 生成；客户端仅读取当日静态数据、不做实时抓取。
PROGRESS_NAV_WORDS = ['关于我们', '隐私', '下载', 'APP', '登录', '注册', '首页', '更多', '上一页',
                      '下一页', '订阅', '免责', '版权', '联系我们', '投稿', '返回', '专题', '视频',
                      '广告', '客户端', '医生站']
HTML_NEWS_BAD = ['about', 'privacy', 'login', 'register', 'javascript', 'void(0)', 'mailto:', '#',
                 'feedback', 'sitemap', 'help', 'wap']

def fetch_html_news(url, source_name, limit):
    """抓取中文资讯首页，解析 <a href>标题</a>（过滤导航/广告，仅保留含中文标题的新闻链接）"""
    html = fetch(url, TIMEOUT)
    html = re.sub(r'<script[\s\S]*?</script>', ' ', html, flags=re.I)
    html = re.sub(r'<style[\s\S]*?</style>', ' ', html, flags=re.I)
    out, seen = [], set()
    for m in re.finditer(r'<a[^>]+href=["\']([^"\']{5,140})["\'][^>]*>([\s\S]{2,90}?)</a>', html, re.I):
        href, title = m.group(1), clean_text(m.group(2))
        if not href or not title or len(title) < 6:
            continue
        if title in seen:
            continue
        low_h = href.lower()
        if any(b in low_h for b in HTML_NEWS_BAD):
            continue
        if any(w in title for w in PROGRESS_NAV_WORDS):
            continue
        if re.search(r'[\u4e00-\u9fff]', title) is None:
            continue
        link = urllib.parse.urljoin(url, href)
        if not re.match(r'^https?://', link):
            continue
        seen.add(title)
        out.append({'title': title, 'link': link, 'source': source_name,
                    'time': '', 'summary': '', 'english': False})
        if len(out) >= limit:
            break
    return out

PROGRESS_SOURCES = [
    {'name': '药智新闻', 'url': 'https://news.yaozh.com/', 'limit': 20, 'cat': 'drug'},
    {'name': '健康时报', 'url': 'https://www.jksb.com.cn/', 'limit': 14, 'cat': 'kw'},
    {'name': '央视网健康', 'url': 'https://jiankang.cctv.com/', 'limit': 12, 'cat': 'kw'},
    {'name': '39健康网', 'url': 'https://www.39.net/', 'limit': 16, 'cat': 'kw'},
]
DISEASE_KW_CN = ['治疗', '疗法', '疾病', '患者', '肿瘤', '癌', '糖尿', '心血管', '心脏', '脑', '中风',
                 '感染', '疫苗', '手术', '预防', '康复', '血压', '心梗', '动脉', '筛查', '慢病', '肺',
                 '乙肝', '肾病', '胃', '骨科', '眼科', '妇产']
DRUG_KW_CN = ['新药', '获批', '上市', '药品', '药物', '创新药', '仿制药', '临床', '试验', '制剂',
              '原料药', '注射液', 'glp-1', '司美格鲁肽', '研发', '药企', '医药', '生物', '原研',
              '三期', '靶向', '抗体', '疫苗获批']
PROGRESS_SKIP_CN = ['医械', '致敬', '盛典', '征文', '报名', '直播', '回放', '白皮书', '报告下载',
                    '招聘', '招商', '合作', '公告', '更名', '工商', '节能', '大会', '论坛', '峰会',
                    '年会', '邀您', '赴约', '博览会', '博物馆', '评选', '榜单', '招商会']

def gen_progress():
    disease, drug = [], []
    for f in PROGRESS_SOURCES:
        try:
            items = fetch_html_news(f['url'], f['name'], f['limit'])
            for it in items:
                title = it['title'].lower()
                if any(k in title for k in PROGRESS_SKIP_CN):
                    continue
                if f['cat'] == 'drug':
                    drug.append(it)
                else:
                    # 药物特征词优先，其次疾病治疗；都不命中则跳过
                    if any(k in title for k in DRUG_KW_CN):
                        drug.append(it)
                    elif any(k in title for k in DISEASE_KW_CN):
                        disease.append(it)
        except Exception as e:
            print('[warn] 进展源 %s 抓取失败: %s' % (f['name'], e), flush=True)
    return {'disease': dedup(disease)[:15], 'drug': dedup(drug)[:15]}

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
        def build_pearvideo():
            return {'id': 'pearvideo', 'label': '梨视频', 'items': dedup(gen_pearvideo())[:24]}
        cats = [f.result() for f in [ex.submit(b) for b in (build_cctv, build_cd, build_thepaper, build_kr36, build_global, build_pearvideo)]]
    cats = [c for c in cats if c and c['items']]
    return {'categories': cats, 'lastUpdated': datetime.datetime.now(datetime.timezone.utc).isoformat()}

# ---------------- 梨视频（简报：热门视频，点击跳转播放页） ----------------
PEAR_VIDEO_URLS = ['https://www.pearvideo.com/', 'https://www.pearvideo.com/category_1']
PEAR_A_RE = re.compile(r'<a[^>]+href="(video_\d+)"[^>]*>([\s\S]*?)</a>', re.I)
PEAR_TITLE_RE = re.compile(r'<div class="[^"]*title[^"]*"[^>]*>([\s\S]*?)</div>', re.I)

def parse_pearvideo_html(html_text):
    items = []
    for m in PEAR_A_RE.finditer(html_text):
        vid = m.group(1)
        inner = m.group(2)
        tm = PEAR_TITLE_RE.search(inner)
        title = clean_text(tm.group(1)) if tm else clean_text(inner)
        if not title:
            continue
        items.append({'title': title[:60], 'link': 'https://www.pearvideo.com/' + vid,
                      'source': '梨视频', 'type': 'video'})
    return items

def gen_pearvideo():
    items = []
    for url in PEAR_VIDEO_URLS:
        try:
            items.extend(parse_pearvideo_html(fetch(url)))
        except Exception as e:
            print('[warn] 梨视频 %s 抓取失败: %s' % (url, e), flush=True)
    return items

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

# ---------------- 豆瓣书影音推荐（个人空间） ----------------
DOUBAN_ROUTES = [('/douban/movie/weekly', '电影', 8), ('/douban/book/latest', '书籍', 8)]

def parse_douban_xml(xml_text, kind, limit):
    items = []
    for m in re.finditer(r'<item>([\s\S]*?)</item>', xml_text):
        block = m.group(1)
        def get(tag):
            mm = re.search(r'<%s[^>]*>([\s\S]*?)</%s>' % (tag, tag), block, re.I)
            if not mm:
                return ''
            return re.sub(r'<[^>]+>', ' ', mm.group(1).replace('<![CDATA[', '').replace(']]>', '')).strip()
        name = html.unescape(get('title'))
        link = html.unescape(get('link'))
        desc = html.unescape(get('description'))
        if not name or not re.match(r'^https?://(movie|book)\.douban\.com/', link, re.I):
            continue
        rm = re.search(r'([\d.]+)\s*分', desc)
        rating = rm.group(1) if rm else ''
        comment = re.sub(r'^.*?影片信息[:：]', '', desc)
        comment = re.sub(r'标题[:：].*?标签[:：][^影]*?(?=影片信息|$)', '', comment).strip()
        if not comment:
            comment = re.sub(r'标题[:：].*?分', '', desc).strip()
        if len(comment) > 60:
            comment = comment[:60] + '…'
        items.append({'name': name, 'type': kind, 'rating': rating,
                      'comment': comment or '豆瓣推荐', 'doubanLink': link, 'source': link})
        if len(items) >= limit:
            break
    return items

def gen_douban():
    items = []
    for route, kind, lim in DOUBAN_ROUTES:
        xml = None
        for inst in ('https://rsshub.woodland.cafe', 'https://rsshub.ktachibana.party', 'https://rsshub.rssforever.com', 'https://rsshub.app'):
            try:
                xml = fetch(inst + route)
                if xml and ('<item' in xml or '<entry' in xml):
                    break
            except Exception:
                xml = None
        if xml:
            items.extend(parse_douban_xml(xml, kind, lim))
    return {'items': items, 'lastUpdated': datetime.datetime.now(datetime.timezone.utc).isoformat()}

# ---------------- 文学经典（个人空间：每日诗词 + 散文，静态精选库） ----------------
# 池子需足够大（≥每日展示数 10），否则 dailyPick 每天全量显示、内容无法轮换。
# 链接策略（2026-10-13 定稿）：全部为原文详情页直链，无搜索页/推广页/百科。
#   诗词 -> 古诗文网详情页 https://www.gushiwen.cn/shiwenv_{id}.aspx （46 首，逐条 HTTP 200 + 标题核验通过）
#   散文 -> 可可诗词网详情页 https://www.kekeshici.com/sanwen/... （24 篇，逐条 HTTP 200 + 标题核验通过；
#            sanwen.net 在云环境不可达，kekeshici 为可访问的散文站替代，均含原文正文）
LIT_URL_MAP = {
    # ---- 诗词 46 首（古诗文网详情页直链） ----
    '静夜思': 'https://www.gushiwen.cn/shiwenv_c35a60c1a8e2.aspx',
    '登鹳雀楼': 'https://www.gushiwen.cn/shiwenv_c90ff9ea5a71.aspx',
    '相思': 'https://www.gushiwen.cn/shiwenv_f324eea45183.aspx',
    '鹿柴': 'https://www.gushiwen.cn/shiwenv_e9b1a8b4def0.aspx',
    '竹里馆': 'https://www.gushiwen.cn/shiwenv_4809b5e7a16a.aspx',
    '问刘十九': 'https://www.gushiwen.cn/shiwenv_d09fef17613b.aspx',
    '春晓': 'https://www.gushiwen.cn/shiwenv_ccee5691ba93.aspx',
    '江雪': 'https://www.gushiwen.cn/shiwenv_58313be2d918.aspx',
    '望庐山瀑布': 'https://www.gushiwen.cn/shiwenv_62802abab937.aspx',
    '黄鹤楼': 'https://www.gushiwen.cn/shiwenv_b0d3f72465ef.aspx',
    '送元二使安西': 'https://www.gushiwen.cn/shiwenv_12a2295aa76b.aspx',
    '九月九日忆山东兄弟': 'https://www.gushiwen.cn/shiwenv_d75a706935de.aspx',
    '游子吟': 'https://www.gushiwen.cn/shiwenv_161d06b0b556.aspx',
    '咏鹅': 'https://www.gushiwen.cn/shiwenv_eeb3869b6242.aspx',
    '回乡偶书': 'https://www.gushiwen.cn/shiwenv_f459f8ed8d23.aspx',
    '出塞': 'https://www.gushiwen.cn/shiwenv_b9e14c6e09aa.aspx',
    '凉州词': 'https://www.gushiwen.cn/shiwenv_9312f5349cd7.aspx',
    '枫桥夜泊': 'https://www.gushiwen.cn/shiwenv_6fb73f607ad3.aspx',
    '别董大': 'https://www.gushiwen.cn/shiwenv_4b3ccba01be6.aspx',
    '早发白帝城': 'https://www.gushiwen.cn/shiwenv_0f81015a040c.aspx',
    '望天门山': 'https://www.gushiwen.cn/shiwenv_97e6296bfb8d.aspx',
    '赠汪伦': 'https://www.gushiwen.cn/shiwenv_ca9eaf40a6ce.aspx',
    '独坐敬亭山': 'https://www.gushiwen.cn/shiwenv_1da5349ad9e4.aspx',
    '夜雨寄北': 'https://www.gushiwen.cn/shiwenv_e46c43d13b97.aspx',
    '嫦娥': 'https://www.gushiwen.cn/shiwenv_caef25db347c.aspx',
    '乌衣巷': 'https://www.gushiwen.cn/shiwenv_8b671db8c10d.aspx',
    '泊秦淮': 'https://www.gushiwen.cn/shiwenv_8e8011f614fb.aspx',
    '山行': 'https://www.gushiwen.cn/shiwenv_3c36881bd247.aspx',
    '清明': 'https://www.gushiwen.cn/shiwenv_d3e3283daac5.aspx',
    '江南春': 'https://www.gushiwen.cn/shiwenv_33cbdb2cf9b3.aspx',
    '赤壁': 'https://www.gushiwen.cn/shiwenv_3fb397218a1e.aspx',
    '过故人庄': 'https://www.gushiwen.cn/shiwenv_4a0d548bebb3.aspx',
    '望岳': 'https://www.gushiwen.cn/shiwenv_efec283b31e0.aspx',
    '水调歌头·明月几时有': 'https://www.gushiwen.cn/shiwenv_632c5beb84eb.aspx',
    '念奴娇·赤壁怀古': 'https://www.gushiwen.cn/shiwenv_5fb51378286c.aspx',
    '江城子·密州出猎': 'https://www.gushiwen.cn/shiwenv_85b8792a66ac.aspx',
    '卜算子·咏梅': 'https://www.gushiwen.cn/shiwenv_2523dc7baa84.aspx',
    '青玉案·元夕': 'https://www.gushiwen.cn/shiwenv_51aa3a553057.aspx',
    '将进酒': 'https://www.gushiwen.cn/shiwenv_ee16df5673bc.aspx',
    '登高': 'https://www.gushiwen.cn/shiwenv_eeb217f8cb2d.aspx',
    '春望': 'https://www.gushiwen.cn/shiwenv_89d3a63c6d7f.aspx',
    '蜀道难': 'https://www.gushiwen.cn/shiwenv_d59ec5d6c91c.aspx',
    '行路难·其一': 'https://www.gushiwen.cn/shiwenv_870828ca8aaa.aspx',
    '梦游天姥吟留别': 'https://www.gushiwen.cn/shiwenv_05e2f6fc757c.aspx',
    '茅屋为秋风所破歌': 'https://www.gushiwen.cn/shiwenv_8e9ecc95d6a4.aspx',
    '蜀相': 'https://www.gushiwen.cn/shiwenv_625762a4b089.aspx',
    # ---- 散文 24 篇（可可诗词网详情页直链） ----
    '背影': 'https://www.kekeshici.com/sanwen/sanwenshangxi/5947.html',
    '荷塘月色': 'https://www.kekeshici.com/sanwen/sanwenshangxi/10618.html',
    '匆匆': 'https://www.kekeshici.com/sanwen/sanwenshangxi/6623.html',
    '春': 'https://www.kekeshici.com/sanwen/sanwenshangxi/6625.html',
    '绿': 'https://www.kekeshici.com/sanwen/sanwenshangxi/4389.html',
    '桨声灯影里的秦淮河': 'https://www.kekeshici.com/sanwen/sanwenshangxi/11634.html',
    '冬天': 'https://www.kekeshici.com/sanwen/zhuziqing/278398.html',
    '从百草园到三味书屋': 'https://www.kekeshici.com/sanwen/sanwenshangxi/6619.html',
    '济南的冬天': 'https://www.kekeshici.com/sanwen/mingpian/11636.html',
    '闲情': 'https://www.kekeshici.com/sanwen/mingpian/34652.html',
    '寄小读者': 'https://www.kekeshici.com/sanwen/sanwenshangxi/4275.html',
    '雅舍': 'https://www.kekeshici.com/sanwen/mingpian/34663.html',
    '白杨礼赞': 'https://www.kekeshici.com/sanwen/sanwenshangxi/5946.html',
    '故都的秋': 'https://www.kekeshici.com/sanwen/sanwenshangxi/10212.html',
    '落花生': 'https://www.kekeshici.com/sanwen/sanwenshangxi/16926.html',
    '荔枝蜜': 'https://www.kekeshici.com/sanwen/mingpian/34831.html',
    '阿长与《山海经》': 'https://www.kekeshici.com/sanwen/sanwenshangxi/5020.html',
    '灯下漫笔': 'https://www.kekeshici.com/sanwen/sanwenshangxi/8310.html',
    '北京的茶食': 'https://www.kekeshici.com/sanwen/sanwenshangxi/5942.html',
    '想北平': 'https://www.kekeshici.com/sanwen/sanwenshangxi/4699.html',
    '我的母亲': 'https://www.kekeshici.com/sanwen/sanwenshangxi/3520.html',
    '窗': 'https://www.kekeshici.com/sanwen/sanwenshangxi/8018.html',
    '桃源与沅州': 'https://www.kekeshici.com/sanwen/sanwenshangxi/4527.html',
    '乌篷船': 'https://www.kekeshici.com/sanwen/sanwenshangxi/3516.html',
}

LIT_POEMS = [
    ('静夜思', '唐'), ('登鹳雀楼', '唐'), ('相思', '唐'), ('鹿柴', '唐'), ('竹里馆', '唐'),
    ('问刘十九', '唐'), ('春晓', '唐'), ('江雪', '唐'), ('望庐山瀑布', '唐'), ('黄鹤楼', '唐'),
    ('送元二使安西', '唐'), ('九月九日忆山东兄弟', '唐'), ('游子吟', '唐'),
    ('咏鹅', '唐'), ('回乡偶书', '唐'), ('出塞', '唐'), ('凉州词', '唐'), ('枫桥夜泊', '唐'),
    ('别董大', '唐'), ('早发白帝城', '唐'), ('望天门山', '唐'), ('赠汪伦', '唐'), ('独坐敬亭山', '唐'),
    ('夜雨寄北', '唐'), ('嫦娥', '唐'), ('乌衣巷', '唐'), ('泊秦淮', '唐'), ('山行', '唐'),
    ('清明', '唐'), ('江南春', '唐'), ('赤壁', '唐'), ('过故人庄', '唐'), ('望岳', '唐'),
    ('水调歌头·明月几时有', '宋'), ('念奴娇·赤壁怀古', '宋'), ('江城子·密州出猎', '宋'),
    ('卜算子·咏梅', '宋'), ('青玉案·元夕', '宋'),
    ('将进酒', '唐'), ('登高', '唐'), ('春望', '唐'), ('蜀道难', '唐'), ('行路难·其一', '唐'),
    ('梦游天姥吟留别', '唐'), ('茅屋为秋风所破歌', '唐'), ('蜀相', '唐'),
]
LIT_ESSAYS = [
    ('背影', '朱自清'), ('荷塘月色', '朱自清'), ('匆匆', '朱自清'), ('春', '朱自清'),
    ('绿', '朱自清'), ('桨声灯影里的秦淮河', '朱自清'), ('冬天', '朱自清'),
    ('从百草园到三味书屋', '鲁迅'), ('济南的冬天', '老舍'), ('闲情', '冰心'),
    ('寄小读者', '冰心'), ('雅舍', '梁实秋'), ('白杨礼赞', '茅盾'), ('故都的秋', '郁达夫'),
    ('落花生', '许地山'), ('荔枝蜜', '杨朔'), ('阿长与《山海经》', '鲁迅'),
    ('灯下漫笔', '鲁迅'), ('北京的茶食', '周作人'), ('想北平', '老舍'),
    ('我的母亲', '胡适'), ('窗', '钱钟书'), ('桃源与沅州', '沈从文'), ('乌篷船', '周作人'),
]
LIT_STATIC = {
    'poems': [{'title': t, 'dynasty': d, 'url': LIT_URL_MAP[t]} for t, d in LIT_POEMS],
    'essays': [{'title': t, 'author': a, 'url': LIT_URL_MAP[t]} for t, a in LIT_ESSAYS],
}

def gen_literature():
    data = {k: list(v) for k, v in LIT_STATIC.items()}
    data['lastUpdated'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    return data

# ---------------- 全历史热帖（全历史网站历史帖子，点击跳转原帖） ----------------
# 来源：https://m2.allhistory.com/ （全历史/全知识）官方推荐历史文章，
# 详情页 https://m2.allhistory.com/article/{id} 可公开访问（SSR 渲染全文，标题已逐条核验）。
ALLH_STATIC = [
    {'title': '比殷墟更早！为什么说良渚遗址是中华五千年文明的实证？',
     'summary': '伟大的城市，伟大的文明',
     'tag': '全历史', 'url': 'https://m2.allhistory.com/article/5d5532723ae20d0001fe0ccc'},
    {'title': '成吉思汗创立的蒙古帝国，为何能横扫欧亚大陆？',
     'summary': '直接统治面积达3300万平方公里的游牧帝国',
     'tag': '全历史', 'url': 'https://m2.allhistory.com/article/5d400f57d47fa20001ed8020'},
    {'title': '商代名相伊尹：到底是社稷之臣，还是篡位之贼？',
     'summary': '商代传奇人物，“水边弃子”伊尹',
     'tag': '全历史', 'url': 'https://m2.allhistory.com/article/5c78e9ef3ae20d00012e5b98'},
    {'title': '“不落之城”钓鱼城：蒙古铁骑的折鞭之处',
     'summary': '阻碍铁骑推进的钓鱼城不仅令南宋政权苟存，更拯救了世界',
     'tag': '全历史', 'url': 'https://m2.allhistory.com/article/5cbbd0703ae20d0001b2e01a'},
    {'title': '朱元璋起义——从底层到顶层的逆袭神话',
     'summary': '经过十五年的南征北讨，曾经的讨饭僧终于实现了人生逆袭',
     'tag': '全历史', 'url': 'https://m2.allhistory.com/article/5c43d3d53ae20d0001b69246'},
]

def gen_allhistory():
    data = {'items': [dict(it) for it in ALLH_STATIC]}
    data['lastUpdated'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    return data

def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else 'data'
    import os
    os.makedirs(out_dir, exist_ok=True)
    results = {}
    with ThreadPoolExecutor(max_workers=4) as ex:
        jobs = {'papers': ex.submit(gen_papers), 'mednews': ex.submit(gen_mednews), 'briefing': ex.submit(gen_briefing), 'douban': ex.submit(gen_douban), 'literature': ex.submit(gen_literature), 'allhistory': ex.submit(gen_allhistory)}
        for name, fut in jobs.items():
            try:
                results[name] = fut.result()
            except Exception as e:
                print('[warn] %s 生成失败: %s' % (name, e), flush=True)
                results[name] = {'items': []} if name != 'briefing' else {'categories': []}
    for name in ('papers', 'mednews', 'briefing', 'douban', 'literature', 'allhistory'):
        path = os.path.join(out_dir, name + '.json')
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(results[name], f, ensure_ascii=False, indent=1)
        n = len(results[name].get('items', [])) if name != 'briefing' else sum(len(c.get('items', [])) for c in results[name].get('categories', []))
        print('OK %s -> %s (%d items)' % (name, path, n), flush=True)

if __name__ == '__main__':
    main()
