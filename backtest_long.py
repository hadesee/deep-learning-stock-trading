# -*- coding: utf-8 -*-
"""
backtest_long.py — 장기 out-of-sample 백테스트 + 상승장/하락장 성과 분리 (발표용)

목적
----
test 50종목(학습에 안 쓴 종목 = 종목기준 out-of-sample)으로 다년 백테스트.
트랜스포머 top-k 전략이
  * 상승장에서 얼마나 수익을 내는지 (up-capture)
  * 하락장에서 얼마나 방어하는지 (down-capture)
를 명확히 보여준다. 발표용 차트·표 생성.

누수 방지
---------
  * transformer_5y.pt 그대로 사용. 재학습 절대 없음.
  * data.py 의 _compute_indicators / FeatureScaler 사용, 스케일러는 체크포인트 것 로드.
  * 날짜 D 예측은 D까지의 20일 윈도우만 사용. 수익률은 다음 거래일 D+1 종가로 측정.

효율 (9년치 → 윈도우 매우 많음)
-------------------------------
  predict.py 를 종목·날짜마다 호출하지 않는다. 대신:
    1) 50종목 각각 _compute_indicators → 가능한 20일 윈도우 전부 생성
    2) 전체 윈도우를 배치(청크)로 모델에 한 번에 통과 → P(up) 일괄 계산
    3) 이후 일별 top-k 선택·수익 계산은 pandas 로.

재사용
------
  predict.py : _load_inference_bundle (모델/스케일러/task/device 1회 로드)
  data.py    : _compute_indicators / FEATURE_COLS / SEQ_LEN / N_FEATURES / FeatureScaler
  model.py   : StockTransformer (predict 경유 로드)
  config.py  : (네트워크 호출 없음 — import 만, 사용 안 함)

수급 제외(명시)
---------------
  수급(KIS inquire-investor)은 최근 ~30거래일 제한이라 다년 백테스트 불가.
  따라서 이 스크립트는 '트랜스포머 단독' 평가만 한다.

integrated_pipeline.py 는 건드리지 않는다.

실행 예시
---------
  python backtest_long.py
  python backtest_long.py --start 2017-01-01 --topk 5 --cost 0.25

출력 (outputs/)
---------------
  backtest_long_cumulative.png   전체기간 누적수익 (전략/시장/무작위)
  backtest_long_regime_bar.png   상승국면 vs 하락국면 누적수익 (전략 vs 시장)
  backtest_long_capture.png      up-capture / down-capture 막대
  backtest_long_summary.csv      전체/상승장/하락장 × 전략별 지표 (gross·net)
"""

from __future__ import annotations

import argparse
import sys
import warnings
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")

BASE_DIR = Path(__file__).resolve().parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

import torch  # noqa: E402

from predict import _load_inference_bundle  # 모델/스케일러/task/device 1회 로드  # noqa: E402
from data import _compute_indicators, FEATURE_COLS, SEQ_LEN, N_FEATURES  # noqa: E402

OHLCV_COLS = ["Open", "High", "Low", "Close", "Volume"]


# ════════════════════════════════════════════════════════════════════════
# 한글 폰트 (Windows: Malgun Gothic, 실패 시 영문 라벨)
# ════════════════════════════════════════════════════════════════════════

import matplotlib  # noqa: E402
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
    return ko if KOR_FONT else en


# ════════════════════════════════════════════════════════════════════════
# 1) 데이터 로드 + 윈도우 일괄 생성
# ════════════════════════════════════════════════════════════════════════

def load_parquet(parquet_path: Path) -> dict[str, pd.DataFrame]:
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

    out: dict[str, pd.DataFrame] = {}
    for ticker, grp in df.groupby("Ticker"):
        out[str(ticker).zfill(6)] = grp[OHLCV_COLS].sort_index().copy()
    return out


