"""
integrated_pipeline.py
======================
기본 실행 흐름:
  1) main.py      -> KOSPI200 전체 후보 수집
  2) Transformer  -> 각 종목 상승확률 P(up) 예측
                  -> KOSPI200 전체 P(up) 랭킹
                  -> Transformer Top10의 최근 N거래일 수급 첨부
                  -> 최종 Top10 + 수급 CSV 저장
  3) 종료

뉴스 + LLM 단계는 기본 실행에서 절대 실행하지 않는다.
필요할 때만 --run-news 옵션으로 별도 실행한다.

필요 환경변수 (.env 또는 shell export):
  APP_KEY, APP_SECRET          KIS 모의투자 API 키
  NAVER_CLIENT_ID              네이버 검색 API (--run-news에서만 필요)
  NAVER_CLIENT_SECRET          네이버 검색 API (--run-news에서만 필요)
  OPENAI_API_KEY               OpenAI API 키 (--run-news에서만 필요)

필요 파일 (동일 폴더):
  transformer_5y.pt   학습된 Transformer 체크포인트 (5년치, 분류 task)
  model.py            StockTransformer 정의
  data.py             _compute_indicators / FEATURE_COLS / SEQ_LEN / FeatureScaler / N_FEATURES
  predict.py          predict_multiple(ckpt_path, ticker_dfs) 추론 코드
  pykrx               raw OHLCV 조회용

실행 예시:
  python integrated_pipeline.py
  python integrated_pipeline.py --candidate-pool 200 --final-max 10
  python integrated_pipeline.py --supply-window 5 --supply-min-positive-days 3
  python integrated_pipeline.py --run-news --news-days 5
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal

import numpy as np
import pandas as pd

try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass


# ──────────────────────────────────────────────
# 경로 기본값
# ──────────────────────────────────────────────

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_MAIN_MODULE       = BASE_DIR / "main.py"
DEFAULT_TRANSFORMER_CKPT  = BASE_DIR / "transformer_5y.pt"
DEFAULT_PREDICT_MODULE    = BASE_DIR / "predict.py"
DEFAULT_OUTPUT_DIR        = BASE_DIR / "outputs"
DEFAULT_LOCAL_OHLCV       = BASE_DIR / "shared_test_raw.parquet"
MIN_OHLCV_ROWS            = 60
SUPPLY_REQUEST_SLEEP_SECONDS = float(os.getenv("KIS_SUPPLY_SLEEP_SECONDS", "0.3"))
KIS_OHLCV_REQUEST_SLEEP_SECONDS = float(os.getenv("KIS_OHLCV_SLEEP_SECONDS", "0.08"))
KIS_OHLCV_MAX_RETRIES = max(1, int(os.getenv("KIS_OHLCV_MAX_RETRIES", "3")))
KIS_OHLCV_CIRCUIT_BREAKER = max(3, int(os.getenv("KIS_OHLCV_CIRCUIT_BREAKER", "10")))
KST = timezone(timedelta(hours=9))

# config.py(같은 폴더)에서 KIS 토큰매니저/베이스URL 임포트 보장 (main.py 와 동일 패턴)
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))
from config import create_token_manager, BASE_URL  # noqa: E402


# ──────────────────────────────────────────────
# 동적 모듈 임포트 헬퍼
# ──────────────────────────────────────────────

def _import_from_path(module_name: str, path: Path):
    if not path.exists():
        raise FileNotFoundError(f"모듈 파일 없음: {path}")
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"spec 로드 실패: {path}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = mod
    spec.loader.exec_module(mod)
    return mod


# ──────────────────────────────────────────────
# STEP 1 : KOSPI200 종목 풀 로드
# ──────────────────────────────────────────────

def step1_load_kospi200_pool(main_module_path: Path, pool_n: int) -> pd.DataFrame:
    """
    실시간 등락률/거래대금으로 선필터하지 않고 KOSPI200 전체 종목 풀을
    Transformer 입력 후보로 유지한다.
    """
    print(f"\n{'='*60}")
    print(f"[STEP 1] KOSPI200 후보 풀 로드 (목표 {pool_n}개)")
    print(f"  모듈 경로: {main_module_path}")

    main_mod = _import_from_path("_kis_main", main_module_path)

    if not hasattr(main_mod, "load_kospi200_pool"):
        raise AttributeError(f"{main_module_path} 에 load_kospi200_pool() 없음")

    pool = main_mod.load_kospi200_pool()
    if hasattr(main_mod, "_filter_valid_stock_codes"):
        pool = main_mod._filter_valid_stock_codes(pool)

    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for stock_info in pool:
        code = str(getattr(stock_info, "code", "")).strip().zfill(6)
        name = str(getattr(stock_info, "name", "") or code).strip()
        if not (code.isdigit() and len(code) == 6) or code in seen:
            continue
        seen.add(code)
        rows.append({
            "종목코드": code,
            "종목명": name,
            "ticker": code,
            "company_name": name,
        })
        if len(rows) >= pool_n:
            break

    if not rows:
        raise RuntimeError("KOSPI200 후보 풀이 비어 있습니다.")

    df = pd.DataFrame(rows).reset_index(drop=True)
    print(f"  로드 완료: {len(df)}개 종목")
    return df


# ──────────────────────────────────────────────
# STEP 2 : Transformer 상승확률 P(up) 전체 랭킹 + Top10 수급 첨부
# ──────────────────────────────────────────────
#
# 흐름:
#   1) 후보 종목들의 raw OHLCV(pykrx)를 모아 ticker_dfs(dict) 구성
#      - index: Date(datetime), columns: Open/High/Low/Close/Volume, 종목당 60행+
#      - 지표는 Transformer 쪽 data.py 가 스스로 계산 (가공 parquet 불필요)
#   2) predict_multiple(transformer_5y.pt, ticker_dfs) → 종목별 P(up)
#   3) KOSPI200 전체를 P(up) 내림차순으로 랭킹
#   4) Transformer Top10에 최근 N거래일 외국인/기관 수급 경향 첨부
#   5) Top10을 반환
#
# 누수 방지: 수급 조회 기준일 = 각 종목 OHLCV 의 마지막(가장 최근 완료된) 거래일.
#            예측 시점에 실제 존재한 데이터만 사용하므로 미래 정보가 새지 않는다.


def _load_predict_module(predict_module_path: Path):
    """predict.py 를 동적 임포트. (predict.py 가 같은 폴더의 data.py/model.py 자동 참조)"""
    if not predict_module_path.exists():
        raise FileNotFoundError(f"predict.py 없음: {predict_module_path}")
    return _import_from_path("_transformer_predict", predict_module_path)


_kis_ohlcv_failures = 0
_kis_ohlcv_disabled = False
_kis_ohlcv_last_request = 0.0
_local_ohlcv_cache: pd.DataFrame | None = None


def _normalize_ohlcv(df: pd.DataFrame, end_date, source: str) -> pd.DataFrame | None:
    keep = ["Open", "High", "Low", "Close", "Volume"]
    if df is None or df.empty or not all(column in df.columns for column in keep):
        return None
    normalized = df[keep].copy()
    normalized.index = pd.to_datetime(normalized.index, errors="coerce")
    normalized = normalized.loc[normalized.index.notna()].sort_index()
    normalized = normalized.loc[normalized.index.date <= end_date]
    for column in keep:
        normalized[column] = pd.to_numeric(normalized[column], errors="coerce")
    normalized = normalized.dropna(subset=keep)
    normalized.attrs["source"] = source
    return normalized if not normalized.empty else None


def _fetch_kis_ohlcv(ticker: str, start, end) -> pd.DataFrame | None:
    global _kis_ohlcv_last_request
    token_manager = create_token_manager()
    payload = None
    last_error: Exception | None = None
    for attempt in range(1, KIS_OHLCV_MAX_RETRIES + 1):
        elapsed = time.monotonic() - _kis_ohlcv_last_request
        if elapsed < KIS_OHLCV_REQUEST_SLEEP_SECONDS:
            time.sleep(KIS_OHLCV_REQUEST_SLEEP_SECONDS - elapsed)
        try:
            response = token_manager.session.get(
                f"{BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
                headers=token_manager.auth_headers("FHKST03010100"),
                params={
                    "FID_COND_MRKT_DIV_CODE": "J",
                    "FID_INPUT_ISCD": str(ticker).zfill(6),
                    "FID_INPUT_DATE_1": start.strftime("%Y%m%d"),
                    "FID_INPUT_DATE_2": end.strftime("%Y%m%d"),
                    "FID_PERIOD_DIV_CODE": "D",
                    "FID_ORG_ADJ_PRC": "1",
                },
                timeout=10,
            )
            _kis_ohlcv_last_request = time.monotonic()
            response.raise_for_status()
            payload = response.json()
            if payload.get("rt_cd") != "0":
                raise RuntimeError(payload.get("msg1") or payload.get("msg_cd") or "KIS OHLCV lookup failed")
            break
        except Exception as exc:
            last_error = exc
            payload = None
            if attempt < KIS_OHLCV_MAX_RETRIES:
                time.sleep(0.4 * attempt)

    if payload is None:
        raise RuntimeError(f"KIS OHLCV failed after {KIS_OHLCV_MAX_RETRIES} attempts: {last_error}")

    rows = []
    for item in payload.get("output2") or []:
        date = pd.to_datetime(item.get("stck_bsop_date"), format="%Y%m%d", errors="coerce")
        if pd.isna(date):
            continue
        rows.append({
            "Date": date,
            "Open": item.get("stck_oprc"),
            "High": item.get("stck_hgpr"),
            "Low": item.get("stck_lwpr"),
            "Close": item.get("stck_clpr"),
            "Volume": item.get("acml_vol"),
        })
    if not rows:
        return None
    return pd.DataFrame(rows).set_index("Date")


def _fetch_local_ohlcv(ticker: str, start, end) -> pd.DataFrame | None:
    global _local_ohlcv_cache
    if not DEFAULT_LOCAL_OHLCV.exists():
        return None
    if _local_ohlcv_cache is None:
        _local_ohlcv_cache = pd.read_parquet(DEFAULT_LOCAL_OHLCV)
        _local_ohlcv_cache.index = pd.to_datetime(_local_ohlcv_cache.index, errors="coerce")

    ticker_values = _local_ohlcv_cache["Ticker"].astype(str).str.zfill(6)
    frame = _local_ohlcv_cache.loc[ticker_values.eq(str(ticker).zfill(6))].copy()
    return frame.loc[(frame.index.date >= start) & (frame.index.date <= end)]


def _fetch_raw_ohlcv(ticker: str, lookback_days: int, as_of=None) -> pd.DataFrame | None:
    """Load recent OHLCV from KIS, then fall back to the bundled parquet."""
    global _kis_ohlcv_disabled, _kis_ohlcv_failures
    end = (as_of or datetime.now(KST)).date()
    start = end - timedelta(days=lookback_days)

    if not _kis_ohlcv_disabled:
        try:
            kis_df = _fetch_kis_ohlcv(ticker, start, end)
            normalized = _normalize_ohlcv(kis_df, end, "kis") if kis_df is not None else None
            if normalized is not None and not normalized.empty:
                _kis_ohlcv_failures = 0
                return normalized
            raise RuntimeError("KIS OHLCV response was empty")
        except Exception as exc:
            _kis_ohlcv_failures += 1
            print(f"  [{ticker}] KIS OHLCV 실패, 로컬 데이터 사용: {exc}")
            if _kis_ohlcv_failures >= KIS_OHLCV_CIRCUIT_BREAKER:
                _kis_ohlcv_disabled = True
                print("  [WARN] KIS OHLCV 연속 실패로 이번 실행에서는 로컬 데이터를 우선합니다.")

    local_df = _fetch_local_ohlcv(ticker, start, end)
    return _normalize_ohlcv(local_df, end, "local_parquet") if local_df is not None else None


def _date_yyyymmdd(value) -> str:
    if hasattr(value, "strftime"):
        return value.strftime("%Y%m%d")
    return str(value).replace("-", "")[:8]


def _date_iso(value) -> str:
    if hasattr(value, "strftime"):
        return value.strftime("%Y-%m-%d")
    text = str(value)
    if len(text) == 8 and text.isdigit():
        return f"{text[:4]}-{text[4:6]}-{text[6:8]}"
    return text[:10]


def _empty_supply_result(
    window: int,
    status: str = "not_checked",
    error: str = "",
) -> dict[str, Any]:
    return {
        "foreign_net_buy_sum": float("nan"),
        "inst_net_buy_sum": float("nan"),
        "total_supply_net_buy": float("nan"),
        "foreign_positive_days": 0,
        "inst_positive_days": 0,
        "supply_score": float("nan"),
        "supply_pass": False,
        "supply_window": int(window),
        "supply_data_days": 0,
        "supply_data_enough": False,
        "supply_base_start_date": "",
        "supply_base_end_date": "",
        "supply_status": status,
        "supply_error": error,
    }


def _kis_million_to_won(value) -> float:
    try:
        return float(str(value).replace(",", "").strip()) * 1_000_000.0
    except Exception:
        return float("nan")


def _fetch_supply_trend(
    ticker: str,
    token_manager,
    base_date,
    window: int,
    min_positive_days: int,
    debug: bool = False,
) -> dict[str, Any]:
    """
    KIS 투자자별 일별 매매 동향에서 base_date 이전(포함) 최근 N거래일 수급 경향을 계산한다.

    supply_pass 조건:
      - 최근 N거래일 데이터가 충분함
      - 외국인 순매수 합계 > 0
      - 기관 순매수 합계 > 0
      - 외국인 순매수 양수인 날 >= min_positive_days
      - 기관 순매수 양수인 날 >= min_positive_days
    """
    ticker = str(ticker).zfill(6)
    base_str = _date_yyyymmdd(base_date)
    result = _empty_supply_result(window)

    url = f"{BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-investor"
    headers = token_manager.auth_headers("FHKST01010900")
    params = {"FID_COND_MRKT_DIV_CODE": "J", "FID_INPUT_ISCD": ticker}

    backoffs = [0.5, 1.0, 1.5]
    payload = None
    reason = ""
    for attempt in range(1, 4):
        try:
            resp = token_manager.session.get(url, headers=headers, params=params, timeout=10)
            resp.raise_for_status()
            data = resp.json()
        except Exception as exc:
            reason = f"{type(exc).__name__}: {exc}"
        else:
            if data.get("rt_cd") == "0":
                payload = data
                break
            reason = f"rt_cd={data.get('rt_cd')} msg={data.get('msg1')}"

        if debug:
            print(f"    [DEBUG {ticker}] 수급 조회 {attempt}/3 실패: {reason}")
        time.sleep(backoffs[attempt - 1])

    if payload is None:
        return _empty_supply_result(window, status="fetch_failed", error=reason)

    rows: list[dict[str, Any]] = []
    for row in payload.get("output") or []:
        d = str(row.get("stck_bsop_date", "")).strip()
        if len(d) != 8 or not d.isdigit() or d > base_str:
            continue

        foreign_net = _kis_million_to_won(row.get("frgn_ntby_tr_pbmn"))
        inst_net = _kis_million_to_won(row.get("orgn_ntby_tr_pbmn"))
        if not (np.isfinite(foreign_net) and np.isfinite(inst_net)):
            continue

        rows.append({
            "date": d,
            "foreign_net_buy": foreign_net,
            "inst_net_buy": inst_net,
        })

    rows.sort(key=lambda x: x["date"], reverse=True)
    selected = rows[:window]
    data_days = len(selected)
    if data_days == 0:
        return _empty_supply_result(window, status="insufficient_data", error="수급 유효 행 없음")

    foreign_sum = float(sum(r["foreign_net_buy"] for r in selected))
    inst_sum = float(sum(r["inst_net_buy"] for r in selected))
    total_sum = foreign_sum + inst_sum
    foreign_positive_days = sum(1 for r in selected if r["foreign_net_buy"] > 0)
    inst_positive_days = sum(1 for r in selected if r["inst_net_buy"] > 0)
    enough = data_days >= window
    supply_pass = (
        enough
        and foreign_sum > 0
        and inst_sum > 0
        and foreign_positive_days >= min_positive_days
        and inst_positive_days >= min_positive_days
    )

    dates = [r["date"] for r in selected]
    status = "ok" if enough else "insufficient_data"
    error = "" if enough else f"최근 {window}거래일 중 {data_days}일만 확보"

    if debug:
        print(
            f"    [DEBUG {ticker}] 수급 {data_days}/{window}일 "
            f"{_date_iso(min(dates))}~{_date_iso(max(dates))} "
            f"외국인합={foreign_sum:,.0f} 기관합={inst_sum:,.0f}"
        )

    return {
        "foreign_net_buy_sum": foreign_sum,
        "inst_net_buy_sum": inst_sum,
        "total_supply_net_buy": total_sum,
        "foreign_positive_days": int(foreign_positive_days),
        "inst_positive_days": int(inst_positive_days),
        "supply_score": total_sum,
        "supply_pass": bool(supply_pass),
        "supply_window": int(window),
        "supply_data_days": int(data_days),
        "supply_data_enough": bool(enough),
        "supply_base_start_date": _date_iso(min(dates)),
        "supply_base_end_date": _date_iso(max(dates)),
        "supply_status": status,
        "supply_error": error,
    }


def _base_step2_record(row: pd.Series) -> dict[str, Any]:
    record = row.to_dict()
    record["ticker"] = str(row["ticker"]).zfill(6)
    record["company_name"] = str(row.get("company_name", ""))
    record["p_up"] = float("nan")
    record["pred_rank"] = float("nan")
    record["pred_pool_size"] = 0
    record["transformer_base_date"] = ""
    record["ohlcv_source"] = ""
    record["prediction_status"] = "pending"
    record["prediction_error"] = ""
    return record


def _sort_rank_df(rank_df: pd.DataFrame) -> pd.DataFrame:
    status_order = {"ok": 0}
    df = rank_df.copy()
    df["_status_order"] = df["prediction_status"].map(status_order).fillna(1)
    df["_p_up_sort"] = pd.to_numeric(df["p_up"], errors="coerce").fillna(float("-inf"))
    df = df.sort_values(
        ["_status_order", "_p_up_sort", "ticker"],
        ascending=[True, False, True],
    ).drop(columns=["_status_order", "_p_up_sort"])
    return df.reset_index(drop=True)


def step2_attach_transformer(
    top_df: pd.DataFrame,
    ckpt_path: Path,
    predict_module_path: Path,
    final_max: int = 10,
    ohlcv_lookback_days: int = 200,
    supply_window: int = 5,
    supply_min_positive_days: int = 3,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    print(f"\n{'='*60}")
    print("[STEP 2] Transformer P(up) 전체 랭킹 + Top10 수급 첨부")
    print(f"  체크포인트 : {ckpt_path}")
    print(
        f"  후보 {len(top_df)}개 전체 예측 → Transformer Top{final_max} 수급 조회"
    )
    print(
        f"  수급 조건: 최근 {supply_window}거래일, "
        f"외국인/기관 양수일 각각 {supply_min_positive_days}일 이상"
    )

    predict_mod = _load_predict_module(predict_module_path)

    top_df = top_df.copy()
    top_df["ticker"] = top_df["ticker"].astype(str).str.zfill(6)
    top_df["company_name"] = top_df["company_name"].astype(str)

    records: dict[str, dict[str, Any]] = {}
    ticker_dfs: dict[str, pd.DataFrame] = {}
    base_dates: dict[str, Any] = {}

    for _, row in top_df.iterrows():
        ticker = str(row["ticker"]).zfill(6)
        record = _base_step2_record(row)
        records[ticker] = record

        try:
            ohlcv = _fetch_raw_ohlcv(ticker, ohlcv_lookback_days)
        except Exception as exc:
            record["prediction_status"] = "ohlcv_error"
            record["prediction_error"] = f"{type(exc).__name__}: {exc}"
            print(f"  [{ticker}] OHLCV 조회 실패: {exc}")
            continue

        if ohlcv is None or ohlcv.empty:
            record["prediction_status"] = "insufficient_data"
            record["prediction_error"] = "OHLCV 데이터 없음"
            print(f"  [{ticker}] OHLCV 데이터 없음 → 예측 제외")
            continue

        if len(ohlcv) < MIN_OHLCV_ROWS:
            record["prediction_status"] = "insufficient_data"
            record["prediction_error"] = f"OHLCV {len(ohlcv)}행 < {MIN_OHLCV_ROWS}행"
            record["transformer_base_date"] = _date_iso(ohlcv.index[-1])
            print(f"  [{ticker}] OHLCV 부족({len(ohlcv)}행) → 예측 제외")
            continue

        ticker_dfs[ticker] = ohlcv
        base_dates[ticker] = ohlcv.index[-1]
        record["transformer_base_date"] = _date_iso(ohlcv.index[-1])
        record["ohlcv_source"] = str(ohlcv.attrs.get("source", ""))
        record["prediction_status"] = "ready"

    scores: dict[str, float] = {}
    errors: dict[str, str] = {}
    if ticker_dfs:
        try:
            predicted = predict_mod.predict_multiple(
                str(ckpt_path),
                ticker_dfs,
                return_errors=True,
            )
            scores, errors = predicted
        except TypeError:
            scores = predict_mod.predict_multiple(str(ckpt_path), ticker_dfs)
            errors = {ticker: "" for ticker in ticker_dfs}
        except Exception as exc:
            message = f"{type(exc).__name__}: {exc}"
            print(f"  [WARN] Transformer 배치 예측 실패: {message}")
            for ticker in ticker_dfs:
                records[ticker]["prediction_status"] = "prediction_failed"
                records[ticker]["prediction_error"] = message

    for ticker in ticker_dfs:
        if records[ticker]["prediction_status"] == "prediction_failed":
            continue

        score = scores.get(ticker, float("nan"))
        error = errors.get(ticker, "")
        if pd.notna(score) and np.isfinite(float(score)):
            records[ticker]["p_up"] = round(float(score), 6)
            records[ticker]["prediction_status"] = "ok"
            records[ticker]["prediction_error"] = ""
        else:
            records[ticker]["prediction_status"] = "prediction_failed"
            records[ticker]["prediction_error"] = error or "predict_multiple returned NaN"

    rank_df = pd.DataFrame(records.values())
    ok_mask = rank_df["prediction_status"].eq("ok")
    ok_sorted = rank_df.loc[ok_mask].sort_values("p_up", ascending=False)
    pred_pool_size = len(ok_sorted)
    for rank, idx in enumerate(ok_sorted.index, start=1):
        rank_df.at[idx, "pred_rank"] = rank
    rank_df["pred_pool_size"] = pred_pool_size
    rank_df = _sort_rank_df(rank_df)

    print(f"  P(up) 예측 성공: {pred_pool_size}/{len(rank_df)}개")
    for _, row in rank_df.head(10).iterrows():
        if row["prediction_status"] == "ok":
            print(
                f"    #{int(row['pred_rank']):>3}/{pred_pool_size} "
                f"{row['ticker']} {row['company_name']:12s} P(up)={row['p_up']*100:.2f}%"
            )

    supply_df = rank_df.copy()
    for col, value in _empty_supply_result(supply_window).items():
        supply_df[col] = value

    success_indices = supply_df.index[supply_df["prediction_status"].eq("ok")].tolist()
    supply_target_indices = success_indices[:final_max]
    debug_supply = bool(os.getenv("IP_DEBUG_SUPPLY"))

    token_manager = None
    if supply_target_indices:
        try:
            token_manager = create_token_manager()
        except Exception as exc:
            message = f"{type(exc).__name__}: {exc}"
            print(f"  [WARN] 수급 조회용 KIS 토큰 생성 실패: {message}")
            for idx in supply_target_indices:
                for col, value in _empty_supply_result(
                    supply_window,
                    status="fetch_failed",
                    error=message,
                ).items():
                    supply_df.at[idx, col] = value

    if token_manager is not None:
        print(f"  Transformer Top{len(supply_target_indices)} 수급 조회:")
        for idx in supply_target_indices:
            ticker = str(supply_df.at[idx, "ticker"]).zfill(6)
            try:
                trend = _fetch_supply_trend(
                    ticker,
                    token_manager,
                    base_dates[ticker],
                    window=supply_window,
                    min_positive_days=supply_min_positive_days,
                    debug=debug_supply,
                )
            except Exception as exc:
                trend = _empty_supply_result(
                    supply_window,
                    status="fetch_failed",
                    error=f"{type(exc).__name__}: {exc}",
                )

            for col, value in trend.items():
                supply_df.at[idx, col] = value

            mark = "PASS" if trend["supply_pass"] else "drop"
            print(
                f"    [{mark}] #{int(supply_df.at[idx, 'pred_rank']):>3}/{pred_pool_size} "
                f"{ticker} P(up)={float(supply_df.at[idx, 'p_up'])*100:.2f}% "
                f"외국인합={trend['foreign_net_buy_sum']:,.0f} "
                f"기관합={trend['inst_net_buy_sum']:,.0f} "
                f"양수일={trend['foreign_positive_days']}/{trend['inst_positive_days']} "
                f"데이터={trend['supply_data_days']}/{trend['supply_window']}"
            )
            time.sleep(SUPPLY_REQUEST_SLEEP_SECONDS)

    final_df = (
        supply_df.loc[supply_target_indices]
        .sort_values("pred_rank")
        .reset_index(drop=True)
    )
    final_df["ensemble_pred_return"] = pd.to_numeric(final_df["p_up"], errors="coerce")

    print(f"\n  Transformer 최종 Top{final_max}: {len(final_df)}개")
    for _, row in final_df.iterrows():
        print(
            f"    #{int(row['pred_rank']):>3}/{pred_pool_size} "
            f"{row['ticker']} {row['company_name']:12s} "
            f"P(up)={row['p_up']*100:.2f}% supply_score={row['supply_score']:,.0f}"
        )

    return rank_df.reset_index(drop=True), supply_df.reset_index(drop=True), final_df


def _build_top10_supply_csv(final_df: pd.DataFrame) -> pd.DataFrame:
    columns = [
        "ticker", "company_name", "pred_rank", "pred_pool_size", "p_up",
        "transformer_base_date", "ohlcv_source", "foreign_net_buy_sum",
        "inst_net_buy_sum", "total_supply_net_buy", "foreign_positive_days",
        "inst_positive_days", "supply_score", "supply_pass", "supply_window",
        "supply_data_days", "supply_data_enough", "supply_base_start_date",
        "supply_base_end_date", "supply_status", "supply_error", "종목코드", "종목명",
    ]
    output = final_df.copy()
    for column in columns:
        if column not in output.columns:
            output[column] = pd.NA
    return output[columns].reset_index(drop=True)


# ──────────────────────────────────────────────
# STEP 3 : 네이버 뉴스 크롤링
# ──────────────────────────────────────────────

import html as _html_module
import re
from email.utils import parsedate_to_datetime
from urllib.parse import urlparse

import requests as _requests

def _clean_html(text: str | None) -> str:
    if not text:
        return ""
    text = re.sub(r"<[^>]+>", " ", text)
    text = _html_module.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def _safe_domain(url: str | None) -> str:
    try:
        return urlparse(url or "").netloc.replace("www.", "")
    except Exception:
        return ""


def _truncate(text: str, n: int) -> str:
    return text if len(text) <= n else text[:n-3] + "..."


def _parse_pubdate(pub_date: str) -> datetime | None:
    try:
        dt = parsedate_to_datetime(pub_date)
        return dt.replace(tzinfo=KST) if dt.tzinfo is None else dt.astimezone(KST)
    except Exception:
        return None


def _fetch_naver_news(query: str, display: int = 30) -> list[dict]:
    cid = os.getenv("NAVER_CLIENT_ID", "")
    sec = os.getenv("NAVER_CLIENT_SECRET", "")
    if not cid or not sec:
        raise EnvironmentError("NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 환경변수 없음")

    res = _requests.get(
        "https://openapi.naver.com/v1/search/news.json",
        headers={"X-Naver-Client-Id": cid, "X-Naver-Client-Secret": sec},
        params={"query": query, "display": min(display, 100), "sort": "date"},
        timeout=10,
    )
    res.raise_for_status()
    return res.json().get("items", [])


def _fetch_news_for_ticker(
    ticker: str,
    company_name: str,
    days: int,
    max_news: int,
) -> list[dict]:
    cutoff   = datetime.now(KST) - timedelta(days=days)
    queries  = [f"{company_name} 주가", f"{company_name} 실적", f"{company_name} 수주 전망"]
    seen     = set()
    items_out: list[dict] = []

    for q in queries:
        try:
            raw = _fetch_naver_news(q, display=30)
            time.sleep(0.15)
        except Exception as e:
            print(f"  [WARN] 뉴스 조회 실패 ({q}): {e}")
            continue

        for item in raw:
            dt = _parse_pubdate(item.get("pubDate", ""))
            if dt is None or dt < cutoff:
                continue

            title = _clean_html(item.get("title", ""))
            desc  = _clean_html(item.get("description", ""))
            url   = item.get("originallink") or item.get("link") or ""
            key   = (title.lower(), _safe_domain(url))

            if key in seen:
                continue
            seen.add(key)

            items_out.append({
                "title":       title,
                "description": desc,
                "pub_date":    dt.isoformat(),
                "url":         url,
                "source":      _safe_domain(url),
            })

    items_out.sort(key=lambda x: x["pub_date"], reverse=True)
    selected = items_out[:max_news]
    for i, it in enumerate(selected, 1):
        it["index"] = i
    return selected


# ──────────────────────────────────────────────
# STEP 4 : OpenAI Structured Output 감성 분석
# ──────────────────────────────────────────────

try:
    from openai import OpenAI as _OpenAI
    from pydantic import BaseModel as _BaseModel, Field as _Field
    _OPENAI_AVAILABLE = True
except ImportError:
    _OPENAI_AVAILABLE = False


if _OPENAI_AVAILABLE:
    class StockSentiment(_BaseModel):
        ticker:           str
        company_name:     str
        label:            Literal["POSITIVE", "NEGATIVE"]
        label_ko:         Literal["긍정", "부정"]
        sentiment_score:  float   # -1.0 ~ 1.0
        confidence:       float   # 0.0 ~ 1.0
        summary:          str
        positive_factors: list[str]
        negative_factors: list[str]
        key_data_points:  list[str]
        used_news_indices: list[int]
        caution:          str


def _row_to_signal_lines(row: pd.Series) -> list[str]:
    exclude = {"ticker", "company_name", "news_query", "transformer_error"}
    lines   = []
    for col, val in row.to_dict().items():
        if col in exclude or val is None:
            continue
        try:
            if pd.isna(val):
                continue
        except Exception:
            pass
        lines.append(f"- {col}: {val}")
    return lines or ["- 추가 정량 데이터 없음"]


def _build_messages(ticker: str, company_name: str, signal_lines: list[str], news_items: list[dict]) -> list[dict]:
    news_block = []
    if not news_items:
        news_block.append("최근 뉴스 없음")
    else:
        for n in news_items:
            news_block.append(
                f"[{n['index']}] {n.get('pub_date','')[:10]} | {n.get('source','')} | "
                f"{n.get('title','')} | {_truncate(n.get('description',''), 200)}"
            )

    system = (
        "너는 한국 주식 단기 뉴스/수급/예측 데이터 분석기다. "
        "제공된 데이터만 근거로 단기(다음 거래일) 관점의 긍정/부정을 분류한다. "
        "모르는 사실을 추가로 지어내지 않는다. "
        "label은 POSITIVE 또는 NEGATIVE 중 하나만 선택한다."
    )
    user = (
        f"ticker: {ticker}\ncompany_name: {company_name}\n\n"
        f"정량 데이터:\n" + "\n".join(signal_lines) + "\n\n"
        f"최근 뉴스:\n" + "\n".join(news_block)
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def _analyze_with_llm(client, model_name: str, ticker: str, company_name: str,
                      row: pd.Series, news_items: list[dict]) -> dict:
    messages     = _build_messages(ticker, company_name, _row_to_signal_lines(row), news_items)

    # ★ 수정: client.responses.parse → client.beta.chat.completions.parse
    response = client.beta.chat.completions.parse(
        model=model_name,
        messages=messages,
        response_format=StockSentiment,
    )
    result = response.choices[0].message.parsed
    return result.model_dump()


def step3_news_llm(
    merged_df: pd.DataFrame,
    output_dir: Path,
    days: int,
    max_news: int,
    openai_model: str,
) -> tuple[Path, Path]:
    print(f"\n{'='*60}")
    print(f"[STEP 3] 뉴스 크롤링 + LLM 감성 분석")
    print(f"  뉴스 기간: 최근 {days}일  /  종목당 최대 {max_news}건  /  모델: {openai_model}")

    if not _OPENAI_AVAILABLE:
        raise ImportError("openai 패키지가 설치되지 않았습니다: pip install openai")

    client = _OpenAI()

    flat_rows  = []
    json_rows  = []

    # Transformer P(up) 내림차순으로 정렬 (높을수록 우선 분석)
    df = merged_df.sort_values("ensemble_pred_return", ascending=False, na_position="last").copy()

    for _, row in df.iterrows():
        ticker       = str(row["ticker"]).zfill(6)
        company_name = str(row["company_name"])

        # ─ 뉴스 수집 ─
        print(f"\n  [{ticker}] {company_name} 뉴스 수집 중...")
        try:
            news_items = _fetch_news_for_ticker(ticker, company_name, days, max_news)
            print(f"    → {len(news_items)}건 수집")
        except Exception as e:
            print(f"    [WARN] 뉴스 수집 실패: {e}")
            news_items = []

        # ─ LLM 분석 ─
        print(f"  [{ticker}] {company_name} LLM 분석 중...")
        try:
            result_dict = _analyze_with_llm(client, openai_model, ticker, company_name, row, news_items)
        except Exception as e:
            print(f"    [ERROR] LLM 실패: {e}")
            result_dict = {
                "ticker": ticker, "company_name": company_name,
                "label": "NEGATIVE", "label_ko": "부정",
                "sentiment_score": 0.0, "confidence": 0.0,
                "summary": f"LLM 분석 실패: {e}",
                "positive_factors": [], "negative_factors": [],
                "key_data_points": [], "used_news_indices": [],
                "caution": "LLM 호출 실패로 유효한 판단이 아님",
            }

        label = result_dict.get("label", "?")
        score = result_dict.get("sentiment_score", 0.0)
        conf  = result_dict.get("confidence", 0.0)
        pred  = row.get("ensemble_pred_return", float("nan"))
        print(f"    → {label} | 감성점수 {score:+.2f} | 신뢰도 {conf:.2f} | P(up) {pred*100:.2f}%")

        # ─ flat CSV 행 구성 ─
        flat: dict[str, Any] = {
            **result_dict,
            "positive_factors": " | ".join(result_dict.get("positive_factors", [])),
            "negative_factors": " | ".join(result_dict.get("negative_factors", [])),
            "key_data_points":  " | ".join(result_dict.get("key_data_points", [])),
            "used_news_indices": ",".join(map(str, result_dict.get("used_news_indices", []))),
            "news_count": len(news_items),
        }
        # 원본 KIS + Transformer/수급 데이터 접두사 붙여서 보존
        for col, val in row.to_dict().items():
            if col not in flat:
                flat[f"input_{col}"] = val
        # 뉴스 제목 열 추가
        for n in news_items:
            idx = n["index"]
            flat[f"news_{idx}_date"]   = n.get("pub_date", "")[:10]
            flat[f"news_{idx}_source"] = n.get("source", "")
            flat[f"news_{idx}_title"]  = n.get("title", "")

        flat_rows.append(flat)
        json_rows.append({"result": result_dict, "input_row": row.to_dict(), "news": news_items})

        time.sleep(0.3)

    # ─ 저장 ─
    output_dir.mkdir(parents=True, exist_ok=True)
    csv_path  = output_dir / "final_stock_transformer_news_llm_result.csv"
    json_path = output_dir / "final_stock_transformer_news_llm_result.json"

    pd.DataFrame(flat_rows).to_csv(csv_path, index=False, encoding="utf-8-sig")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(json_rows, f, ensure_ascii=False, indent=2)

    return csv_path, json_path


# ──────────────────────────────────────────────
# 전체 파이프라인 실행
# ──────────────────────────────────────────────

def run(args: argparse.Namespace) -> int:
    output_dir = Path(args.output_dir)

    # ── STEP 1 : KOSPI200 전체 후보 풀 로드 ──
    try:
        top_df = step1_load_kospi200_pool(Path(args.main_module), args.candidate_pool)
    except Exception as e:
        print(f"\n[FATAL] STEP 1 실패: {e}", file=sys.stderr)
        return 1

    output_dir.mkdir(parents=True, exist_ok=True)
    step1_csv = output_dir / "step1_candidate_pool.csv"
    top_df.to_csv(step1_csv, index=False, encoding="utf-8-sig")
    print(f"  저장: {step1_csv}")

    # ── STEP 2 : Transformer P(up) 전체 랭킹 + Top10 수급 첨부 ──
    try:
        all_rank_df, supply_checked_df, final_top10_df = step2_attach_transformer(
            top_df,
            ckpt_path=Path(args.transformer_ckpt),
            predict_module_path=Path(args.predict_module),
            final_max=args.final_max,
            ohlcv_lookback_days=args.ohlcv_lookback_days,
            supply_window=args.supply_window,
            supply_min_positive_days=args.supply_min_positive_days,
        )
    except Exception as e:
        print(f"\n[FATAL] STEP 2 실패: {e}", file=sys.stderr)
        return 1

    step2_rank_csv = output_dir / "step2_all_transformer_rank.csv"
    step2_supply_csv = output_dir / "step2_supply_checked.csv"
    step2_final_csv = output_dir / "step2_final_top10.csv"
    step2_top10_supply_csv = output_dir / "step2_transformer_supply_demand.csv"
    top10_supply_df = _build_top10_supply_csv(final_top10_df)

    all_rank_df.to_csv(step2_rank_csv, index=False, encoding="utf-8-sig")
    supply_checked_df.to_csv(step2_supply_csv, index=False, encoding="utf-8-sig")
    final_top10_df.to_csv(step2_final_csv, index=False, encoding="utf-8-sig")
    top10_supply_df.to_csv(step2_top10_supply_csv, index=False, encoding="utf-8-sig")
    print(f"  저장: {step2_rank_csv}")
    print(f"  저장: {step2_supply_csv}")
    print(f"  저장: {step2_final_csv}")
    print(f"  저장: {step2_top10_supply_csv}")

    # 기본 실행: 뉴스/LLM 미수행 (--run-news 일 때만 STEP 3 수행)
    if not args.run_news:
        print(f"\n{'='*60}")
        print("[DONE] 기본 파이프라인 완료 - 뉴스/LLM 미실행 (--run-news 로 활성화)")
        print(f"  전체 랭킹 : {step2_rank_csv}")
        print(f"  수급 확인 : {step2_supply_csv}")
        print(f"  최종 Top  : {step2_final_csv}")
        print(f"  Top10 수급: {step2_top10_supply_csv}")
        return 0

    # ── STEP 3 : 뉴스 + LLM 감성 분석 (옵션) ──
    if final_top10_df.empty:
        print("\n[INFO] 최종 Top10 이 비어 뉴스/LLM 단계를 건너뜁니다.")
        return 0

    try:
        csv_path, json_path = step3_news_llm(
            final_top10_df,
            output_dir=output_dir,
            days=args.news_days,
            max_news=args.max_news,
            openai_model=args.openai_model,
        )
    except Exception as e:
        print(f"\n[FATAL] STEP 3 실패: {e}", file=sys.stderr)
        return 1

    print(f"\n{'='*60}")
    print("[ALL DONE] 뉴스/LLM 포함 완료")
    print(f"  전체 랭킹 : {step2_rank_csv}")
    print(f"  수급 확인 : {step2_supply_csv}")
    print(f"  최종 Top  : {step2_final_csv}")
    print(f"  최종 CSV  : {csv_path}")
    print(f"  최종 JSON : {json_path}")
    return 0


# ──────────────────────────────────────────────
# CLI
# ──────────────────────────────────────────────

def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="KOSPI200 전체 → Transformer P(up) 랭킹 → Top10 수급 첨부 → (옵션) 뉴스 LLM"
    )
    p.add_argument("--main-module",            default=str(DEFAULT_MAIN_MODULE),
                   help="main.py 경로 (기본: 같은 폴더의 main.py)")
    p.add_argument("--transformer-ckpt",       default=str(DEFAULT_TRANSFORMER_CKPT),
                   help="학습된 Transformer 체크포인트 (.pt, 분류 모델)")
    p.add_argument("--predict-module",         default=str(DEFAULT_PREDICT_MODULE),
                   help="predict.py 경로 (data.py/model.py 와 같은 폴더)")
    p.add_argument("--output-dir",             default=str(DEFAULT_OUTPUT_DIR),
                   help="결과 저장 폴더")
    p.add_argument("--candidate-pool",         type=int, default=200,
                   help="Transformer 예측 대상 KOSPI200 후보 수 (기본 200)")
    p.add_argument("--final-max",              type=int, default=10,
                   help="Transformer P(up) 기준 최종 Top 개수 (기본 10)")
    p.add_argument("--ohlcv-lookback-days",    type=int, default=200,
                   help="KIS/로컬 raw OHLCV 조회 기간(일, 기본 200)")
    p.add_argument("--supply-window",          type=int, default=5,
                   help="수급 경향 조회 거래일 수 (기본 최근 5거래일)")
    p.add_argument("--supply-min-positive-days", type=int, default=3,
                   help="외국인/기관 각각 순매수 양수여야 하는 최소 일수 (기본 3)")
    p.add_argument("--run-news",               action="store_true",
                   help="설정 시에만 STEP 3(뉴스 크롤링+LLM)을 실행한다 (기본 미실행)")
    p.add_argument("--news-days",              type=int, default=3,
                   help="뉴스 수집 기간 (기본 최근 3일, --run-news 에서만 사용)")
    p.add_argument("--max-news",               type=int, default=8,
                   help="종목당 최대 뉴스 수 (기본 8건, --run-news 에서만 사용)")
    p.add_argument("--openai-model",           default=os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
                   help="OpenAI 모델명 (기본 gpt-4o-mini, --run-news 에서만 사용)")
    return p


def main() -> int:
    parser = _build_parser()
    args   = parser.parse_args()
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
