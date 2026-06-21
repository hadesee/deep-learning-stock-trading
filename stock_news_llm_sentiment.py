from __future__ import annotations

import argparse
import html
import json
import os
import re
import time
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse

import pandas as pd
import requests
from google import genai
from google.genai import types
from pydantic import BaseModel, Field


try:
    from dotenv import load_dotenv

    load_dotenv()
except Exception:
    pass


KST = timezone(timedelta(hours=9))


# =========================
# LLM 출력 스키마
# =========================

class StockSentimentResult(BaseModel):
    ticker: str = Field(description="종목코드")
    company_name: str = Field(description="종목명")
    label: Literal["POSITIVE", "NEGATIVE"] = Field(
        description="단기 관점 긍정/부정. 중립에 가까워도 둘 중 더 가까운 쪽으로 선택"
    )
    label_ko: Literal["긍정", "부정"] = Field(description="한국어 라벨")
    sentiment_score: float = Field(
        ge=-1.0,
        le=1.0,
        description="-1에 가까울수록 강한 부정, 1에 가까울수록 강한 긍정",
    )
    confidence: float = Field(
        ge=0.0,
        le=1.0,
        description="판단 신뢰도. 뉴스가 적거나 데이터가 애매하면 낮게",
    )
    summary: str = Field(description="최종 판단 요약")
    positive_factors: list[str] = Field(description="긍정 요인")
    negative_factors: list[str] = Field(description="부정 요인")
    key_data_points: list[str] = Field(description="예측 상승률, 수급, 거래량 등 핵심 데이터 포인트")
    used_news_indices: list[int] = Field(description="판단에 사용한 뉴스 번호")
    caution: str = Field(description="해석 시 주의할 점")


# =========================
# 유틸
# =========================

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
        return urlparse(url).netloc.replace("www.", "")
    except Exception:
        return ""


def truncate(text: str, max_chars: int) -> str:
    text = text or ""
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 3] + "..."


def is_missing(value) -> bool:
    if value is None:
        return True
    try:
        return bool(pd.isna(value))
    except Exception:
        return False


def serialize_value(value):
    if is_missing(value):
        return None
    if isinstance(value, (pd.Timestamp, datetime)):
        return value.isoformat()
    if hasattr(value, "item"):
        try:
            return value.item()
        except Exception:
            pass
    return value


def model_to_dict(obj):
    if hasattr(obj, "model_dump"):
        return obj.model_dump()
    return obj.dict()


# =========================
# 입력 데이터 로딩
# =========================

def load_stock_output(input_path: str) -> pd.DataFrame:
    path = Path(input_path)

    if not path.exists():
        raise FileNotFoundError(f"입력 파일을 찾을 수 없습니다: {input_path}")

    suffix = path.suffix.lower()

    if suffix in [".xlsx", ".xls"]:
        df = pd.read_excel(path)
    elif suffix == ".json":
        df = pd.read_json(path)
    else:
        df = pd.read_csv(path)

    # 자주 쓰는 한글 컬럼명 자동 매핑
    rename_map = {
        "종목코드": "ticker",
        "코드": "ticker",
        "티커": "ticker",
        "종목명": "company_name",
        "회사명": "company_name",
        "기업명": "company_name",
        "이름": "company_name",
        "name": "company_name",
    }

    for old, new in rename_map.items():
        if old in df.columns and new not in df.columns:
            df = df.rename(columns={old: new})

    required = {"ticker", "company_name"}
    missing = required - set(df.columns)

    if missing:
        raise ValueError(
            f"입력 파일에 필요한 컬럼이 없습니다: {missing}\n"
            f"최소 컬럼: ticker, company_name\n"
            f"예: 005930, 삼성전자"
        )

    df["ticker"] = df["ticker"].astype(str).str.zfill(6)

    return df


def add_ensemble_prediction_if_possible(df: pd.DataFrame) -> pd.DataFrame:
    """
    LSTM / TSFM / Transformer 예측값 컬럼이 있으면 평균값을 자동 계산.
    이미 ensemble_pred_return 컬럼이 있으면 그대로 사용.
    """
    if "ensemble_pred_return" in df.columns:
        return df

    candidate_keywords = [
        "pred",
        "predict",
        "prediction",
        "return",
        "상승률",
        "예측",
        "lstm",
        "tsfm",
        "transformer",
        "transform",
    ]

    candidate_cols = []
    for col in df.columns:
        lower = str(col).lower()
        if any(k in lower for k in candidate_keywords):
            numeric = pd.to_numeric(df[col], errors="coerce")
            if numeric.notna().sum() > 0:
                candidate_cols.append(col)

    if candidate_cols:
        numeric_df = df[candidate_cols].apply(pd.to_numeric, errors="coerce")
        df["ensemble_pred_return"] = numeric_df.mean(axis=1)

    return df


