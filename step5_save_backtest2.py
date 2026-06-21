import pandas as pd
import numpy as np
import torch
import torch.nn as nn
from sklearn.preprocessing import RobustScaler
import os

# 1. 학습 때와 동일한 LSTM 모델 구조 정의 (구조 자체는 input 11개로 동일)
class LSTMModel(nn.Module):
    def __init__(self, input_size=11, hidden_size=64, num_layers=2):
        super(LSTMModel, self).__init__()
        self.lstm = nn.LSTM(input_size, hidden_size, num_layers, batch_first=True)
        self.fc = nn.Linear(hidden_size, 1)
        
    def forward(self, x):
        out, _ = self.lstm(x)
        out = self.fc(out[:, -1, :]) 
        return out

def run_and_save_backtest_v2(target_ticker, start_date, end_date):
    print(f"--- [V2 검증 시스템] 종목: {target_ticker} | 기간: {start_date} ~ {end_date} ---")
    
    # 2. 정제된 Parquet 파일 로드
    if not os.path.exists('step2_kospi200_indicators.parquet'):
        print("에러: 'step2_kospi200_indicators.parquet' 파일이 존재하지 않습니다.")
        return
        
    df = pd.read_parquet('step2_kospi200_indicators.parquet')
    stock_df = df[df['Ticker'] == target_ticker].sort_index(ascending=True)
    
    if stock_df.empty:
        print(f"에러: 데이터셋에 {target_ticker} 종목 데이터가 없습니다.")
        return

    # ★ [V2 변경 포인트 1] 추론을 위한 비율 데이터 실시간 가공 ★
    stock_df['Prev_Close'] = stock_df['Close'].shift(1)
    stock_df['Close_Return'] = (stock_df['Close'] / stock_df['Prev_Close']) - 1
    stock_df['Open_Gap'] = (stock_df['Open'] / stock_df['Prev_Close']) - 1
    stock_df['High_Ratio'] = (stock_df['High'] / stock_df['Open']) - 1
    stock_df['Low_Ratio'] = (stock_df['Low'] / stock_df['Open']) - 1
    stock_df = stock_df.dropna() # shift로 발생한 첫 행의 빈값 제거

    # 3. 가중치 모델 파일(.pth) 로드
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    model = LSTMModel(input_size=11, hidden_size=64, num_layers=2).to(device)
    
    # ★ [V2 변경 포인트 2] V2 모델 파일명으로 로드 (학습 시 저장한 이름으로 맞춰주세요) ★
    model_filename = 'lstm_stock_model_v2.pth' # V2 모델명
    if not os.path.exists(model_filename):
        print(f"에러: '{model_filename}' 가중치 파일이 없습니다.")
        return
    model.load_state_dict(torch.load(model_filename, map_location=device))
    model.eval()
    
    # ★ [V2 변경 포인트 3] 피처 리스트 교체 ★
    features = [
        'Open_Gap', 'High_Ratio', 'Low_Ratio', 'Close_Return', 'Volume', 
        'RSI', 'MACD', 'MACD_Signal', 
        'BBU_20_2.0_2.0', 'BBL_20_2.0_2.0', 'BBB_20_2.0_2.0'
    ]
    
    # 사용자가 요청한 기간 필터링
    requested_period_df = stock_df.loc[start_date:end_date]
    if requested_period_df.empty:
        print("에러: 해당 기간에 일치하는 주가 데이터가 없습니다.")
        return
        
    results = []
    
    # 5. 지정 기간 하루씩 슬라이딩하며 추론 진행
    print("일자별 예측 및 실제 수익률 대조 중...")
    for target_date in requested_period_df.index:
        idx = stock_df.index.get_loc(target_date)
        
        # 과거 20영업일이 확보되지 않으면 건너뜀
        if idx < 20:
            continue
            
        # 예측 시점(오늘) 기준 과거 20일 데이터 분리
        input_data = stock_df.iloc[idx - 20 : idx].copy()
        current_date = stock_df.index[idx - 1] # 오늘 날짜
        
        # 실제 다음날(target_date) 일어난 진짜 종가 및 수익률 (이건 원본 종가로 계산해야 정확함)
        actual_close = stock_df.iloc[idx]['Close']
        prev_close = stock_df.iloc[idx - 1]['Close']
        actual_next_return = (actual_close - prev_close) / prev_close * 100
        
        # 데이터 스케일링 전처리
        input_data['Volume'] = np.log1p(input_data['Volume'])
        scaler = RobustScaler()
        scaled_features = scaler.fit_transform(input_data[features])
        
        # 텐서 변환 [1, 20, 11]
        input_tensor = torch.tensor(scaled_features, dtype=torch.float32).unsqueeze(0).to(device)
        
        # 모델 예측 실행
        with torch.no_grad():
            pred = model(input_tensor)
            predicted_next_return = pred.item() * 100 # % 단위 변환
            
        # 데이터 저장 버퍼에 축적
        results.append({
            'Base_Date(오늘)': current_date.strftime('%Y-%m-%d'),
            'Target_Date(내일)': target_date.strftime('%Y-%m-%d'),
            'Actual_Close(실제종가)': int(actual_close),
            'Predicted_Return(예측수익률%)': round(predicted_next_return, 2),
            'Actual_Return(실제수익률%)': round(actual_next_return, 2),
            'Is_Correct(적중여부)': 'SUCCESS' if (predicted_next_return * actual_next_return > 0) else 'FAIL'
        })
        
    # 6. 데이터프레임 변환 및 CSV 저장
    result_df = pd.DataFrame(results)
    
    # 파일명 생성 예시: "005930_v2_backtest_20250302_to_20250529.csv"
    clean_start = start_date.replace('-', '')
    clean_end = end_date.replace('-', '')
    save_filename = f"{target_ticker}_v2_backtest_{clean_start}_to_{clean_end}.csv"
    
    result_df.to_csv(save_filename, index=False, encoding='utf-8-sig')
    
    print("\n" + "="*75)
    print(f"🎉 V2 검증 완료 및 파일 저장 성공!")
    print(f"📁 저장된 파일명: {save_filename}")
    print("="*75)
    
    success_count = result_df['Is_Correct(적중여부)'].value_counts().get('SUCCESS', 0)
    total_count = len(result_df)
    accuracy = (success_count / total_count) * 100 if total_count > 0 else 0
    print(f"📊 총 검증 일수: {total_count}일 | 방향 적중: {success_count}회")
    print(f"🎯 V2 모델 정확도: {accuracy:.2f}%")

if __name__ == "__main__":
    run_and_save_backtest_v2(
        target_ticker='035420', 
        start_date='2026-01-01', 
        end_date='2026-03-31'
    )