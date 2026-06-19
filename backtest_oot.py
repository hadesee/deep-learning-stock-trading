# -*- coding: utf-8 -*-
"""
backtest_oot.py — Out-of-time(미관측 구간) 백테스트 + ablation 시각자료 생성

목적
----
학습/테스트에 쓰지 않은 "신선 구간"(parquet 데이터 cutoff 다음 거래일 ~ 오늘)에서
  [A] 트랜스포머 단독  vs  [B] 트랜스포머 + 수급경향  vs  [기준선: 시장 / 무작위]
를 비교해 "각 단계가 성능에 기여한다"를 그래프로 보인다.

핵심 원칙 (누수 방지 — 엄수)
----------------------------
  * transformer_5y.pt 그대로 사용. 재학습 절대 없음.
  * 날짜 D 예측은 D까지의 OHLCV만 사용(윈도우가 D에서 끝남).
  * 수익률은 다음 거래일 D+1 종가로 측정.
  * 수급도 D까지의 데이터만 사용.
  * 마지막 신선일은 D+1이 없으므로 수익률 계산에서 제외.

재사용
------
  predict.py  : _load_inference_bundle / _predict_with_bundle (모델 1회 로드 후 재사용)
  data.py     : predict.py 가 내부적으로 지표 계산에 사용
  config.py   : create_token_manager / BASE_URL (KIS 수급 조회)
  integrated_pipeline.py : _fetch_supply_trend 의 KIS inquire-investor 호출/파싱 로직을
                           재사용(import한 헬퍼 + 동일 요청 로직 복제)

integrated_pipeline.py 는 건드리지 않는다 (별도 스크립트).

실행 예시
---------
  python backtest_oot.py
  python backtest_oot.py --topk 5 --cost 0.25 --ablation-n 10
  python backtest_oot.py --no-supply        # KIS 키 없을 때 수급 단계 생략(A/기준선만)

출력 (outputs/)
---------------
  oot_cumulative_return.png   누적수익 곡선 (메인)
  oot_metrics_bar.png         전략별 일평균수익 막대
  oot_supply_ablation.png     수급 통과 vs 탈락 평균 다음날 수익 막대
  oot_summary.csv             전략별 지표 표 (누적/일평균/적중률/샤프, gross·net)
"""

from __future__ import annotations

import argparse
import concurrent.futures
import sys
import time
import warnings
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")

BASE_DIR = Path(__file__).resolve().parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

# 재사용: 추론 번들(모델 1회 로드)
from predict import _load_inference_bundle, _predict_with_bundle  # noqa: E402

KST = timezone(timedelta(hours=9))

OHLCV_COLS = ["Open", "High", "Low", "Close", "Volume"]
MIN_OHLCV_ROWS = 60          # 지표 워밍업 + 20일 윈도우 최소치
FETCH_TIMEOUT_SECONDS = 10   # 종목별 pykrx 호출 타임아웃
FETCH_SLEEP_SECONDS = 0.2    # 종목 간 간격


# ════════════════════════════════════════════════════════════════════════
# 한글 폰트 (Windows: Malgun Gothic, 실패 시 영문 라벨)
# ════════════════════════════════════════════════════════════════════════

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib import font_manager  # noqa: E402


def _setup_korean_font() -> bool:
    for name in ["Malgun Gothic", "AppleGothic", "NanumGothic", "NanumBarunGothic"]:
        try:
            font_manager.findfont(name, fallback_to_default=False)
            plt.rcParams["font.family"] = name
            plt.rcParams["axes.unicode_minus"] = False
            return True
        except Exception:
            continue
    plt.rcParams["axes.unicode_minus"] = False
    return False


KOR_FONT = _setup_korean_font()


def L(ko: str, en: str) -> str:
    """한글 폰트가 있으면 ko, 없으면 en 라벨."""
    return ko if KOR_FONT else en


# ════════════════════════════════════════════════════════════════════════
# 데이터: parquet 로드 + 신선 OHLCV 수집(pykrx) + 종목별 연속 시계열 구성
# ════════════════════════════════════════════════════════════════════════