def build_all_windows(
    ohlcv: dict[str, pd.DataFrame],
) -> tuple[np.ndarray, pd.DataFrame]:
    """
    전 종목의 모든 유효 20일 윈도우를 생성.

    각 윈도우 = feat[i-SEQ_LEN+1 : i+1]  (predict.py 와 동일: 마지막 SEQ_LEN 행이 D 에서 끝남)
      → 예측 시점 D = dates[i],  다음날 수익률 = (Close[i+1]-Close[i]) / Close[i]
      → 누수 없음: 윈도우는 D 까지만, 수익률은 D+1.

    반환:
      X      : (M, SEQ_LEN, N_FEATURES) float32  — 스케일링 전
      meta   : DataFrame[date, ticker, ret_next]  (행 순서가 X 와 1:1)
                ret_next 는 D+1 이 없으면 NaN (마지막 거래일).
    """
    X_list: list[np.ndarray] = []
    rows: list[dict[str, Any]] = []

    for ticker, g in ohlcv.items():
        g = g.sort_index()
        if len(g) < SEQ_LEN + 1:
            continue
        feat_df = _compute_indicators(g.drop(columns=[c for c in ["Ticker"] if c in g.columns]))
        feat = feat_df[FEATURE_COLS].values.astype(np.float32)
        close = g["Close"].astype(float).values
        dates = g.index

        n = len(feat)
        for i in range(SEQ_LEN - 1, n):
            window = feat[i - SEQ_LEN + 1 : i + 1]
            if window.shape[0] != SEQ_LEN or not np.isfinite(window).all():
                continue
            if i + 1 < n and close[i] > 0:
                ret_next = (close[i + 1] - close[i]) / close[i]
            else:
                ret_next = np.nan  # 마지막 거래일 → D+1 없음
            X_list.append(window)
            rows.append({
                "date": pd.Timestamp(dates[i]).normalize(),
                "ticker": ticker,
                "ret_next": ret_next,
            })

    if not X_list:
        return (np.empty((0, SEQ_LEN, N_FEATURES), dtype=np.float32),
                pd.DataFrame(columns=["date", "ticker", "ret_next"]))

    X = np.stack(X_list).astype(np.float32)
    meta = pd.DataFrame(rows)
    return X, meta


# ════════════════════════════════════════════════════════════════════════
# 2) 배치 추론 (P(up) 일괄)
# ════════════════════════════════════════════════════════════════════════

def batch_predict(bundle: dict[str, Any], X: np.ndarray, batch_size: int) -> np.ndarray:
    """체크포인트 스케일러로 변환 후 청크 단위로 모델 통과 → P(up). 재학습 없음."""
    if len(X) == 0:
        return np.empty(0, dtype=np.float32)

    device = bundle["device"]
    model = bundle["model"]
    scaler = bundle["scaler"]
    task = bundle["task"]

    Xs = scaler.transform(X).astype(np.float32)  # 체크포인트 스케일러 사용
    preds = np.empty(len(Xs), dtype=np.float32)

    model.eval()
    with torch.no_grad():
        for s in range(0, len(Xs), batch_size):
            chunk = torch.from_numpy(Xs[s : s + batch_size]).to(device)
            raw = model(chunk)
            if task == "classification":
                raw = torch.sigmoid(raw)  # P(up)
            preds[s : s + batch_size] = raw.detach().cpu().numpy().ravel()
    return preds


# ════════════════════════════════════════════════════════════════════════
# 3) 일별 전략 수익 구성
# ════════════════════════════════════════════════════════════════════════