# =========================
# 네이버 뉴스 수집
# =========================

def fetch_naver_news_once(
    query: str,
    display: int = 30,
    start: int = 1,
    timeout: int = 10,
) -> list[dict]:
    client_id = os.getenv("NAVER_CLIENT_ID")
    client_secret = os.getenv("NAVER_CLIENT_SECRET")

    if not client_id or not client_secret:
        raise EnvironmentError(
            "NAVER_CLIENT_ID, NAVER_CLIENT_SECRET 환경변수를 설정해야 합니다."
        )

    url = "https://openapi.naver.com/v1/search/news.json"

    headers = {
        "X-Naver-Client-Id": client_id,
        "X-Naver-Client-Secret": client_secret,
    }

    params = {
        "query": query,
        "display": min(display, 100),
        "start": start,
        "sort": "date",
    }

    res = requests.get(url, headers=headers, params=params, timeout=timeout)
    res.raise_for_status()

    data = res.json()
    return data.get("items", [])


def parse_naver_pubdate(pub_date: str) -> datetime | None:
    try:
        dt = parsedate_to_datetime(pub_date)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=KST)
        return dt.astimezone(KST)
    except Exception:
        return None


def fetch_article_body(url: str, timeout: int = 8) -> str:
    """
    선택 기능.
    --fetch-body 옵션을 켰을 때만 사용.
    언론사 페이지 구조가 제각각이라 실패할 수 있음.
    실패하면 빈 문자열 반환.
    """
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

        extracted = trafilatura.extract(
            res.text,
            include_comments=False,
            include_tables=False,
            favor_precision=True,
        )

        return clean_html(extracted or "")
    except Exception:
        return ""


def build_news_queries(company_name: str, ticker: str, custom_query: str | None = None) -> list[str]:
    if custom_query and str(custom_query).strip():
        return [str(custom_query).strip()]

    # 종목명이 애매한 경우를 줄이기 위해 주가/실적/수주 키워드를 나눠 검색
    return [
        f"{company_name} 주가",
        f"{company_name} 실적",
        f"{company_name} 수주 전망",
    ]


def fetch_recent_news_for_stock(
    ticker: str,
    company_name: str,
    custom_query: str | None = None,
    days: int = 3,
    max_news: int = 8,
    display_per_query: int = 30,
    fetch_body: bool = False,
    sleep_sec: float = 0.15,
) -> list[dict]:
    cutoff = datetime.now(KST) - timedelta(days=days)

    queries = build_news_queries(company_name, ticker, custom_query)

    seen = set()
    news_items: list[dict] = []

    for query in queries:
        raw_items = fetch_naver_news_once(
            query=query,
            display=display_per_query,
            start=1,
        )

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

            dedupe_key = (
                title.lower(),
                safe_domain(url),
            )

            if dedupe_key in seen:
                continue

            seen.add(dedupe_key)

            body = ""
            if fetch_body:
                body = fetch_article_body(url)
                time.sleep(sleep_sec)

            news_items.append(
                {
                    "title": title,
                    "description": description,
                    "body": truncate(body, 1800),
                    "pub_date": pub_dt.isoformat(),
                    "url": url,
                    "source": safe_domain(url),
                    "query": query,
                }
            )

    # 최신순 정렬
    news_items.sort(key=lambda x: x["pub_date"], reverse=True)

    # LLM에 넣을 번호 부여
    selected = news_items[:max_news]
    for idx, item in enumerate(selected, start=1):
        item["index"] = idx

    return selected


# =========================
# LLM 입력 생성
# =========================

def row_to_signal_lines(row: pd.Series) -> list[str]:
    """
    모델 예측값, 수급, 거래량 등 입력 row의 모든 유효 컬럼을 LLM에 넘김.
    ticker/company_name/news_query는 제외.
    """
    exclude_cols = {"ticker", "company_name", "news_query"}
    lines = []

    for col, val in row.to_dict().items():
        if col in exclude_cols:
            continue

        val = serialize_value(val)

        if val is None:
            continue

        lines.append(f"- {col}: {val}")

    if not lines:
        lines.append("- 추가 정량 데이터 없음")

    return lines


