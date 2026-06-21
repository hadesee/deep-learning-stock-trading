"""
integrated_pipeline.py
======================
기본 실행 흐름:
  1) main.py      -> KOSPI200 전체 후보 수집
  2) Transformer  -> 각 종목 상승확률 P(up) 예측
                  -> KOSPI200 전체 P(up) 랭킹
                  -> Transformer Top10에 최근 N거래일 외국인/기관 수급 데이터 첨부
                  -> 최종 Top10 + Transformer 순위/수급 CSV 저장
  3) 종료

필요 환경변수 (.env 또는 shell export):
  APP_KEY, APP_SECRET          KIS 모의투자 API 키

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
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import requests

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
MIN_OHLCV_ROWS            = 60
SUPPLY_REQUEST_SLEEP_SECONDS = float(os.getenv("KIS_SUPPLY_SLEEP_SECONDS", "0.3"))
SUPPLY_REQUEST_TIMEOUT_SECONDS = float(os.getenv("KIS_SUPPLY_TIMEOUT_SECONDS", "5"))
SUPPLY_MAX_RETRIES = max(1, int(os.getenv("KIS_SUPPLY_MAX_RETRIES", "2")))
PYKRX_REQUEST_TIMEOUT_SECONDS = float(os.getenv("PYKRX_REQUEST_TIMEOUT_SECONDS", "12"))
PYKRX_OHLCV_MAX_RETRIES = max(1, int(os.getenv("PYKRX_OHLCV_MAX_RETRIES", "2")))
PYKRX_OHLCV_RETRY_SLEEP_SECONDS = float(os.getenv("PYKRX_OHLCV_RETRY_SLEEP_SECONDS", "0.5"))
KST = timezone(timedelta(hours=9))

# config.py(같은 폴더)에서 KIS 토큰매니저/베이스URL 임포트 보장 (main.py 와 동일 패턴)
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))
from config import create_token_manager, BASE_URL  # noqa: E402


_ORIGINAL_REQUESTS_SESSION_REQUEST = requests.sessions.Session.request


def _request_with_default_timeout(self, method, url, **kwargs):
    """pykrx 내부 requests 호출이 무기한 대기하지 않도록 기본 timeout을 강제한다."""
    kwargs.setdefault("timeout", PYKRX_REQUEST_TIMEOUT_SECONDS)
    return _ORIGINAL_REQUESTS_SESSION_REQUEST(self, method, url, **kwargs)


requests.sessions.Session.request = _request_with_default_timeout


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
    main.py 의 load_kospi200_pool() 만 호출해 KOSPI200 종목코드/종목명 후보 풀을 만든다.

    KIS 현재가 API 호출, 등락률 필터, 거래대금 정렬은 하지 않는다.
    Transformer(STEP 2)가 이 후보 전체에 대해 P(up)을 계산하고 전체 랭킹을 만든다.
    """
    print(f"\n{'='*60}")
    print(f"[STEP 1] KOSPI200 후보 풀 로드 (목표 {pool_n}개, 정렬/현재가 조회 없음)")
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
        raise RuntimeError("KOSPI200 후보 풀이 비어 있습니다. pykrx 조회 또는 내장 종목 풀을 확인하세요.")

    df = pd.DataFrame(rows).reset_index(drop=True)

    print(f"  로드 완료: {len(df)}개 종목")
    for _, row in df.head(10).iterrows():
        print(f"    {row['ticker']} {row['company_name']}")
    if len(df) > 10:
        print(f"    ... 외 {len(df) - 10}개")

    return df


# ──────────────────────────────────────────────
# STEP 2 : Transformer 상승확률 P(up) 전체 랭킹 + Top10 수급 데이터 첨부
# ──────────────────────────────────────────────
#
# 흐름:
#   1) 후보 종목들의 raw OHLCV(pykrx)를 모아 ticker_dfs(dict) 구성
#      - index: Date(datetime), columns: Open/High/Low/Close/Volume, 종목당 60행+
#      - 지표는 Transformer 쪽 data.py 가 스스로 계산 (가공 parquet 불필요)
#   2) predict_multiple(transformer_5y.pt, ticker_dfs) → 종목별 P(up)
#   3) KOSPI200 전체를 P(up) 내림차순으로 랭킹
#   4) Transformer P(up) 상위 Top10에 최근 N거래일 외국인/기관 수급 데이터 첨부
#   5) Top10 CSV 저장용 데이터를 반환
#
# 누수 방지: 수급 조회 기준일 = 각 종목 OHLCV 의 마지막(가장 최근 완료된) 거래일.
#            예측 시점에 실제 존재한 데이터만 사용하므로 미래 정보가 새지 않는다.


