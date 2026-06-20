from __future__ import annotations

import html
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import List
from google import genai
from google.genai import types
import pandas as pd
import requests

try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parent / ".env", override=False)
except Exception:
    pass

# Windows consoles default to cp949 and raise UnicodeEncodeError on the emoji
# status prints below. The Node backend sets PYTHONUTF8=1, but harden direct runs.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:
        pass

_gemini_client = None


def get_gemini_client():
    global _gemini_client
    if _gemini_client is None:
        _gemini_client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
    return _gemini_client


KST = timezone(timedelta(hours=9))

def evaluate_stock_news(title: str, content: str) -> dict:
    prompt = f"""
    당신은 냉철한 퀀트 투자 및 금융 데이터 분석가입니다. 
    다음 주식 관련 기사를 읽고, 해당 기업의 주가에 미칠 단기적 영향을 평가해주세요.

    [기사 정보]
    - 기사 제목: {title}
    - 기사 내용: {content}

    [출력 형식]
    반드시 다른 설명 없이 아래의 JSON 형식으로만 답변해 주세요.
    {{
        "impact_score": 0, // -10(매우 강력한 악재)부터 10(매우 강력한 호재)까지의 정수
        "sentiment": "", // "Bullish"(호재), "Bearish"(악재), "Neutral"(중립) 중 택 1
        "summary": "", // 기사의 핵심 내용을 1문장으로 요약
        "trading_insight": "" // 이 기사를 읽은 투자자가 취해야 할 포지션이나 리스크 요인 (1~2문장)
    }}
    """
    
    try:
        # 최신 모델명(gemini-2.5-flash)과 새로운 호출 규격 적용
        response = get_gemini_client().models.generate_content(
            model='gemini-2.5-flash',
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json"
            )
        )
        return json.loads(response.text)
    except Exception as e:
        print(f"API 평가 중 에러 발생: {e}")
        return {}

def summarize_titles_and_descriptions(news_list: list[dict]) -> str:
    summaries = []
    for idx, news in enumerate(news_list, start=1):
        title = news.get("title", "")
        description = news.get("description", "")
        summaries.append(f"{idx}. 제목: {title}\n요약: {description}")

    return "\n\n".join(summaries)


def normalize_group_evaluation(value: dict) -> dict:
    """Enforce the numeric ranges and sentiment rule promised by the prompt."""
    normalized = dict(value)
    try:
        combined = max(0.0, min(float(normalized.get("final_combined_score", 0.0)), 100.0))
    except (TypeError, ValueError):
        combined = 0.0
    try:
        news_score = float(normalized.get("news_overall_score", 0.0))
    except (TypeError, ValueError):
        news_score = 0.0
    if 10.0 < news_score <= 100.0:
        news_score /= 10.0

    normalized["final_combined_score"] = round(combined, 2)
    normalized["news_overall_score"] = round(max(0.0, min(news_score, 10.0)), 2)
    normalized["final_sentiment"] = "Bullish" if combined >= 70 else "Neutral" if combined >= 60 else "Bearish"
    return normalized


def evaluate_stock_news_group(
    ticker: str,
    company_name: str,
    aggregated_content: str,
    tech_info: dict | None = None,
) -> dict:
    tech_lines = []
    for key, value in (tech_info or {}).items():
        if key not in {"ticker", "company_name", "종목코드", "종목명"}:
            tech_lines.append(f"- {key}: {value}")
    tech_text = "\n".join(tech_lines) or "- 사용 가능한 기술 데이터 없음"

    prompt = f"""
    당신은 냉철한 퀀트 투자 및 금융 데이터 분석가입니다.
    다음은 {company_name}({ticker}) 관련 최신 뉴스와 기술적 지표/모델 예측입니다.

    [기술적 지표 및 모델 예측]
    {tech_text}

    [뉴스 목록]
    {aggregated_content}

    기술 데이터와 뉴스를 종합해 아래 JSON 객체만 반환하세요.
    final_combined_score가 70 이상이면 Bullish, 60 이상 70 미만이면 Neutral,
    60 미만이면 Bearish로 final_sentiment를 정하세요.
    {{
        "ticker": "{ticker}",
        "news_overall_score": 0.0,
        "news_sentiment_tally": "",
        "final_sentiment": "Neutral",
        "final_combined_score": 0.0,
        "summary": "",
        "trading_insight": ""
    }}
    """

    try:
        response = get_gemini_client().models.generate_content(
            model='gemini-2.5-flash',
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json"
            )
        )
        return normalize_group_evaluation(json.loads(response.text))
    except Exception as e:
        print(f"API 평가 중 에러 발생: {e}")
        return {}


