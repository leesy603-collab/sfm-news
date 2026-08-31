#!/usr/bin/env node
// 영업이슈 뉴스 수집기 — 구글 뉴스 RSS + 네이버 검색 API → docs/news.json
// 의존성 없음. Node 20+ 내장 fetch 사용.
//
//   node collect.mjs          실수집
//   node collect.mjs --test   네트워크 없이 파싱·중복제거·매칭 자체검사

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const ROOT = dirname(fileURLToPath(import.meta.url))
const OUT = join(ROOT, 'docs', 'news.json')

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

// ─────────────────────────────────────────── 순수 함수 (테스트 대상)

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }

/** CDATA·HTML 태그·엔티티를 걷어내고 평문으로 만든다. */
export function decode(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#?\w+);/g, (m, k) => ENT[k] ?? (k[0] === '#' ? String.fromCharCode(+k.slice(1)) : m))
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
    return { title, url: tag(s, 'link'), press, summary: '', published: tag(s, 'pubDate') }
  })
}

/** 제목을 비교용 어절로 쪼갠다. 한 글자짜리는 버린다. */
export function tokens(title) {
  return decode(title).toLowerCase().split(/[^가-힣a-z0-9]+/).filter((w) => w.length >= 2)
}

/**
 * 같은 사건을 다룬 기사인지. 짧은 쪽 기준 8할 이상 겹치면 같다고 본다.
 * 앞 N자 비교로는 「…발표」와 「…발표 확정」이 갈라져서 이렇게 한다.
 */
export function sameStory(a, b) {
  const A = new Set(tokens(a))
  const B = new Set(tokens(b))
  const m = Math.min(A.size, B.size)
  if (m < 3) return decode(a) === decode(b)   // 어절이 너무 적으면 오병합 위험이 커서 완전일치만
  let inter = 0
  for (const w of A) if (B.has(w)) inter += 1
  return inter / m >= 0.8
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
export function matchTopic(topic, text, ageHours) {
  const t = text.toLowerCase()
  const has = (w) => t.includes(w.toLowerCase())
  if (!(topic.must ?? []).every(has)) return null
  if ((topic.not ?? []).some(has)) return null
  const hits = (topic.any ?? []).filter(has).length
  if ((topic.any ?? []).length && hits === 0) return null
  return hits * 2 + (ageHours <= 24 ? 3 : 0)
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

// ─────────────────────────────────────────── 수집

async function get(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res
}

async function fromGoogle(q) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:2d')}&hl=ko&gl=KR&ceid=KR:ko`
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
  const cfg = JSON.parse(readFileSync(join(ROOT, 'topics.json'), 'utf8'))
  const now = Date.now()
  const maxAge = (cfg.maxAgeDays ?? 3) * 24 * 3600e3
  const pool = []

  // 공통 제외어는 토픽별 not 에 합쳐서 한 곳에서만 관리한다.
  const topics = cfg.topics.map((t) => ({ ...t, not: [...(t.not ?? []), ...(cfg.blockWords ?? [])] }))
  const blocked = (press) => (cfg.blockPress ?? []).some((p) => press.includes(p))

  for (const topic of cfg.topics) {
    for (const q of topic.q) {
      for (const [src, fn] of [['google', fromGoogle], ['naver', fromNaver]]) {
        try {
          for (const raw of await fn(q)) {
            const at = Date.parse(raw.published)
            if (!raw.title || !raw.url || !Number.isFinite(at) || now - at > maxAge) continue
            const press = pressOf(raw.url, raw.press)
            if (blocked(press)) continue
            pool.push({ ...raw, at, press, topics: [], score: 0 })
          }
        } catch (e) {
          console.warn(`  ! ${src} "${q}" 실패: ${e.message}`)
        }
      }
    }
  }
  console.log(`수집 ${pool.length}건`)

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

  const out = {
    updatedAt: new Date().toISOString(),
    naver: !!NAVER,
    topics: cfg.topics.map((t) => ({
      id: t.id,
      label: t.label,
      kind: t.kind,
      count: [...keep].filter((it) => it.topics.includes(t.id)).length,
    })),
    items: [...keep]
      .sort((a, b) => b.at - a.at)
      .map(({ title, url, press, summary, at, others, topics }) => ({
        title, url, press, summary: summary.slice(0, 160), others, topics,
        publishedAt: new Date(at).toISOString(),
      })),
  }

  // 내용이 그대로면 커밋이 생기지 않게 파일을 건드리지 않는다.
  const body = JSON.stringify(out, null, 1)
  const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null
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
  assert.equal(matchTopic(T, '5세대 실손 전환', 1), 2 * 2 + 3)         // 2히트 + 최신
  assert.equal(matchTopic(T, '5세대 실손 전환', 99), 2 * 2)            // 오래됨 → 보너스 없음

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

if (process.argv.includes('--test')) test()
else await main()
