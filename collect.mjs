#!/usr/bin/env node
// 영업이슈 뉴스 수집기 — 구글 뉴스 RSS + 네이버 검색 API → docs/news.json
// 의존성 없음. Node 20+ 내장 fetch 사용.
//
//   node collect.mjs                    실수집
//   node collect.mjs --test             네트워크 없이 파싱·중복제거·매칭 자체검사
//   node collect.mjs --topics <경로>     다른 설정 파일로 수집 (검증용)

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const ROOT = dirname(fileURLToPath(import.meta.url))
const OUT = join(ROOT, 'docs', 'news.json')

// --topics <경로> 로 다른 설정 파일을 물릴 수 있다. 에이전트가 원본을 건드리지 않고 검증할 때 쓴다.
const argIdx = process.argv.indexOf('--topics')
const TOPICS = argIdx > -1 ? process.argv[argIdx + 1] : join(ROOT, 'topics.json')

// ── 네이버 API는 이관 중. 어느 키를 넣었느냐로 엔드포인트가 갈린다.
//    NAVER_KEY_ID/NAVER_KEY      → NAVER API HUB (신규 발급)
//    NAVER_CLIENT_ID/_SECRET     → 구 개발자센터 (2027-06-30 까지 유예)
const NAVER = process.env.NAVER_KEY_ID
  ? {
      url: 'https://naverapihub.apigw.ntruss.com/search/v1/news',
      headers: {
        'X-NCP-APIGW-API-KEY-ID': process.env.NAVER_KEY_ID,
        'X-NCP-APIGW-API-KEY': process.env.NAVER_KEY,
      },
    }
  : process.env.NAVER_CLIENT_ID
    ? {
        url: 'https://openapi.naver.com/v1/search/news.json',
        headers: {
          'X-Naver-Client-Id': process.env.NAVER_CLIENT_ID,
          'X-Naver-Client-Secret': process.env.NAVER_CLIENT_SECRET,
        },
      }
    : null

// 네이버 API는 언론사명을 안 준다. originallink 도메인에서 복원한다.
const PRESS = {
  'chosun.com': '조선일보', 'joongang.co.kr': '중앙일보', 'donga.com': '동아일보',
  'hani.co.kr': '한겨레', 'khan.co.kr': '경향신문', 'seoul.co.kr': '서울신문',
  'hankookilbo.com': '한국일보', 'kmib.co.kr': '국민일보', 'segye.com': '세계일보',
  'munhwa.com': '문화일보', 'hankyung.com': '한국경제', 'mk.co.kr': '매일경제',
  'sedaily.com': '서울경제', 'fnnews.com': '파이낸셜뉴스', 'edaily.co.kr': '이데일리',
  'mt.co.kr': '머니투데이', 'asiae.co.kr': '아시아경제', 'heraldcorp.com': '헤럴드경제',
  'newsis.com': '뉴시스', 'yna.co.kr': '연합뉴스', 'news1.kr': '뉴스1',
  'kbs.co.kr': 'KBS', 'imbc.com': 'MBC', 'sbs.co.kr': 'SBS', 'ytn.co.kr': 'YTN',
  'insnews.co.kr': '한국보험신문', 'insweek.co.kr': '보험신보', 'insjournal.co.kr': '보험저널',
  'thebell.co.kr': '더벨', 'biz.chosun.com': '조선비즈', 'dailian.co.kr': '데일리안',
}

const PRESS_TIER = JSON.parse(readFileSync(join(ROOT, 'press.json'), 'utf8'))

// ── 보험사 상품 광고 배제 (자사·타사 구분 없이)
// 「삼성생명 가족대표건강보험 Plus+ 출시」 한 건이 25개 매체에 살포되는 식이다.
// 실측 41건 중 16개 대표 유형으로 규칙을 짜서 16/16 차단, 정보성 기사 오차단 0 을 확인했다.
const INSURERS = ['삼성화재','삼성생명','현대해상','DB손해보험','DB손보','KB손해보험','KB손보','KB라이프',
  '메리츠화재','한화손해보험','한화손보','한화생명','흥국화재','흥국생명','롯데손해보험','MG손해보험',
  'NH농협손해보험','농협손해보험','농협손보','NH농협생명','하나손해보험','하나손보','캐롯','AXA',
  '교보생명','미래에셋생명','동양생명','신한라이프','신한생명','메트라이프','라이나','AIA','처브',
  'ABL생명','iM라이프','푸본현대생명']

// 이 말이 있으면 광고가 아니라 「부정적 보도」로 보고 살린다.
const NEGATIVE = ['적발','제재','과징금','과태료','징계','기관주의','시정명령','환수','고발','기소',
  '불완전판매','부당','미지급','부지급','거절','거부','분쟁','소송','패소','피소','민원','논란','의혹',
  '제동','철퇴','오류','부진','적자','악화']