def _load_predict_module(predict_module_path: Path):
    """predict.py 를 동적 임포트. (predict.py 가 같은 폴더의 data.py/model.py 자동 참조)"""
    if not predict_module_path.exists():
        raise FileNotFoundError(f"predict.py 없음: {predict_module_path}")
    return _import_from_path("_transformer_predict", predict_module_path)


def _fetch_raw_ohlcv(ticker: str, lookback_days: int, as_of=None) -> pd.DataFrame | None:
    """
    pykrx 에서 단일 종목 raw OHLCV 를 받아 Transformer 입력 형식으로 반환.
      - index: DatetimeIndex(Date), columns: Open/High/Low/Close/Volume
      - 데이터 부족/실패 시 None
    as_of(기준일) 이후 데이터는 받지 않는다(미래 정보 차단). 기본은 오늘(KST).
    """
    from pykrx import stock

    end = (as_of or datetime.now(KST)).date()
    start = end - timedelta(days=lookback_days)
    last_error: Exception | None = None
    for attempt in range(1, PYKRX_OHLCV_MAX_RETRIES + 1):
        try:
            df = stock.get_market_ohlcv(start.strftime("%Y%m%d"), end.strftime("%Y%m%d"), ticker)
            break
        except Exception as exc:
            last_error = exc
            if attempt < PYKRX_OHLCV_MAX_RETRIES:
                time.sleep(PYKRX_OHLCV_RETRY_SLEEP_SECONDS * attempt)
    else:
        if last_error:
            raise last_error
        return None

    if df is None or df.empty:
        return None

    rename = {"시가": "Open", "고가": "High", "저가": "Low", "종가": "Close", "거래량": "Volume"}
    df = df.rename(columns=rename)
    keep = ["Open", "High", "Low", "Close", "Volume"]
    if not all(c in df.columns for c in keep):
        return None
    df = df[keep].copy()

    if not isinstance(df.index, pd.DatetimeIndex):
        df.index = pd.to_datetime(df.index)
    df = df.sort_index()
    df = df[df.index.date <= end]   # 기준일 이후 행 제거 (방어적 누수 차단)
    return df


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

    def _response_reason(status_code: int, data: Any, text: str) -> str:
        if isinstance(data, dict):
            msg = data.get("msg1") or data.get("msg_cd") or data
            rt_cd = data.get("rt_cd")
            if status_code >= 400:
                return f"HTTP {status_code}: rt_cd={rt_cd} msg={msg}"
            return f"rt_cd={rt_cd} msg={msg}"

        snippet = " ".join((text or "").split())[:300]
        return f"HTTP {status_code}: {snippet or 'empty response'}"

    backoffs = [min(8.0, 0.8 * (2 ** i)) for i in range(SUPPLY_MAX_RETRIES)]
    payload = None
    reason = ""
    for attempt in range(1, SUPPLY_MAX_RETRIES + 1):
        try:
            resp = token_manager.session.get(
                url,
                headers=headers,
                params=params,
                timeout=SUPPLY_REQUEST_TIMEOUT_SECONDS,
            )
        except Exception as exc:
            reason = f"{type(exc).__name__}: {exc}"
        else:
            text = resp.text
            try:
                data = resp.json()
            except ValueError:
                data = None

            if 200 <= resp.status_code < 300 and isinstance(data, dict) and data.get("rt_cd") == "0":
                payload = data
                break
            reason = _response_reason(resp.status_code, data, text)

        if debug:
            print(f"    [DEBUG {ticker}] 수급 조회 {attempt}/{SUPPLY_MAX_RETRIES} 실패: {reason}")
        if attempt < SUPPLY_MAX_RETRIES:
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
    print("[STEP 2] Transformer P(up) 전체 랭킹 + Top10 수급 데이터 첨부")
    print(f"  체크포인트 : {ckpt_path}")
    print(
        f"  후보 {len(top_df)}개 전체 예측 → Transformer Top{final_max} 수급 조회"
    )
    print(
        f"  수급 참고 기준: 최근 {supply_window}거래일, "
        f"외국인/기관 양수일 각각 {supply_min_positive_days}일 이상이면 supply_pass=True"
    )

    predict_mod = _load_predict_module(predict_module_path)

    top_df = top_df.copy()
    top_df["ticker"] = top_df["ticker"].astype(str).str.zfill(6)
    top_df["company_name"] = top_df["company_name"].astype(str)

    records: dict[str, dict[str, Any]] = {}
    ticker_dfs: dict[str, pd.DataFrame] = {}
    base_dates: dict[str, Any] = {}

    total_candidates = len(top_df)
    for position, (_, row) in enumerate(top_df.iterrows(), start=1):
        ticker = str(row["ticker"]).zfill(6)
        record = _base_step2_record(row)
        records[ticker] = record

        if position == 1 or position % 10 == 0 or position == total_candidates:
            print(f"  [OHLCV 조회] {position}/{total_candidates} {ticker}", flush=True)

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
        record["prediction_status"] = "ready"

    scores: dict[str, float] = {}
    errors: dict[str, str] = {}
    if ticker_dfs:
        try:
            print(f"  [Transformer 예측] 준비 종목 {len(ticker_dfs)}개 배치 추론 시작", flush=True)
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
        total_supply_targets = len(supply_target_indices)
        for supply_position, idx in enumerate(supply_target_indices, start=1):
            ticker = str(supply_df.at[idx, "ticker"]).zfill(6)
            print(f"    [수급 조회] {supply_position}/{total_supply_targets} {ticker}")
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
        "ticker",
        "company_name",
        "pred_rank",
        "pred_pool_size",
        "p_up",
        "transformer_base_date",
        "foreign_net_buy_sum",
        "inst_net_buy_sum",
        "total_supply_net_buy",
        "foreign_positive_days",
        "inst_positive_days",
        "supply_score",
        "supply_pass",
        "supply_window",
        "supply_data_days",
        "supply_data_enough",
        "supply_base_start_date",
        "supply_base_end_date",
        "supply_status",
        "supply_error",
        "종목코드",
        "종목명",
    ]
    out = final_df.copy()
    for col in columns:
        if col not in out.columns:
            out[col] = pd.NA
    return out[columns].reset_index(drop=True)