def build_daily_returns(
    meta: pd.DataFrame,
    start: pd.Timestamp,
    end: pd.Timestamp | None,
    topk: int,
    random_trials: int,
    seed: int,
) -> pd.DataFrame:
    """
    meta[date,ticker,ret_next,p_up] → 일별 전략 gross 수익 DataFrame.
    반환 index=date, columns=[transformer, market, random, n_names].
    """
    df = meta.dropna(subset=["ret_next", "p_up"]).copy()
    df = df[df["date"] >= start]
    if end is not None:
        df = df[df["date"] <= end]

    rng = np.random.default_rng(seed)
    recs = []
    for D, grp in df.groupby("date"):
        g = grp.sort_values("p_up", ascending=False)
        rets = g["ret_next"].values
        n = len(g)
        if n == 0:
            continue
        kk = min(topk, n)
        tr = float(np.mean(rets[:kk]))                 # 트랜스포머 top-k
        mkt = float(np.mean(rets))                     # 시장(동일가중 전체)
        # 무작위 k (random_trials 평균)
        trials = [np.mean(rng.choice(rets, size=kk, replace=False)) for _ in range(random_trials)]
        rnd = float(np.mean(trials))
        recs.append({"date": D, "transformer": tr, "market": mkt,
                     "random": rnd, "n_names": n})

    out = pd.DataFrame(recs).sort_values("date").set_index("date")
    return out


# ════════════════════════════════════════════════════════════════════════
# 4) 지표
# ════════════════════════════════════════════════════════════════════════

def apply_cost(gross: np.ndarray, cost_roundtrip: float, traded: bool) -> np.ndarray:
    """traded=True(매일 리밸런싱) 면 왕복비용 차감."""
    if not traded:
        return gross.copy()
    return gross - (cost_roundtrip / 100.0)


def cum_return(daily: np.ndarray) -> float:
    return float(np.prod(1.0 + daily) - 1.0) if len(daily) else float("nan")


def cum_curve(daily: np.ndarray) -> np.ndarray:
    return (np.cumprod(1.0 + daily) - 1.0) if len(daily) else np.array([])


def max_drawdown(daily: np.ndarray) -> float:
    """최대낙폭 (음수). 누적 equity 기준."""
    if len(daily) == 0:
        return float("nan")
    eq = np.cumprod(1.0 + daily)
    peak = np.maximum.accumulate(eq)
    dd = eq / peak - 1.0
    return float(dd.min())


def daily_sharpe(daily: np.ndarray) -> float:
    if len(daily) < 2:
        return float("nan")
    sd = np.std(daily, ddof=1)
    return float(np.mean(daily) / sd) if sd > 0 else float("nan")


def hit_rate(daily: np.ndarray) -> float:
    return float(np.mean(daily > 0)) if len(daily) else float("nan")


def metrics(daily: np.ndarray) -> dict[str, float]:
    return {
        "n_days": int(len(daily)),
        "cum": cum_return(daily),
        "mean": float(np.mean(daily)) if len(daily) else float("nan"),
        "hit": hit_rate(daily),
        "sharpe": daily_sharpe(daily),
        "mdd": max_drawdown(daily),
    }


# ════════════════════════════════════════════════════════════════════════
# 5) 상승장/하락장 분리
# ════════════════════════════════════════════════════════════════════════

def regime_labels(market_daily: np.ndarray, ma_window: int) -> np.ndarray:
    """
    시장 누적지수의 ma_window 이동평균 위=상승국면(True), 아래=하락국면(False).
    MA 워밍업(앞 ma_window-1일)은 None(np.nan) 으로 라벨 미정.
    반환: object 배열 [True/False/np.nan]
    """
    idx = np.cumprod(1.0 + market_daily)  # 누적지수
    s = pd.Series(idx)
    ma = s.rolling(ma_window, min_periods=ma_window).mean()
    out = np.full(len(idx), np.nan, dtype=object)
    valid = ma.notna().values
    out[valid] = (s.values[valid] > ma.values[valid])
    return out


def updown_capture(strat: np.ndarray, market: np.ndarray) -> dict[str, float]:
    """
    up-capture   = mean(strat | market>0) / mean(market | market>0)
    down-capture = mean(strat | market<0) / mean(market | market<0)
    (비율; %로 표기 시 ×100)
    """
    up = market > 0
    dn = market < 0
    res = {"up_capture": float("nan"), "down_capture": float("nan"),
           "n_up": int(up.sum()), "n_down": int(dn.sum()),
           "strat_up_mean": float("nan"), "mkt_up_mean": float("nan"),
           "strat_dn_mean": float("nan"), "mkt_dn_mean": float("nan")}
    if up.any():
        sm, mm = float(np.mean(strat[up])), float(np.mean(market[up]))
        res["strat_up_mean"], res["mkt_up_mean"] = sm, mm
        if mm != 0:
            res["up_capture"] = sm / mm
    if dn.any():
        sm, mm = float(np.mean(strat[dn])), float(np.mean(market[dn]))
        res["strat_dn_mean"], res["mkt_dn_mean"] = sm, mm
        if mm != 0:
            res["down_capture"] = sm / mm
    return res