const AD_WORD = /출시|선보|선봬|론칭|런칭|신상품|신담보|등판|내놨|내놓았|판매 개시|단독 판매|가입 이벤트|리뉴얼/
// 따옴표로 감싼 상품명 — 광고 기사의 가장 확실한 지문이다
const PRODUCT = /['‘’"“”「『][^'‘’"“”」』]{2,30}(보험|보장|플랜|케어|라이프|통치|치간지)[^'‘’"“”」』]{0,12}['‘’"“”」』]/
const CORP_PR = /지정|기업|협력|확장|체질개선|포트폴리오|업무협약|MOU|캠페인/

/** 보험사 상품 광고·기업홍보 기사인가. 부정 보도는 광고로 보지 않는다. */
export function isProductAd(title) {
  const t = String(title)
  if (NEGATIVE.some((w) => t.includes(w))) return false
  const named = INSURERS.some((c) => t.toLowerCase().includes(c.toLowerCase()))
  if (named && (AD_WORD.test(t) || PRODUCT.test(t) || CORP_PR.test(t))) return true
  if (/신상품|신담보/.test(t)) return true                     // 실명 없이 「9월 손보 신상품」 식으로도 온다
  if (/론칭|런칭/.test(t) && /보험|보장/.test(t)) return true
  return false
}

/** 매체 등급. 이름이 도메인 형태면 구글조차 매체명을 모르는 곳이라 차단한다. */
export function tierOf(press) {
  const p = String(press)
  if (/^[a-z0-9-]+\.[a-z]{2,}/i.test(p) || p.includes('.co.kr') || p.includes('.kr/')) return 0
  if (PRESS_TIER.T1.some((x) => p.includes(x))) return 1
  if (PRESS_TIER.T2.some((x) => p.includes(x))) return 2
  return 3
}

// ─────────────────────────────────────────── 순수 함수 (테스트 대상)

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', hellip: '…', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', bull: '•', laquo: '«', raquo: '»', times: '×', sim: '∼' }

/** CDATA·HTML 태그·엔티티를 걷어내고 평문으로 만든다. 16진수 엔티티·이모지까지. */
export function decode(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&(?:#(\d+)|#x([\da-f]+)|(\w+));/gi, (m, d, h, name) => {
      if (name) return ENT[name] ?? m
      const cp = d ? +d : parseInt(h, 16)
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m
    })
    .replace(/\s+/g, ' ')
    .trim()
}