def load_base_parquet(parquet_path: Path) -> tuple[dict[str, pd.DataFrame], pd.Timestamp, list[str]]:
    """
    shared_test_raw.parquet 로드.
    반환: {ticker: OHLCV DataFrame(Date index)}, cutoff(=데이터 max 날짜, 동적), ticker 목록.
    """
    if not parquet_path.exists():
        raise FileNotFoundError(
            f"parquet 없음: {parquet_path}\n"
            "  shared_test_raw.parquet 가 같은 폴더에 있어야 합니다."
        )

    df = pd.read_parquet(parquet_path)
    if "Ticker" not in df.columns:
        raise ValueError("parquet 에 'Ticker' 컬럼이 없습니다.")
    if not isinstance(df.index, pd.DatetimeIndex):
        df.index = pd.to_datetime(df.index)

    missing = [c for c in OHLCV_COLS if c not in df.columns]
    if missing:
        raise ValueError(f"parquet 에 OHLCV 컬럼 부족: {missing}")

    base: dict[str, pd.DataFrame] = {}
    for ticker, grp in df.groupby("Ticker"):
        t = str(ticker).zfill(6)
        g = grp[OHLCV_COLS].sort_index().copy()
        base[t] = g

    cutoff = pd.Timestamp(df.index.max()).normalize()
    tickers = sorted(base.keys())
    return base, cutoff, tickers


def _fetch_fresh_one(ticker: str, start: str, end: str) -> pd.DataFrame | None:
    """pykrx 로 단일 종목의 [start, end] 일봉을 받아 OHLCV(영문) 로 반환."""
    from pykrx import stock

    raw = stock.get_market_ohlcv(start, end, ticker)
    if raw is None or raw.empty:
        return None
    rename = {"시가": "Open", "고가": "High", "저가": "Low", "종가": "Close", "거래량": "Volume"}
    raw = raw.rename(columns=rename)
    if not all(c in raw.columns for c in OHLCV_COLS):
        return None
    out = raw[OHLCV_COLS].copy()
    if not isinstance(out.index, pd.DatetimeIndex):
        out.index = pd.to_datetime(out.index)
    out = out.sort_index()
    # 거래정지일(가격 0) 방어
    out = out[(out[["Open", "High", "Low", "Close"]] > 0).all(axis=1)]
    return out


def fetch_fresh_ohlcv(
    tickers: list[str],
    cutoff: pd.Timestamp,
    today: pd.Timestamp,
    fresh_path: Path,
) -> tuple[dict[str, pd.DataFrame], list[str], list[str]]:
    """
    cutoff 다음날 ~ today 의 신선 OHLCV 를 종목별로 받아 dict 반환.
    이미 fresh_path 가 있으면 재사용. 종목 간 sleep(0.2), 호출당 타임아웃 10초, 실패 skip.
    반환: ({ticker: fresh_df}, 성공 ticker, 실패 ticker)
    """
    if fresh_path.exists():
        print(f"  신선 데이터 재사용: {fresh_path.name}")
        fdf = pd.read_parquet(fresh_path)
        if not isinstance(fdf.index, pd.DatetimeIndex):
            fdf.index = pd.to_datetime(fdf.index)
        fresh: dict[str, pd.DataFrame] = {}
        for ticker, grp in fdf.groupby("Ticker"):
            fresh[str(ticker).zfill(6)] = grp[OHLCV_COLS].sort_index().copy()
        ok = [t for t in tickers if t in fresh and not fresh[t].empty]
        fail = [t for t in tickers if t not in ok]
        return fresh, ok, fail

    start = (cutoff + timedelta(days=1)).strftime("%Y%m%d")
    end = today.strftime("%Y%m%d")
    print(f"  신선 OHLCV 수집: {start} ~ {end}  ({len(tickers)}종목, pykrx)")

    fresh = {}
    ok, fail = [], []
    for i, ticker in enumerate(tickers, 1):
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
                fut = ex.submit(_fetch_fresh_one, ticker, start, end)
                g = fut.result(timeout=FETCH_TIMEOUT_SECONDS)
        except concurrent.futures.TimeoutError:
            print(f"    [{i:>2}/{len(tickers)}] {ticker} 타임아웃(>{FETCH_TIMEOUT_SECONDS}s) → skip")
            fail.append(ticker)
            continue
        except Exception as exc:
            print(f"    [{i:>2}/{len(tickers)}] {ticker} 실패: {type(exc).__name__}: {exc} → skip")
            fail.append(ticker)
            continue

        if g is None or g.empty:
            # 신선 구간에 신규 거래일이 아직 없을 수도 있음 → 빈 프레임으로 표시
            fresh[ticker] = pd.DataFrame(columns=OHLCV_COLS)
            ok.append(ticker)
        else:
            fresh[ticker] = g
            ok.append(ticker)
        time.sleep(FETCH_SLEEP_SECONDS)

    # 저장(재실행 시 재사용)
    if fresh:
        parts = []
        for t, g in fresh.items():
            if g is None or g.empty:
                continue
            gg = g.copy()
            gg["Ticker"] = t
            parts.append(gg)
        if parts:
            pd.concat(parts).to_parquet(fresh_path)
            print(f"  신선 데이터 저장: {fresh_path.name}")

    return fresh, ok, fail