# ════════════════════════════════════════════════════════════════════════
# 6) 차트
# ════════════════════════════════════════════════════════════════════════

COL_TR = "#1f77b4"
COL_MKT = "#7f7f7f"
COL_RND = "#2ca02c"


def _period_caption(dates: pd.DatetimeIndex, n_days: int) -> str:
    return L(
        f"기간 {dates[0].date()} ~ {dates[-1].date()} · {n_days}거래일 · "
        "종목기준 out-of-sample(학습 미사용 50종목)",
        f"{dates[0].date()} ~ {dates[-1].date()} · {n_days} trading days · "
        "out-of-sample (50 held-out tickers)",
    )


def chart_cumulative(daily: pd.DataFrame, regimes: np.ndarray,
                     net: dict[str, np.ndarray], out_path: Path) -> None:
    dates = daily.index
    fig, ax = plt.subplots(figsize=(11, 6))

    # 하락국면 배경 음영
    in_down = False
    span_start = None
    for i, lab in enumerate(regimes):
        is_down = (lab is False)
        if is_down and not in_down:
            in_down, span_start = True, dates[i]
        elif not is_down and in_down:
            ax.axvspan(span_start, dates[i], color="#d62728", alpha=0.06)
            in_down = False
    if in_down:
        ax.axvspan(span_start, dates[-1], color="#d62728", alpha=0.06)

    ax.plot(dates, cum_curve(net["transformer"]) * 100, color=COL_TR, lw=1.8,
            label=L("트랜스포머 top-k", "Transformer top-k"))
    ax.plot(dates, cum_curve(net["market"]) * 100, color=COL_MKT, lw=1.6,
            label=L("기준선: 시장", "Baseline: Market"))
    ax.plot(dates, cum_curve(net["random"]) * 100, color=COL_RND, lw=1.4, alpha=0.9,
            label=L("기준선: 무작위", "Baseline: Random"))
    ax.axhline(0, color="black", lw=0.8, ls="--", alpha=0.5)
    ax.set_title(L("누적수익 (net, 거래비용 차감) — 음영=하락국면",
                   "Cumulative Return (net) — shaded = down regime")
                 + f"\n{_period_caption(dates, len(dates))}", fontsize=12)
    ax.set_xlabel(L("날짜", "Date"))
    ax.set_ylabel(L("누적수익 (%)", "Cumulative return (%)"))
    ax.legend(loc="best")
    ax.grid(True, alpha=0.3)
    fig.autofmt_xdate()
    fig.tight_layout()
    fig.savefig(out_path, dpi=150)
    plt.close(fig)


