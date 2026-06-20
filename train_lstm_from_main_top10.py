"""
Train an LSTM using the TOP N stocks selected by main.py/config.py.

Flow:
1) main.py scans KOSPI200 using KIS quote API and selects TOP N by volume/trading value.
2) This script downloads historical OHLCV for those selected tickers with pykrx.
3) It builds the same ratio/indicator features used by the existing LSTM pipeline.
4) It trains an LSTM to predict next-day return.
5) It saves:
   - selected_top_stocks.csv
   - step2_kospi200_indicators.parquet
   - lstm_stock_model_top10.pth, or your chosen output name

Required:
    pip install pykrx pandas numpy torch scikit-learn python-dotenv requests pyarrow

Required env for KIS scan:
    APP_KEY, APP_SECRET
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import random
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import torch
import torch.nn as nn
from sklearn.preprocessing import RobustScaler


BASE_DIR = Path(__file__).resolve().parent


FEATURES_10 = [
    "Open_Gap",
    "High_Ratio",
    "Low_Ratio",
    "Close_Return",
    "Volume",
    "RSI",
    "MACD",
    "MACD_Signal",
    "BBU_20_2.0_2.0",
    "BBL_20_2.0_2.0",
]
FEATURES_11 = FEATURES_10 + ["BBB_20_2.0_2.0"]


class LSTMModel(nn.Module):
    def __init__(self, input_size: int, hidden_size: int = 64, num_layers: int = 2):
        super().__init__()
        self.lstm = nn.LSTM(input_size, hidden_size, num_layers, batch_first=True)
        self.fc = nn.Linear(hidden_size, 1)

    def forward(self, x):
        out, _ = self.lstm(x)
        return self.fc(out[:, -1, :])


@dataclass
class TrainSummary:
    top_n: int
    tickers: list[str]
    feature_count: int
    sequence_length: int
    train_samples: int
    valid_samples: int
    epochs: int
    best_valid_loss: float
    model_output: str
    indicator_output: str


def set_seed(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def import_module_from_path(module_name: str, path: str | Path):
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"module file not found: {path}")
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"failed to load spec: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def ensure_config_imported(config_module_path: str | Path) -> None:
    # main.py imports `config`, so register the selected config file first.
    import_module_from_path("config", config_module_path)


def normalize_ticker(value: Any) -> str:
    return str(value).strip().zfill(6)


def scan_top_stocks(main_module_path: str | Path, config_module_path: str | Path, top_n: int, sort_column: str) -> pd.DataFrame:
    ensure_config_imported(config_module_path)
    main_mod = import_module_from_path("kis_main_scan_module", main_module_path)

    if not hasattr(main_mod, "scan_kospi200"):
        raise AttributeError(f"{main_module_path} does not define scan_kospi200()")

    try:
        top_df = main_mod.scan_kospi200(top_n=top_n, sort_column=sort_column)
    except TypeError:
        # Backward compatibility with older main.py.
        top_df = main_mod.scan_kospi200().head(top_n).copy()
        if sort_column in top_df.columns:
            top_df = top_df.sort_values(sort_column, ascending=False).head(top_n).copy()

    if top_df is None or top_df.empty:
        raise RuntimeError("scan_kospi200() returned empty result")

    if "종목코드" not in top_df.columns:
        raise ValueError("main.py result must include '종목코드'")

    top_df = top_df.head(top_n).copy()
    top_df["ticker"] = top_df["종목코드"].map(normalize_ticker)
    if "종목명" in top_df.columns:
        top_df["company_name"] = top_df["종목명"].astype(str)
    else:
        top_df["company_name"] = top_df["ticker"]
    return top_df


def calc_rsi(close: pd.Series, period: int = 14) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    rsi = 100 - (100 / (1 + rs))
    return rsi.fillna(50)


def add_indicators(stock_df: pd.DataFrame) -> pd.DataFrame:
    df = stock_df.sort_index().copy()

    df["Prev_Close"] = df["Close"].shift(1)
    df["Close_Return"] = (df["Close"] / df["Prev_Close"]) - 1
    df["Open_Gap"] = (df["Open"] / df["Prev_Close"]) - 1
    df["High_Ratio"] = (df["High"] / df["Open"]) - 1
    df["Low_Ratio"] = (df["Low"] / df["Open"]) - 1

    df["RSI"] = calc_rsi(df["Close"], period=14)

    ema12 = df["Close"].ewm(span=12, adjust=False).mean()
    ema26 = df["Close"].ewm(span=26, adjust=False).mean()
    df["MACD"] = ema12 - ema26
    df["MACD_Signal"] = df["MACD"].ewm(span=9, adjust=False).mean()

    ma20 = df["Close"].rolling(20).mean()
    std20 = df["Close"].rolling(20).std()
    df["BBU_20_2.0_2.0"] = ma20 + 2.0 * std20
    df["BBL_20_2.0_2.0"] = ma20 - 2.0 * std20
    df["BBB_20_2.0_2.0"] = (df["BBU_20_2.0_2.0"] - df["BBL_20_2.0_2.0"]) / ma20.replace(0, np.nan)

    df["Target_Return"] = (df["Close"].shift(-1) / df["Close"]) - 1
    return df.replace([np.inf, -np.inf], np.nan).dropna()


def fetch_history_for_tickers(tickers: list[str], years: int, sleep_sec: float = 0.2) -> pd.DataFrame:
    try:
        from pykrx import stock
    except ImportError as exc:
        raise ImportError("pykrx가 필요합니다. 먼저 `pip install pykrx`를 실행하세요.") from exc

    import time

    end = datetime.now()
    start = end - timedelta(days=int(years * 365.25))
    start_yyyymmdd = start.strftime("%Y%m%d")
    end_yyyymmdd = end.strftime("%Y%m%d")

    frames: list[pd.DataFrame] = []
    for i, ticker in enumerate(tickers, start=1):
        print(f"[INFO] history download {i}/{len(tickers)}: {ticker}")
        raw = stock.get_market_ohlcv_by_date(start_yyyymmdd, end_yyyymmdd, ticker)
        if raw is None or raw.empty:
            print(f"[WARN] no history: {ticker}")
            continue

        df = raw.rename(
            columns={
                "시가": "Open",
                "고가": "High",
                "저가": "Low",
                "종가": "Close",
                "거래량": "Volume",
            }
        )
        required = ["Open", "High", "Low", "Close", "Volume"]
        missing = [c for c in required if c not in df.columns]
        if missing:
            print(f"[WARN] missing columns for {ticker}: {missing}")
            continue

        df = df[required].copy()
        df.index = pd.to_datetime(df.index)
        df["Ticker"] = ticker
        df = add_indicators(df)
        frames.append(df)
        time.sleep(sleep_sec)

    if not frames:
        raise RuntimeError("No historical data downloaded")

    all_df = pd.concat(frames).sort_index()
    all_df["Ticker"] = all_df["Ticker"].astype(str).str.zfill(6)
    return all_df


def build_samples(indicator_df: pd.DataFrame, features: list[str], sequence_length: int) -> tuple[np.ndarray, np.ndarray, pd.DataFrame]:
    xs: list[np.ndarray] = []
    ys: list[float] = []
    meta_rows: list[dict[str, Any]] = []

    for ticker, stock_df in indicator_df.groupby("Ticker"):
        stock_df = stock_df.sort_index().copy()
        missing = [c for c in features + ["Target_Return"] if c not in stock_df.columns]
        if missing:
            print(f"[WARN] skip {ticker}, missing: {missing}")
            continue

        for end_idx in range(sequence_length, len(stock_df)):
            window = stock_df.iloc[end_idx - sequence_length : end_idx].copy()
            target = stock_df.iloc[end_idx]["Target_Return"]
            if pd.isna(target):
                continue

            window["Volume"] = np.log1p(window["Volume"])
            try:
                scaled = RobustScaler().fit_transform(window[features])
            except ValueError:
                continue

            if not np.isfinite(scaled).all() or not np.isfinite(target):
                continue

            xs.append(scaled.astype(np.float32))
            ys.append(float(target))
            meta_rows.append(
                {
                    "ticker": ticker,
                    "base_date": stock_df.index[end_idx - 1].strftime("%Y-%m-%d"),
                    "target_date": stock_df.index[end_idx].strftime("%Y-%m-%d"),
                    "target_return": float(target),
                }
            )

    if not xs:
        raise RuntimeError("No LSTM samples were built. Check history length and features.")

    return np.stack(xs), np.array(ys, dtype=np.float32).reshape(-1, 1), pd.DataFrame(meta_rows)


def train_model(
    x: np.ndarray,
    y: np.ndarray,
    input_size: int,
    epochs: int,
    batch_size: int,
    lr: float,
    valid_ratio: float,
    seed: int,
    device: torch.device,
) -> tuple[LSTMModel, float, int, int]:
    n = len(x)
    indices = np.arange(n)
    rng = np.random.default_rng(seed)
    rng.shuffle(indices)

    valid_size = max(1, int(n * valid_ratio))
    valid_idx = indices[:valid_size]
    train_idx = indices[valid_size:]

    x_train = torch.tensor(x[train_idx], dtype=torch.float32).to(device)
    y_train = torch.tensor(y[train_idx], dtype=torch.float32).to(device)
    x_valid = torch.tensor(x[valid_idx], dtype=torch.float32).to(device)
    y_valid = torch.tensor(y[valid_idx], dtype=torch.float32).to(device)

    model = LSTMModel(input_size=input_size, hidden_size=64, num_layers=2).to(device)
    optimizer = torch.optim.Adam(model.parameters(), lr=lr)
    criterion = nn.MSELoss()

    best_state = None
    best_valid_loss = float("inf")

    for epoch in range(1, epochs + 1):
        model.train()
        perm = torch.randperm(len(x_train), device=device)
        train_losses: list[float] = []

        for start in range(0, len(x_train), batch_size):
            batch_idx = perm[start : start + batch_size]
            bx = x_train[batch_idx]
            by = y_train[batch_idx]

            optimizer.zero_grad()
            pred = model(bx)
            loss = criterion(pred, by)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
            optimizer.step()
            train_losses.append(float(loss.item()))

        model.eval()
        with torch.no_grad():
            valid_loss = float(criterion(model(x_valid), y_valid).item())

        if valid_loss < best_valid_loss:
            best_valid_loss = valid_loss
            best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}

        if epoch == 1 or epoch % 5 == 0 or epoch == epochs:
            train_loss = float(np.mean(train_losses)) if train_losses else float("nan")
            print(f"[TRAIN] epoch {epoch:03d}/{epochs} | train_loss={train_loss:.8f} | valid_loss={valid_loss:.8f}")

    if best_state is not None:
        model.load_state_dict(best_state)
    return model, best_valid_loss, len(train_idx), len(valid_idx)


def run(args: argparse.Namespace) -> None:
    set_seed(args.seed)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    print("[STEP 1] main.py/config.py로 TOP 종목 스캔")
    top_df = scan_top_stocks(
        main_module_path=args.main_module,
        config_module_path=args.config_module,
        top_n=args.top,
        sort_column=args.sort_column,
    )
    selected_csv = output_dir / "selected_top_stocks.csv"
    top_df.to_csv(selected_csv, index=False, encoding="utf-8-sig")
    tickers = top_df["ticker"].tolist()
    print(f"[DONE] selected tickers: {', '.join(tickers)}")
    print(f"[DONE] saved: {selected_csv}")

    print("[STEP 2] 선택 종목 과거 OHLCV 다운로드 + 지표 생성")
    indicator_df = fetch_history_for_tickers(tickers, years=args.years, sleep_sec=args.history_sleep_sec)
    indicator_output = Path(args.indicator_output)
    if not indicator_output.is_absolute():
        indicator_output = output_dir / indicator_output
    indicator_df.to_parquet(indicator_output)
    print(f"[DONE] indicator parquet saved: {indicator_output}")

    features = FEATURES_11 if args.feature_count == 11 else FEATURES_10
    print(f"[STEP 3] LSTM 학습 샘플 생성: feature_count={len(features)}, sequence_length={args.sequence_length}")
    x, y, sample_meta = build_samples(indicator_df, features=features, sequence_length=args.sequence_length)
    sample_meta_output = output_dir / "lstm_training_samples_meta.csv"
    sample_meta.to_csv(sample_meta_output, index=False, encoding="utf-8-sig")
    print(f"[DONE] samples: {len(x):,} | meta saved: {sample_meta_output}")

    print("[STEP 4] LSTM 학습")
    device = torch.device("cuda" if torch.cuda.is_available() and not args.cpu else "cpu")
    print(f"[INFO] device: {device}")
    model, best_valid_loss, train_n, valid_n = train_model(
        x=x,
        y=y,
        input_size=len(features),
        epochs=args.epochs,
        batch_size=args.batch_size,
        lr=args.lr,
        valid_ratio=args.valid_ratio,
        seed=args.seed,
        device=device,
    )

    model_output = Path(args.model_output)
    if not model_output.is_absolute():
        model_output = output_dir / model_output
    torch.save(model.state_dict(), model_output)
    print(f"[DONE] model saved: {model_output}")

    summary = TrainSummary(
        top_n=args.top,
        tickers=tickers,
        feature_count=len(features),
        sequence_length=args.sequence_length,
        train_samples=train_n,
        valid_samples=valid_n,
        epochs=args.epochs,
        best_valid_loss=best_valid_loss,
        model_output=str(model_output),
        indicator_output=str(indicator_output),
    )
    summary_json = output_dir / "lstm_training_summary.json"
    with open(summary_json, "w", encoding="utf-8") as f:
        json.dump(asdict(summary), f, ensure_ascii=False, indent=2)
    print(f"[DONE] summary saved: {summary_json}")

    print("\n[ALL DONE]")
    print(f"- selected stocks : {selected_csv}")
    print(f"- indicator data  : {indicator_output}")
    print(f"- model           : {model_output}")
    print("\n다음 예측/뉴스 파이프라인 실행 예:")
    print(
        "python integrated_stock_lstm_news_pipeline.py "
        f"--indicator-parquet \"{indicator_output}\" "
        f"--lstm-model \"{model_output}\" "
        f"--sort-column {args.sort_column} --top {args.top}"
    )


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Train LSTM from TOP N stocks selected by main.py/config.py")
    parser.add_argument("--main-module", default=str(BASE_DIR / "main.py"), help="Path to main.py")
    parser.add_argument("--config-module", default=str(BASE_DIR / "config.py"), help="Path to config.py")
    parser.add_argument("--output-dir", default="outputs", help="Output directory")
    parser.add_argument("--top", type=int, default=10, help="Number of selected stocks from main.py")
    parser.add_argument("--sort-column", default="누적거래량", help="Column used by main.py to select top stocks")

    parser.add_argument("--years", type=int, default=3, help="Years of historical OHLCV to download for selected tickers")
    parser.add_argument("--indicator-output", default="step2_kospi200_indicators.parquet", help="Indicator parquet output path")
    parser.add_argument("--history-sleep-sec", type=float, default=0.2, help="Sleep between pykrx requests")

    parser.add_argument("--model-output", default="lstm_stock_model_top10.pth", help="Trained LSTM model output path")
    parser.add_argument("--feature-count", type=int, choices=[10, 11], default=11, help="Use 10 or 11 LSTM features")
    parser.add_argument("--sequence-length", type=int, default=20, help="LSTM sequence length")
    parser.add_argument("--epochs", type=int, default=30, help="Training epochs")
    parser.add_argument("--batch-size", type=int, default=64, help="Batch size")
    parser.add_argument("--lr", type=float, default=0.001, help="Learning rate")
    parser.add_argument("--valid-ratio", type=float, default=0.2, help="Validation ratio")
    parser.add_argument("--seed", type=int, default=42, help="Random seed")
    parser.add_argument("--cpu", action="store_true", help="Force CPU training")
    return parser


def main() -> int:
    parser = build_arg_parser()
    args = parser.parse_args()
    try:
        run(args)
        return 0
    except Exception as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
