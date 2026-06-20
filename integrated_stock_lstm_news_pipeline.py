"""
Integrated stock pipeline
=========================

Flow:
1) Scan KOSPI 200 and select TOP N high spot-volume/trading-value stocks from main.py
2) Build 10/11-feature LSTM input from step2_kospi200_indicators.parquet
3) Predict next return with LSTM model
4) Merge KIS quote data + LSTM prediction
5) Run Naver news crawling + OpenAI LLM sentiment analysis

Required files in the same folder or provided by arguments:
- config.py
- main.py
- stock_news_llm_sentiment.py
- step2_kospi200_indicators.parquet
- lstm_stock_model_10f.pth or lstm_stock_model_v2.pth

Required env:
- APP_KEY, APP_SECRET for config.py based KIS auth
- NAVER_CLIENT_ID, NAVER_CLIENT_SECRET for Naver news API
- OPENAI_API_KEY for OpenAI LLM
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import sys
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import torch
import torch.nn as nn
from sklearn.preprocessing import RobustScaler


# =========================
# Paths / dynamic imports
# =========================

BASE_DIR = Path(__file__).resolve().parent


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


def first_existing_path(*candidates: str | Path) -> Path:
    for candidate in candidates:
        path = Path(candidate)
        if path.exists():
            return path
    return Path(candidates[0])


def ensure_config_imported(config_module_path: str | Path) -> None:
    # main.py imports `config`, so register the selected config file under that module name first.
    import_module_from_path("config", config_module_path)


# =========================
# LSTM model
# =========================

class LSTMModel(nn.Module):
    def __init__(self, input_size: int, hidden_size: int = 64, num_layers: int = 2):
        super().__init__()
        self.lstm = nn.LSTM(input_size, hidden_size, num_layers, batch_first=True)
        self.fc = nn.Linear(hidden_size, 1)

    def forward(self, x):
        out, _ = self.lstm(x)
        return self.fc(out[:, -1, :])


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

# 기존 step5_save_backtest2.py는 이 11개 feature로 학습된 모델 구조였음.
FEATURES_11 = FEATURES_10 + ["BBB_20_2.0_2.0"]


def normalize_ticker(value: Any) -> str:
    return str(value).strip().zfill(6)


def prepare_indicator_df(parquet_path: str | Path) -> pd.DataFrame:
    path = Path(parquet_path)
    if not path.exists():
        raise FileNotFoundError(f"indicator parquet not found: {path}")

    df = pd.read_parquet(path)

    if "Ticker" not in df.columns:
        raise ValueError("Parquet must include a 'Ticker' column")

    required_price_cols = {"Open", "High", "Low", "Close", "Volume"}
    missing = required_price_cols - set(df.columns)
    if missing:
        raise ValueError(f"Parquet missing required OHLCV columns: {sorted(missing)}")

    # Make sure index is datetime if possible.
    if not isinstance(df.index, pd.DatetimeIndex):
        for candidate in ["Date", "date", "날짜"]:
            if candidate in df.columns:
                df[candidate] = pd.to_datetime(df[candidate])
                df = df.set_index(candidate)
                break

    df = df.copy()
    df["Ticker"] = df["Ticker"].astype(str).str.zfill(6)
    return df


def add_ratio_features(stock_df: pd.DataFrame) -> pd.DataFrame:
    stock_df = stock_df.sort_index(ascending=True).copy()
    stock_df["Prev_Close"] = stock_df["Close"].shift(1)
    stock_df["Close_Return"] = (stock_df["Close"] / stock_df["Prev_Close"]) - 1
    stock_df["Open_Gap"] = (stock_df["Open"] / stock_df["Prev_Close"]) - 1
    stock_df["High_Ratio"] = (stock_df["High"] / stock_df["Open"]) - 1
    stock_df["Low_Ratio"] = (stock_df["Low"] / stock_df["Open"]) - 1
    return stock_df.dropna()


def infer_lstm_input_size(model_path: str | Path, device: torch.device) -> int:
    path = Path(model_path)
    if not path.exists():
        raise FileNotFoundError(f"LSTM model file not found: {path}")
    state = torch.load(path, map_location=device)
    weight = state.get("lstm.weight_ih_l0") if isinstance(state, dict) else None
    if weight is None:
        raise ValueError("LSTM state_dict에서 lstm.weight_ih_l0를 찾지 못해 input_size를 자동 판단할 수 없습니다.")
    return int(weight.shape[1])


def load_lstm_model(model_path: str | Path, input_size: int, device: torch.device) -> LSTMModel:
    path = Path(model_path)
    if not path.exists():
        raise FileNotFoundError(f"LSTM model file not found: {path}")

    model = LSTMModel(input_size=input_size, hidden_size=64, num_layers=2).to(device)
    state = torch.load(path, map_location=device)
    model.load_state_dict(state)
    model.eval()
    return model


def predict_one_stock_latest(
    indicator_df: pd.DataFrame,
    ticker: str,
    model: LSTMModel,
    features: list[str],
    device: torch.device,
    sequence_length: int = 20,
) -> dict[str, Any]:
    ticker = normalize_ticker(ticker)
    stock_df = indicator_df[indicator_df["Ticker"] == ticker].copy()

    if stock_df.empty:
        return {
            "ticker": ticker,
            "lstm_status": "NO_DATA",
            "lstm_pred_return": np.nan,
            "lstm_base_date": "",
            "lstm_error": f"No indicator data for ticker {ticker}",
        }

    stock_df = add_ratio_features(stock_df)

    missing = [col for col in features if col not in stock_df.columns]
    if missing:
        return {
            "ticker": ticker,
            "lstm_status": "MISSING_FEATURES",
            "lstm_pred_return": np.nan,
            "lstm_base_date": "",
            "lstm_error": f"Missing features: {missing}",
        }

    if len(stock_df) < sequence_length:
        return {
            "ticker": ticker,
            "lstm_status": "TOO_SHORT",
            "lstm_pred_return": np.nan,
            "lstm_base_date": "",
            "lstm_error": f"Need at least {sequence_length} rows, got {len(stock_df)}",
        }

    input_data = stock_df.iloc[-sequence_length:].copy()
    base_date = input_data.index[-1]

    # Same preprocessing style as step5_save_backtest2.py
    input_data["Volume"] = np.log1p(input_data["Volume"])
    scaler = RobustScaler()
    scaled = scaler.fit_transform(input_data[features])

    tensor = torch.tensor(scaled, dtype=torch.float32).unsqueeze(0).to(device)
    with torch.no_grad():
        pred = model(tensor).item() * 100.0

    if hasattr(base_date, "strftime"):
        base_date_str = base_date.strftime("%Y-%m-%d")
    else:
        base_date_str = str(base_date)

    return {
        "ticker": ticker,
        "lstm_status": "OK",
        "lstm_pred_return": round(float(pred), 4),
        "lstm_base_date": base_date_str,
        "lstm_error": "",
    }


# =========================
# Top10 + merge + LLM
# =========================

def scan_top_stocks(main_module_path: str | Path, config_module_path: str | Path, top_n: int, sort_column: str) -> pd.DataFrame:
    # main.py imports `config`, so load the selected config module first.
    ensure_config_imported(config_module_path)
    main_mod = import_module_from_path("kis_main_scan_module", main_module_path)

    if not hasattr(main_mod, "scan_kospi200"):
        raise AttributeError(f"{main_module_path} does not define scan_kospi200()")

    df = main_mod.scan_kospi200(top_n=top_n, sort_column=sort_column)
    if df is None or df.empty:
        raise RuntimeError("scan_kospi200() returned empty result")

    df = df.head(top_n).copy()
    df["ticker"] = df["종목코드"].astype(str).str.zfill(6)
    df["company_name"] = df["종목명"].astype(str)
    return df


def attach_lstm_predictions(
    top_df: pd.DataFrame,
    parquet_path: str | Path,
    model_path: str | Path,
    feature_count: str | int,
    sequence_length: int,
) -> pd.DataFrame:
    indicator_df = prepare_indicator_df(parquet_path)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    if str(feature_count).lower() == "auto":
        feature_count = infer_lstm_input_size(model_path, device=device)
    else:
        feature_count = int(feature_count)

    if feature_count == 10:
        features = FEATURES_10
    elif feature_count == 11:
        features = FEATURES_11
    else:
        raise ValueError(f"지원하지 않는 LSTM input_size={feature_count}. 현재 10 또는 11 feature 모델만 지원합니다.")

    model = load_lstm_model(model_path, input_size=len(features), device=device)

    pred_rows = []
    for _, row in top_df.iterrows():
        ticker = normalize_ticker(row["ticker"])
        print(f"[INFO] LSTM predict: {ticker} {row.get('company_name', '')}")
        pred_rows.append(
            predict_one_stock_latest(
                indicator_df=indicator_df,
                ticker=ticker,
                model=model,
                features=features,
                device=device,
                sequence_length=sequence_length,
            )
        )

    pred_df = pd.DataFrame(pred_rows)
    merged = top_df.merge(pred_df, on="ticker", how="left")

    # stock_news_llm_sentiment.py can auto-use any numeric pred columns.
    merged["ensemble_pred_return"] = pd.to_numeric(merged["lstm_pred_return"], errors="coerce")
    merged["lstm_feature_count"] = feature_count
    merged["lstm_sequence_length"] = sequence_length
    return merged


def run_news_llm(
    news_module_path: str | Path,
    input_csv: str | Path,
    output_csv: str | Path,
    output_json: str | Path,
    days: int,
    top_n: int,
    max_news: int,
    fetch_body: bool,
    model_name: str,
):
    news_mod = import_module_from_path("stock_news_llm_sentiment_module", news_module_path)

    if not hasattr(news_mod, "run_pipeline"):
        raise AttributeError(f"{news_module_path} does not define run_pipeline()")

    news_mod.run_pipeline(
        input_path=str(input_csv),
        output_csv=str(output_csv),
        output_json=str(output_json),
        days=days,
        top=top_n,
        rank_col="ensemble_pred_return",
        max_news=max_news,
        fetch_body=fetch_body,
        model=model_name,
    )


def run_integrated_pipeline(args: argparse.Namespace) -> None:
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    print("[STEP 1] KIS TOP 종목 스캔")
    top_df = scan_top_stocks(
        main_module_path=args.main_module,
        config_module_path=args.config_module,
        top_n=args.top,
        sort_column=args.sort_column,
    )

    print("[STEP 2] LSTM 예측 붙이기")
    merged_df = attach_lstm_predictions(
        top_df=top_df,
        parquet_path=args.indicator_parquet,
        model_path=args.lstm_model,
        feature_count=args.feature_count,
        sequence_length=args.sequence_length,
    )

    lstm_input_csv = output_dir / "top10_with_lstm_for_llm.csv"
    merged_df.to_csv(lstm_input_csv, index=False, encoding="utf-8-sig")
    print(f"[DONE] LSTM+KIS merged CSV: {lstm_input_csv}")

    print("[STEP 3] 뉴스 크롤링 + LLM 분석")
    output_csv = output_dir / "final_stock_lstm_news_llm_result.csv"
    output_json = output_dir / "final_stock_lstm_news_llm_result.json"

    run_news_llm(
        news_module_path=args.news_module,
        input_csv=lstm_input_csv,
        output_csv=output_csv,
        output_json=output_json,
        days=args.news_days,
        top_n=args.top,
        max_news=args.max_news,
        fetch_body=args.fetch_body,
        model_name=args.openai_model,
    )

    print("\n[ALL DONE]")
    print(f"- LSTM input CSV : {lstm_input_csv}")
    print(f"- Final CSV      : {output_csv}")
    print(f"- Final JSON     : {output_json}")


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="KIS top10 -> LSTM -> Naver news -> LLM integrated pipeline")

    parser.add_argument("--config-module", default=str(first_existing_path(BASE_DIR / "config.py", BASE_DIR / "config(1).py")), help="Path to KIS config module")
    parser.add_argument("--main-module", default=str(first_existing_path(BASE_DIR / "main.py", BASE_DIR / "main(2).py", BASE_DIR / "main(1).py")), help="Path to KIS scanner main module")
    parser.add_argument("--news-module", default=str(first_existing_path(BASE_DIR / "stock_news_llm_sentiment.py", BASE_DIR / "stock_news_llm_sentiment(1).py")), help="Path to news+LLM module")
    parser.add_argument("--indicator-parquet", default="step2_kospi200_indicators.parquet", help="Indicator parquet path")
    parser.add_argument("--lstm-model", default=str(first_existing_path("lstm_stock_model_v2.pth", "lstm_stock_model_10f.pth")), help="LSTM .pth model path")
    parser.add_argument("--output-dir", default="outputs", help="Output directory")

    parser.add_argument("--top", type=int, default=10, help="Number of top stocks to process")
    parser.add_argument("--sort-column", default="당일거래대금(원)", help="KIS scan sorting column. Use 누적거래량 for pure spot volume.")
    parser.add_argument("--feature-count", choices=["auto", "10", "11"], default="auto", help="Use 10/11 LSTM features, or auto-detect from .pth")
    parser.add_argument("--sequence-length", type=int, default=20, help="LSTM sequence length")

    parser.add_argument("--news-days", type=int, default=3, help="Recent news lookback days")
    parser.add_argument("--max-news", type=int, default=8, help="Max news articles per stock")
    parser.add_argument("--fetch-body", action="store_true", help="Try to fetch article body with trafilatura")
    parser.add_argument("--openai-model", default=os.getenv("OPENAI_MODEL", "gpt-4o-mini"), help="OpenAI model")

    return parser


def main() -> int:
    parser = build_arg_parser()
    args = parser.parse_args()

    try:
        run_integrated_pipeline(args)
        return 0
    except Exception as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