/** 구글 뉴스 RSS의 <item> 들을 뽑는다. */
export function parseRss(xml) {
  const tag = (s, t) => {
    const m = s.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`))
    return m ? decode(m[1]) : ''
  }
  return xml.split('<item>').slice(1).map((chunk) => {
    const s = chunk.split('</item>')[0]
    const press = tag(s, 'source')
    let title = tag(s, 'title')
    // 구글은 제목 끝에 " - 언론사"를 붙인다.
    if (press && title.endsWith(' - ' + press)) title = title.slice(0, -(press.length + 3))
    title = stripNav(title)
    return { title, url: tag(s, 'link'), press, summary: '', published: tag(s, 'pubDate') }
  })
}

/** 언론사 사이트의 네비게이션 찌꺼기가 제목에 딸려 온다. 떼어낸다. */
export const stripNav = (t) =>
  String(t).replace(/\s*[>|｜]\s*(뉴스|기사|홈|메인|속보)\s*$/, '').trim()

/** 제목을 비교용 어절로 쪼갠다. 한 글자짜리는 버린다. */
export function tokens(title) {
  return decode(title).toLowerCase().split(/[^가-힣a-z0-9]+/).filter((w) => w.length >= 2)
}

/**
 * 같은 사건을 다룬 기사인지. 짧은 쪽 기준 3.5할 이상 겹치면 같다고 본다.
 * 0.8 은 실측에서 아무것도 안 묶었다 — 같은 발표를 다룬 기사도 제목 어휘가 제각각이라서다.
 * 0.35 까지 내려도 오병합이 없음을 확인했다 (8주룰 4건 · 간병비3법 3+2건 · 5세대실손 3건).
 * 앞 N자 비교로는 「…발표」와 「…발표 확정」이 갈라져서 이렇게 한다.
 */
export function sameStory(a, b) {
  const A = new Set(tokens(a))
  const B = new Set(tokens(b))
  const m = Math.min(A.size, B.size)
  if (m < 3) return decode(a) === decode(b)   // 어절이 너무 적으면 오병합 위험이 커서 완전일치만
  let inter = 0
  for (const w of A) if (B.has(w)) inter += 1
  return inter / m >= 0.35
}

/** 링크에서 추적 파라미터를 떼어낸 정규형. */
export function normUrl(url) {
  try {
    const u = new URL(url)
    return u.host.replace(/^www\./, '') + u.pathname.replace(/\/$/, '')
  } catch {
    return String(url)
  }
}

export function pressOf(url, fallback = '') {
  if (fallback) return fallback
  try {
    const host = new URL(url).host.replace(/^www\./, '')
    return PRESS[host] ?? PRESS[host.replace(/^[^.]+\./, '')] ?? host
  } catch {
    return ''
  }
}

/**
 * 토픽 규칙 적용. 통과하면 점수, 탈락이면 null.
 * must 전부 포함(AND) → not 하나라도 걸리면 탈락 → any 가 있으면 최소 1개 히트 필요.
 */
const HANJA = [[/車/g,'자동차'],[/損保/g,'손해보험'],[/生保/g,'생명보험'],[/銀/g,'은행'],[/美/g,'미국'],[/中/g,'중국'],[/日/g,'일본']]
export const unhanja = (s) => HANJA.reduce((a,[re,to])=>a.replace(re,to), String(s))

export function matchTopic(topic, text, ageHours) {
  const t = unhanja(text).toLowerCase()
  const has = (w) => t.includes(w.toLowerCase())
  // must 의 각 항목은 `|` 로 대안을 적을 수 있다 — 「암|항암|종양」 이면 셋 중 하나만 있으면 된다.
  // 항목끼리는 AND. 「암 계열 단어 + 비용 계열 단어」 같은 2단 조건이 이걸로 표현된다.
  const hasAny = (w) => String(w).split('|').some(has)
  if (!(topic.must ?? []).every(hasAny)) return null
  if ((topic.not ?? []).some(has)) return null
  const hits = (topic.any ?? []).filter(has).length
  if ((topic.any ?? []).length && hits === 0) return null
  // 신선도 가중. 화면 상단에 일주일 전 기사가 오르던 문제를 여기서 잡는다.
  const fresh = ageHours <= 24 ? 8 : ageHours <= 48 ? 5 : ageHours <= 72 ? 2 : 0
  return hits * 2 + fresh
}

/** 구글 뉴스가 주는 중계 주소인가. 언론사 원문 주소가 있으면 그쪽을 쓴다. */
export const isRedirect = (url) => String(url).includes('news.google.com')

/** 링크가 같거나 같은 사건이면 한 건으로 묶고 others 를 센다. */
export function dedupe(items) {
  const byUrl = new Map()
  const out = []
  for (const it of items) {
    const key = normUrl(it.url)
    // ponytail: 제목 비교가 O(n²) 선형 스캔. 수집량이 수천 건이 되면 앞 6자 버킷팅으로 올린다.
    const hit = byUrl.get(key) ?? out.find((o) => sameStory(o.title, it.title))
    if (hit) {
      hit.others += 1
      // 요약·언론사가 비어 있던 대표 기사에 나중에 온 값을 채워준다.
      if (!hit.summary && it.summary) hit.summary = it.summary
      if (!hit.press && it.press) hit.press = it.press
      // 구글 리다이렉트 주소보다 언론사 원문 주소가 낫다. 카톡에 붙였을 때 뭔지 보인다.
      if (isRedirect(hit.url) && !isRedirect(it.url)) hit.url = it.url
      byUrl.set(key, hit)
      continue
    }
    it.others = 0
    byUrl.set(key, it)
    out.push(it)
  }
  return out
}

// ─────────────────────────────────────────── 구글 뉴스 → 원문 주소
// CBMi… 아이디는 AU_yqL… 신형이라 오프라인 복호화가 안 된다 (2026-09-11 실측 42/42 신형).
// 서명은 59만 바이트짜리 기사 페이지 맨 끝에 있어서 끝까지 받아야 한다.
// 429(google.com/sorry)는 「그만」 신호다. 다른 경로로 우회하지 않고 이번 회차를 접는다.

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36'
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function parseSig(html) {
  const sg = /data-n-a-sg="([^"]+)"/.exec(html)?.[1]
  const ts = /data-n-a-ts="(\d+)"/.exec(html)?.[1]
  return sg && ts ? { sg, ts: +ts } : null
}

export async function googleSig(url) {
  const id = new URL(url).pathname.split('/').pop()
  // 두 번째 경로는 페이지 형식이 바뀌어 서명이 안 보일 때만 쓴다. 차단(4xx)이면 바로 던진다.
  for (const base of ['https://news.google.com/articles/', 'https://news.google.com/rss/articles/']) {
    const res = await fetch(base + id, { headers: { 'user-agent': UA, 'accept-language': 'ko-KR,ko;q=0.9' }, signal: AbortSignal.timeout(10000) })
    if (!res.ok) throw new Error(`google GET ${res.status}`)
    if (res.url.includes('consent.google.')) throw new Error('google consent')
    const sig = parseSig(await res.text())
    if (sig) return { id, ...sig }
  }
  throw new Error('google no signature')
}

const GN_CTX = [['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1], 'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0]

export const garturlBody = (sigs) => 'f.req=' + encodeURIComponent(JSON.stringify([
  sigs.map(({ id, ts, sg }, i) => ['Fbv4je', JSON.stringify(['garturlreq', GN_CTX, id, ts, sg]), null, String(i + 1)]),
]))

/** batchexecute 응답에서 주소를 뽑는다. 요청 순서대로, 실패한 칸은 null. */
export function parseGarturl(text, n) {
  const out = Array(n).fill(null)
  for (const m of text.matchAll(/\["wrb\.fr","Fbv4je","((?:[^"\\]|\\.)*)",null,null,null,"(\d+|generic)"\]/g)) {
    const url = JSON.parse(JSON.parse(`"${m[1]}"`))[1]
    const k = m[2] === 'generic' ? 0 : +m[2] - 1
    if (k < n && /^https?:\/\//.test(url)) out[k] = url
  }
  return out
}

/** 서명 여러 개를 POST 한 번에 푼다. 10개 묶음 실측 202ms, 개별과 10/10 동일. */
export async function googleResolve(sigs) {
  const res = await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
    method: 'POST',
    headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: garturlBody(sigs),
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) throw new Error(`google POST ${res.status}`)
  return parseGarturl(await res.text(), sigs.length)
}

export async function resolveGoogleNewsUrl(url) {
  const [link] = await googleResolve([await googleSig(url)])
  if (!link) throw new Error('google no url')
  return link
}

// ─────────────────────────────────────────── 언론사 HTML → 메타

// WHATWG 라벨에 없는 한국 별칭. euc-kr·ks_c_5601-1987·windows-949 는 TextDecoder 가 원래 안다.
const CHARSET_ALIAS = { cp949: 'euc-kr', ms949: 'euc-kr', 'x-windows-949': 'euc-kr', uhc: 'euc-kr' }

/** 헤더 charset 우선, 없으면 앞 32KB 의 meta 태그. 브라우저와 같은 순서다. */
export function charsetOf(type, bytes) {
  const pick = (s) => /charset\s*=\s*["']?([\w:.-]+)/i.exec(s)?.[1]?.toLowerCase()
  const metas = Buffer.from(bytes.subarray(0, 32768)).toString('latin1').match(/<meta\b[^>]*>/gi)?.join(' ') ?? ''
  return pick(type) ?? pick(metas) ?? 'utf-8'
}

export function decodeHtml(bytes, type = '') {
  const cs = charsetOf(type, bytes)
  try { return new TextDecoder(CHARSET_ALIAS[cs] ?? cs).decode(bytes) } catch { return new TextDecoder().decode(bytes) }
}

const TAG = (name) => new RegExp(`<${name}\\b(?:[^>"']|"[^"]*"|'[^']*')*>`, 'gi')   // 따옴표 안의 > 도 견딘다
const attr = (tag, name) => {
  const r = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag)
  return r ? r[1] ?? r[2] ?? r[3] : undefined
}
const absHttp = (u, base) => { try { const h = new URL(u, base).href; return /^https?:/.test(h) ? h : '' } catch { return '' } }

export function parseMeta(html, base) {
  const m = {}
  for (const [tag] of html.matchAll(TAG('meta'))) {
    const key = (attr(tag, 'property') ?? attr(tag, 'name') ?? '').toLowerCase()
    const val = attr(tag, 'content')
    // 두 번 푼다 — 「&amp;lt;표&amp;gt;」 처럼 이중 이스케이프하는 곳이 있다 (실측 1/40)
    if (key && val && !(key in m)) m[key] = decode(decode(val))
  }
  let canonical = ''
  for (const [tag] of html.matchAll(TAG('link'))) if (/^canonical$/i.test(attr(tag, 'rel') ?? '')) { canonical = absHttp(decode(attr(tag, 'href') ?? ''), base); break }
  const img = m['og:image'] || m['og:image:url'] || m['og:image:secure_url'] || m['twitter:image'] || m['twitter:image:src'] || ''
  const image = img ? absHttp(img, base) : ''
  return {
    // ponytail: 파일명에 logo 가 든 대표 이미지는 사이트 로고로 본다 (실측 1/40). 오판이 보이면 언론사별 목록으로 올린다.
    image: /logo[^/]*$/i.test(image) ? '' : image,
    desc: (m['og:description'] || m['twitter:description'] || m.description || '').slice(0, 160),
    canonical: canonical || (m['og:url'] ? absHttp(m['og:url'], base) : ''),
  }
}

/**
 * 8초·1.5MB 상한. og 태그는 <head> 안에 있으니 </head> 를 보면 그만 받는다 (실측 손실 0/40, 중앙값 10KB 에서 끊김).
 * 구글이 AMP 판본을 주면 og 태그가 없다 (실측 3/40) → canonical 로 한 번만 더 간다.
 */
export async function fetchMeta(url, { timeout = 8000, cap = 1.5e6, follow = true } = {}) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'accept-language': 'ko-KR,ko;q=0.9' },
    signal: AbortSignal.timeout(timeout),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const type = res.headers.get('content-type') ?? ''
  if (type && !/html|xml/i.test(type)) { res.body?.cancel(); throw new Error(`not html: ${type}`) }
  const chunks = []
  let size = 0
  for await (const c of res.body) {
    chunks.push(c)
    size += c.length
    if (size >= cap || Buffer.from(c.buffer, c.byteOffset, c.length).includes('</head>')) break
  }
  const meta = { link: res.url, ...parseMeta(decodeHtml(Buffer.concat(chunks, Math.min(size, cap)), type), res.url) }
  if (follow && !meta.image && !meta.desc && meta.canonical && meta.canonical !== res.url) {
    return fetchMeta(meta.canonical, { timeout, cap, follow: false }).catch(() => meta)
  }
  return meta
}

// ─────────────────────────────────────────── 동시성·운영

/** 동시 n 개로 fn 을 돌린다. 결과는 Promise.allSettled 모양 — 하나가 터져도 나머지를 잃지 않는다. */
export async function pool(list, n, fn) {
  const out = new Array(list.length)
  let next = 0
  const worker = async () => {
    while (next < list.length) {
      const i = next++
      try { out[i] = { status: 'fulfilled', value: await fn(list[i], i) } } catch (reason) { out[i] = { status: 'rejected', reason } }
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, worker))
  return out
}

/** 이전 회차의 link·image·desc 를 url 기준으로 옮겨 싣는다. 아직 image 를 못 정한 항목만 돌려준다. */
export function carryOver(items, prevItems) {
  const old = new Map(prevItems.map((p) => [normUrl(p.url), p]))
  return items.filter((it) => {
    const p = old.get(normUrl(it.url))
    for (const f of ['link', 'image', 'desc']) if (p?.[f] !== undefined && it[f] === undefined) it[f] = p[f]
    return it.image === undefined
  })
}

/**
 * 미리보기 채우기. 던지지 않는다. items 를 직접 고친다.
 *   link  언론사 원문 주소 (구글을 못 풀면 없음 → 다음 회차 재시도)
 *   image og:image. '' = 찾아봤는데 없음·실패 (재시도 안 함)
 * 구글 GET 은 회차당 cap 건까지, 약 1초 간격. 실측: 연속 40건(+POST 41건)은 통과, 그 직후 /articles/ 가 429.
 */
// ponytail: 첫 1주(~2026-09-18)는 회차당 10건·약 2초 간격으로 조심해서 시작한다. Actions 로그에 429 가 없으면 cap 20·gap 800~1200ms 로 올린다
export async function enrich(items, prevItems = [], { cap = 10, conc = 4, budgetMs = 120e3, gap = () => 1800 + Math.random() * 400 } = {}) {
  const t0 = Date.now()
  const over = () => Date.now() - t0 > budgetMs
  const todo = carryOver(items, prevItems).slice(0, cap)
  let fail = 0
  try {
    // 1) 서명 — 구글에는 순차로. 429·동의화면·연속 3회 실패면 이번 회차는 접는다.
    const sigs = []
    let streak = 0
    for (const it of todo) {
      if (it.link) continue
      if (!isRedirect(it.url)) { it.link = it.url; continue }
      if (over()) break
      try { sigs.push([it, await googleSig(it.url)]); streak = 0 } catch (e) {
        fail += 1
        console.warn(`  ! 구글 서명: ${e.message}`)
        if (/429|consent/.test(e.message) || ++streak >= 3) break
      }
      await sleep(gap())
    }
    // 2) 원문 주소 — 서명 10개씩 POST 한 번
    for (let i = 0; i < sigs.length; i += 10) {
      const chunk = sigs.slice(i, i + 10)
      try {
        (await googleResolve(chunk.map(([, s]) => s))).forEach((link, k) => { if (link) chunk[k][0].link = link; else fail += 1 })
      } catch (e) { fail += chunk.length; console.warn(`  ! 구글 주소: ${e.message}`); break }
      await sleep(gap())
    }
    // 3) 메타 — 언론사는 제각각이라 동시에 conc 개
    const ready = todo.filter((it) => it.link && it.image === undefined)
    const res = await pool(ready, conc, async (it) => { if (over()) throw new Error('budget'); return fetchMeta(it.link) })
    res.forEach((r, k) => {
      const it = ready[k]
      if (r.status === 'fulfilled') { it.link = r.value.link; it.image = r.value.image; it.desc = r.value.desc }
      else if (r.reason?.message !== 'budget') { it.image = ''; it.desc = ''; fail += 1 }
    })
  } catch (e) {
    console.warn(`  ! 미리보기 중단: ${e.message}`)     // 여기까지 채운 것만 남는다
  }
  const c = (f) => todo.filter((it) => it[f]).length
  const line = `미리보기 대상 ${todo.length} · 링크 ${c('link')} · 그림 ${c('image')} · 설명 ${c('desc')} · 실패 ${fail} · ${((Date.now() - t0) / 1000).toFixed(1)}s`
  console.log(line)
  return line
}

// ─────────────────────────────────────────── 수집

async function get(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res
}

async function fromGoogle(q, days) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${q} when:${days}d`)}&hl=ko&gl=KR&ceid=KR:ko`
  const xml = await (await get(url, { headers: { 'user-agent': 'Mozilla/5.0' } })).text()
  return parseRss(xml)
}

