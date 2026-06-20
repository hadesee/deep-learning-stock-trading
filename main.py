"""Scan KOSPI 200 stocks with KIS mock trading quote API."""

from __future__ import annotations

import os
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import pandas as pd
import requests

from config import BASE_URL, KISAuthError, KISTokenManager, create_token_manager


KOSPI200_INDEX_CODE = "1028"
CURRENT_PRICE_PATH = "/uapi/domestic-stock/v1/quotations/inquire-price"
CURRENT_PRICE_TR_ID = "FHKST01010100"
REQUEST_TIMEOUT_SECONDS = 10

TOP_N = 10

REQUEST_SLEEP_SECONDS = float(os.getenv("KIS_REQUEST_SLEEP_SECONDS", "0.08"))
MAX_RETRIES = int(os.getenv("KIS_MAX_RETRIES", "3"))
KOSPI200_POOL_SOURCE = os.getenv("KOSPI200_POOL_SOURCE", "pykrx").strip().lower()
TOP_SORT_COLUMN = os.getenv("TOP_SORT_COLUMN", "당일거래대금(원)").strip()

OUTPUT_COLUMNS = [
    "종목코드",
    "종목명",
    "현재가",
    "등락률(%)",
    "누적거래량",
    "전일거래량",
    "당일거래대금(원)",
    "전일대비거래량비율(%)",
]