def build_combined(
    base: dict[str, pd.DataFrame],
    fresh: dict[str, pd.DataFrame],
    cutoff: pd.Timestamp,
) -> dict[str, pd.DataFrame]:
    """
    종목별: (parquet 의 cutoff 이하) + (fresh 의 cutoff 초과) 를 이어붙여 연속 시계열 구성.
    중복 날짜는 fresh 우선.
    """
    combined: dict[str, pd.DataFrame] = {}
    for t, g_old in base.items():
        old = g_old[g_old.index <= cutoff]
        new = fresh.get(t)
        if new is not None and not new.empty:
            new = new[new.index > cutoff]
            merged = pd.concat([old, new])
            merged = merged[~merged.index.duplicated(keep="last")].sort_index()
        else:
            merged = old.sort_index()
        combined[t] = merged
    return combined


def fresh_trading_dates(
    combined: dict[str, pd.DataFrame],
    cutoff: pd.Timestamp,
    today: pd.Timestamp,
) -> list[pd.Timestamp]:
    """신선 구간 거래일 = cutoff 초과 ~ today 이하, 전 종목 합집합(정렬)."""
    dates: set[pd.Timestamp] = set()
    for g in combined.values():
        for d in g.index:
            if cutoff < d <= today:
                dates.add(pd.Timestamp(d).normalize())
    return sorted(dates)


# ════════════════════════════════════════════════════════════════════════
# 수급: KIS inquire-investor (50종목 1회씩 ~30일 history) → 일자별 평가
#   _fetch_supply_trend 의 요청/파싱 로직 재사용(헬퍼 import + 동일 호출 복제)
# ════════════════════════════════════════════════════════════════════════

def fetch_supply_history(ticker: str, token_manager) -> list[dict[str, Any]] | None:
    """
    KIS 투자자별 일별 매매동향(inquire-investor)을 1회 호출해
    최근 ~30거래일의 일자별 외국인/기관 순매수(원)를 리스트로 반환.
    실패 시 None. (integrated_pipeline._fetch_supply_trend 와 동일한 엔드포인트/파싱)
    """
    from config import BASE_URL
    from integrated_pipeline import _kis_million_to_won  # 파싱 헬퍼 재사용

    ticker = str(ticker).zfill(6)
    url = f"{BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-investor"
    headers = token_manager.auth_headers("FHKST01010900")
    params = {"FID_COND_MRKT_DIV_CODE": "J", "FID_INPUT_ISCD": ticker}

    backoffs = [0.5, 1.0, 1.5]
    payload = None
    for attempt in range(1, 4):
        try:
            resp = token_manager.session.get(url, headers=headers, params=params, timeout=10)
            resp.raise_for_status()
            data = resp.json()
        except Exception:
            data = None
        if data is not None and data.get("rt_cd") == "0":
            payload = data
            break
        time.sleep(backoffs[attempt - 1])

    if payload is None:
        return None

    rows: list[dict[str, Any]] = []
    for row in payload.get("output") or []:
        d = str(row.get("stck_bsop_date", "")).strip()
        if len(d) != 8 or not d.isdigit():
            continue
        foreign_net = _kis_million_to_won(row.get("frgn_ntby_tr_pbmn"))
        inst_net = _kis_million_to_won(row.get("orgn_ntby_tr_pbmn"))
        if not (np.isfinite(foreign_net) and np.isfinite(inst_net)):
            continue
        rows.append({
            "date": pd.Timestamp(f"{d[:4]}-{d[4:6]}-{d[6:8]}"),
            "foreign_net": foreign_net,
            "inst_net": inst_net,
        })
    rows.sort(key=lambda x: x["date"])
    return rows


def collect_supply_histories(
    tickers: list[str],
    token_manager,
) -> dict[str, list[dict[str, Any]]]:
    """50종목 1회씩 수급 history 수집. 실패 종목은 dict 에서 제외."""
    out: dict[str, list[dict[str, Any]]] = {}
    n_ok = 0
    for ticker in tickers:
        hist = None
        try:
            hist = fetch_supply_history(ticker, token_manager)
        except Exception:
            hist = None
        if hist:
            out[ticker] = hist
            n_ok += 1
        time.sleep(FETCH_SLEEP_SECONDS)
    print(f"  수급 history 수집: {n_ok}/{len(tickers)}종목 성공")
    return out