def chart_regime_bar(regime_stats: dict[str, dict[str, dict[str, float]]],
                     out_path: Path, n_days: int, caption: str) -> None:
    """상승국면 vs 하락국면 누적수익 (전략 vs 시장)."""
    fig, ax = plt.subplots(figsize=(8, 6))
    groups = [L("상승국면", "Up regime"), L("하락국면", "Down regime")]
    tr_vals = [regime_stats["up"]["transformer"]["cum"] * 100,
               regime_stats["down"]["transformer"]["cum"] * 100]
    mkt_vals = [regime_stats["up"]["market"]["cum"] * 100,
                regime_stats["down"]["market"]["cum"] * 100]
    x = np.arange(len(groups))
    w = 0.36
    b1 = ax.bar(x - w / 2, tr_vals, w, color=COL_TR,
                label=L("트랜스포머 top-k", "Transformer top-k"))
    b2 = ax.bar(x + w / 2, mkt_vals, w, color=COL_MKT,
                label=L("시장", "Market"))
    ax.axhline(0, color="black", lw=0.8)
    ax.set_xticks(x)
    ax.set_xticklabels(groups)
    ax.set_ylabel(L("국면 내 누적수익 (net, %)", "In-regime cumulative return (net, %)"))
    ax.set_title(L("상승장/하락장 누적수익: 전략 vs 시장",
                   "Cumulative return by regime: Strategy vs Market")
                 + f"\n{caption}", fontsize=12)
    ax.legend()
    ax.grid(True, axis="y", alpha=0.3)
    for bars in (b1, b2):
        for b in bars:
            v = b.get_height()
            ax.text(b.get_x() + b.get_width() / 2, v, f"{v:.1f}",
                    ha="center", va="bottom" if v >= 0 else "top", fontsize=9)
    fig.tight_layout()
    fig.savefig(out_path, dpi=150)
    plt.close(fig)


def chart_capture(cap_tr: dict[str, float], cap_rnd: dict[str, float],
                  out_path: Path, caption: str) -> None:
    fig, ax = plt.subplots(figsize=(8, 6))
    groups = [L("up-capture\n(상승장 추종)", "up-capture"),
              L("down-capture\n(하락장 방어)", "down-capture")]
    tr_vals = [cap_tr["up_capture"] * 100, cap_tr["down_capture"] * 100]
    rnd_vals = [cap_rnd["up_capture"] * 100, cap_rnd["down_capture"] * 100]
    x = np.arange(len(groups))
    w = 0.36
    b1 = ax.bar(x - w / 2, tr_vals, w, color=COL_TR,
                label=L("트랜스포머 top-k", "Transformer top-k"))
    b2 = ax.bar(x + w / 2, rnd_vals, w, color=COL_RND,
                label=L("무작위", "Random"))
    ax.axhline(100, color="black", lw=0.9, ls="--", alpha=0.7)
    ax.text(ax.get_xlim()[1], 100, L(" 100%=시장과 동일", " 100% = market"),
            va="bottom", ha="right", fontsize=8, color="black")
    ax.set_xticks(x)
    ax.set_xticklabels(groups)
    ax.set_ylabel(L("캡처율 (%)", "Capture ratio (%)"))
    ax.set_title(L("Up / Down Capture (높을수록 상승추종, 낮을수록 하락방어)",
                   "Up / Down Capture (high up-capture, low down-capture is best)")
                 + f"\n{caption}", fontsize=11.5)
    ax.legend()
    ax.grid(True, axis="y", alpha=0.3)
    for bars in (b1, b2):
        for b in bars:
            v = b.get_height()
            if np.isfinite(v):
                ax.text(b.get_x() + b.get_width() / 2, v, f"{v:.0f}",
                        ha="center", va="bottom" if v >= 0 else "top", fontsize=9)
    fig.tight_layout()
    fig.savefig(out_path, dpi=150)
    plt.close(fig)


# ════════════════════════════════════════════════════════════════════════
# 7) main
# ════════════════════════════════════════════════════════════════════════

def _seg_metrics(net: dict[str, np.ndarray], gross: dict[str, np.ndarray],
                 mask: np.ndarray) -> dict[str, dict[str, float]]:
    out = {}
    for key in ("transformer", "market", "random"):
        out[key] = {"net": metrics(net[key][mask]), "gross": metrics(gross[key][mask])}
    return out