STATIC_KOSPI200_POOL = (
    ("005930", "삼성전자"),
    ("000660", "SK하이닉스"),
    ("005380", "현대차"),
    ("373220", "LG에너지솔루션"),
    ("207940", "삼성바이오로직스"),
    ("329180", "HD현대중공업"),
    ("012450", "한화에어로스페이스"),
    ("000270", "기아"),
    ("034020", "두산에너빌리티"),
    ("402340", "SK스퀘어"),
    ("028260", "삼성물산"),
    ("105560", "KB금융"),
    ("068270", "셀트리온"),
    ("042660", "한화오션"),
    ("035420", "NAVER"),
    ("012330", "현대모비스"),
    ("055550", "신한지주"),
    ("015760", "한국전력"),
    ("032830", "삼성생명"),
    ("010130", "고려아연"),
    ("267260", "HD현대일렉트릭"),
    ("009540", "HD한국조선해양"),
    ("006400", "삼성SDI"),
    ("005490", "POSCO홀딩스"),
    ("086790", "하나금융지주"),
    ("035720", "카카오"),
    ("010140", "삼성중공업"),
    ("051910", "LG화학"),
    ("064350", "현대로템"),
    ("000810", "삼성화재"),
    ("298040", "효성중공업"),
    ("316140", "우리금융지주"),
    ("034730", "SK"),
    ("009150", "삼성전기"),
    ("006800", "미래에셋증권"),
    ("267250", "HD현대"),
    ("011200", "HMM"),
    ("003670", "포스코퓨처엠"),
    ("086280", "현대글로비스"),
    ("096770", "SK이노베이션"),
    ("138040", "메리츠금융지주"),
    ("066570", "LG전자"),
    ("033780", "KT&G"),
    ("272210", "한화시스템"),
    ("024110", "기업은행"),
    ("042700", "한미반도체"),
    ("352820", "하이브"),
    ("047810", "한국항공우주"),
    ("0126Z0", "삼성에피스홀딩스"),
    ("000150", "두산"),
    ("010120", "LS ELECTRIC"),
    ("003550", "LG"),
    ("030200", "KT"),
    ("018260", "삼성에스디에스"),
    ("017670", "SK텔레콤"),
    ("307950", "현대오토에버"),
    ("000720", "현대건설"),
    ("079550", "LIG넥스원"),
    ("259960", "크래프톤"),
    ("323410", "카카오뱅크"),
    ("010950", "S-Oil"),
    ("047050", "포스코인터내셔널"),
    ("071050", "한국금융지주"),
    ("278470", "에이피알"),
    ("326030", "SK바이오팜"),
    ("003230", "삼양식품"),
    ("039490", "키움증권"),
    ("377300", "카카오페이"),
    ("005830", "DB손해보험"),
    ("000880", "한화"),
    ("003490", "대한항공"),
    ("007660", "이수페타시스"),
    ("180640", "한진칼"),
    ("000100", "유한양행"),
    ("005940", "NH투자증권"),
    ("443060", "HD현대마린솔루션"),
    ("161390", "한국타이어앤테크놀로지"),
    ("090430", "아모레퍼시픽"),
    ("016360", "삼성증권"),
    ("454910", "두산로보틱스"),
    ("006260", "LS"),
    ("064400", "LG씨엔에스"),
    ("032640", "LG유플러스"),
    ("011070", "LG이노텍"),
    ("029780", "삼성카드"),
    ("034220", "LG디스플레이"),
    ("022100", "포스코DX"),
    ("128940", "한미약품"),
    ("241560", "두산밥캣"),
    ("078930", "GS"),
    ("001040", "CJ"),
    ("021240", "코웨이"),
    ("052690", "한전기술"),
    ("028050", "삼성E&A"),
    ("009830", "한화솔루션"),
    ("001440", "대한전선"),
    ("138930", "BNK금융지주"),
    ("036570", "엔씨소프트"),
    ("066970", "엘앤에프"),
    ("004020", "현대제철"),
    ("175330", "JB금융지주"),
    ("271560", "오리온"),
    ("082740", "한화엔진"),
    ("251270", "넷마블"),
    ("062040", "산일전기"),
    ("450080", "에코프로머티"),
    ("011790", "SKC"),
    ("002380", "KCC"),
    ("051900", "LG생활건강"),
    ("302440", "SK바이오사이언스"),
    ("011780", "금호석유화학"),
    ("035250", "강원랜드"),
    ("036460", "한국가스공사"),
    ("111770", "영원무역"),
    ("017800", "현대엘리베이터"),
    ("018880", "한온시스템"),
    ("011170", "롯데케미칼"),
    ("103140", "풍산"),
    ("097950", "CJ제일제당"),
    ("004990", "롯데지주"),
    ("071970", "HD현대마린엔진"),
    ("204320", "HL만도"),
    ("014680", "한솔케미칼"),
    ("088350", "한화생명"),
    ("457190", "이수스페셜티케미컬"),
    ("012750", "에스원"),
    ("004170", "신세계"),
    ("008930", "한미사이언스"),
    ("001430", "세아베스틸지주"),
    ("009970", "영원무역홀딩스"),
    ("009420", "한올바이오파마"),
    ("005850", "에스엘"),
    ("026960", "동서"),
    ("051600", "한전KPS"),
    ("383220", "F&F"),
    ("000240", "한국앤컴퍼니"),
    ("004370", "농심"),
    ("001450", "현대해상"),
    ("081660", "미스토홀딩스"),
    ("030000", "제일기획"),
    ("139480", "이마트"),
    ("011210", "현대위아"),
    ("028670", "팬오션"),
    ("000120", "CJ대한통운"),
    ("139130", "iM금융지주"),
    ("010060", "OCI홀딩스"),
    ("002790", "아모레퍼시픽홀딩스"),
    ("023530", "롯데쇼핑"),
    ("192820", "코스맥스"),
    ("047040", "대우건설"),
    ("361610", "SK아이이테크놀로지"),
    ("069960", "현대백화점"),
    ("282330", "BGF리테일"),
    ("069620", "대웅제약"),
    ("006280", "녹십자"),
    ("006040", "동원산업"),
    ("008770", "호텔신라"),
    ("017960", "한국카본"),
    ("073240", "금호타이어"),
    ("007070", "GS리테일"),
    ("375500", "DL이앤씨"),
    ("112610", "씨에스윈드"),
    ("006360", "GS건설"),
    ("034230", "파라다이스"),
    ("161890", "한국콜마"),
    ("298020", "효성티앤씨"),
    ("007310", "오뚜기"),
    ("007340", "DN오토모티브"),
    ("003090", "대웅"),
    ("001800", "오리온홀딩스"),
    ("120110", "코오롱인더"),
    ("000080", "하이트진로"),
    ("071320", "지역난방공사"),
    ("300720", "한일시멘트"),
    ("005300", "롯데칠성"),
    ("004000", "롯데정밀화학"),
    ("185750", "종근당"),
    ("285130", "SK케미칼"),
    ("192080", "더블유게임즈"),
    ("009240", "한샘"),
    ("280360", "롯데웰푸드"),
    ("006650", "대한유화"),
    ("137310", "에스디바이오센서"),
    ("000670", "영풍"),
    ("298050", "HS효성첨단소재"),
    ("003240", "태광산업"),
    ("004490", "세방전지"),
    ("093370", "후성"),
    ("000210", "DL"),
    ("114090", "GKL"),
    ("014820", "동원시스템즈"),
    ("001680", "대상"),
    ("069260", "TKG휴켐스"),
    ("005250", "녹십자홀딩스"),
    ("268280", "미원에스씨"),
    ("002840", "미원상사"),
    ("008730", "율촌화학"),
    ("005420", "코스모화학"),
    ("002030", "아세아"),
    ("003030", "세아제강지주"),
)


class KISAPIError(RuntimeError):
    """Raised when a KIS quote API call fails."""