def supply_pass_on(
    history: list[dict[str, Any]],
    D: pd.Timestamp,
    window: int,
    min_positive_days: int,
) -> bool | None:
    """
    D 기준(포함) 최근 window 거래일에서 외국인/기관 각각 순매수 양수일이
    min_positive_days 이상이면 통과(True). 데이터 없으면 None.
    누수 방지: D 이후 데이터는 일절 사용하지 않음.
    """
    if not history:
        return None
    rows = [r for r in history if r["date"] <= D]
    if not rows:
        return None
    rows = sorted(rows, key=lambda x: x["date"])[-window:]
    foreign_pos = sum(1 for r in rows if r["foreign_net"] > 0)
    inst_pos = sum(1 for r in rows if r["inst_net"] > 0)
    return (foreign_pos >= min_positive_days) and (inst_pos >= min_positive_days)


# ════════════════════════════════════════════════════════════════════════
# 예측 / 수익률
# ════════════════════════════════════════════════════════════════════════

def predict_pup_asof(bundle: dict[str, Any], df_upto_D: pd.DataFrame) -> float:
    """D 까지의 OHLCV 로 P(up) 예측. 윈도우가 D 에서 끝난다(누수 없음). 실패 시 nan."""
    try:
        return float(_predict_with_bundle(bundle, df_upto_D))
    except Exception:
        return float("nan")


def next_day_return(g: pd.DataFrame, D: pd.Timestamp) -> float:
    """(Close[D+1] - Close[D]) / Close[D]. D 또는 다음 거래일 없으면 nan."""
    idx = g.index
    pos = idx.get_indexer([D])
    if len(pos) == 0 or pos[0] == -1:
        return float("nan")
    i = pos[0]
    if i + 1 >= len(idx):
        return float("nan")
    c0 = float(g["Close"].iloc[i])
    c1 = float(g["Close"].iloc[i + 1])
    if c0 <= 0:
        return float("nan")
    return (c1 - c0) / c0


# ════════════════════════════════════════════════════════════════════════
# 지표 계산
# ════════════════════════════════════════════════════════════════════════

def cumulative(daily: np.ndarray) -> float:
    if len(daily) == 0:
        return float("nan")
    return float(np.prod(1.0 + daily) - 1.0)


def cum_curve(daily: np.ndarray) -> np.ndarray:
    if len(daily) == 0:
        return np.array([])
    return np.cumprod(1.0 + daily) - 1.0


def daily_sharpe(daily: np.ndarray) -> float:
    if len(daily) < 2:
        return float("nan")
    sd = np.std(daily, ddof=1)
    if sd == 0:
        return float("nan")
    return float(np.mean(daily) / sd)


def hit_rate(daily: np.ndarray) -> float:
    if len(daily) == 0:
        return float("nan")
    return float(np.mean(daily > 0))


def summarize(name: str, gross: np.ndarray, net: np.ndarray) -> dict[str, Any]:
    return {
        "strategy": name,
        "n_days": int(len(gross)),
        "cum_gross": cumulative(gross),
        "cum_net": cumulative(net),
        "mean_gross": float(np.mean(gross)) if len(gross) else float("nan"),
        "mean_net": float(np.mean(net)) if len(net) else float("nan"),
        "hit_gross": hit_rate(gross),
        "hit_net": hit_rate(net),
        "sharpe_gross": daily_sharpe(gross),
        "sharpe_net": daily_sharpe(net),
    }


# ════════════════════════════════════════════════════════════════════════
# 백테스트
# ════════════════════════════════════════════════════════════════════════