def main() -> None:
    p = argparse.ArgumentParser(description="장기 out-of-sample 백테스트 + 상승장/하락장 분리")
    p.add_argument("--parquet", default=str(BASE_DIR / "shared_test_raw.parquet"))
    p.add_argument("--ckpt", default=str(BASE_DIR / "transformer_5y.pt"))
    p.add_argument("--outdir", default=str(BASE_DIR / "outputs"))
    p.add_argument("--start", default="2017-01-01", help="백테스트 시작일")
    p.add_argument("--end", default=None, help="백테스트 종료일(기본: 데이터 끝)")
    p.add_argument("--topk", type=int, default=5)
    p.add_argument("--cost", type=float, default=0.25, help="왕복 거래비용 %")
    p.add_argument("--ma-window", type=int, default=60, help="국면 판정 이동평균 길이")
    p.add_argument("--random-trials", type=int, default=200)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--batch-size", type=int, default=4096)
    p.add_argument("--device", default="cpu")
    args = p.parse_args()

    parquet_path = Path(args.parquet)
    ckpt_path = Path(args.ckpt)
    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    start = pd.Timestamp(args.start).normalize()
    end = pd.Timestamp(args.end).normalize() if args.end else None

    print("=" * 70)
    print("장기 OUT-OF-SAMPLE 백테스트 (트랜스포머 단독, 수급 제외)")
    print("=" * 70)

    # 1) 데이터 + 윈도우 일괄 생성
    ohlcv = load_parquet(parquet_path)
    print(f"  parquet : {parquet_path.name}  | 종목 수: {len(ohlcv)}")
    X, meta = build_all_windows(ohlcv)
    print(f"  윈도우  : {len(X):,}개 (전 종목·전 거래일, 누수 없는 20일 윈도우)")
    if len(X) == 0:
        print("[중단] 윈도우 0개.")
        sys.exit(1)

    # 2) 모델 1회 로드 + 배치 추론
    print(f"  체크포인트: {ckpt_path.name} (그대로 사용, 재학습 없음)")
    bundle = _load_inference_bundle(str(ckpt_path), args.device)
    print(f"  배치 추론 중... (batch_size={args.batch_size}, task={bundle['task']})")
    meta["p_up"] = batch_predict(bundle, X, args.batch_size)

    # 3) 일별 전략 수익
    daily = build_daily_returns(meta, start, end, args.topk, args.random_trials, args.seed)
    if len(daily) < 2:
        print(f"[중단] 백테스트 거래일 {len(daily)}일.")
        sys.exit(1)
    dates = daily.index
    n_days = len(daily)
    print(f"  기간    : {dates[0].date()} ~ {dates[-1].date()}  (거래일 {n_days}일)")

    gross = {k: daily[k].values.astype(float) for k in ("transformer", "market", "random")}
    net = {
        "transformer": apply_cost(gross["transformer"], args.cost, traded=True),
        "market": apply_cost(gross["market"], args.cost, traded=True),
        "random": apply_cost(gross["random"], args.cost, traded=True),
    }

    # 4) 국면 라벨 (시장 net 기준 누적지수의 MA)
    regimes = regime_labels(net["market"], args.ma_window)
    up_mask = np.array([r is True for r in regimes])
    dn_mask = np.array([r is False for r in regimes])
    all_mask = np.ones(n_days, dtype=bool)

    seg = {
        "overall": _seg_metrics(net, gross, all_mask),
        "up": _seg_metrics(net, gross, up_mask),
        "down": _seg_metrics(net, gross, dn_mask),
    }

    # 국면별 차트는 net cum 사용
    regime_cum = {
        "up": {k: {"cum": cum_return(net[k][up_mask])} for k in ("transformer", "market")},
        "down": {k: {"cum": cum_return(net[k][dn_mask])} for k in ("transformer", "market")},
    }

    # 5) up/down-capture (net 기준)
    cap_tr = updown_capture(net["transformer"], net["market"])
    cap_rnd = updown_capture(net["random"], net["market"])

    # 6) 콘솔 출력
    def _line(name, m):
        return (f"    {name:<16} 누적 {m['cum']*100:>8.2f}%  "
                f"일평균 {m['mean']*100:>7.3f}%  적중 {m['hit']*100:>5.1f}%  "
                f"샤프 {m['sharpe']:>6.3f}  MDD {m['mdd']*100:>7.2f}%")

    label = {"transformer": L("트랜스포머", "Transformer"),
             "market": L("시장", "Market"), "random": L("무작위", "Random")}
    print(f"\n  국면 일수: 상승 {int(up_mask.sum())}일 / 하락 {int(dn_mask.sum())}일 / "
          f"미정(MA워밍업) {n_days - int(up_mask.sum()) - int(dn_mask.sum())}일")

    print("\n[전체기간] (net)")
    for k in ("transformer", "market", "random"):
        print(_line(label[k], seg["overall"][k]["net"]))
    print("\n[상승국면] (net)")
    for k in ("transformer", "market", "random"):
        print(_line(label[k], seg["up"][k]["net"]))
    print("\n[하락국면] (net)")
    for k in ("transformer", "market", "random"):
        print(_line(label[k], seg["down"][k]["net"]))

    print("\n[Up/Down Capture] (net, 트랜스포머)")
    print(f"    up-capture   = {cap_tr['up_capture']*100:>7.1f}%  "
          f"(상승일 {cap_tr['n_up']}일: 전략 {cap_tr['strat_up_mean']*100:.3f}% / "
          f"시장 {cap_tr['mkt_up_mean']*100:.3f}%)")
    print(f"    down-capture = {cap_tr['down_capture']*100:>7.1f}%  "
          f"(하락일 {cap_tr['n_down']}일: 전략 {cap_tr['strat_dn_mean']*100:.3f}% / "
          f"시장 {cap_tr['mkt_dn_mean']*100:.3f}%)")
    print(L("    → up-capture 높고 down-capture 낮을수록 좋음 (상승추종+하락방어)",
            "    → high up-capture, low down-capture is best"))

    # 7) CSV
    rows = []
    seg_name = {"overall": L("전체", "Overall"), "up": L("상승국면", "Up regime"),
                "down": L("하락국면", "Down regime")}
    for seg_key in ("overall", "up", "down"):
        for k in ("transformer", "market", "random"):
            mn, mg = seg[seg_key][k]["net"], seg[seg_key][k]["gross"]
            rows.append({
                "segment": seg_name[seg_key], "strategy": label[k],
                "n_days": mn["n_days"],
                "cum_gross": mg["cum"], "cum_net": mn["cum"],
                "mean_gross": mg["mean"], "mean_net": mn["mean"],
                "hit_gross": mg["hit"], "hit_net": mn["hit"],
                "sharpe_gross": mg["sharpe"], "sharpe_net": mn["sharpe"],
                "mdd_gross": mg["mdd"], "mdd_net": mn["mdd"],
            })
    # capture 행 추가
    rows.append({
        "segment": L("캡처(net)", "Capture(net)"), "strategy": label["transformer"],
        "n_days": cap_tr["n_up"] + cap_tr["n_down"],
        "cum_gross": np.nan, "cum_net": np.nan,
        "mean_gross": np.nan, "mean_net": np.nan,
        "hit_gross": np.nan, "hit_net": np.nan,
        "sharpe_gross": cap_tr["up_capture"], "sharpe_net": cap_tr["down_capture"],
        "mdd_gross": np.nan, "mdd_net": np.nan,
    })
    csv_path = outdir / "backtest_long_summary.csv"
    pd.DataFrame(rows).to_csv(csv_path, index=False, encoding="utf-8-sig")

    # 8) 차트
    caption = _period_caption(dates, n_days)
    chart_cumulative(daily, regimes, net, outdir / "backtest_long_cumulative.png")
    chart_regime_bar(regime_cum, outdir / "backtest_long_regime_bar.png", n_days, caption)
    chart_capture(cap_tr, cap_rnd, outdir / "backtest_long_capture.png", caption)

    print("\n저장 완료:")
    for f in ("backtest_long_cumulative.png", "backtest_long_regime_bar.png",
              "backtest_long_capture.png", "backtest_long_summary.csv"):
        print(f"  {outdir / f}")
    if not KOR_FONT:
        print("\n[참고] 한글 폰트 미탐지 → 차트 영문 라벨 출력.")


if __name__ == "__main__":
    main()