@dataclass(frozen=True)
class StockInfo:
    code: str
    name: str


def load_kospi200_pool() -> list[StockInfo]:
    if KOSPI200_POOL_SOURCE == "static":
        print("[INFO] 내장 KOSPI 200 풀을 사용합니다. 최신 구성종목 조회는 KOSPI200_POOL_SOURCE=pykrx 로 설정하세요.")
        return _load_static_kospi200_pool()

    try:
        from pykrx import stock
    except ImportError as exc:
        print(f"[WARN] pykrx import 실패: {exc}. 내장 KOSPI 200 풀을 사용합니다.")
        return _load_static_kospi200_pool()

    try:
        codes = _get_index_members(stock)
    except Exception as exc:
        print(f"[WARN] pykrx KOSPI 200 구성종목 조회 실패: {exc}")
        print("[WARN] 내장 KOSPI 200 풀을 사용합니다. 최신 정기변경 반영이 필요하면 pykrx/KRX 로그인을 확인하세요.")
        return _load_static_kospi200_pool()

    if not codes:
        print("[WARN] pykrx KOSPI 200 구성종목이 비어 있습니다. 내장 KOSPI 200 풀을 사용합니다.")
        return _load_static_kospi200_pool()

    pool: list[StockInfo] = []
    for code in codes:
        try:
            name = stock.get_market_ticker_name(code)
        except Exception:
            name = ""
        pool.append(StockInfo(code=code, name=name or code))

    return pool


def _load_static_kospi200_pool() -> list[StockInfo]:
    return [StockInfo(code=code, name=name) for code, name in STATIC_KOSPI200_POOL]


