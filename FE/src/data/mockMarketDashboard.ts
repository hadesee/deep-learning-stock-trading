import type { MarketDashboardData, StockQuote } from "../types/trading";

// Stocks are the AI Top10 (step2 ranking + step3 news evaluation). Prices are
// demo placeholders until the live KIS bridge is connected.
const stocks: StockQuote[] = [
  {
    "code": "000270",
    "name": "기아",
    "market": "KOSPI",
    "isKospi200": true,
    "currentPrice": 105000,
    "change": 2310,
    "changeRate": 2.2,
    "direction": "up",
    "accumulatedVolume": 5400238,
    "tradingValue": 567025000000,
    "tradingValueRank": 1,
    "investorFlow": {
      "personal": -87143,
      "foreign": 1123619,
      "institution": -1036476
    },
    "aiSummary": "기아는 환율 효과, 친환경차 제품 믹스 개선, EV3 신차 효과 등으로 견조한 판매 성장과 실적 기대감을 높이고 있습니다. 다만, 원화 강세 전환 시 해외 매출 감소 가능성과 최근 기관의 순매도세는 잠재적 리스크로 작용할 수 있습니다.",
    "sentimentLabel": "POSITIVE",
    "confidence": 0.72,
    "predictedReturn": null,
    "upProbability": 0.7927,
    "miniSeries": [
      43,
      45,
      47,
      49,
      51,
      53,
      55,
      57
    ]
  },
  {
    "code": "005490",
    "name": "POSCO홀딩스",
    "market": "KOSPI",
    "isKospi200": true,
    "currentPrice": 430000,
    "change": -10750,
    "changeRate": -2.5,
    "direction": "down",
    "accumulatedVolume": 924901,
    "tradingValue": 397707500000,
    "tradingValueRank": 2,
    "investorFlow": {
      "personal": 211007,
      "foreign": 79477,
      "institution": -290484
    },
    "aiSummary": "POSCO홀딩스는 최근 주간 기관 순매도 종목에 포함되어 기관투자자들이 차익 실현에 나선 것으로 분석됩니다.",
    "sentimentLabel": "NEGATIVE",
    "confidence": 0.25,
    "predictedReturn": null,
    "upProbability": 0.7895,
    "miniSeries": [
      58,
      56,
      53,
      51,
      49,
      47,
      44,
      42
    ]
  },
  {
    "code": "267250",
    "name": "HD현대",
    "market": "KOSPI",
    "isKospi200": true,
    "currentPrice": 95000,
    "change": 3325,
    "changeRate": 3.5,
    "direction": "up",
    "accumulatedVolume": 2337184,
    "tradingValue": 222032500000,
    "tradingValueRank": 3,
    "investorFlow": {
      "personal": 169505,
      "foreign": 382684,
      "institution": -552189
    },
    "aiSummary": "HD현대 그룹은 친환경 선박 기술 및 ESG 역량 강화, K-전력기기 시장의 슈퍼사이클 수혜, 미국 해군과의 협력 확대 등 다양한 사업 부문에서 긍정적인 전망을 보이고 있습니다. 특히 HD현대 마린솔루션은 KB증권의 '매수' 추천을 받는 등 전반적으로 그룹의 기업가치 상승이 기대됩니다.",
    "sentimentLabel": "POSITIVE",
    "confidence": 0.85,
    "predictedReturn": null,
    "upProbability": 0.7594,
    "miniSeries": [
      39,
      42,
      45,
      48,
      52,
      55,
      58,
      61
    ]
  },
  {
    "code": "012330",
    "name": "현대모비스",
    "market": "KOSPI",
    "isKospi200": true,
    "currentPrice": 250000,
    "change": 7000,
    "changeRate": 2.8,
    "direction": "up",
    "accumulatedVolume": 864070,
    "tradingValue": 216017500000,
    "tradingValueRank": 4,
    "investorFlow": {
      "personal": 345628,
      "foreign": -215804,
      "institution": -129824
    },
    "aiSummary": "현대모비스는 메리츠증권으로부터 로봇 핵심 부품 기업으로의 전환 가능성을 높이 평가받아 목표 주가 90만원과 매수 의견을 제시받았다. 다만, 인도 공장 화재와 같은 공급망 차질 가능성 및 유럽 시장 경쟁 심화 등의 잠재적 리스크 요인도 언급되었다.",
    "sentimentLabel": "POSITIVE",
    "confidence": 0.78,
    "predictedReturn": null,
    "upProbability": 0.7544,
    "miniSeries": [
      41,
      44,
      46,
      49,
      51,
      54,
      56,
      59
    ]
  },
  {
    "code": "005380",
    "name": "현대차",
    "market": "KOSPI",
    "isKospi200": true,
    "currentPrice": 245000,
    "change": -735,
    "changeRate": -0.3,
    "direction": "down",
    "accumulatedVolume": 8031398,
    "tradingValue": 1967692500000,
    "tradingValueRank": 5,
    "investorFlow": {
      "personal": 1872477,
      "foreign": 670041,
      "institution": -2542518
    },
    "aiSummary": "현대차는 글로벌 시장 둔화와 전기차 수요 조정, 친환경차 판매 공백이라는 단기적 도전에 직면해 있으며, 판매량 감소가 불가피할 것으로 예상됩니다. 다만, 원화 약세에 따른 환율 효과가 실적을 일부 방어할 것으로 보이며, KB증권의 매수 추천과 로봇/AI 분야의 장기 성장 잠재력은 긍정적입니다.",
    "sentimentLabel": "NEGATIVE",
    "confidence": 0.47,
    "predictedReturn": null,
    "upProbability": 0.7494,
    "miniSeries": [
      51,
      51,
      50,
      50,
      50,
      50,
      49,
      49
    ]
  },
  {
    "code": "007660",
    "name": "이수페타시스",
    "market": "KOSPI",
    "isKospi200": true,
    "currentPrice": 42000,
    "change": 1176,
    "changeRate": 2.8,
    "direction": "up",
    "accumulatedVolume": 9787917,
    "tradingValue": 411092500000,
    "tradingValueRank": 6,
    "investorFlow": {
      "personal": 1014024,
      "foreign": 1450571,
      "institution": -2464595
    },
    "aiSummary": "이수페타시스는 최근 AI 반도체 산업 성장과 함께 주요 자산운용사의 ETF 편입 및 하반기 실적 개선 기대로 긍정적인 평가를 받고 있습니다. 다만, 기관 투자자의 차익 실현 매도세가 일부 나타났지만, 외국인 투자자의 매수세가 유입되며 상쇄되는 흐름을 보입니다.",
    "sentimentLabel": "POSITIVE",
    "confidence": 0.78,
    "predictedReturn": null,
    "upProbability": 0.7466,
    "miniSeries": [
      41,
      44,
      46,
      49,
      51,
      54,
      56,
      59
    ]
  },
  {
    "code": "032830",
    "name": "삼성생명",
    "market": "KOSPI",
    "isKospi200": true,
    "currentPrice": 105000,
    "change": 4042,
    "changeRate": 3.85,
    "direction": "up",
    "accumulatedVolume": 1904762,
    "tradingValue": 200000000000,
    "tradingValueRank": 7,
    "investorFlow": {
      "personal": -526771,
      "foreign": 253676,
      "institution": 273095
    },
    "aiSummary": "삼성생명은 삼성전자 지분 가치 부각으로 시가총액이 LG에너지솔루션을 제치고 6위까지 상승했으며, 증권가에서 유망 종목으로 지목되고 있습니다. 삼성전자의 특별배당 가능성은 삼성생명이 보유한 삼성전자 지분 가치 상승에 대한 기대감을 더욱 키우고 있습니다.",
    "sentimentLabel": "POSITIVE",
    "confidence": 0.89,
    "predictedReturn": null,
    "upProbability": 0.7373,
    "miniSeries": [
      38,
      41,
      45,
      48,
      52,
      55,
      59,
      62
    ]
  },
  {
    "code": "016360",
    "name": "삼성증권",
    "market": "KOSPI",
    "isKospi200": true,
    "currentPrice": 52000,
    "change": 260,
    "changeRate": 0.5,
    "direction": "up",
    "accumulatedVolume": 3846154,
    "tradingValue": 200000000000,
    "tradingValueRank": 8,
    "investorFlow": {
      "personal": 521654,
      "foreign": 98442,
      "institution": -620096
    },
    "aiSummary": "삼성증권은 과거 양호한 주가 흐름을 보였으나, 하반기 금리 인상 가능성으로 인한 트레이딩 손익 둔화 우려가 제기되고 있습니다. 타 기업에 대한 활발한 리서치 활동 및 계열사 협업 소식도 있으나, 본업의 잠재적 리스크가 주목됩니다.",
    "sentimentLabel": "NEGATIVE",
    "confidence": 0.55,
    "predictedReturn": null,
    "upProbability": 0.7109,
    "miniSeries": [
      48,
      49,
      49,
      50,
      50,
      51,
      51,
      52
    ]
  },
  {
    "code": "003670",
    "name": "포스코퓨처엠",
    "market": "KOSPI",
    "isKospi200": true,
    "currentPrice": 180000,
    "change": 2700,
    "changeRate": 1.5,
    "direction": "up",
    "accumulatedVolume": 1111111,
    "tradingValue": 200000000000,
    "tradingValueRank": 9,
    "investorFlow": {
      "personal": -13572,
      "foreign": 136289,
      "institution": -122717
    },
    "aiSummary": "해당 기업에 대한 최신 뉴스가 없습니다.",
    "sentimentLabel": "NEUTRAL",
    "confidence": 0.65,
    "predictedReturn": null,
    "upProbability": 0.7013,
    "miniSeries": [
      45,
      47,
      48,
      49,
      51,
      52,
      53,
      55
    ]
  },
  {
    "code": "051910",
    "name": "LG화학",
    "market": "KOSPI",
    "isKospi200": true,
    "currentPrice": 320000,
    "change": 2560,
    "changeRate": 0.8,
    "direction": "up",
    "accumulatedVolume": 625000,
    "tradingValue": 200000000000,
    "tradingValueRank": 10,
    "investorFlow": {
      "personal": -125356,
      "foreign": 165662,
      "institution": -40306
    },
    "aiSummary": "LG화학은 1분기 석유화학 부문에서 흑자를 기록했으나, 전기차 수요 둔화와 석유화학 산업 침체로 핵심 사업은 전반적으로 숨 고르기 중입니다. 워터솔루션 사업부 매각과 같은 사업 재편을 모색하고 있으며, LG그룹의 피지컬AI 잠재력에도 불구하고 최근 주가는 조정을 겪고 있습니다.",
    "sentimentLabel": "NEGATIVE",
    "confidence": 0.58,
    "predictedReturn": null,
    "upProbability": 0.7006,
    "miniSeries": [
      47,
      48,
      49,
      50,
      50,
      51,
      52,
      53
    ]
  }
];

