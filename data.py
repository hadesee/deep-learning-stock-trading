# -*- coding: utf-8 -*-
"""
data.py

LEAK-GUARD:
  [1] Indicators computed on full period; slicing at window-generation stage
  [2] Volume rolling z-score is causal (past-only)
  [3] Scaler fit ONLY on train slice
  [4] Target = next-day return after window's last day (no future leakage)

BUG FIXES:
  [FIX-1] OHLC 0->NaN before log (prevents -inf); window valid check: isfinite
  [FIX-5] Target index: target[i-1] not target[i] (off-by-one alignment fix)
  [FIX-6] RSI: pure-gain->100, no-change->50 (prevents spurious NaN windows)
  [FIX-8] load_all_data / prepare_datasets_from_dfs split (compute indicators once)

DATE-SPLIT ALIGNMENT (agreed with friend):
  Eval window (val/test): target date in [EVAL_START, EVAL_END]
  Train window          : target date in [TRAIN_START[years], EVAL_END]
  Input 20-day window may reach before EVAL_START/TRAIN_START -- only target date
  is filtered, so the very first eval day is never dropped due to warmup.
  Train/val/test tickers are fully disjoint -> no leakage even though date ranges overlap.
"""

import logging
import warnings
from typing import Optional, Tuple

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore", category=RuntimeWarning)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Date-split constants (agreed with friend)
# ---------------------------------------------------------------------------
EVAL_START  = "2025-06-01"   # val/test target-date lower bound (inclusive)
EVAL_END    = "2026-05-31"   # val/test target-date upper bound (inclusive)
TRAIN_START = {              # train target-date lower bound per year-variant
    1:  "2025-06-01",
    5:  "2021-06-01",
    10: "2016-06-01",
}

FEATURE_COLS = [
    "f_open", "f_high", "f_low", "f_close",
    "f_volume",
    "f_rsi",
    "f_macd", "f_macd_signal",
    "f_pct_b", "f_norm_bw", "f_rel_bw",
]
N_FEATURES = len(FEATURE_COLS)
SEQ_LEN = 20


# ---------------------------------------------------------------------------
# Indicator helpers
# ---------------------------------------------------------------------------

def _rsi(close: pd.Series, period: int = 14) -> pd.Series:
    """[FIX-6] pure-gain->100; no-change->50."""
    delta    = close.diff()
    gain     = delta.clip(lower=0)
    loss     = (-delta).clip(lower=0)
    avg_gain = gain.ewm(com=period - 1, min_periods=period).mean()
    avg_loss = loss.ewm(com=period - 1, min_periods=period).mean()
    has_data  = avg_gain.notna() & avg_loss.notna()
    pure_gain = has_data & (avg_loss == 0) & (avg_gain > 0)
    both_zero = has_data & (avg_gain == 0) & (avg_loss == 0)
    rs  = avg_gain / avg_loss.replace(0, np.nan)
    rsi = 100 - 100 / (1 + rs)
    rsi[pure_gain] = 100.0
    rsi[both_zero] = 50.0
    return rsi


def _ema(s: pd.Series, span: int) -> pd.Series:
    return s.ewm(span=span, adjust=False).mean()


def _compute_indicators(df: pd.DataFrame) -> pd.DataFrame:
    """[FIX-1] 0-price -> NaN. [LEAK-GUARD-1] full period before any slicing."""
    df = df.sort_index()
    open_  = df["Open"].astype(float).replace(0, np.nan)
    high   = df["High"].astype(float).replace(0, np.nan)
    low    = df["Low"].astype(float).replace(0, np.nan)
    close  = df["Close"].astype(float).replace(0, np.nan)
    vol    = df["Volume"].astype(float)

    prev_close = close.shift(1)
    df["f_open"]  = np.log(open_  / prev_close)
    df["f_high"]  = np.log(high   / prev_close)
    df["f_low"]   = np.log(low    / prev_close)
    df["f_close"] = np.log(close  / prev_close)

    # [LEAK-GUARD-2] causal rolling z-score
    log_vol   = np.log1p(vol)
    roll_mean = log_vol.rolling(60, min_periods=1).mean()
    roll_std  = log_vol.rolling(60, min_periods=1).std()
    df["f_volume"] = (log_vol - roll_mean) / roll_std.replace(0, np.nan)

    df["f_rsi"] = _rsi(close) / 100.0

    macd_line   = _ema(close, 12) - _ema(close, 26)
    macd_signal = _ema(macd_line, 9)
    df["f_macd"]        = macd_line   / close
    df["f_macd_signal"] = macd_signal / close

    sma20    = close.rolling(20).mean()
    std20    = close.rolling(20).std()
    bb_upper = sma20 + 2 * std20
    bb_lower = sma20 - 2 * std20
    bb_width = bb_upper - bb_lower
    bw_range = (bb_upper - bb_lower).replace(0, np.nan)
    df["f_pct_b"]   = (close - bb_lower) / bw_range
    df["f_norm_bw"] = bw_range / sma20.replace(0, np.nan)
    df["f_rel_bw"]  = bb_width / close
    return df