def build_llm_input(
    ticker: str,
    company_name: str,
    signal_lines: list[str],
    news_items: list[dict],
) -> list[dict]:
    news_block_lines = []

    if not news_items:
        news_block_lines.append("최근 뉴스 없음")
    else:
        for n in news_items:
            one = [
                f"[{n['index']}]",
                f"date: {n.get('pub_date', '')}",
                f"source: {n.get('source', '')}",
                f"title: {n.get('title', '')}",
                f"description: {n.get('description', '')}",
            ]

            if n.get("body"):
                one.append(f"body_excerpt: {truncate(n.get('body', ''), 1200)}")

            news_block_lines.append("\n".join(one))

    system_msg = """
너는 한국 주식 단기 뉴스/수급/예측 데이터 분석기다.
목표는 투자 추천이 아니라, 제공된 데이터만 근거로 단기 관점의 긍정/부정을 분류하는 것이다.

규칙:
1. 반드시 제공된 정량 데이터와 뉴스만 사용한다.
2. 모르는 사실을 추가로 지어내지 않는다.
3. 뉴스가 없거나 약하면 confidence를 낮춘다.
4. label은 POSITIVE 또는 NEGATIVE 중 하나만 선택한다.
5. 중립에 가까우면 더 우세한 쪽을 선택하되 confidence를 낮춘다.
6. used_news_indices에는 실제 판단에 쓴 뉴스 번호만 넣는다.
7. sentiment_score는 -1.0 ~ 1.0 사이로 준다.
8. 단기 관점은 내일 또는 다음 거래일 근처로 본다.
""".strip()

    user_msg = f"""
분석 대상:
- ticker: {ticker}
- company_name: {company_name}

정량 데이터:
{chr(10).join(signal_lines)}

최근 뉴스:
{chr(10).join(news_block_lines)}

위 정보를 종합해서 이 종목의 단기 관점 긍정/부정을 판단해라.
특히 다음 요소를 함께 고려해라:
- Transformer/LSTM/TSFM 예측 상승률이 있으면 그 방향성과 크기
- 외국인/기관/개인 순매수, 프로그램 수급, 거래량 등 수급 데이터
- 최근 2~3일 뉴스의 호재/악재성
- 뉴스와 정량 데이터가 서로 충돌하는 경우 confidence를 낮춤
""".strip()

    return [
        {"role": "system", "content": system_msg},
        {"role": "user", "content": user_msg},
    ]


# =========================
# LLM 호출
# =========================

def analyze_stock_with_llm(
    client,
    model: str,
    ticker: str,
    company_name: str,
    row: pd.Series,
    news_items: list[dict],
) -> StockSentimentResult:
    signal_lines = row_to_signal_lines(row)

    messages = build_llm_input(
        ticker=ticker,
        company_name=company_name,
        signal_lines=signal_lines,
        news_items=news_items,
    )

    system_msg = messages[0]["content"]
    user_msg = messages[1]["content"]

    response = client.models.generate_content(
        model=model,
        contents=user_msg,
        config=types.GenerateContentConfig(
            system_instruction=system_msg,
            response_mime_type="application/json",
            response_schema=StockSentimentResult,
        ),
    )

    parsed = getattr(response, "parsed", None)

    if parsed is None:
        parsed = json.loads(response.text)

    if isinstance(parsed, StockSentimentResult):
        return parsed

    if hasattr(StockSentimentResult, "model_validate"):
        return StockSentimentResult.model_validate(parsed)

    return StockSentimentResult.parse_obj(parsed)


# =========================
# 결과 저장용 flatten
# =========================

def flatten_result(
    result: StockSentimentResult,
    row: pd.Series,
    news_items: list[dict],
) -> dict:
    result_dict = model_to_dict(result)

    flat = {
        "ticker": result_dict["ticker"],
        "company_name": result_dict["company_name"],
        "label": result_dict["label"],
        "label_ko": result_dict["label_ko"],
        "sentiment_score": result_dict["sentiment_score"],
        "confidence": result_dict["confidence"],
        "summary": result_dict["summary"],
        "positive_factors": " | ".join(result_dict["positive_factors"]),
        "negative_factors": " | ".join(result_dict["negative_factors"]),
        "key_data_points": " | ".join(result_dict["key_data_points"]),
        "used_news_indices": ",".join(map(str, result_dict["used_news_indices"])),
        "caution": result_dict["caution"],
        "news_count": len(news_items),
    }

    # 입력 row의 원본 데이터도 결과 CSV에 같이 붙임
    for col, val in row.to_dict().items():
        val = serialize_value(val)
        if val is not None:
            flat[f"input_{col}"] = val

    # 뉴스 제목도 확인용으로 붙임
    for n in news_items:
        idx = n["index"]
        flat[f"news_{idx}_date"] = n.get("pub_date", "")
        flat[f"news_{idx}_source"] = n.get("source", "")
        flat[f"news_{idx}_title"] = n.get("title", "")
        flat[f"news_{idx}_url"] = n.get("url", "")

    return flat


# =========================
# 메인 파이프라인
# =========================