def run_stock_analysis_pipeline(
    stocks_list: list,
    days: int = 1,
    max_news: int = 20,
    fetch_body: bool = False,
):
    print("📰 1단계: 네이버 뉴스 크롤링 시작...")
    stock_map = {
        str(stock.get("ticker", "")).zfill(6): stock
        for stock in stocks_list
    }
    crawled_data = crawl_stocks(
        stocks=stocks_list,
        days=days,
        max_news=max_news,
        fetch_body=fetch_body,
    )

    final_results = {}

    print("\n🤖 2단계: Gemini API 종목 단위 분석 시작...")
    for ticker, stock in stock_map.items():
        news_list = crawled_data.get(ticker, [])
        company_name = str(stock.get("company_name", ""))
        tech_info = stock.get("tech_data", {})
        print(f"\n[{ticker}] 기술 데이터와 기사 요약 결합 중...")
        aggregated_content = summarize_titles_and_descriptions(news_list)

        if not aggregated_content:
            aggregated_content = "관련 최신 뉴스가 없습니다. 기술 데이터만으로 평가하세요."

        print(f" -> {ticker}에 대해 Gemini API 한 번 호출")
        evaluation = evaluate_stock_news_group(
            ticker=ticker,
            company_name=company_name,
            aggregated_content=aggregated_content,
            tech_info=tech_info,
        )

        if evaluation:
            final_results[ticker] = {
                "ticker": ticker,
                "company_name": company_name,
                "news_count": len(news_list),
                "evaluation": evaluation,
                "news": news_list,
                "tech_data": tech_info,
            }
            print(
                f"    [결과] 감성: {evaluation.get('final_sentiment')}, "
                f"종합 점수: {evaluation.get('final_combined_score')}점"
            )
            print("    [Gemini 전체 출력]")
            print(json.dumps(evaluation, ensure_ascii=False, indent=2))
        else:
            print(f"    [WARN] {ticker}에 대한 Gemini 평가 실패")

    return final_results

def clean_html(text: str | None) -> str:
    if not text:
        return ""
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def safe_domain(url: str | None) -> str:
    if not url:
        return ""
    try:
        from urllib.parse import urlparse

        return urlparse(url).netloc.replace("www.", "")
    except Exception:
        return ""


def parse_naver_pubdate(pub_date: str) -> datetime | None:
    try:
        dt = parsedate_to_datetime(pub_date)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=KST)
        return dt.astimezone(KST)
    except Exception:
        return None


def fetch_naver_news_once(query: str, display: int = 30, start: int = 1, timeout: int = 10) -> List[dict]:
    client_id = os.getenv("NAVER_CLIENT_ID")
    client_secret = os.getenv("NAVER_CLIENT_SECRET")

    if not client_id or not client_secret:
        raise EnvironmentError("NAVER_CLIENT_ID, NAVER_CLIENT_SECRET 환경변수를 설정해야 합니다.")

    url = "https://openapi.naver.com/v1/search/news.json"

    headers = {
        "X-Naver-Client-Id": client_id,
        "X-Naver-Client-Secret": client_secret,
    }

    params = {"query": query, "display": min(display, 100), "start": start, "sort": "date"}

    res = requests.get(url, headers=headers, params=params, timeout=timeout)
    res.raise_for_status()

    data = res.json()
    return data.get("items", [])