def run_backtest(
    combined: dict[str, pd.DataFrame],
    dates: list[pd.Timestamp],
    bundle: dict[str, Any],
    supply_hist: dict[str, list[dict[str, Any]]] | None,
    topk: int,
    cost_roundtrip: float,
    ablation_n: int,
    supply_window: int,
    supply_min_pos: int,
    random_trials: int,
    seed: int,
) -> dict[str, Any]:
    """
    dates: 신선 구간 거래일 전체. 마지막 날은 D+1 없으므로 내부에서 제외.
    각 거래일 D 에 대해 종목별 P(up)(D까지) 와 다음날 수익률 산출 후 전략별 일수익 계산.
    """
    cost_frac = cost_roundtrip / 100.0
    rng = np.random.default_rng(seed)

    bt_dates = dates[:-1]  # 마지막 신선일 제외 (D+1 없음)

    # 전략별 일수익(gross) 누적 리스트
    A_g, B_g, MKT_g, RND_g = [], [], [], []
    A_pos, B_pos, RND_pos = [], [], []  # 그 날 포지션 보유 종목 수(비용 적용 판단)
    used_dates: list[pd.Timestamp] = []

    # ablation: 전체 (종목,날짜) 관측을 pass/fail 풀로 모음
    abl_pass: list[float] = []
    abl_fail: list[float] = []

    for D in bt_dates:
        # --- 종목별 P(up) (D까지) + 다음날 수익률 ---
        pups: dict[str, float] = {}
        rets: dict[str, float] = {}
        for t, g in combined.items():
            if D not in g.index:
                continue
            df_upto = g.loc[:D]
            if len(df_upto) < MIN_OHLCV_ROWS:
                continue
            r = next_day_return(g, D)
            if not np.isfinite(r):
                continue
            p = predict_pup_asof(bundle, df_upto)
            if not np.isfinite(p):
                continue
            pups[t] = p
            rets[t] = r

        if not pups:
            continue

        ranked = sorted(pups.keys(), key=lambda t: pups[t], reverse=True)
        used_dates.append(D)

        # --- [A] 트랜스포머 단독: 상위 k 매수 ---
        a_sel = ranked[:topk]
        a_ret = float(np.mean([rets[t] for t in a_sel])) if a_sel else 0.0
        A_g.append(a_ret)
        A_pos.append(len(a_sel))

        # --- 수급 평가 (있으면) ---
        supply_flag: dict[str, bool | None] = {}
        if supply_hist is not None:
            for t in ranked:
                supply_flag[t] = supply_pass_on(
                    supply_hist.get(t, []), D, supply_window, supply_min_pos
                )

        # --- [B] 트랜스포머 + 수급: 상위 k 중 수급 통과만 ---
        if supply_hist is not None:
            b_sel = [t for t in a_sel if supply_flag.get(t) is True]
            b_ret = float(np.mean([rets[t] for t in b_sel])) if b_sel else 0.0
            B_g.append(b_ret)
            B_pos.append(len(b_sel))

        # --- [기준선1] 시장: 그날 전 종목 동일가중 ---
        MKT_g.append(float(np.mean([rets[t] for t in ranked])))

        # --- [기준선2] 무작위: 매일 무작위 k개 (random_trials 평균) ---
        pool = list(ranked)
        if len(pool) >= 1:
            kk = min(topk, len(pool))
            trial_means = []
            for _ in range(random_trials):
                pick = rng.choice(len(pool), size=kk, replace=False)
                trial_means.append(np.mean([rets[pool[j]] for j in pick]))
            RND_g.append(float(np.mean(trial_means)))
            RND_pos.append(kk)

        # --- ablation: 트랜스포머 상위 N 안에서 수급 통과 vs 탈락 ---
        if supply_hist is not None:
            topN = ranked[:ablation_n]
            for t in topN:
                f = supply_flag.get(t)
                if f is True:
                    abl_pass.append(rets[t])
                elif f is False:
                    abl_fail.append(rets[t])
                # None(데이터 없음)은 ablation 에서 제외

    # --- net 계산 (포지션 보유일에만 왕복 비용 차감) ---
    def net_of(gross: list[float], pos: list[int]) -> np.ndarray:
        g = np.array(gross, dtype=float)
        p = np.array(pos, dtype=float)
        return g - np.where(p > 0, cost_frac, 0.0)

    A_g = np.array(A_g, dtype=float)
    MKT_g = np.array(MKT_g, dtype=float)
    RND_g = np.array(RND_g, dtype=float)
    A_n = net_of(A_g, A_pos)
    RND_n = net_of(RND_g, RND_pos)
    MKT_n = MKT_g - cost_frac  # 시장도 매일 동일가중 리밸런싱 가정

    result: dict[str, Any] = {
        "dates": used_dates,
        "strategies": {},
        "ablation": {
            "pass_returns": np.array(abl_pass, dtype=float),
            "fail_returns": np.array(abl_fail, dtype=float),
        },
    }

    result["strategies"]["A_transformer"] = {
        "label_ko": "트랜스포머 단독", "label_en": "Transformer-only",
        "gross": A_g, "net": A_n,
    }
    if supply_hist is not None:
        B_g = np.array(B_g, dtype=float)
        B_n = net_of(B_g, B_pos)
        result["strategies"]["B_transformer_supply"] = {
            "label_ko": "트랜스포머+수급", "label_en": "Transformer+Supply",
            "gross": B_g, "net": B_n,
        }
    result["strategies"]["MKT_market"] = {
        "label_ko": "기준선:시장", "label_en": "Baseline: Market",
        "gross": MKT_g, "net": MKT_n,
    }
    result["strategies"]["RND_random"] = {
        "label_ko": "기준선:무작위", "label_en": "Baseline: Random",
        "gross": RND_g, "net": RND_n,
    }
    return result