# ──────────────────────────────────────────────
# 전체 파이프라인 실행
# ──────────────────────────────────────────────

def run_news_crawling_and_llm(
    step2_final_csv: Path,
    output_dir: Path,
    days: int = 1,
    max_news: int = 5,
) -> None:
    """
    step2_final_top10.csv를 읽어서 뉴스 크롤링 + Gemini LLM 분석을 수행합니다.
    """
    print(f"\n{'='*60}")
    print("[STEP 3] 뉴스 크롤링 + Gemini LLM 분석")
    print(f"  입력 CSV: {step2_final_csv}")
    
    try:
        # crolling.py 동적 임포트
        crolling_path = Path(__file__).resolve().parent / "crolling.py"
        if not crolling_path.exists():
            print(f"  [WARN] crolling.py를 찾을 수 없습니다: {crolling_path}")
            return
        
        crolling_mod = _import_from_path("_crolling_module", crolling_path)
        
        if not hasattr(crolling_mod, "load_input"):
            print(f"  [WARN] crolling.py에 load_input() 함수가 없습니다.")
            return
        
        if not hasattr(crolling_mod, "run_stock_analysis_pipeline"):
            print(f"  [WARN] crolling.py에 run_stock_analysis_pipeline() 함수가 없습니다.")
            return
        
        # CSV 읽기
        stocks = crolling_mod.load_input(str(step2_final_csv))
        print(f"  로드된 종목: {len(stocks)}개")
        
        for stock in stocks[:5]:
            print(f"    - {stock['ticker']} {stock['company_name']}")
        if len(stocks) > 5:
            print(f"    ... 외 {len(stocks) - 5}개")
        
        # 뉴스 크롤링 + LLM 분석 실행
        print(f"\n  📰 뉴스 크롤링 + Gemini LLM 분석 시작...")
        # 파라미터로 max_news 값을 명시적으로 전달
        analyzed_results = crolling_mod.run_stock_analysis_pipeline(stocks, max_news=max_news)
        
        # 결과 저장
        output_json = output_dir / "step3_final_news_llm_analysis.json"
        with open(output_json, "w", encoding="utf-8") as f:
            import json
            json.dump(analyzed_results, f, ensure_ascii=False, indent=2)
        print(f"  저장: {output_json}")
        
        # CSV 형태로도 저장
        results_list = []
        for ticker, data in analyzed_results.items():
            evaluation = data.get("evaluation", {})
            final_sentiment = evaluation.get("final_sentiment") or evaluation.get("sentiment", "")
            final_score = evaluation.get("final_combined_score", evaluation.get("impact_score", 0))
            record = {
                "ticker": ticker,
                "company_name": data.get("company_name", ""),
                "news_count": data.get("news_count", 0),
                "sentiment": final_sentiment,
                "impact_score": final_score,
                "summary": evaluation.get("summary", ""),
                "trading_insight": evaluation.get("trading_insight", ""),
            }
            results_list.append(record)
        
        if results_list:
            results_df = pd.DataFrame(results_list)
            output_csv = output_dir / "step3_final_news_llm_analysis.csv"
            results_df.to_csv(output_csv, index=False, encoding="utf-8-sig")
            print(f"  저장: {output_csv}")
            
            print(f"\n  📊 분석 결과 요약:")
            for _, row in results_df.iterrows():
                print(f"    [{row['sentiment']}] {row['ticker']} {row['company_name']}: "
                      f"종합점수={row['impact_score']}, "
                      f"뉴스={row['news_count']}건")
    
    except Exception as e:
        print(f"  [ERROR] STEP 3 실패: {e}")
        import traceback
        traceback.print_exc()