async function fromNaver(q) {
  if (!NAVER) return []
  const url = `${NAVER.url}?query=${encodeURIComponent(q)}&display=20&sort=date`
  const { items = [] } = await (await get(url, { headers: NAVER.headers })).json()
  return items.map((it) => ({
    title: decode(it.title),
    url: it.originallink || it.link,
    press: '',
    summary: decode(it.description),
    published: it.pubDate,
  }))
}

async function main() {
  const cfg = JSON.parse(readFileSync(TOPICS, 'utf8'))
  const now = Date.now()
  const maxAge = (cfg.maxAgeDays ?? 3) * 24 * 3600e3
  const pool = []

  // 공통 제외어는 토픽별 not 에 합쳐서 한 곳에서만 관리한다.
  const topics = cfg.topics.map((t) => ({ ...t, not: [...(t.not ?? []), ...(cfg.blockWords ?? [])] }))
  const blocked = (press) => (cfg.blockPress ?? []).some((p) => press.includes(p))
  let tries = 0
  let fails = 0

  for (const topic of cfg.topics) {
    for (const q of topic.q) {
      for (const [src, fn] of [['google', (x) => fromGoogle(x, cfg.searchDays ?? 7)], ['naver', fromNaver]]) {
        if (src === 'naver' && !NAVER) continue
        tries += 1
        try {
          for (const raw of await fn(q)) {
            const at = Date.parse(raw.published)
            if (!raw.title || !raw.url || !Number.isFinite(at) || now - at > maxAge) continue
            const press = pressOf(raw.url, raw.press)
            if (blocked(press)) continue
            if (tierOf(press) === 0) continue          // 매체명이 도메인 형태 = 출처 불명
            if (isProductAd(raw.title)) continue       // 보험사 상품 광고·기업홍보
            pool.push({ ...raw, at, press, topics: [], score: 0 })
          }
        } catch (e) {
          fails += 1
          console.warn(`  ! ${src} "${q}" 실패: ${e.message}`)
        }
      }
    }
  }
  console.log(`수집 ${pool.length}건 (요청 ${tries}회 중 ${fails}회 실패)`)

  const items = dedupe(pool)
  console.log(`중복 제거 후 ${items.length}건`)

  // 토픽 매칭 — 한 기사가 여러 토픽에 걸릴 수 있다.
  for (const it of items) {
    const text = `${it.title} ${it.summary}`
    const age = (now - it.at) / 3600e3
    for (const topic of topics) {
      const s = matchTopic(topic, text, age)
      if (s === null) continue
      it.topics.push(topic.id)
      it.score = Math.max(it.score, s)
    }
  }

  // 토픽별 상위 N건만 남긴다.
  const keep = new Set()
  for (const topic of topics) {
    items
      .filter((it) => it.topics.includes(topic.id))
      .sort((a, b) => b.score - a.score || b.at - a.at)
      .slice(0, cfg.perTopic ?? 8)
      .forEach((it) => keep.add(it))
  }

  // 「이번에 새로 들어온 기사」를 표시하려면 이전 회차 기록이 필요하다.
  const nowIso = new Date().toISOString()
  const seenBefore = new Map(
    (existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')).items ?? [] : [])
      .map((i) => [normUrl(i.url), i.firstSeenAt ?? i.publishedAt])
  )

  const out = {
    updatedAt: nowIso,
    naver: !!NAVER,
    topics: cfg.topics.map((t) => ({
      id: t.id,
      label: t.label,
      kind: t.kind,
      count: [...keep].filter((it) => it.topics.includes(t.id)).length,
    })),
    items: [...keep]
      .sort((a, b) => b.at - a.at)
      .map(({ title, url, press, summary, at, others, topics, score }) => ({
        title, url, press, summary: summary.slice(0, 160), others, topics, score,
        tier: tierOf(press),
        publishedAt: new Date(at).toISOString(),
        firstSeenAt: seenBefore.get(normUrl(url)) ?? nowIso,   // 언제 처음 들어왔는지
      })),
  }

  const prev2 = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null
  const prev = prev2

  // ── 안전장치. 구글이 데이터센터 IP를 막으면 수집이 통째로 비는데,
  //    그걸 그대로 쓰면 멀쩡하던 페이지가 빈 화면이 된다. 옛 기사가 빈 화면보다 낫다.
  //    실패로 종료해서 Actions 를 빨갛게 만든다 — 지속되면 사람이 알아채야 한다.
  const bad =
    fails > tries / 2 ? `요청 ${tries}회 중 ${fails}회 실패`
    : !out.items.length && prev?.items?.length ? '수집 0건'
    : null
  if (bad && prev) {
    console.error(`
⚠ ${bad} — 기존 파일을 유지한다. news.json 은 그대로 둔다.`)
    process.exitCode = 1
    return
  }
  // ponytail: 일부 토픽만 실패해 결과가 홀쭉해지는 경우는 안 막는다.
  //           조용한 뉴스 날과 구분이 안 돼서, 막으면 오탐이 더 잦다.

  // 미리보기 — 이전 회차 값을 이월하고 새 기사만 찾는다. 여기서 무슨 일이 나도 수집 결과는 그대로 쓴다.
  try { await enrich(out.items, prev?.items ?? [], process.env.PREVIEW_CAP ? { cap: +process.env.PREVIEW_CAP, budgetMs: 360e3 } : {}) } catch (e) { console.warn(`  ! 미리보기 건너뜀: ${e.message}`) }
  const body = JSON.stringify(out, null, 1)

  // 내용이 그대로면 커밋이 생기지 않게 파일을 건드리지 않는다.
  if (prev && JSON.stringify(prev.items) === JSON.stringify(out.items)) {
    console.log('변경 없음 — 파일 유지')
    return
  }
  writeFileSync(OUT, body)
  console.log(`기록 ${out.items.length}건 → ${OUT}`)
  if (!NAVER) console.log('(네이버 키 없음 — 구글 뉴스만 수집)')
}

// ─────────────────────────────────────────── 자체검사

function test() {
  assert.equal(decode('<![CDATA[<b>실손</b>&amp;간병]]>'), '실손&간병')
  assert.equal(decode('&#39;5세대&#39;  실손'), "'5세대' 실손")

  const rss = `<rss><channel>
    <item><title>5세대 실손 개편안 발표 - 한국경제</title>
      <link>https://news.google.com/x?a=1</link>
      <pubDate>Mon, 31 Aug 2026 01:00:00 GMT</pubDate>
      <source url="https://hankyung.com">한국경제</source></item>
    <item><title>도수치료 관리급여 시행 - 매일경제</title>
      <link>https://news.google.com/y</link>
      <pubDate>Mon, 31 Aug 2026 02:00:00 GMT</pubDate>
      <source url="https://mk.co.kr">매일경제</source></item>
  </channel></rss>`
  const parsed = parseRss(rss)
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0].title, '5세대 실손 개편안 발표')   // " - 언론사" 제거
  assert.equal(parsed[0].press, '한국경제')

  assert.equal(normUrl('https://www.mk.co.kr/news/1/?utm=a'), 'mk.co.kr/news/1')
  assert.equal(normUrl('http://mk.co.kr/news/1'), 'mk.co.kr/news/1')  // 같은 기사로 묶여야 한다
  assert.equal(pressOf('https://www.insnews.co.kr/a/1'), '한국보험신문')
  assert.equal(pressOf('https://x.com/a', '연합뉴스'), '연합뉴스')

  const T = { id: 'silson', must: ['실손'], any: ['5세대', '전환'], not: ['드라마'] }
  assert.equal(matchTopic(T, '자동차보험 인상', 1), null)              // must 불충족
  assert.equal(matchTopic(T, '실손 드라마 5세대', 1), null)            // not 걸림
  assert.equal(matchTopic(T, '실손보험 손해율 상승', 1), null)         // any 0히트
  assert.equal(matchTopic(T, '5세대 실손 전환', 1), 2 * 2 + 8)         // 2히트 + 24h 이내
  assert.equal(matchTopic(T, '5세대 실손 전환', 30), 2 * 2 + 5)        // 48h 이내
  assert.equal(matchTopic(T, '5세대 실손 전환', 99), 2 * 2)            // 오래됨 → 보너스 없음

  // must 의 `|` — 항목 안은 OR, 항목끼리는 AND
  // 보험사 상품 광고 배제 — 실측 41건에서 뽑은 대표 유형
  assert.ok(isProductAd('삼성생명, 치료 횟수별 보장 강화한 ‘가족대표건강보험 Plus+’ 출시'))
  assert.ok(isProductAd('IM라이프, 치매간병보험 출시…연금 넘어 노년기 보장까지'))   // 대소문자 무시
  assert.ok(isProductAd('9월 손보 신상품 ‘보장 공백’ 파고든다'))              // 실명 없어도
  assert.ok(!isProductAd('4세대 실손보험료 최대 300% 할증? 5세대 출시 후 달라진 점'))     // 정보성은 살린다
  assert.ok(!isProductAd('[단독] 메리츠화재 ‘질문톡’서 보상 답변 오류…정정 완료')) // 부정 보도는 살린다

  const C = { must: ['암|항암|종양', '비급여|치료비|부담'], any: [], not: [] }
  assert.ok(matchTopic(C, '비급여 항암치료 부담 커져', 1) !== null)
  assert.ok(matchTopic(C, '표적항암제 치료비 급등', 1) !== null)
  assert.equal(matchTopic(C, '35개 주요수술 진료비 10조원 돌파', 1), null)   // 암 계열 없음 → 탈락
  assert.equal(matchTopic(C, '암 신약 임상 성공', 1), null)                  // 비용 계열 없음 → 탈락

  assert.deepEqual(tokens('5세대 실손, 개편안 발표!'), ['5세대', '실손', '개편안', '발표'])
  assert.ok(sameStory('5세대 실손 개편안 발표', '5세대 실손 개편안 발표 확정'))   // 뒷말만 붙은 경우
  assert.ok(!sameStory('5세대 실손 개편안 발표', '자동차보험 손해율 악화 지속'))
  assert.ok(!sameStory('보험료 인상', '자동차 보험료 인상 확정 발표'))          // 어절 2개 → 완전일치만

  const merged = dedupe([
    { title: '5세대 실손 개편안 발표', url: 'https://news.google.com/rss/articles/CBM0', press: '매일경제', summary: '' },
    { title: '5세대 실손 개편안 발표 확정', url: 'https://hankyung.com/n/9', press: '', summary: '금융위는…' },
    { title: '5세대 실손 개편안 발표', url: 'https://news.google.com/rss/articles/CBM0', press: '', summary: '' },  // 같은 링크
    { title: '자동차보험 손해율 악화 지속', url: 'https://yna.co.kr/n/3', press: '연합뉴스', summary: '' },
  ])
  assert.equal(merged.length, 2)
  assert.equal(merged[0].others, 2)
  assert.equal(merged[0].summary, '금융위는…')          // 비어 있던 대표 기사에 스니펫이 채워진다
  assert.equal(merged[0].url, 'https://hankyung.com/n/9') // 구글 중계 주소 → 언론사 원문 주소로 승격
  assert.equal(merged[1].others, 0)

  console.log('자체검사 통과')
}