export const mockMarketDashboard: MarketDashboardData = {
  generatedAt: "2026-06-19T16:10:00+09:00",
  sessionLabel: "2026.06.19 기준 · AI 후보 분석",
  focusedStockCode: "000270",
  indices: [
  {
    "symbol": "KOSPI",
    "name": "코스피",
    "value": 8160.59,
    "change": -478.82,
    "changeRate": -5.54,
    "direction": "down",
    "miniSeries": [
      86,
      78,
      72,
      66,
      59,
      55,
      51,
      49
    ]
  },
  {
    "symbol": "KOSDAQ",
    "name": "코스닥",
    "value": 1002.44,
    "change": -47.29,
    "changeRate": -4.5,
    "direction": "down",
    "miniSeries": [
      70,
      66,
      62,
      58,
      54,
      51,
      49,
      48
    ]
  },
  {
    "symbol": "KOSPI200",
    "name": "코스피200",
    "value": 1297.02,
    "change": -82.49,
    "changeRate": -5.98,
    "direction": "down",
    "miniSeries": [
      90,
      84,
      77,
      70,
      63,
      57,
      52,
      49
    ]
  }
],
  stocks,
  watchlist: stocks.slice(0, 8),
  events: [
  {
    "timeLabel": "09:08",
    "title": "코스피200 선물 급락으로 프로그램 매도 사이드카 발동"
  },
  {
    "timeLabel": "15:30",
    "title": "코스피 8,160.59 마감, 전일 대비 -5.54%"
  },
  {
    "timeLabel": "장마감",
    "title": "기아·현대차 등 자동차 대형주로 단기 매수 후보 집중"
  }
],
};
