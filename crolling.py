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

    load_dotenv()
except Exception:
    pass

# .env 파일에 있는 GEMINI_API_KEY를 자동으로 인식합니다.
client = genai.Client()


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
        response = client.models.generate_content(
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


def evaluate_stock_news_group(ticker: str, company_name: str, aggregated_content: str, tech_info: dict = None) -> dict:
    
    # 기술적 지표 데이터를 텍스트로 변환
    tech_text = ""
    if tech_info:
        tech_text = "[기술적 지표 및 딥러닝 모델 예측 데이터]\n"
        for k, v in tech_info.items():
            if k not in ["종목코드", "종목명"]: # 중복 정보 제외
                tech_text += f"- {k}: {v}\n"

    # 프롬프트 길이와 출력 길이를 최적화하고 명확한 규칙 부여
    prompt = f"""
    당신은 냉철한 퀀트 투자 및 금융 데이터 분석가입니다.
    다음은 {company_name}({ticker}) 관련 최신 뉴스 요약과 기술적 지표/모델 예측 결과입니다.

    {tech_text}

    [최신 뉴스 목록]
    {aggregated_content}

    위 데이터를 종합적으로 분석하여, 해당 기업의 단기 주가 방향성에 대한 최종 평가를 아래 JSON 형식으로 작성해주세요.
    반드시 다른 설명 없이 JSON 형식만 출력해주세요.

    [점수 및 감성 평가 기준]
    - final_combined_score: 기술적 지표와 뉴스를 종합한 100점 만점 총점 (0.0 ~ 100.0)
    - final_sentiment 규칙: final_combined_score가 70점 이상이면 "Bullish", 60점 이상 70점 미만이면 "Neutral", 60점 미만이면 "Bearish"로 엄격하게 기재할 것.

    {{
        "ticker": "{ticker}",
        "news_overall_score": 0.0, // 뉴스 기사들의 종합 호재/악재 점수 (0.0 ~ 10.0 사이의 실수)
        "news_sentiment_tally": "", // 전체 기사들의 감성 분포 한 줄 요약 (예: "긍정 5건, 부정 2건, 중립 1건")
        "final_sentiment": "", // 위 평가 기준(점수 구간)에 따른 최종 방향성 ("Bullish", "Bearish", "Neutral")
        "final_combined_score": 0.0, // 기술적 지표와 뉴스 점수를 융합한 최종 총점 (0.0 ~ 100.0)
        "summary": "", // 입력된 최신 뉴스들의 핵심 내용만 종합하여 요약 (1~2문장)
        "trading_insight": "" // 뉴스 요약 내용과 기술적 지표(차트)를 종합하여 구체적인 매매 타점, 대응 전략 또는 리스크 제시 (2~3문장)
    }}
    """

    try:
        response = client.models.generate_content(
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


def run_stock_analysis_pipeline(stocks_list: list, max_news: int = 8):
    print("📰 1단계: 네이버 뉴스 크롤링 시작...")
    
    # 💡 추가: 종목코드별 기술적 지표 데이터를 매핑해두기
    tech_data_map = {str(s.get("ticker", "")).zfill(6): s.get("tech_data", {}) for s in stocks_list}

    crawled_data = crawl_stocks(
        stocks=stocks_list,
        days=1,
        max_news=max_news,
        fetch_body=False,
    )

    final_results = {}

    print("\n🤖 2단계: Gemini API 종목 단위 종합 분석 시작...")
    for ticker, news_list in crawled_data.items():
        print(f"\n[{ticker}] 기술적 지표 및 기사 데이터 융합 분석 중...")
        
        # 기사가 없을 경우를 대비해 텍스트 처리 변경
        aggregated_content = summarize_titles_and_descriptions(news_list)
        if not aggregated_content:
            print(f"[INFO] {ticker}에 대한 최근 기사가 없습니다. 기술적 지표만으로 분석을 진행합니다.")
            aggregated_content = "관련 최신 뉴스가 없습니다."
            company_name = tech_data_map.get(ticker, {}).get("종목명", "")
        else:
            company_name = news_list[0].get("company_name", "")

        # 💡 추가: 매핑해둔 기술적 지표 꺼내기
        tech_info = tech_data_map.get(ticker, {})

        print(f" -> {ticker}에 대해 Gemini API 호출")
        
        # 💡 수정: tech_info 파라미터를 추가하여 전달
        evaluation = evaluate_stock_news_group(
            ticker=ticker, 
            company_name=company_name, 
            aggregated_content=aggregated_content,
            tech_info=tech_info
        )

        if evaluation:
            final_results[ticker] = {
                "ticker": ticker,
                "company_name": company_name,
                "news_count": len(news_list),
                "evaluation": evaluation,
                "news": news_list,
                # 필요하다면 최종 결과에 기술적 지표도 다시 담아줄 수 있습니다.
                "tech_data": tech_info 
            }
            print(f"    [최종 결과] 방향성: {evaluation.get('sentiment')}, 종합 점수: {evaluation.get('impact_score')}점")
            print("    [Gemini 종합 분석]")
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
            "company_name": str(row["종목명"]),
            "tech_data": row.to_dict()  # 💡 추가: DataFrame의 모든 열(MACD, RSI, p_up 등)을 딕셔너리로 저장
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
        rows.append({"ticker": str(r["ticker"]), "company_name": str(r["company_name"]), "news_query": r.get("news_query")})

    return rows


# removed `main()` that used hard-coded stocks and performed file/terminal side-effects.


def main_with_args():
    """파일 입출력을 지원하는 버전 (CLI 사용 시)"""
    import argparse

    parser = argparse.ArgumentParser(description="Crawl Naver news for given stocks")
    parser.add_argument("--input", required=True, help="Input CSV/JSON/XLSX with ticker and company_name")
    parser.add_argument("--output", default="outputs/crawled_news.json", help="Output JSON path")
    parser.add_argument("--days", type=int, default=3, help="Recent days to include")
    parser.add_argument("--max-news", type=int, default=8, help="Max news per stock")
    parser.add_argument("--display", type=int, default=30, help="Naver API display per query")
    parser.add_argument("--fetch-body", action="store_true", help="Also fetch article body (requires trafilatura)")
    args = parser.parse_args()

    stocks = load_input(args.input)

    results = crawl_stocks(
        stocks=stocks,
        days=args.days,
        max_news=args.max_news,
        display_per_query=args.display,
        fetch_body=args.fetch_body,
    )

    # Return results to caller instead of writing files or printing to terminal.
    return results

if __name__ == "__main__":
    # 테스트용 관심 종목 리스트
    target_stocks = [
        {"ticker": "005930", "company_name": "삼성전자"},
        {"ticker": "000660", "company_name": "SK하이닉스"}
    ]

    try:
        top_stocks = get_top_kis_stocks(top_n=10)
    except Exception as exc:
        print(f"[ERROR] 상위 KIS 종목 가져오기 실패: {exc}")
        sys.exit(1)

    if not top_stocks:
        print("[WARN] 상위 10개 KIS 종목을 찾지 못했습니다.")
        sys.exit(1)

    analyzed_news_data = run_stock_analysis_pipeline(top_stocks)

    # 최종 결과물 확인 (JSON 형태로 예쁘게 출력)
    print("\n✅ === 최종 분석 완료 데이터 ===")
    print(json.dumps(analyzed_news_data, ensure_ascii=False, indent=4))