/** 미리보기 자체검사 — 네트워크 없음 */
async function previewTest() {
  // decode — collect.mjs 의 기존 검사 두 개가 그대로 통과해야 교체할 수 있다
  assert.equal(decode('<![CDATA[<b>실손</b>&amp;간병]]>'), '실손&간병')
  assert.equal(decode('&#39;5세대&#39;  실손'), "'5세대' 실손")
  assert.equal(decode('A&#x27;B &middot; C&hellip; &ldquo;D&rdquo; &#128512; &bogus;'), "A'B · C… “D” 😀 &bogus;")
  assert.equal(decode('&#0; &#x110000;'), '&#0; &#x110000;')          // 잘못된 코드포인트는 건드리지 않는다

  // parseMeta — 속성 순서·작은따옴표·따옴표 안의 > ·첫 값 우선·엔티티
  const base = 'https://www.x.co.kr/news/articleView.html?idxno=1'
  const m = parseMeta(`<head>
    <meta content="https://img.x.co.kr/a.jpg" property="og:image">
    <meta property='og:image' content='https://img.x.co.kr/second.jpg'>
    <meta name="twitter:image" content="/tw.jpg">
    <meta property="og:description" content="수술비 > 치료비? &quot;5세대&quot; 실손&amp;간병 &#x2F; 정리">
    <link rel="canonical" href="/news/articleView.html?idxno=1&amp;x=2">
  </head>`, base)
  assert.equal(m.image, 'https://img.x.co.kr/a.jpg')
  assert.equal(m.desc, '수술비 > 치료비? "5세대" 실손&간병 / 정리')
  assert.equal(m.canonical, 'https://www.x.co.kr/news/articleView.html?idxno=1&x=2')
  assert.equal(parseMeta('<meta property="og:description" content="&amp;lt;표=CEO&amp;gt;국감 A&amp;amp;B">', base).desc, '<표=CEO>국감 A&B')  // 이중 이스케이프

  // 상대·프로토콜 상대·한글 파일명·위험 스킴·로고
  assert.equal(parseMeta('<meta name="twitter:image" content="/data/photo/1.jpg">', base).image, 'https://www.x.co.kr/data/photo/1.jpg')
  assert.equal(parseMeta('<meta property="og:image" content="//cdn.x.kr/p.png">', base).image, 'https://cdn.x.kr/p.png')
  assert.equal(parseMeta('<meta property="og:image" content="https://x.kr/사진 1.jpg">', base).image, 'https://x.kr/%EC%82%AC%EC%A7%84%201.jpg')
  assert.equal(parseMeta('<meta property="og:image" content="javascript:alert(1)">', base).image, '')
  assert.equal(parseMeta('<meta property="og:image" content="/img/d_logo.jpg">', base).image, '')
  assert.equal(parseMeta('<meta property="og:image" content="https://logo.x.kr/news/1.jpg">', base).image, 'https://logo.x.kr/news/1.jpg')  // 호스트명은 안 본다
  assert.deepEqual(parseMeta('<title>메타 없음</title>', base), { image: '', desc: '', canonical: '' })
  assert.equal(parseMeta('<meta name="description" content="요약만">', base).desc, '요약만')          // og 없으면 일반 description

  // 문자셋 — EUC-KR 바이트: 한 = C7 D1, 글 = B1 DB
  const euc = Buffer.concat([Buffer.from('<meta charset="euc-kr"><meta property="og:description" content="'), Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]), Buffer.from('">')])
  assert.equal(parseMeta(decodeHtml(euc, 'text/html'), base).desc, '한글')                     // meta 의 charset
  assert.equal(decodeHtml(Buffer.from([0xc7, 0xd1]), 'text/html; charset=EUC-KR'), '한')         // 헤더의 charset
  assert.equal(decodeHtml(Buffer.from([0xc7, 0xd1]), 'text/html; charset=ks_c_5601-1987'), '한')
  assert.equal(decodeHtml(Buffer.from([0xc7, 0xd1]), 'text/html; charset=cp949'), '한')          // WHATWG 라벨에 없는 별칭
  assert.equal(decodeHtml(Buffer.from('한', 'utf8'), 'text/html; charset=bogus'), '한')          // 모르는 라벨 → utf-8
  assert.equal(charsetOf('text/html', Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=euc-kr">')), 'euc-kr')
  assert.equal(charsetOf('text/html; charset=utf-8', Buffer.from('<meta charset="euc-kr">')), 'utf-8')   // 헤더가 이긴다

  // fetchMeta 전체 경로 — 가짜 fetch: AMP(메타 없음) → canonical 한 번 따라가기, 거기는 EUC-KR 헤더
  const pages = {
    'https://x.kr/amp/1': ['text/html', Buffer.from('<html><head><link rel="canonical" href="/news/1"></head>')],
    'https://x.kr/news/1': ['text/html; charset=euc-kr', Buffer.concat([Buffer.from('<head><meta property="og:image" content="/p/1.jpg"><meta property="og:description" content="'), Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]), Buffer.from('"></head><body>')])],
    'https://x.kr/amp/404': ['text/html', Buffer.from('<head><link rel="canonical" href="/gone"></head>')],
  }
  const realFetch = globalThis.fetch
  const hits = []
  globalThis.fetch = async (u) => {
    hits.push(u)
    if (!pages[u]) return new Response('no', { status: 404 })
    const r = new Response(pages[u][1], { headers: { 'content-type': pages[u][0] } })
    Object.defineProperty(r, 'url', { value: u })
    return r
  }
  try {
    assert.deepEqual(await fetchMeta('https://x.kr/amp/1'), { link: 'https://x.kr/news/1', image: 'https://x.kr/p/1.jpg', desc: '한글', canonical: '' })
    assert.equal((await fetchMeta('https://x.kr/amp/404')).link, 'https://x.kr/amp/404')   // canonical 이 죽었으면 원래 결과
    assert.equal(hits.length, 4)
  } finally { globalThis.fetch = realFetch }

  // 구글 — 서명 추출, 요청 본문, 응답 해석 (= 이스케이프 포함)
  assert.deepEqual(parseSig('<div data-n-a-id="CBMi" data-n-a-ts="1789088568" data-n-a-sg="Ae5Wzi8uAdQU"></div>'), { sg: 'Ae5Wzi8uAdQU', ts: 1789088568 })
  assert.equal(parseSig('<html>consent</html>'), null)
  const req = JSON.parse(decodeURIComponent(garturlBody([{ id: 'CBMiA', ts: 1, sg: 'S1' }, { id: 'CBMiB', ts: 2, sg: 'S2' }]).slice(6)))[0]
  assert.deepEqual([req.length, req[1][0], req[1][3]], [2, 'Fbv4je', '2'])
  assert.deepEqual(JSON.parse(req[1][1]).slice(2), ['CBMiB', 2, 'S2'])
  const wrb = (inner, idx) => ['wrb.fr', 'Fbv4je', inner, null, null, null, idx]
  const text = ")]}'\n\n" + JSON.stringify([
    wrb('["garturlres","http://www.x.com/news/articleViewAmp.html?idxno\\u003d851558",1]', '2'),
    ['wrb.fr', 'Fbv4je', null, null, null, [3], '1'],          // 실패한 칸
    ['di', 13], ['af.httprm', 12, '790', 1],
  ])
  assert.deepEqual(parseGarturl(text, 2), [null, 'http://www.x.com/news/articleViewAmp.html?idxno=851558'])
  assert.deepEqual(parseGarturl(")]}'\n\n" + JSON.stringify([wrb('["garturlres","https://a.kr/1",1]', 'generic')]), 1), ['https://a.kr/1'])

  // pool — 동시 상한·순서 보존·하나 실패해도 나머지 유지
  let live = 0
  let peak = 0
  const got = await pool([30, 10, 20, 0, 5], 2, async (ms, i) => {
    live += 1; peak = Math.max(peak, live); await sleep(ms); live -= 1
    if (i === 3) throw new Error('boom')
    return i
  })
  assert.equal(peak, 2)
  assert.deepEqual(got.map((r) => (r.status === 'fulfilled' ? r.value : r.reason.message)), [0, 1, 2, 'boom', 4])

  // carryOver — 이전 값 보존, 못 끝낸 항목만 다시
  const g = (x) => `https://news.google.com/rss/articles/${x}?oc=5`
  const prev = [
    { url: g('A'), link: 'https://a.kr/1', image: 'https://a.kr/1.jpg', desc: '가' },
    { url: g('B'), link: 'https://b.kr/1' },                          // 링크만 풀고 메타 전에 끝난 회차
    { url: g('C'), link: 'https://c.kr/1', image: '', desc: '' },     // 확정 실패 — 다시 안 찾는다
  ]
  const cur = ['A', 'B', 'C', 'D'].map((x) => ({ url: g(x) }))
  assert.deepEqual(carryOver(cur, prev).map((t) => t.url.at(-6)), ['B', 'D'])
  assert.deepEqual([cur[0].image, cur[1].link, cur[1].image, cur[2].image], ['https://a.kr/1.jpg', 'https://b.kr/1', undefined, ''])

  // enrich — 전부 이월된 경우 아무 요청도 안 하고 끝난다
  const cur2 = [{ url: g('A') }, { url: g('C') }]
  assert.match(await enrich(cur2, prev), /대상 0 /)
  assert.equal(cur2[0].desc, '가')

  console.log('미리보기 자체검사 통과')
}

if (process.argv.includes('--test')) { test(); await previewTest() }
else await main()