def run_pipeline(
    input_path: str,
    output_csv: str,
    output_json: str,
    days: int = 3,
    top: int = 10,
    rank_col: str | None = None,
    max_news: int = 8,
    fetch_body: bool = False,
    model: str = "gemini-2.5-flash",
    llm_sleep_sec: float = 0.3,
) -> None:
    client = genai.Client()

    df = load_stock_output(input_path)
    df = add_ensemble_prediction_if_possible(df)

    if rank_col:
        if rank_col not in df.columns:
            raise ValueError(f"rank_col={rank_col} 컬럼이 입력 파일에 없습니다.")
        df = df.sort_values(rank_col, ascending=False)

    df = df.head(top).copy()

    flat_rows = []
    json_rows = []

    for i, row in df.iterrows():
        ticker = str(row["ticker"]).zfill(6)
        company_name = str(row["company_name"])
        custom_query = row.get("news_query", None)

        print(f"[INFO] {ticker} {company_name} 뉴스 수집 중...")

        try:
            news_items = fetch_recent_news_for_stock(
                ticker=ticker,
                company_name=company_name,
                custom_query=custom_query,
                days=days,
                max_news=max_news,
                fetch_body=fetch_body,
            )
        except Exception as e:
            print(f"[WARN] 뉴스 수집 실패: {ticker} {company_name} / {e}")
            news_items = []

        print(f"[INFO] {ticker} {company_name} LLM 분석 중... 뉴스 {len(news_items)}개")

        try:
            result = analyze_stock_with_llm(
                client=client,
                model=model,
                ticker=ticker,
                company_name=company_name,
                row=row,
                news_items=news_items,
            )
        except Exception as e:
            print(f"[ERROR] LLM 분석 실패: {ticker} {company_name} / {e}")

            # 실패해도 전체 파이프라인은 계속 돌게 fallback 생성
            result = StockSentimentResult(
                ticker=ticker,
                company_name=company_name,
                label="NEGATIVE",
                label_ko="부정",
                sentiment_score=0.0,
                confidence=0.0,
                summary=f"LLM 분석 실패: {e}",
                positive_factors=[],
                negative_factors=[],
                key_data_points=[],
                used_news_indices=[],
                caution="LLM 호출 실패로 유효한 판단이 아님",
            )

        flat = flatten_result(result, row, news_items)
        flat_rows.append(flat)

        json_rows.append(
            {
                "result": model_to_dict(result),
                "input_row": {
                    k: serialize_value(v)
                    for k, v in row.to_dict().items()
                    if serialize_value(v) is not None
                },
                "news": news_items,
            }
        )

        time.sleep(llm_sleep_sec)

    out_df = pd.DataFrame(flat_rows)

    Path(output_csv).parent.mkdir(parents=True, exist_ok=True)
    Path(output_json).parent.mkdir(parents=True, exist_ok=True)

    out_df.to_csv(output_csv, index=False, encoding="utf-8-sig")

    with open(output_json, "w", encoding="utf-8") as f:
        json.dump(json_rows, f, ensure_ascii=False, indent=2)

    print(f"[DONE] CSV 저장: {output_csv}")
    print(f"[DONE] JSON 저장: {output_json}")


def main():
    parser = argparse.ArgumentParser()

    parser.add_argument(
    "--model",
    default=os.getenv("GEMINI_MODEL", "gemini-2.5-flash"),
    help="Gemini 모델명. 환경변수 GEMINI_MODEL로도 설정 가능",
    )
    parser.add_argument(
        "--output-csv",
        default="outputs/stock_sentiment_result.csv",
        help="결과 CSV 저장 경로",
    )
    parser.add_argument(
        "--output-json",
        default="outputs/stock_sentiment_result.json",
        help="뉴스 포함 상세 JSON 저장 경로",
    )
    parser.add_argument(
        "--days",
        type=int,
        default=3,
        help="최근 며칠 뉴스를 볼지. 기본 3일",
    )
    parser.add_argument(
        "--top",
        type=int,
        default=10,
        help="상위 몇 종목 처리할지. 기본 10",
    )
    parser.add_argument(
        "--rank-col",
        default=None,
        help="정렬 기준 컬럼. 예: ensemble_pred_return. 없으면 입력 순서 유지",
    )
    parser.add_argument(
        "--max-news",
        type=int,
        default=8,
        help="종목당 LLM에 넣을 최대 뉴스 수",
    )
    parser.add_argument(
        "--fetch-body",
        action="store_true",
        help="언론사 원문 본문 일부도 가져오기. trafilatura 필요. 실패 가능",
    )
    parser.add_argument(
        "--model",
        default=os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
        help="OpenAI 모델명. 환경변수 OPENAI_MODEL로도 설정 가능",
    )

    args = parser.parse_args()

    run_pipeline(
        input_path=args.input,
        output_csv=args.output_csv,
        output_json=args.output_json,
        days=args.days,
        top=args.top,
        rank_col=args.rank_col,
        max_news=args.max_news,
        fetch_body=args.fetch_body,
        model=args.model,
    )


if __name__ == "__main__":
    main()