# ---------------------------------------------------------------------------
# Load helpers
# ---------------------------------------------------------------------------

def load_and_engineer(parquet_path: str) -> pd.DataFrame:
    """Load parquet; compute all indicators on full period. [LEAK-GUARD-1]"""
    df = pd.read_parquet(parquet_path).sort_index()
    parts = [_compute_indicators(grp) for _, grp in df.groupby("Ticker", sort=False)]
    return pd.concat(parts).sort_index()


def load_all_data(
    train_path: str, val_path: str, test_path: str
) -> Tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """[FIX-8] Compute indicators ONCE; reuse for all year variants."""
    logger.info("Loading data and computing indicators (once)...")
    result = (
        load_and_engineer(train_path),
        load_and_engineer(val_path),
        load_and_engineer(test_path),
    )
    logger.info("Data load complete.")
    return result


# ---------------------------------------------------------------------------
# Window generation  (date-range based)
# ---------------------------------------------------------------------------

def _make_windows_for_ticker(
    grp: pd.DataFrame,
    target_start: Optional[str] = None,
    target_end:   Optional[str] = None,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    [FIX-5] window = feat[i-SEQ_LEN:i], target = target[i-1] (day i-1->day i return)
    [FIX-1] isfinite check (catches inf from log(0) too)
    [LEAK-GUARD-4] target uses close[i] which is AFTER window end. No leakage.

    target_start / target_end : only TARGET dates (tgt_date = dates[i]) are filtered.
    The 20-day input window may use rows before target_start -- this is intentional
    so that the very first day of the eval period has a full 20-day context.
    """
    grp   = grp.sort_index()
    feat  = grp[FEATURE_COLS].values
    dates = grp.index
    close = grp["Close"].astype(float).values

    # Convert bounds once
    ts = pd.Timestamp(target_start) if target_start else None
    te = pd.Timestamp(target_end)   if target_end   else None

    target      = np.empty(len(close))
    target[:-1] = (close[1:] - close[:-1]) / close[:-1]
    target[-1]  = np.nan
    target      = np.clip(target, -0.30, 0.30)

    Xs, ys, ds = [], [], []
    for i in range(SEQ_LEN, len(feat)):
        tgt_val  = target[i - 1]            # [FIX-5]
        tgt_date = dates[i]

        # Date filter (on TARGET date only, not on window rows)
        if ts is not None and tgt_date < ts:
            continue
        if te is not None and tgt_date > te:
            continue

        if not np.isfinite(tgt_val):        # [FIX-1]
            continue
        window = feat[i - SEQ_LEN : i]
        if not np.isfinite(window).all():   # [FIX-1]
            continue

        Xs.append(window)
        ys.append(tgt_val)
        ds.append(tgt_date)

    if not Xs:
        return (
            np.empty((0, SEQ_LEN, N_FEATURES), dtype=np.float32),
            np.empty(0, dtype=np.float32),
            np.array([]),
        )
    return (
        np.array(Xs, dtype=np.float32),
        np.array(ys, dtype=np.float32),
        np.array(ds),
    )


def make_windows(
    df: pd.DataFrame,
    target_start: Optional[str] = None,
    target_end:   Optional[str] = None,
    split_name:   str = "data",
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Generate windows for all tickers in df, filtering by target-date range.
    Tickers with zero qualifying windows are skipped and logged.
    """
    all_X, all_y, all_d = [], [], []
    skipped = 0
    for ticker, grp in df.groupby("Ticker"):
        X, y, d = _make_windows_for_ticker(grp, target_start, target_end)
        if len(X) == 0:
            logger.warning(f"[{split_name}] Ticker {ticker}: no windows, skipped")
            skipped += 1
            continue
        all_X.append(X); all_y.append(y); all_d.append(d)

    n_total = sum(len(x) for x in all_X) if all_X else 0
    ts_str = target_start or "any"
    te_str = target_end   or "any"
    logger.info(f"[{split_name}] target=[{ts_str}, {te_str}]  "
                f"skipped={skipped}  total={n_total}")

    if not all_X:
        return (
            np.empty((0, SEQ_LEN, N_FEATURES), dtype=np.float32),
            np.empty(0, dtype=np.float32),
            np.array([]),
        )
    return (
        np.concatenate(all_X, axis=0),
        np.concatenate(all_y, axis=0),
        np.concatenate(all_d, axis=0),
    )


# ---------------------------------------------------------------------------
# Scaler
# ---------------------------------------------------------------------------

class FeatureScaler:
    """Per-feature z-score. MUST fit only on train slice. [LEAK-GUARD-3]"""

    def __init__(self):
        self.mean_: Optional[np.ndarray] = None
        self.std_:  Optional[np.ndarray] = None

    def fit(self, X: np.ndarray) -> "FeatureScaler":
        flat = X.reshape(-1, X.shape[-1])
        self.mean_ = flat.mean(axis=0)
        self.std_  = flat.std(axis=0)
        self.std_[self.std_ < 1e-8] = 1.0
        return self

    def transform(self, X: np.ndarray) -> np.ndarray:
        return (X - self.mean_) / self.std_

    def fit_transform(self, X: np.ndarray) -> np.ndarray:
        return self.fit(X).transform(X)

    def state_dict(self) -> dict:
        return {"mean": self.mean_, "std": self.std_}

    def load_state_dict(self, d: dict):
        self.mean_ = d["mean"]; self.std_ = d["std"]


# ---------------------------------------------------------------------------
# PyTorch Dataset
# ---------------------------------------------------------------------------

import torch
from torch.utils.data import Dataset


class StockDataset(Dataset):
    def __init__(self, X: np.ndarray, y: np.ndarray):
        self.X = torch.from_numpy(X); self.y = torch.from_numpy(y)
    def __len__(self): return len(self.X)
    def __getitem__(self, idx): return self.X[idx], self.y[idx]


# ---------------------------------------------------------------------------
# Prepare datasets (per-year, from pre-computed DataFrames)
# ---------------------------------------------------------------------------

def prepare_datasets_from_dfs(
    train_df: pd.DataFrame,
    val_df:   pd.DataFrame,
    test_df:  pd.DataFrame,
    years: int,
) -> Tuple[StockDataset, StockDataset, StockDataset,
           FeatureScaler, np.ndarray, np.ndarray]:
    """
    Train: target in [TRAIN_START[years], EVAL_END]
    Val  : target in [EVAL_START, EVAL_END]   (fixed for all year variants)
    Test : target in [EVAL_START, EVAL_END]   (fixed for all year variants)

    [LEAK-GUARD-3] Scaler fit ONLY on this year's train slice.
    Tickers are fully disjoint across splits, so overlapping date ranges are fine.
    """
    logger.info(f"[prepare] {years}y model  "
                f"train=[{TRAIN_START[years]}, {EVAL_END}]  "
                f"val/test=[{EVAL_START}, {EVAL_END}]")

    X_tr, y_tr, _     = make_windows(train_df,
                                     target_start=TRAIN_START[years],
                                     target_end=EVAL_END,
                                     split_name=f"train_{years}y")
    X_va, y_va, d_va  = make_windows(val_df,
                                     target_start=EVAL_START,
                                     target_end=EVAL_END,
                                     split_name="val")
    X_te, y_te, d_te  = make_windows(test_df,
                                     target_start=EVAL_START,
                                     target_end=EVAL_END,
                                     split_name="test")

    # [LEAK-GUARD-3] scaler fit on train only
    scaler = FeatureScaler()
    X_tr   = scaler.fit_transform(X_tr)
    X_va   = scaler.transform(X_va)
    X_te   = scaler.transform(X_te)

    logger.info(f"[prepare] train={len(X_tr)}, val={len(X_va)}, test={len(X_te)}")
    return (
        StockDataset(X_tr, y_tr),
        StockDataset(X_va, y_va),
        StockDataset(X_te, y_te),
        scaler, d_va, d_te,
    )


def prepare_datasets(
    train_path: str, val_path: str, test_path: str, years: int,
) -> Tuple[StockDataset, StockDataset, StockDataset,
           FeatureScaler, np.ndarray, np.ndarray]:
    """Convenience wrapper (computes indicators inline)."""
    tr, va, te = load_all_data(train_path, val_path, test_path)
    return prepare_datasets_from_dfs(tr, va, te, years)