def fetch_article_body(url: str, timeout: int = 8) -> str:
    if not url:
        return ""

    try:
        import trafilatura
    except Exception:
        return ""

    try:
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (compatible; StockResearchBot/1.0; "
                "+research-purpose)"
            )
        }
        res = requests.get(url, headers=headers, timeout=timeout)
        res.raise_for_status()

        extracted = trafilatura.extract(res.text, include_comments=False, include_tables=False, favor_precision=True)
        return clean_html(extracted or "")
    except Exception:
        return ""


def build_news_queries(company_name: str, ticker: str, custom_query: str | None = None) -> List[str]:
    if custom_query and str(custom_query).strip():
        return [str(custom_query).strip()]

    return [f"{company_name} 주가", f"{company_name} 실적", f"{company_name} 수주 전망"]


def fetch_recent_news_for_stock(
    ticker: str,
    company_name: str,
    custom_query: str | None = None,
    days: int = 3,
    max_news: int = 8,
    display_per_query: int = 30,
    fetch_body: bool = False,
    sleep_sec: float = 0.15,
) -> List[dict]:
    cutoff = datetime.now(KST) - timedelta(days=days)

    queries = build_news_queries(company_name, ticker, custom_query)

    seen = set()
    news_items: List[dict] = []

    for query in queries:
        try:
            raw_items = fetch_naver_news_once(query=query, display=display_per_query, start=1)
        except Exception:
            raw_items = []
            raw_items = []

        time.sleep(sleep_sec)

        for item in raw_items:
            pub_dt = parse_naver_pubdate(item.get("pubDate", ""))
            if pub_dt is None:
                continue
            if pub_dt < cutoff:
                continue

            title = clean_html(item.get("title", ""))
            description = clean_html(item.get("description", ""))
            originallink = item.get("originallink") or ""
            link = item.get("link") or ""
            url = originallink or link

            dedupe_key = (title.lower(), safe_domain(url))
            if dedupe_key in seen:
                continue
            seen.add(dedupe_key)

            body = ""
            if fetch_body:
                body = fetch_article_body(url)
                time.sleep(sleep_sec)

            news_items.append(
                {
                    "ticker": str(ticker).zfill(6),
                    "company_name": company_name,
                    "title": title,
                    "description": description,
                    "body": body[:1800],
                    "pub_date": pub_dt.isoformat(),
                    "url": url,
                    "source": safe_domain(url),
                    "query": query,
                }
            )

    # 최신순 정렬 및 선택
    news_items.sort(key=lambda x: x["pub_date"], reverse=True)
    selected = news_items[:max_news]
    for idx, item in enumerate(selected, start=1):
        item["index"] = idx

    return selected


def crawl_stocks(
    stocks: List[dict],
    days: int = 3,
    max_news: int = 8,
    display_per_query: int = 30,
    fetch_body: bool = False,
    sleep_sec: float = 0.15,
) -> dict:
    """Crawl news for a list of stocks. Each stock is dict with keys 'ticker' and 'company_name' (optionally 'news_query').

    Returns a dict mapping ticker -> list of news items.
    """
    results = {}
    for s in stocks:
        ticker = str(s.get("ticker", "")).zfill(6)
        company_name = s.get("company_name") or s.get("name") or ""
        custom_query = s.get("news_query")
        
        news = fetch_recent_news_for_stock(
            ticker=ticker,
            company_name=company_name,
            custom_query=custom_query,
            days=days,
            max_news=max_news,
            display_per_query=display_per_query,
            fetch_body=fetch_body,
            sleep_sec=sleep_sec,
        )
        results[ticker] = news

    return results


# hard-coded stock helper removed — pass stocks into `crawl_stocks()` instead.