# ════════════════════════════════════════════════════════════════════════
# 시각자료
# ════════════════════════════════════════════════════════════════════════

COLORS = {
    "A_transformer": "#1f77b4",
    "B_transformer_supply": "#d62728",
    "MKT_market": "#7f7f7f",
    "RND_random": "#2ca02c",
}


def _caption(n_days: int) -> str:
    return L(
        f"표본 {n_days}거래일 (소표본) · out-of-time(미관측 구간)",
        f"N={n_days} trading days (small sample) · out-of-time",
    )


def chart_cumulative(result: dict[str, Any], out_path: Path, n_days: int) -> None:
    fig, ax = plt.subplots(figsize=(10, 6))
    dates = result["dates"]
    x = pd.to_datetime(dates)
    for key, s in result["strategies"].items():
        net = s["net"]
        if len(net) == 0:
            continue
        curve = cum_curve(net) * 100.0
        xs = x[: len(curve)]
        ax.plot(xs, curve, marker="o", ms=3, lw=1.8,
                color=COLORS.get(key), label=L(s["label_ko"], s["label_en"]))
    ax.axhline(0, color="black", lw=0.8, ls="--", alpha=0.5)
    ax.set_title(L("누적수익 (net, 거래비용 차감)", "Cumulative Return (net of costs)")
                 + f"\n{_caption(n_days)}", fontsize=13)
    ax.set_xlabel(L("거래일", "Trading day"))
    ax.set_ylabel(L("누적수익 (%)", "Cumulative return (%)"))
    ax.legend(loc="best")
    ax.grid(True, alpha=0.3)
    fig.autofmt_xdate()
    fig.tight_layout()
    fig.savefig(out_path, dpi=150)
    plt.close(fig)


def chart_metrics_bar(summaries: list[dict[str, Any]], out_path: Path, n_days: int) -> None:
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(12, 5.5))
    labels = [s["_label"] for s in summaries]
    colors = [s["_color"] for s in summaries]

    means = [s["mean_net"] * 100.0 for s in summaries]
    ax1.bar(labels, means, color=colors)
    ax1.axhline(0, color="black", lw=0.8)
    ax1.set_title(L("일평균 수익 (net, %)", "Mean daily return (net, %)"))
    ax1.set_ylabel("%")
    ax1.grid(True, axis="y", alpha=0.3)
    for i, v in enumerate(means):
        ax1.text(i, v, f"{v:.3f}", ha="center",
                 va="bottom" if v >= 0 else "top", fontsize=9)

    hits = [s["hit_net"] * 100.0 for s in summaries]
    ax2.bar(labels, hits, color=colors)
    ax2.axhline(50, color="black", lw=0.8, ls="--", alpha=0.6)
    ax2.set_title(L("적중률 (상승일 비율, %)", "Hit rate (% up days)"))
    ax2.set_ylabel("%")
    ax2.grid(True, axis="y", alpha=0.3)
    for i, v in enumerate(hits):
        ax2.text(i, v, f"{v:.1f}", ha="center", va="bottom", fontsize=9)

    fig.suptitle(_caption(n_days), fontsize=11)
    for ax in (ax1, ax2):
        ax.tick_params(axis="x", labelrotation=15)
    fig.tight_layout(rect=(0, 0, 1, 0.95))
    fig.savefig(out_path, dpi=150)
    plt.close(fig)


def chart_ablation(ablation: dict[str, np.ndarray], out_path: Path,
                   n_days: int, ablation_n: int) -> None:
    p = ablation["pass_returns"]
    f = ablation["fail_returns"]
    p_mean = float(np.mean(p)) * 100.0 if len(p) else float("nan")
    f_mean = float(np.mean(f)) * 100.0 if len(f) else float("nan")

    fig, ax = plt.subplots(figsize=(7, 6))
    labels = [
        L(f"수급 통과\n(n={len(p)})", f"Supply PASS\n(n={len(p)})"),
        L(f"수급 탈락\n(n={len(f)})", f"Supply FAIL\n(n={len(f)})"),
    ]
    vals = [p_mean, f_mean]
    bars = ax.bar(labels, vals, color=["#d62728", "#7f7f7f"])
    ax.axhline(0, color="black", lw=0.8)
    ax.set_ylabel(L("다음날 평균수익 (%)", "Mean next-day return (%)"))
    ax.set_title(
        L(f"수급 효과 분리 (트랜스포머 상위 {ablation_n} 내)",
          f"Supply ablation (within transformer top {ablation_n})")
        + f"\n{_caption(n_days)}",
        fontsize=12,
    )
    ax.grid(True, axis="y", alpha=0.3)
    for b, v in zip(bars, vals):
        if np.isfinite(v):
            ax.text(b.get_x() + b.get_width() / 2, v, f"{v:.3f}%",
                    ha="center", va="bottom" if v >= 0 else "top", fontsize=11)
    fig.tight_layout()
    fig.savefig(out_path, dpi=150)
    plt.close(fig)


