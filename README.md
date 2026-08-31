# 영업이슈 뉴스

RC·지점장·센터장이 아침조회와 상담에서 쓰는, 영업이슈에 걸린 기사만 모아 보여주는 모바일 웹 한 장.

```
collect.mjs   구글 뉴스 RSS + 네이버 검색 API → 매칭 → docs/news.json
topics.json   ★ 매달 손대는 유일한 파일
docs/         GitHub Pages 가 그대로 서빙
```

의존성 0개. `npm install` 없음. Node 20+ 내장 `fetch` 만 쓴다.

---

## 설치 (최초 1회, 약 20분)

### 1. GitHub 리포 만들기 — 3분
[github.com/new](https://github.com/new) → 이름 `sfm-news` → **Public** → Create.
Pages 무료 호스팅은 public 리포 기준이라 public 으로 만든다.
그래서 **사내 목표·실적·시상액은 이 리포에 절대 넣지 않는다.**

이 폴더를 그대로 올린다.

```bash
cd news-app
git init -b main
git add .
git commit -m "영업이슈 뉴스 초기 구축"
git remote add origin https://github.com/<아이디>/sfm-news.git
git push -u origin main
```

### 2. Pages 켜기 — 1분
리포 **Settings → Pages** → Source `Deploy from a branch` → Branch `main` / 폴더 `/docs` → Save.

몇 분 뒤 링크가 살아난다 → `https://<아이디>.github.io/sfm-news/`
**이 링크 하나만 카톡으로 뿌리면 끝이다.**

### 3. Actions 쓰기 권한 — 1분
**Settings → Actions → General → Workflow permissions** → `Read and write permissions` → Save.
(수집 결과를 봇이 커밋해야 해서 필요하다.)

### 4. 첫 실행 — 1분
**Actions 탭 → `news` → Run workflow.**
녹색이 뜨면 링크를 폰에서 열어 확인한다.

여기까지만 해도 **구글 뉴스만으로 동작한다.** 아래 5번은 선택이다.

### 5. (선택) 네이버 뉴스 붙이기 — 10분
네이버 검색 API 를 붙이면 기사마다 **요약 스니펫**이 붙고, RC 가 실제로 보는 네이버 노출 기준과 맞춰진다.

> ⚠ 네이버 검색 API 는 개발자센터에서 **NAVER API HUB(네이버클라우드)** 로 이관됐다.
> 신규 발급은 HUB 쪽이다. 도메인·헤더가 예전 글과 다르니 옛날 블로그를 따라가지 말 것.

1. [네이버클라우드 플랫폼](https://www.ncloud.com/) 가입 (본인인증 필요)
2. 콘솔 → **NAVER API HUB** → Application 등록 → **Search** 서비스 선택 → 이용 신청
3. 발급된 `Client ID` / `Client Secret` 복사
4. 리포 **Settings → Secrets and variables → Actions → New repository secret** 로 2개 등록

   | Name | Value |
   |---|---|
   | `NAVER_KEY_ID` | Client ID |
   | `NAVER_KEY` | Client Secret |

5. Actions 에서 Run workflow 재실행

무료 한도는 Search API 통합 **월 77.5만 건**. 이 앱은 1회 실행에 20건 남짓 쓰므로 한도 걱정은 없다.

구 개발자센터(`developers.naver.com`) 키를 이미 갖고 있다면 이름만 바꿔 넣으면 그대로 동작한다 —
`NAVER_CLIENT_ID` / `NAVER_CLIENT_SECRET`. (구 방식은 2027-06-30 까지 유예)

---

## 갱신 주기

| KST | 용도 |
|---|---|
| 06:40 | 아침조회 전 |
| 10 / 13 / 16 / 19시 | 장중 |

⚠ GitHub Actions 스케줄은 **정각 보장이 아니다.** 부하에 따라 수 분~수십 분 밀린다.
아침조회가 7시 정각이면 `.github/workflows/news.yml` 의 `40 21 * * *` 을 더 앞당긴다.

---

## 매달 하는 일 — 이슈 갈아끼우기

Claude Code 에서 한 마디:

```
/news-refresh 9월
```

그 달 영업방향 자료를 읽고 `topics.json` 의 이슈를 새로 뽑아 넣은 뒤,
수집을 돌려 오탐을 잡고 커밋까지 한다. (`news-topics` → 수집 → `news-qa` 순서)

손으로 고칠 때는 `topics.json` 만 건드린다.

```jsonc
{
  "id": "silson",              // 영문 소문자 식별자
  "label": "실손 5세대",        // 화면에 뜨는 이름
  "kind": "상시테마",           // 또는 "월간이슈"
  "q": ["5세대 실손보험"],      // 검색어 (구글·네이버에 그대로 던진다)
  "must": ["실손"],            // 전부 있어야 통과 (AND)
  "any": ["5세대", "전환"],     // 최소 1개는 있어야 통과. 많이 맞을수록 상위
  "not": []                   // 하나라도 있으면 탈락
}
```

`blockWords` / `blockPress` 는 **모든 토픽에 공통 적용**된다. 토픽마다 같은 제외어를 반복해 쓰지 않는다.

---

## 로컬 확인

```bash
node collect.mjs --test    # 파싱·중복제거·매칭 자체검사 (네트워크 불필요)
node collect.mjs           # 실수집 → docs/news.json
python -m http.server 8080 -d docs
```

---

## 컴플라이언스

- 기사 **제목·짧은 발췌·언론사·원문 링크**만 노출한다. 본문을 재배포하지 않는다.
- **AI가 문장을 짓지 않는다.** 요약은 언론사가 준 스니펫 그대로다. 상품 권유·단정 표현이 자동 생성될 여지를 구조에서 없앴다.
- 포털 재게시(다음·네이트·줌)는 원출처가 불명해서 제외한다.
- 사건사고·투자권유·광고성 기사는 `blockWords` 로 뺀다.
- 리포가 public 이다. **사내 수치·고객 정보는 어떤 파일에도 넣지 않는다.**