def crawl_stocks_from_kis_top(
    top_n: int = 10,
    days: int = 3,
    max_news: int = 8,
    display_per_query: int = 30,
    fetch_body: bool = False,
    sleep_sec: float = 0.15,
) -> dict:
    """
    main.py의 scan_kospi200()으로 상위 N개 종목을 가져온 뒤
    바로 뉴스 크롤링을 수행합니다.
    
    Returns: dict mapping ticker -> list of news items
    """
    import importlib.util
    import sys
    
    # main.py 동적 import
    main_path = Path(__file__).resolve().parent / "main.py"
    if not main_path.exists():
        raise FileNotFoundError(f"main.py not found at {main_path}")
    
    spec = importlib.util.spec_from_file_location("kis_main_module", main_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Failed to load spec from {main_path}")
    
    main_mod = importlib.util.module_from_spec(spec)
    sys.modules["kis_main_module"] = main_mod
    spec.loader.exec_module(main_mod)
    
    # scan_kospi200 호출
    top_df = main_mod.scan_kospi200(top_n=top_n)
    
    # DataFrame을 stocks 리스트로 변환
    stocks = []
    for _, row in top_df.iterrows():
        stocks.append({
            "ticker": str(row["종목코드"]).zfill(6),
            "company_name": str(row["종목명"])
        })
    
    if not stocks:
        print("[WARN] KIS 상위 종목이 없습니다.")
        return {}
    
    print(f"[INFO] KIS 상위 {len(stocks)}개 종목으로 뉴스 크롤링 시작")
    
    # crawl_stocks 호출
    return crawl_stocks(
        stocks=stocks,
        days=days,
        max_news=max_news,
        display_per_query=display_per_query,
        fetch_body=fetch_body,
        sleep_sec=sleep_sec,
    )


def get_top_kis_stocks(top_n: int = 10) -> List[dict]:
    """main.py의 scan_kospi200()으로 상위 N개 종목을 가져옵니다."""
    import importlib.util
    import sys

    main_path = Path(__file__).resolve().parent / "main.py"
    if not main_path.exists():
        raise FileNotFoundError(f"main.py not found at {main_path}")

    spec = importlib.util.spec_from_file_location("kis_main_module", main_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Failed to load spec from {main_path}")

    main_mod = importlib.util.module_from_spec(spec)
    sys.modules["kis_main_module"] = main_mod
    spec.loader.exec_module(main_mod)

    top_df = main_mod.scan_kospi200(top_n=top_n)
    stocks: List[dict] = []
    for _, row in top_df.iterrows():
        stocks.append({
            "ticker": str(row["종목코드"]).zfill(6),
            "company_name": str(row["종목명"]),
        })

    return stocks


def load_input(input_path: str) -> List[dict]:
    p = Path(input_path)
    if not p.exists():
        raise FileNotFoundError(input_path)

    suffix = p.suffix.lower()
    if suffix in [".xlsx", ".xls"]:
        df = pd.read_excel(p)
    elif suffix == ".json":
        data = json.loads(p.read_text(encoding="utf-8"))
        # accept list of objects
        if isinstance(data, list):
            return data
        df = pd.DataFrame(data)
    else:
        df = pd.read_csv(p)

    # normalize columns
    rename_map = {"종목코드": "ticker", "종목명": "company_name", "회사명": "company_name"}
    for old, new in rename_map.items():
        if old in df.columns and new not in df.columns:
            df = df.rename(columns={old: new})

    if "ticker" not in df.columns or "company_name" not in df.columns:
        raise ValueError("입력 파일에 'ticker'와 'company_name' 컬럼이 필요합니다.")

    rows = []
    for _, r in df.iterrows():
        raw_ticker = r["ticker"]
        if isinstance(raw_ticker, float) and raw_ticker.is_integer():
            raw_ticker = int(raw_ticker)
        ticker = re.sub(r"\D", "", str(raw_ticker)).zfill(6)[-6:]

        tech_data = {}
        for key, value in r.to_dict().items():
            if pd.isna(value):
                value = None
            elif hasattr(value, "item"):
                value = value.item()
            tech_data[str(key)] = value

        rows.append({
            "ticker": ticker,
            "company_name": str(r["company_name"]),
            "news_query": r.get("news_query"),
            "tech_data": tech_data,
        })

    return rows


def resolve_stocks(input_path: str | None, top_n: int) -> List[dict]:
    """Pick the stock universe: an explicit input file (the pipeline's Top-N CSV)
    when given, otherwise the live KIS Top-N scan via main.py."""
    if input_path:
        return load_input(input_path)
    return get_top_kis_stocks(top_n=top_n)


def run_and_save(
    stocks: List[dict],
    output_path: str,
    days: int = 1,
    max_news: int = 20,
    fetch_body: bool = False,
    merge_existing: bool = False,
) -> dict:
    """Crawl + Gemini-analyze the given stocks and write the ticker-keyed result
    to `output_path` (so the Node backend can read it). Returns the dict too."""
    analyzed = run_stock_analysis_pipeline(
        stocks,
        days=days,
        max_news=max_news,
        fetch_body=fetch_body,
    )

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    saved = analyzed
    if merge_existing and out.exists():
        try:
            current = json.loads(out.read_text(encoding="utf-8"))
            saved = {**current, **analyzed} if isinstance(current, dict) else analyzed
        except (OSError, ValueError):
            saved = analyzed
    out.write_text(json.dumps(saved, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n💾 저장: {out} ({len(analyzed)}개 종목)")
    return analyzed


def main_with_args() -> int:
    """CLI: 후보 종목(CSV/JSON/XLSX) 또는 KIS 상위 N개에 대해 네이버 뉴스 + Gemini
    감성분석을 수행하고 ticker-keyed JSON으로 저장한다. 백엔드가 spawn 해서 사용한다."""
    import argparse

    parser = argparse.ArgumentParser(
        description="Crawl Naver news + Gemini sentiment for given (or KIS Top-N) stocks"
    )
    parser.add_argument("--input", default=None, help="ticker/company_name 컬럼이 있는 CSV/JSON/XLSX. 미지정 시 KIS 상위 N개 사용")
    parser.add_argument("--output", default="outputs/news_gemini_result.json", help="결과 JSON 경로")
    parser.add_argument("--top-n", type=int, default=10, help="--input 없을 때 KIS 상위 종목 수")
    parser.add_argument("--ticker", default=None, help="입력 목록에서 이 종목코드만 분석")
    parser.add_argument("--days", type=int, default=1, help="최근 며칠 뉴스 포함")
    parser.add_argument("--max-news", type=int, default=20, help="종목당 최대 뉴스 수")
    parser.add_argument("--fetch-body", action="store_true", help="본문까지 수집 (trafilatura 필요)")
    parser.add_argument("--merge", action="store_true", help="기존 결과 JSON에 종목별 결과를 병합")
    args = parser.parse_args()

    try:
        stocks = resolve_stocks(args.input, args.top_n)
    except Exception as exc:
        print(f"[ERROR] 종목 목록 로드 실패: {exc}", file=sys.stderr)
        return 1

    if args.ticker:
        target = re.sub(r"\D", "", str(args.ticker)).zfill(6)[-6:]
        stocks = [stock for stock in stocks if str(stock.get("ticker", "")).zfill(6) == target]

    if not stocks:
        print("[WARN] 분석할 종목이 없습니다.", file=sys.stderr)
        return 1

    analyzed = run_and_save(
        stocks,
        output_path=args.output,
        days=args.days,
        max_news=args.max_news,
        fetch_body=args.fetch_body,
        merge_existing=args.merge,
    )

    print("\n✅ === 최종 분석 완료 데이터 ===")
    print(json.dumps(analyzed, ensure_ascii=False, indent=4))
    return 0


if __name__ == "__main__":
    raise SystemExit(main_with_args())