def fetch_current_price(
    token_manager: KISTokenManager,
    stock_info: StockInfo,
) -> dict[str, Any]:
    url = f"{BASE_URL}{CURRENT_PRICE_PATH}"
    headers = token_manager.auth_headers(CURRENT_PRICE_TR_ID)
    params = {
        "FID_COND_MRKT_DIV_CODE": "J",
        "FID_INPUT_ISCD": stock_info.code,
    }

    last_error: Exception | None = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = token_manager.session.get(
                url,
                headers=headers,
                params=params,
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
            if response.status_code == 429:
                raise KISAPIError("rate limit exceeded (HTTP 429)")
            response.raise_for_status()
            payload = response.json()
            break
        except (requests.RequestException, ValueError, KISAPIError) as exc:
            last_error = exc
            if attempt >= MAX_RETRIES:
                raise KISAPIError(f"{stock_info.code} quote request failed: {exc}") from exc
            time.sleep(0.5 * attempt)
    else:
        raise KISAPIError(f"{stock_info.code} quote request failed: {last_error}")

    if payload.get("rt_cd") != "0":
        message = payload.get("msg1") or payload.get("msg_cd") or payload
        raise KISAPIError(f"{stock_info.code} quote API error: {message}")

    output = payload.get("output") or {}
    if not isinstance(output, dict):
        raise KISAPIError(f"{stock_info.code} quote output was not an object: {output}")

    return output


def build_candidate(stock_info: StockInfo, quote: dict[str, Any]) -> dict[str, Any]:
    current_price = _to_int(quote.get("stck_prpr"))
    change_rate = _to_float(quote.get("prdy_ctrt"))
    current_volume = _to_int(quote.get("acml_vol"))
    previous_volume = _to_int(quote.get("prdy_vol"))
    trading_value = _to_int(quote.get("acml_tr_pbmn"))
    volume_rate_pct = _get_volume_rate_pct(quote)

    return {
        "종목코드": stock_info.code,
        "종목명": quote.get("hts_kor_isnm") or stock_info.name,
        "현재가": current_price,
        "등락률(%)": change_rate,
        "누적거래량": current_volume,
        "전일거래량": previous_volume,
        "당일거래대금(원)": trading_value,
        "전일대비거래량비율(%)": volume_rate_pct,
    }


def scan_kospi200(top_n: int = TOP_N, sort_column: str = TOP_SORT_COLUMN) -> pd.DataFrame:
    """
    KOSPI200 전체 후보를 KIS 현재가 API로 조회한 뒤, 현물 수급 기준 상위 종목을 반환합니다.

    기본 정렬은 당일거래대금(원)입니다. 거래량 자체 기준이 필요하면
    sort_column="누적거래량" 또는 환경변수 TOP_SORT_COLUMN=누적거래량 을 사용하세요.
    """
    token_manager = create_token_manager()
    pool = load_kospi200_pool()
    pool = _filter_valid_stock_codes(pool)
    print(f"[INFO] KOSPI 200 대상 {len(pool)}개 종목 조회 시작 ({datetime.now():%Y-%m-%d %H:%M:%S})")

    rows: list[dict[str, Any]] = []
    failures: list[str] = []

    for index, stock_info in enumerate(pool, start=1):
        try:
            quote = fetch_current_price(token_manager, stock_info)
            rows.append(build_candidate(stock_info, quote))
        except KISAPIError as exc:
            failures.append(str(exc))

        if index % 25 == 0 or index == len(pool):
            print(f"[INFO] 진행률 {index}/{len(pool)} | 수집 {len(rows)}개 | 실패 {len(failures)}개")

        time.sleep(REQUEST_SLEEP_SECONDS)

    if failures:
        print(f"[WARN] API 실패 {len(failures)}건 발생. 첫 5건:")
        for failure in failures[:5]:
            print(f"       - {failure}")

    if not rows:
        return pd.DataFrame(columns=OUTPUT_COLUMNS)

    df = pd.DataFrame(rows, columns=OUTPUT_COLUMNS)
    if sort_column not in df.columns:
        raise ValueError(f"sort_column={sort_column!r} 컬럼이 없습니다. 사용 가능: {list(df.columns)}")

    # 상한가/거래정지성 이상치를 뒤로 보내되, 후보 자체는 버리지 않습니다.
    primary_mask = (df["등락률(%)"] > 0.0) & (df["등락률(%)"] < 25.0)
    primary = df.loc[primary_mask].sort_values(sort_column, ascending=False)
    secondary = df.loc[~primary_mask].sort_values(sort_column, ascending=False)

    return pd.concat([primary, secondary], ignore_index=True).head(top_n).reset_index(drop=True)


def print_result(df: pd.DataFrame) -> None:
    display_df = df.copy()
    if not display_df.empty:
        display_df["현재가"] = display_df["현재가"].map(lambda value: f"{int(value):,}")
        display_df["등락률(%)"] = display_df["등락률(%)"].map(lambda value: f"{float(value):.2f}")
        display_df["누적거래량"] = display_df["누적거래량"].map(lambda value: f"{int(value):,}")
        display_df["전일거래량"] = display_df["전일거래량"].map(lambda value: f"{int(value):,}")
        display_df["당일거래대금(원)"] = display_df["당일거래대금(원)"].map(lambda value: f"{int(value):,}")
        display_df["전일대비거래량비율(%)"] = display_df["전일대비거래량비율(%)"].map(
            lambda value: f"{float(value):.2f}"
        )

    print("\n[RESULT] KOSPI 200 수급/모멘텀 상위 10")
    with pd.option_context("display.max_columns", None, "display.width", 160):
        print(display_df.to_string(index=False))


def _get_index_members(stock_module: Any) -> list[str]:
    try:
        codes = stock_module.get_index_portfolio_deposit_file(KOSPI200_INDEX_CODE)
    except TypeError:
        today = datetime.now().strftime("%Y%m%d")
        codes = stock_module.get_index_portfolio_deposit_file(today, KOSPI200_INDEX_CODE)

    return [str(code).zfill(6) for code in codes]


def _filter_valid_stock_codes(pool: list[StockInfo]) -> list[StockInfo]:
    valid_pool: list[StockInfo] = []
    for stock_info in pool:
        code = str(stock_info.code).strip()
        if not (code.isdigit() and len(code) == 6):
            print(f"[WARN] 잘못된 종목코드 skip: {stock_info.code!r} ({stock_info.name})")
            continue
        valid_pool.append(StockInfo(code=code, name=stock_info.name))
    return valid_pool


def _get_volume_rate_pct(quote: dict[str, Any]) -> float:
    api_value = _to_float(quote.get("prdy_vrss_vol_rate"), default=-1.0)
    if api_value >= 0:
        return api_value

    current_volume = _to_int(quote.get("acml_vol"))
    previous_volume = _to_int(quote.get("prdy_vol"))
    if previous_volume <= 0:
        return 0.0

    return current_volume / previous_volume * 100.0


def _to_int(value: Any, default: int = 0) -> int:
    try:
        return int(float(str(value).replace(",", "").strip()))
    except (TypeError, ValueError):
        return default


def _to_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(str(value).replace(",", "").strip())
    except (TypeError, ValueError):
        return default


def main() -> int:
    try:
        result = scan_kospi200()
        print_result(result)
        return 0
    except KISAuthError as exc:
        print(f"[ERROR] 인증/토큰 오류: {exc}", file=sys.stderr)
        return 1
    except RuntimeError as exc:
        print(f"[ERROR] 실행 오류: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\n[WARN] 사용자에 의해 중단되었습니다.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