def run(args: argparse.Namespace) -> int:
    output_dir = Path(args.output_dir)

    # ── STEP 1 : KOSPI200 후보 풀 로드 ──
    try:
        top_df = step1_load_kospi200_pool(Path(args.main_module), args.candidate_pool)
    except Exception as e:
        print(f"\n[FATAL] STEP 1 실패: {e}", file=sys.stderr)
        return 1

    output_dir.mkdir(parents=True, exist_ok=True)
    step1_csv = output_dir / "step1_candidate_pool.csv"
    top_df.to_csv(step1_csv, index=False, encoding="utf-8-sig")
    print(f"  저장: {step1_csv}")

    # ── STEP 2 : Transformer P(up) 전체 랭킹 + Top10 수급 데이터 첨부 ──
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

    # ── STEP 3 : 뉴스 크롤링 + LLM 분석 ──
    run_news_crawling_and_llm(
        step2_final_csv=step2_final_csv,
        output_dir=output_dir,
        days=args.news_days if hasattr(args, "news_days") else 1,
        max_news=args.max_news if hasattr(args, "max_news") else 5,
    )

    print(f"\n{'='*60}")
    print("[ALL DONE] 전체 파이프라인 완료")
    print(f"  STEP 1 (후보 풀)      : {step1_csv}")
    print(f"  STEP 2 (Transformer) : {step2_final_csv}")
    print(f"  STEP 2 (수급 정보)   : {step2_top10_supply_csv}")
    print(f"  STEP 3 (뉴스+LLM)    : {output_dir / 'step3_final_news_llm_analysis.csv'}")
    return 0


# ──────────────────────────────────────────────
# CLI
# ──────────────────────────────────────────────

def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="KOSPI200 후보 풀 → Transformer P(up) 전체 랭킹 → Top10 수급 데이터 + 뉴스 크롤링 + LLM 분석"
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
                   help="Transformer 예측에 넣을 KOSPI200 후보 수 (기본 200)")
    p.add_argument("--final-max",              type=int, default=10,
                   help="Transformer P(up) 기준 최종 Top 개수 (기본 10)")
    p.add_argument("--ohlcv-lookback-days",    type=int, default=200,
                   help="pykrx raw OHLCV 조회 기간(일). 지표 warmup+윈도우 확보용 (기본 200)")
    p.add_argument("--supply-window",          type=int, default=5,
                   help="수급 경향 조회 거래일 수 (기본 최근 5거래일)")
    p.add_argument("--supply-min-positive-days", type=int, default=3,
                   help="외국인/기관 각각 순매수 양수여야 하는 최소 일수 (기본 3)")
    p.add_argument("--news-days",              type=int, default=1,
                   help="뉴스 조회 기간(일) (기본 1)")
    p.add_argument("--max-news",               type=int, default=5,
                   help="종목당 최대 뉴스 수 (기본 5)")
    return p


def main() -> int:
    parser = _build_parser()
    args   = parser.parse_args()
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