# ════════════════════════════════════════════════════════════════════════
# 콘솔 출력
# ════════════════════════════════════════════════════════════════════════

def print_summary_table(summaries: list[dict[str, Any]]) -> None:
    print("\n" + "=" * 92)
    print("전략별 요약 (gross = 비용 전, net = 왕복 비용 차감)")
    print("-" * 92)
    head = (f"{'전략':<22}{'일수':>5}{'누적%(net)':>12}{'일평균%(net)':>13}"
            f"{'적중률%':>9}{'샤프(net)':>10}{'누적%(gross)':>13}")
    print(head)
    print("-" * 92)
    for s in summaries:
        print(
            f"{s['_label']:<22}{s['n_days']:>5}"
            f"{s['cum_net']*100:>12.2f}{s['mean_net']*100:>13.3f}"
            f"{s['hit_net']*100:>9.1f}{s['sharpe_net']:>10.3f}"
            f"{s['cum_gross']*100:>13.2f}"
        )
    print("=" * 92)


# ════════════════════════════════════════════════════════════════════════
# main
# ════════════════════════════════════════════════════════════════════════

def main() -> None:
    p = argparse.ArgumentParser(description="Out-of-time 백테스트 + ablation 시각자료")
    p.add_argument("--parquet", default=str(BASE_DIR / "shared_test_raw.parquet"))
    p.add_argument("--fresh", default=str(BASE_DIR / "fresh_ohlcv.parquet"))
    p.add_argument("--ckpt", default=str(BASE_DIR / "transformer_5y.pt"))
    p.add_argument("--outdir", default=str(BASE_DIR / "outputs"))
    p.add_argument("--topk", type=int, default=5, help="매수 종목 수")
    p.add_argument("--cost", type=float, default=0.25, help="왕복 거래비용 %")
    p.add_argument("--ablation-n", type=int, default=10, help="ablation 트랜스포머 상위 N")
    p.add_argument("--supply-window", type=int, default=5)
    p.add_argument("--supply-min-positive-days", type=int, default=3)
    p.add_argument("--random-trials", type=int, default=200)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--device", default="cpu")
    p.add_argument("--today", default=None, help="기준일 override (YYYY-MM-DD), 기본 오늘(KST)")
    p.add_argument("--no-supply", action="store_true", help="수급 단계 생략(KIS 키 없을 때)")
    args = p.parse_args()

    parquet_path = Path(args.parquet)
    fresh_path = Path(args.fresh)
    ckpt_path = Path(args.ckpt)
    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    today = (pd.Timestamp(args.today).normalize() if args.today
             else pd.Timestamp(datetime.now(KST).date()))

    print("=" * 70)
    print("OUT-OF-TIME 백테스트 (미관측 구간)")
    print("=" * 70)

    # 1) parquet 로드 → cutoff(동적) + 종목/OHLCV
    base, cutoff, tickers = load_base_parquet(parquet_path)
    print(f"  parquet     : {parquet_path.name}")
    print(f"  cutoff(동적): {cutoff.date()}  (parquet 데이터 max 날짜)")
    print(f"  종목 수     : {len(tickers)}")

    if today <= cutoff:
        print(f"\n[중단] today({today.date()}) 가 cutoff({cutoff.date()}) 이하 → 신선 구간 없음.")
        sys.exit(1)

    # 2) 신선 OHLCV 수집 + 연속 시계열 구성
    fresh, ok, fail = fetch_fresh_ohlcv(tickers, cutoff, today, fresh_path)
    print(f"  신선 수집   : 성공 {len(ok)}  실패 {len(fail)}"
          + (f"  실패목록={fail}" if fail else ""))
    combined = build_combined(base, fresh, cutoff)

    # 3) 신선 구간 거래일
    dates = fresh_trading_dates(combined, cutoff, today)
    if len(dates) < 2:
        print(f"\n[중단] 신선 거래일이 {len(dates)}일 → 백테스트 불가(최소 2일 필요).")
        sys.exit(1)
    print(f"  신선 구간   : {dates[0].date()} ~ {dates[-1].date()}  (거래일 {len(dates)}일)")
    print(f"  백테스트 대상: {dates[0].date()} ~ {dates[-2].date()} "
          f"(마지막일 {dates[-1].date()} 은 D+1 없어 제외) → {len(dates)-1}일")

    # 4) 모델 번들 1회 로드 (재학습 없음)
    print(f"  체크포인트  : {ckpt_path.name} (그대로 사용, 재학습 없음)")
    bundle = _load_inference_bundle(str(ckpt_path), args.device)

    # 5) 수급 history 수집 (옵션)
    supply_hist: dict[str, list[dict[str, Any]]] | None = None
    if args.no_supply:
        print("  수급 단계   : 생략(--no-supply)")
    else:
        try:
            from config import create_token_manager
            tm = create_token_manager()
            supply_hist = collect_supply_histories(tickers, tm)
            if not supply_hist:
                print("  [WARN] 수급 history 0건 → 수급 전략/ablation 생략")
                supply_hist = None
        except Exception as exc:
            print(f"  [WARN] KIS 토큰/수급 조회 실패: {type(exc).__name__}: {exc} → 수급 생략")
            supply_hist = None

    # 6) 백테스트
    result = run_backtest(
        combined, dates, bundle, supply_hist,
        topk=args.topk, cost_roundtrip=args.cost, ablation_n=args.ablation_n,
        supply_window=args.supply_window, supply_min_pos=args.supply_min_positive_days,
        random_trials=args.random_trials, seed=args.seed,
    )
    n_days = len(result["dates"])
    if n_days == 0:
        print("\n[중단] 유효 백테스트 일수 0 → 결과 없음.")
        sys.exit(1)

    # 7) 지표 요약
    summaries = []
    for key, s in result["strategies"].items():
        summ = summarize(L(s["label_ko"], s["label_en"]), s["gross"], s["net"])
        summ["_label"] = L(s["label_ko"], s["label_en"])
        summ["_color"] = COLORS.get(key, "#333333")
        summ["_key"] = key
        summaries.append(summ)

    # 8) 콘솔 출력
    print(f"\n  유효 백테스트 일수: {n_days}일 (소표본 — 해석 주의)")
    print_summary_table(summaries)

    abl = result["ablation"]
    pr, fr = abl["pass_returns"], abl["fail_returns"]
    print("\n[ablation] 수급 효과 분리 (트랜스포머 상위 "
          f"{args.ablation_n} 내, 다음날 평균수익)")
    if len(pr) or len(fr):
        pm = np.mean(pr) * 100 if len(pr) else float("nan")
        fm = np.mean(fr) * 100 if len(fr) else float("nan")
        print(f"  통과 그룹: 평균 {pm:>7.3f}%  (n={len(pr)})")
        print(f"  탈락 그룹: 평균 {fm:>7.3f}%  (n={len(fr)})")
        if np.isfinite(pm) and np.isfinite(fm):
            diff = pm - fm
            verdict = "수급이 신호를 더한다(통과>탈락)" if diff > 0 else "이 표본에선 효과 불명확"
            print(f"  차이(통과-탈락): {diff:>+7.3f}%p → {verdict}")
    else:
        print("  (수급 데이터 없음 — ablation 생략)")

    # 9) 시각자료 + CSV
    csv_path = outdir / "oot_summary.csv"
    cols = ["strategy", "n_days", "cum_gross", "cum_net", "mean_gross", "mean_net",
            "hit_gross", "hit_net", "sharpe_gross", "sharpe_net"]
    pd.DataFrame([{c: s[c] for c in cols} for s in summaries]).to_csv(
        csv_path, index=False, encoding="utf-8-sig")

    chart_cumulative(result, outdir / "oot_cumulative_return.png", n_days)
    chart_metrics_bar(summaries, outdir / "oot_metrics_bar.png", n_days)
    chart_ablation(abl, outdir / "oot_supply_ablation.png", n_days, args.ablation_n)

    print("\n저장 완료:")
    print(f"  {outdir/'oot_cumulative_return.png'}")
    print(f"  {outdir/'oot_metrics_bar.png'}")
    print(f"  {outdir/'oot_supply_ablation.png'}")
    print(f"  {csv_path}")
    if not KOR_FONT:
        print("\n[참고] 한글 폰트(Malgun Gothic 등) 미탐지 → 차트는 영문 라벨로 출력됨.")


if __name__ == "__main__":
    main()
