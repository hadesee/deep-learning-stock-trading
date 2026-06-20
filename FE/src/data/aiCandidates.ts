// AUTO-GENERATED from outputs/step2_final_top10.csv + step3_final_news_llm_analysis.json
// Do not edit by hand; regenerate from the pipeline outputs.

export type AiNews = {
  title: string;
  url: string;
  source: string;
  pubDate: string;
  description: string;
  index: number;
  sentiment?: string;
  sentimentKo?: string;
  sentimentReason?: string;
};

export type AiCandidate = {
  ticker: string;
  companyName: string;
  rank: number;
  poolSize: number;
  pUp: number;
  baseDate: string;
  ensemblePredReturn: number;
  foreignNetBuy: number;
  instNetBuy: number;
  totalSupplyNetBuy: number;
  foreignPositiveDays: number;
  instPositiveDays: number;
  supplyWindow: number;
  newsCount: number;
  newsOverallScore: number;
  newsSentimentTally: string;
  finalSentiment: string;
  finalSentimentKo: string;
  finalCombinedScore: number;
  summary: string;
  tradingInsight: string;
  news: AiNews[];
};

export const aiCandidates: AiCandidate[] = [
  {
    "ticker": "000270",
    "companyName": "기아",
    "rank": 1,
    "poolSize": 199,
    "pUp": 0.792696,
    "baseDate": "2026-06-19",
    "ensemblePredReturn": 0.792696,
    "foreignNetBuy": 117980000000.0,
    "instNetBuy": -108830000000.0,
    "totalSupplyNetBuy": 9150000000.0,
    "foreignPositiveDays": 4,
    "instPositiveDays": 0,
    "supplyWindow": 5,
    "newsCount": 5,
    "newsOverallScore": 7.2,
    "newsSentimentTally": "긍정 3건, 부정 2건",
    "finalSentiment": "Bullish",
    "finalSentimentKo": "상승 우위",
    "finalCombinedScore": 72.0,
    "summary": "기아는 환율 효과, 친환경차 제품 믹스 개선, EV3 신차 효과 등으로 견조한 판매 성장과 실적 기대감을 높이고 있습니다. 다만, 원화 강세 전환 시 해외 매출 감소 가능성과 최근 기관의 순매도세는 잠재적 리스크로 작용할 수 있습니다.",
    "tradingInsight": "강력한 전기차 모멘텀과 애널리스트의 긍정적 전망은 단기 주가 상승 동력을 제공할 것으로 보입니다. 다만, 단기 차익실현 물량(기관 순매도) 출현 가능성과 환율 변동성 리스크를 고려하여, 조정 시 매수 기회를 탐색하거나 주요 지지선에서의 반등 여부를 주시하는 전략이 유효합니다.",
    "news": [
      {
        "title": "환율·친환경차 두 날개 달았다… 기아 실적 기대감 폭발",
        "url": "https://www.pinpointnews.co.kr/news/articleView.html?idxno=461672",
        "source": "pinpointnews.co.kr",
        "pubDate": "2026-06-20T12:58:00+09:00",
        "description": "한화투자증권은 기아 의 견조한 판매 흐름과 친환경차 제품 믹스 개선, 긍정적인 환율 효과를 바탕으로 성장 가능성을 긍정적으로 평가했다. 목표 주가 는 29만원, 투자의견은 매수를 제시했다.",
        "index": 1
      },
      {
        "title": "[투자전략] 기아 EV3 효과 본격화…현대차보다 강한 전기차 모멘텀",
        "url": "https://www.topstarnews.net/news/articleView.html?idxno=16103695",
        "source": "topstarnews.net",
        "pubDate": "2026-06-20T11:52:00+09:00",
        "description": "현재 데이터만 놓고 보면 전기차 신차 효과가 판매 성장으로 연결되고 있는 기업은 기아 다. 반면 현대차는 아이오닉3 출시 전까지 친환경차 판매 공백을 어떻게 메울지가 하반기 주가 의 핵심 관전 포인트로 꼽힌다.",
        "index": 2
      },
      {
        "title": "[뉴스락 특별기획∣K-산업 실적 기상도 ㊤] 잘되는 곳, 버티는 곳, 무너...",
        "url": "http://www.newslock.co.kr/news/articleView.html?idxno=131613",
        "source": "newslock.co.kr",
        "pubDate": "2026-06-20T09:22:00+09:00",
        "description": "그러나 유가 하락에 따른 원화 강세 전환 시 해외 매출 비중이 절대적으로 높은 현대차· 기아 의 달러 환산 매출이 줄어드는 역효과가 나타날 수 있다. 실적 전망도 녹록지 않다. 현대차의 2분기 영업이익 컨센서스는...",
        "index": 3
      },
      {
        "title": "[베스트&워스트] 삼화전자 73% 폭등·디아이씨 34% 급락…AI 반도체 전력...",
        "url": "https://www.etoday.co.kr/news/view/2595515",
        "source": "etoday.co.kr",
        "pubDate": "2026-06-20T08:02:00+09:00",
        "description": "현대차 및 기아 차 핵심 부품 공급사로서 전장 부품 섹터의 견고한 실적 모멘텀이 부각되는 가운데 기관의 꾸준한 순매수세가 유입되며 탄력적인 주가 흐름을 증명했다. 대원전선우는 시작일 기준가 1만750원에서...",
        "index": 4
      },
      {
        "title": "[주간 거래소 기관] SK하이닉스 삼성전자 사들이고 한미반도체 현대차는...",
        "url": "https://www.pinpointnews.co.kr/news/articleView.html?idxno=461630",
        "source": "pinpointnews.co.kr",
        "pubDate": "2026-06-20T07:20:00+09:00",
        "description": "반면 최근 높은 주가 상승세를 보였던 일부 종목에서는 차익 실현에 나서면서 업종별 수급 흐름이... 이와 함께 지주회사 두산과 LG, 철강 기업 POSCO홀딩스, 반도체 기업 DB하이텍, 자동차 업체 기아 가 기관 순매도...",
        "index": 5
      }
    ]
  },
  {
    "ticker": "005490",
    "companyName": "POSCO홀딩스",
    "rank": 2,
    "poolSize": 199,
    "pUp": 0.789487,
    "baseDate": "2026-06-19",
    "ensemblePredReturn": 0.789487,
    "foreignNetBuy": 34175000000.0,
    "instNetBuy": -124908000000.0,
    "totalSupplyNetBuy": -90733000000.0,
    "foreignPositiveDays": 4,
    "instPositiveDays": 1,
    "supplyWindow": 5,
    "newsCount": 1,
    "newsOverallScore": 2.0,
    "newsSentimentTally": "부정 1건",
    "finalSentiment": "Bearish",
    "finalSentimentKo": "하락 우위",
    "finalCombinedScore": 25.0,
    "summary": "POSCO홀딩스는 최근 주간 기관 순매도 종목에 포함되어 기관투자자들이 차익 실현에 나선 것으로 분석됩니다.",
    "tradingInsight": "기관의 순매도 포착은 단기적인 주가 하방 압력을 시사합니다. 추가적인 매도세 확산 가능성을 염두에 두고 보수적인 접근이 필요하며, 매수 시점은 기관 매도세 진정 및 기술적 지표의 반등 신호를 확인한 후 고려하는 것이 바람직합니다.",
    "news": [
      {
        "title": "[주간 거래소 기관] SK하이닉스 삼성전자 사들이고 한미반도체 현대차는...",
        "url": "https://www.pinpointnews.co.kr/news/articleView.html?idxno=461630",
        "source": "pinpointnews.co.kr",
        "pubDate": "2026-06-20T07:20:00+09:00",
        "description": "반면 최근 높은 주가 상승세를 보였던 일부 종목에서는 차익 실현에 나서면서 업종별 수급 흐름이... 이와 함께 지주회사 두산과 LG, 철강 기업 POSCO홀딩스 , 반도체 기업 DB하이텍, 자동차 업체 기아가 기관 순매도...",
        "index": 1
      }
    ]
  },
  {
    "ticker": "267250",
    "companyName": "HD현대",
    "rank": 3,
    "poolSize": 199,
    "pUp": 0.759411,
    "baseDate": "2026-06-19",
    "ensemblePredReturn": 0.759411,
    "foreignNetBuy": 36355000000.0,
    "instNetBuy": -52458000000.0,
    "totalSupplyNetBuy": -16103000000.0,
    "foreignPositiveDays": 4,
    "instPositiveDays": 0,
    "supplyWindow": 5,
    "newsCount": 5,
    "newsOverallScore": 8.5,
    "newsSentimentTally": "긍정 5건, 부정 0건, 중립 0건",
    "finalSentiment": "Bullish",
    "finalSentimentKo": "상승 우위",
    "finalCombinedScore": 85.0,
    "summary": "HD현대 그룹은 친환경 선박 기술 및 ESG 역량 강화, K-전력기기 시장의 슈퍼사이클 수혜, 미국 해군과의 협력 확대 등 다양한 사업 부문에서 긍정적인 전망을 보이고 있습니다. 특히 HD현대 마린솔루션은 KB증권의 '매수' 추천을 받는 등 전반적으로 그룹의 기업가치 상승이 기대됩니다.",
    "tradingInsight": "제공된 뉴스에 따르면 HD현대 그룹의 자회사들은 친환경 관련 성장 산업과 해외 시장 확대를 통해 견조한 사업 전망을 보이고 있으며, 이는 기업가치 상승에 긍정적인 영향을 미칠 것으로 판단됩니다. 현재의 긍정적인 모멘텀을 고려할 때 단기적인 주가 상승 가능성이 높다고 분석됩니다. 다만, 구체적인 매매 타점은 추가적인 거래량, 이동평균선, RSI 등 기술적 지표의 분석을 통해 보완적인 결정을 내리는 것이 바람직합니다.",
    "news": [
      {
        "title": "[2026 ESG Awards] HD 한국조선해양, 친환경 선박 기술...ESG 성과로 연결",
        "url": "http://www.hansbiz.co.kr/news/articleView.html?idxno=845398",
        "source": "hansbiz.co.kr",
        "pubDate": "2026-06-20T13:00:00+09:00",
        "description": "친환경 선박 시장 확대와 탄소중립을 요구하는 목소리가 점점 커지는 상황에서 HD 한국조선해양의 탁월한 ESG 역량은 향후 수주 경쟁력과 기업가치의 동반 상승을 이끄는 핵심 동력이 될 것\"이라고 전망 했다.",
        "index": 1
      },
      {
        "title": "[재계핫이슈] '1만 코스피' 달성과 중앙그룹 사태",
        "url": "https://www.pennmike.com/news/articleView.html?idxno=122438",
        "source": "pennmike.com",
        "pubDate": "2026-06-20T12:16:00+09:00",
        "description": "현재 삼성전자와 SK하이닉스 같은 실적이 좋은 회사들의 주가 가 이미 대폭 상승함으로써 주식 투자자들이 다른 투자대상을 찾고 있는 상황에서 유망한 회사들의 추가 상장 필요성은 더욱 높아지고 있다. 당장, HD현대 로...",
        "index": 2
      },
      {
        "title": "슈퍼사이클 맞은 K-전력기기, ‘친환경’ 타고 영토 넓힌다",
        "url": "https://www.mediapen.com/news/view/1105525",
        "source": "mediapen.com",
        "pubDate": "2026-06-20T10:48:00+09:00",
        "description": "(효성중공업· HD현대 일렉트릭·LS일렉트릭)의 올해 1분기 기준 수주 잔고는 37조2765억 원으로 집계됐다. 이는... 이같은 친환경 움직임음 국내 전력기기 업계에는 기회가 될 전망 이다. 단기적으로는 부담 요인이지만 국내...",
        "index": 3
      },
      {
        "title": "KB증권, 6월 셋째주 삼성전기 등 8종목 매수 추천",
        "url": "https://www.bigtanews.co.kr/article/view/big202606200001",
        "source": "bigtanews.co.kr",
        "pubDate": "2026-06-20T10:14:00+09:00",
        "description": "목표 주가 44만원과 투자의견 Buy 유지. HD현대 마린솔루션(443060) 2분기 매출 5917억원(+26.5% YoY), 영업이익 976억원(+17.6 YoY, 영업이익률 16.5%)으로 매출 컨센서스 부합, 영업이익 컨센서스 하회할 전망....",
        "index": 4
      },
      {
        "title": "이재명 \"트럼프, 美 군함 10척 건조 가능하냐 물어\"…한미 조선협력 급...",
        "url": "https://www.econovill.com/news/articleView.html?idxno=742931",
        "source": "econovill.com",
        "pubDate": "2026-06-20T09:46:00+09:00",
        "description": "한화오션은 2024년 국내 조선소 가운데 처음으로 미 해군 군수지원함 '월리 시라'호 MRO 사업을 수주한 데 이어 '유콘'호와 '찰스 드류'호 정비 사업까지 따내며 누적 수주 실적 을 확대했다. HD현대 중공업 역시 미 해군 7함대...",
        "index": 5
      }
    ]
  },
  {
    "ticker": "012330",
    "companyName": "현대모비스",
    "rank": 4,
    "poolSize": 199,
    "pUp": 0.754394,
    "baseDate": "2026-06-19",
    "ensemblePredReturn": 0.754394,
    "foreignNetBuy": -53951000000.0,
    "instNetBuy": -32456000000.0,
    "totalSupplyNetBuy": -86407000000.0,
    "foreignPositiveDays": 2,
    "instPositiveDays": 2,
    "supplyWindow": 5,
    "newsCount": 2,
    "newsOverallScore": 7.5,
    "newsSentimentTally": "긍정 1건, 부정 1건",
    "finalSentiment": "Bullish",
    "finalSentimentKo": "상승 우위",
    "finalCombinedScore": 78.0,
    "summary": "현대모비스는 메리츠증권으로부터 로봇 핵심 부품 기업으로의 전환 가능성을 높이 평가받아 목표 주가 90만원과 매수 의견을 제시받았다. 다만, 인도 공장 화재와 같은 공급망 차질 가능성 및 유럽 시장 경쟁 심화 등의 잠재적 리스크 요인도 언급되었다.",
    "tradingInsight": "메리츠증권의 긍정적인 분석과 높은 목표 주가는 단기적으로 매수 포지션을 고려할 만한 강력한 상승 모멘텀을 제공한다. 하지만 공급망 리스크와 시장 경쟁 심화 가능성은 잠재적인 하방 압력으로 작용할 수 있으므로, 해당 이슈들에 대한 지속적인 모니터링과 주의 깊은 접근이 필요하다.",
    "news": [
      {
        "title": "자동차 부품사에서 로봇 핵심 기업으로… 현대모비스 의 대전환",
        "url": "https://www.pinpointnews.co.kr/news/articleView.html?idxno=461691",
        "source": "pinpointnews.co.kr",
        "pubDate": "2026-06-20T14:26:00+09:00",
        "description": "메리츠증권은 현대모비스 가 보스턴다이내믹스와의 협력을 통해 로봇 핵심 부품 공급자로 도약할 가능성이 높다고 평가했다. 목표 주가 90만원, 투자의견은 매수를 제시했다.",
        "index": 1
      },
      {
        "title": "[투자전략] 기아 EV3 효과 본격화… 현대 차보다 강한 전기차 모멘텀",
        "url": "https://www.topstarnews.net/news/articleView.html?idxno=16103695",
        "source": "topstarnews.net",
        "pubDate": "2026-06-20T11:52:00+09:00",
        "description": "셋째, 현대모비스 인도 공장 화재와 같은 공급망 차질 가능성이다. 넷째, 유럽 시장 경쟁 심화에 따른... 반면 현대 차는 아이오닉3 출시 전까지 친환경차 판매 공백을 어떻게 메울지가 하반기 주가 의 핵심 관전...",
        "index": 2
      }
    ]
  },
  {
    "ticker": "005380",
    "companyName": "현대차",
    "rank": 5,
    "poolSize": 199,
    "pUp": 0.749361,
    "baseDate": "2026-06-19",
    "ensemblePredReturn": 0.749361,
    "foreignNetBuy": 164160000000.0,
    "instNetBuy": -622917000000.0,
    "totalSupplyNetBuy": -458757000000.0,
    "foreignPositiveDays": 3,
    "instPositiveDays": 0,
    "supplyWindow": 5,
    "newsCount": 5,
    "newsOverallScore": 4.7,
    "newsSentimentTally": "긍정 2건, 중립 1건, 부정 2건",
    "finalSentiment": "Bearish",
    "finalSentimentKo": "하락 우위",
    "finalCombinedScore": 47.0,
    "summary": "현대차는 글로벌 시장 둔화와 전기차 수요 조정, 친환경차 판매 공백이라는 단기적 도전에 직면해 있으며, 판매량 감소가 불가피할 것으로 예상됩니다. 다만, 원화 약세에 따른 환율 효과가 실적을 일부 방어할 것으로 보이며, KB증권의 매수 추천과 로봇/AI 분야의 장기 성장 잠재력은 긍정적입니다.",
    "tradingInsight": "단기적으로는 글로벌 시장 둔화와 전기차 판매 공백이라는 부정적 요인들이 주가에 하방 압력을 가할 것으로 판단됩니다. 환율 효과는 방어적이지만 핵심 사업의 성장 둔화 우려가 단기 모멘텀을 제약하므로, 아이오닉3 출시 전까지는 신중한 접근이나 보수적 매매 전략이 유효합니다. 로봇/AI 분야의 장기 성장 잠재력은 있으나, 단기 주가 방향성에는 직접적인 영향이 제한적입니다.",
    "news": [
      {
        "title": "\"이제는 실적으로 답할 차례\"… 현대차 에 찾아온 진짜 시험대",
        "url": "https://www.pinpointnews.co.kr/news/articleView.html?idxno=461673",
        "source": "pinpointnews.co.kr",
        "pubDate": "2026-06-20T13:02:00+09:00",
        "description": "현대차 가 글로벌 자동차 시장 둔화와 전기차 수요 조정이라는 도전에 직면한 가운데, 향후 주가 방향은 실제 실적 개선 여부에 달려 있다는 분석이 나왔다. 한화투자증권은 최근 보고서에서 판매량 감소가 불가피한...",
        "index": 1
      },
      {
        "title": "\"이제는 실적 으로 답할 차례\"… 현대차 에 찾아온 진짜 시험대",
        "url": "https://www.pinpointnews.co.kr/news/articleView.html?idxno=461673",
        "source": "pinpointnews.co.kr",
        "pubDate": "2026-06-20T13:02:00+09:00",
        "description": "원화 약세에 따른 환율 효과가 해외 판매 비중이 높은 현대차 의 실적 을 일부 방어할 것으로 예상된다. 현대차 는 글로벌 브랜드 경쟁력과 다양한 지역별 판매 기반을 바탕으로 어려운 시장 환경 속에서도 안정적인 사업...",
        "index": 2
      },
      {
        "title": "[온체인분석] 토요일 새벽에 삼성전자를 산다 '주식 Perp'의 정체",
        "url": "https://www.tokenpost.kr/news/insights/371084",
        "source": "tokenpost.kr",
        "pubDate": "2026-06-20T12:02:00+09:00",
        "description": "세계 최대 가상자산 거래소 바이낸스는 6월 초 삼성전자(005930)·SK하이닉스(000660)· 현대차 (005380) 주가 를 기초자산으로 한 '무기한 선물(perpetual futures·이하 Perp)'을 상장했다. 이 상품은 24시간, 주말 구분 없이, 최대...",
        "index": 3
      },
      {
        "title": "[투자전략] 기아 EV3 효과 본격화… 현대차 보다 강한 전기차 모멘텀",
        "url": "https://www.topstarnews.net/news/articleView.html?idxno=16103695",
        "source": "topstarnews.net",
        "pubDate": "2026-06-20T11:52:00+09:00",
        "description": "현재 데이터만 놓고 보면 전기차 신차 효과가 판매 성장으로 연결되고 있는 기업은 기아다. 반면 현대차 는 아이오닉3 출시 전까지 친환경차 판매 공백을 어떻게 메울지가 하반기 주가 의 핵심 관전 포인트로 꼽힌다.",
        "index": 4
      },
      {
        "title": "KB증권, 6월 셋째주 삼성전기 등 8종목 매수 추천",
        "url": "https://www.bigtanews.co.kr/article/view/big202606200001",
        "source": "bigtanews.co.kr",
        "pubDate": "2026-06-20T10:14:00+09:00",
        "description": "목표 주가 200만원과 투자의견 Buy 유지. 현대차 (005380) 2035년 산업용 휴머노이드 점유율 60%. 중량 화물, 킥 동작 통한 탁월한 전신제어. 구글, 엔비디아: AI 개발 전략적 협력 관계. 하루 만에 동작 익히고...",
        "index": 5
      }
    ]
  },
  {
    "ticker": "007660",
    "companyName": "이수페타시스",
    "rank": 6,
    "poolSize": 199,
    "pUp": 0.746615,
    "baseDate": "2026-06-19",
    "ensemblePredReturn": 0.746615,
    "foreignNetBuy": 60924000000.0,
    "instNetBuy": -103513000000.0,
    "totalSupplyNetBuy": -42589000000.0,
    "foreignPositiveDays": 4,
    "instPositiveDays": 2,
    "supplyWindow": 5,
    "newsCount": 5,
    "newsOverallScore": 8.5,
    "newsSentimentTally": "긍정 4건, 부정 1건",
    "finalSentiment": "Bullish",
    "finalSentimentKo": "상승 우위",
    "finalCombinedScore": 78.0,
    "summary": "이수페타시스는 최근 AI 반도체 산업 성장과 함께 주요 자산운용사의 ETF 편입 및 하반기 실적 개선 기대로 긍정적인 평가를 받고 있습니다. 다만, 기관 투자자의 차익 실현 매도세가 일부 나타났지만, 외국인 투자자의 매수세가 유입되며 상쇄되는 흐름을 보입니다.",
    "tradingInsight": "이수페타시스는 AI 반도체 관련 핵심 부품 기업으로, 자산운용사의 ETF 편입과 외국인 매수세로 긍정적인 모멘텀을 형성하고 있습니다. 기관의 차익 실현 매물 출회는 단기적인 주가 변동성을 야기할 수 있으나, AI 성장 스토리와 하반기 실적 개선 기대감을 고려할 때 장기적인 관점에서의 접근이 유효해 보입니다. 다만, 기술적 지표가 제시되지 않았으므로, 투자 시 시장 수급과 차트 흐름을 면밀히 관찰하며 매수 시점을 신중하게 결정할 필요가 있습니다.",
    "news": [
      {
        "title": "[자산운용 레이더] 미래에셋자산운용, 한국투자신탁운용, 신한자산운용...",
        "url": "http://www.bizwnews.com/news/articleView.html?idxno=139024",
        "source": "bizwnews.com",
        "pubDate": "2026-06-20T15:30:00+09:00",
        "description": "아울러 LG이노텍· 이수페타시스 등 기판·적층세라믹콘덴서(MLCC) 등 핵심 부품 기업도 함께 담았다.... 하반기 실적 개선 기대가 이어지고 있어 국내 메모리 대표 기업에 대한 투자 매력은 여전히 유효하다고...",
        "index": 1
      },
      {
        "title": "AI 열풍에 반도체 ETF 질주…한투운용 '수익률 900% 돌파' 신한운용 '순...",
        "url": "https://www.shinailbo.co.kr/news/articleView.html?idxno=5032282",
        "source": "shinailbo.co.kr",
        "pubDate": "2026-06-20T14:00:00+09:00",
        "description": "해당 상품은 삼성전자와 SK하이닉스를 중심으로 삼성전기, LG이노텍, 이수페타시스 등 AI 반도체... 한지영 키움증권 연구원은 \"삼성전자와 SK하이닉스의 증시 영향력이 확대되면서 이들 종목의 주가 와 수급...",
        "index": 2
      },
      {
        "title": "신한운용 'SOL AI반도체TOP2플러스' 돌풍…상장 3개월 만에 순자산 7조 돌...",
        "url": "https://www.econovill.com/news/articleView.html?idxno=742933",
        "source": "econovill.com",
        "pubDate": "2026-06-20T10:14:00+09:00",
        "description": "대형주 주가 가 강세를 보이면서 투자 수요가 집중된 것으로 풀이된다. ◆ 삼성전자·SK하이닉스 중심... 여기에 LG이노텍, 이수페타시스 등 AI 서버 투자 확대에 따라 중요성이 커지고 있는 기판과 적층세라믹콘덴서...",
        "index": 3
      },
      {
        "title": "[주간 거래소 기관] SK하이닉스 삼성전자 사들이고 한미반도체 현대차는...",
        "url": "https://www.pinpointnews.co.kr/news/articleView.html?idxno=461630",
        "source": "pinpointnews.co.kr",
        "pubDate": "2026-06-20T07:20:00+09:00",
        "description": "반면 최근 높은 주가 상승세를 보였던 일부 종목에서는 차익 실현에 나서면서 업종별 수급 흐름이... AI 반도체 관련 기판 기업 이수페타시스 와 2차전지 기업 LG에너지솔루션에서도 매도세가 확인됐다. 금융주인...",
        "index": 4
      },
      {
        "title": "[주간 거래소 외국인] 삼성전자 SK스퀘어 LG이노텍 대한전선 집중매수....",
        "url": "https://www.pinpointnews.co.kr/news/articleView.html?idxno=461629",
        "source": "pinpointnews.co.kr",
        "pubDate": "2026-06-20T07:14:00+09:00",
        "description": "LS ELECTRIC과 미래에셋증권, 신한지주, 하나금융지 주가 순매수 상위 종목에 이름을 올렸다. 또한 방산 기업 LIG넥스원과 고다층 인쇄회로기판(PCB) 기업 이수페타시스 에도 외국인 매수세가 유입됐다. 반면 순매도에서는...",
        "index": 5
      }
    ]
  },
  {
    "ticker": "032830",
    "companyName": "삼성생명",
    "rank": 7,
    "poolSize": 199,
    "pUp": 0.737253,
    "baseDate": "2026-06-19",
    "ensemblePredReturn": 0.737253,
    "foreignNetBuy": 26636000000.0,
    "instNetBuy": 28675000000.0,
    "totalSupplyNetBuy": 55311000000.0,
    "foreignPositiveDays": 4,
    "instPositiveDays": 2,
    "supplyWindow": 5,
    "newsCount": 5,
    "newsOverallScore": 8.8,
    "newsSentimentTally": "긍정 3건, 중립 1건",
    "finalSentiment": "Bullish",
    "finalSentimentKo": "상승 우위",
    "finalCombinedScore": 88.5,
    "summary": "삼성생명은 삼성전자 지분 가치 부각으로 시가총액이 LG에너지솔루션을 제치고 6위까지 상승했으며, 증권가에서 유망 종목으로 지목되고 있습니다. 삼성전자의 특별배당 가능성은 삼성생명이 보유한 삼성전자 지분 가치 상승에 대한 기대감을 더욱 키우고 있습니다.",
    "tradingInsight": "제시된 뉴스 분석에 따르면 삼성생명은 삼성전자 지분 가치 상승과 긍정적인 시장 및 증권사 평가에 힘입어 단기적인 상승 모멘텀이 강합니다. 투자자는 삼성전자의 주가 흐름 및 향후 배당 정책 발표를 주요 모니터링 변수로 삼아야 하며, 중장기적으로는 금리 환경 및 보험 본업의 실적 개선 여부도 함께 고려하는 것이 바람직합니다.",
    "news": [
      {
        "title": "코스피 9000 돌파했는데 “닷컴버블 후반부와 닮았다”…증권가 분석은",
        "url": "https://www.sedaily.com/article/20058135?ref=naver",
        "source": "sedaily.com",
        "pubDate": "2026-06-20T21:08:00+09:00",
        "description": "반면 AI나 로봇 사업 진출 가능성만 거론돼도 실적과 무관하게 주가 가 급등하는 사례가 이어지고 있다. 이... 삼성 전자 지분 가치가 부각된 삼성생명 도 최근 LG에너지솔루션을 제치고 시가총액 6위에 올라섰다.",
        "index": 1
      },
      {
        "title": "삼전닉스 말고 또 있다...한투가 콕 집은 유망 종목",
        "url": "https://www.mk.co.kr/article/12078698",
        "source": "mk.co.kr",
        "pubDate": "2026-06-20T21:01:00+09:00",
        "description": "선진국 엔비디아·알파벳·마이크론 신흥국 홍콩거래소·강서동업 주목 국내 SK스퀘어· 삼성생명 ·SK하이닉스... 우려보다 양호한 게이밍사업부 실적 역시 투자 심리 개선 요인으로 꼽혔다. 마이크론도 주목할 만하다....",
        "index": 2
      },
      {
        "title": "\"9천피 더 간다\" 기대감에 빚투 과열…예탁금·담보대출 동반 급증",
        "url": "https://economist.co.kr/article/view/ecn202606200011",
        "source": "economist.co.kr",
        "pubDate": "2026-06-20T16:43:00+09:00",
        "description": "반면 주가 하락에 베팅하는 대차거래 잔고는 191조4990억원으로 최근 3거래일 연속 감소했다. 시장에서는... 삼성생명 ·교보 생명 ·한화 생명 등 국내 3대 생명 보험사의 약관대출 잔액은 지난달 말 기준 32조4224억원으로...",
        "index": 3
      },
      {
        "title": "삼성 전자 '특별배당' 효과, 63만원까지 오른다… 삼성 물산 목표 주가 줄상...",
        "url": "https://view.asiae.co.kr/article/2026061908243827450",
        "source": "view.asiae.co.kr",
        "pubDate": "2026-06-20T16:23:00+09:00",
        "description": "증권가에서 삼성 물산에 대한 목표 주가 줄상향이 이어지고 있다. 삼성 전자 배당 확대에 따른 주주환원... 삼성 물산은 삼성 전자, 삼성생명 , 삼성 바이오로직스 등 삼성 그룹 핵심 계열사 지분을 보유하고 있으며, 해당...",
        "index": 4
      },
      {
        "title": "삼성 전자 '특별배당' 효과, 63만원까지 오른다… 삼성 물산 목표주가 줄상...",
        "url": "https://view.asiae.co.kr/article/2026061908243827450",
        "source": "view.asiae.co.kr",
        "pubDate": "2026-06-20T16:23:00+09:00",
        "description": "부문 실적 개선 전망이 맞물린 결과다. 20일 증권가에 따르면 DS투자증권은 전날 삼성 물산의 목표주가를... 삼성 물산은 삼성 전자, 삼성생명 , 삼성 바이오로직스 등 삼성 그룹 핵심 계열사 지분을 보유하고 있으며, 해당...",
        "index": 5
      }
    ]
  },
  {
    "ticker": "016360",
    "companyName": "삼성증권",
    "rank": 8,
    "poolSize": 199,
    "pUp": 0.71088,
    "baseDate": "2026-06-19",
    "ensemblePredReturn": 0.71088,
    "foreignNetBuy": 5119000000.0,
    "instNetBuy": -32245000000.0,
    "totalSupplyNetBuy": -27126000000.0,
    "foreignPositiveDays": 3,
    "instPositiveDays": 1,
    "supplyWindow": 5,
    "newsCount": 5,
    "newsOverallScore": 4.5,
    "newsSentimentTally": "부정 1건, 중립 4건",
    "finalSentiment": "Bearish",
    "finalSentimentKo": "하락 우위",
    "finalCombinedScore": 55.0,
    "summary": "삼성증권은 과거 양호한 주가 흐름을 보였으나, 하반기 금리 인상 가능성으로 인한 트레이딩 손익 둔화 우려가 제기되고 있습니다. 타 기업에 대한 활발한 리서치 활동 및 계열사 협업 소식도 있으나, 본업의 잠재적 리스크가 주목됩니다.",
    "tradingInsight": "냉철한 분석에 따르면, 삼성증권의 단기 주가 방향성은 금리 인상으로 인한 트레이딩 수익 감소 우려로 하방 압력을 받을 수 있습니다. 기술적 지표는 부재하나, 이러한 본업 리스크는 투자 심리를 위축시킬 가능성이 높으므로, 보수적인 관점에서 접근하며 추가적인 사업 동향 및 금리 정책 변화를 주시하는 것이 현명합니다. 매수 관점에서는 금리 인상 우려가 완화되거나 실적 개선의 명확한 신호가 나타날 때까지 관망 전략이 유효합니다.",
    "news": [
      {
        "title": "금리 인상 우려감 높을 때 사 모아야 할 주식은 [주末머니]",
        "url": "https://view.asiae.co.kr/article/2026061816493961217",
        "source": "view.asiae.co.kr",
        "pubDate": "2026-06-20T17:24:00+09:00",
        "description": "주가 흐름이 양호했던 삼성증권 (+40.8%), 한국금융지주(+16.2%), NH투자 증권 (+12.3%) 등도 코스피 수익률에는 미치지 못하는 수치를 보였다. 하반기 기준금리 인상 가능성으로 일각에서는 트레이딩 손익 둔화에 대한 우려도...",
        "index": 1
      },
      {
        "title": "'9년만에 완전체 월드투어' 빅뱅 덕분에 47% 오른다는 이 주식 [주末머니...",
        "url": "https://view.asiae.co.kr/article/2026061814245023821",
        "source": "view.asiae.co.kr",
        "pubDate": "2026-06-20T17:10:00+09:00",
        "description": "최민하 삼성증권 연구원은 와이지엔터테인먼트에 대해 \"데뷔 20주년을 맞은 빅뱅의 컴백을 비롯해... 목표 주가 는 현재 주가 (4만8300원)보다 47% 높은 7만1000원으로 제시하며 투자의견 '매수'를 유지했다. 올해 하반기부터...",
        "index": 2
      },
      {
        "title": "[주末머니]2분기 적자 전망되는데 목표 주가 는 올라간 이 기업",
        "url": "https://view.asiae.co.kr/article/2026061915193856657",
        "source": "view.asiae.co.kr",
        "pubDate": "2026-06-20T16:14:00+09:00",
        "description": "이에 삼성증권 은 LG디스플레이에 대한 목표 주가 를 기존보다 소폭 상향한 1만7000원으로 제시하고 투자의견 '매수'를 유지했다. 목표 주가 상향은 비교 기업들의 평균 주가 상승에 따른 주가 순자산비율(PBR) 변화를...",
        "index": 3
      },
      {
        "title": "[주末머니]2분기 적자 전망되는데 목표주가는 올라간 이 기업",
        "url": "https://view.asiae.co.kr/article/2026061915193856657",
        "source": "view.asiae.co.kr",
        "pubDate": "2026-06-20T16:14:00+09:00",
        "description": "삼성증권 은 올해 LG디스플레이 연간 실적 전망도 일부 조정했다. 2분기 인력 효율화 비용 반영을 고려해 연간 매출 전망은 25조3000억원, 영업이익 전망은 1조2000억원으로 낮췄다. 다만 하반기부터는 모바일 패널 출하...",
        "index": 4
      },
      {
        "title": "LG전자, 가전제품 자원순환 생태계 조성 나선다",
        "url": "https://news.bizwatch.co.kr/article/industry/2026/06/19/0027",
        "source": "news.bizwatch.co.kr",
        "pubDate": "2026-06-20T15:00:00+09:00",
        "description": "신상품 수준으로 정비한 제품) 사업 실증도 진행. 리퍼비시 제품은 엄격한 품질 검사를 거쳐 신제품과... 한진칼, 대한항공, 아시아나항공, 진에어는 삼성 생명, 삼성 화재, 삼성 카드, 삼성증권 , 삼성 자산운용과 이를...",
        "index": 5
      }
    ]
  },
  {
    "ticker": "003670",
    "companyName": "포스코퓨처엠",
    "rank": 9,
    "poolSize": 199,
    "pUp": 0.701252,
    "baseDate": "2026-06-19",
    "ensemblePredReturn": 0.701252,
    "foreignNetBuy": 24532000000.0,
    "instNetBuy": -22089000000.0,
    "totalSupplyNetBuy": 2443000000.0,
    "foreignPositiveDays": 4,
    "instPositiveDays": 1,
    "supplyWindow": 5,
    "newsCount": 0,
    "newsOverallScore": 0.0,
    "newsSentimentTally": "",
    "finalSentiment": "Neutral",
    "finalSentimentKo": "중립",
    "finalCombinedScore": 65.0,
    "summary": "해당 기업에 대한 최신 뉴스가 없습니다.",
    "tradingInsight": "최신 뉴스가 부재하며, 기술적 지표에 대한 정보도 제공되지 않아 단기 주가 방향성을 예측하기 어렵습니다. 현재로서는 명확한 매매 시그널이 없는 중립적인 상황으로 판단됩니다. 추가적인 정보나 시장 상황 변화를 관망하며 신중하게 접근하는 것이 리스크를 관리하는 데 중요합니다.",
    "news": []
  },
  {
    "ticker": "051910",
    "companyName": "LG화학",
    "rank": 10,
    "poolSize": 199,
    "pUp": 0.700647,
    "baseDate": "2026-06-19",
    "ensemblePredReturn": 0.700647,
    "foreignNetBuy": 53012000000.0,
    "instNetBuy": -12898000000.0,
    "totalSupplyNetBuy": 40114000000.0,
    "foreignPositiveDays": 4,
    "instPositiveDays": 2,
    "supplyWindow": 5,
    "newsCount": 4,
    "newsOverallScore": 4.5,
    "newsSentimentTally": "긍정 1건, 부정 1건, 중립 2건",
    "finalSentiment": "Bearish",
    "finalSentimentKo": "하락 우위",
    "finalCombinedScore": 58.0,
    "summary": "LG화학은 1분기 석유화학 부문에서 흑자를 기록했으나, 전기차 수요 둔화와 석유화학 산업 침체로 핵심 사업은 전반적으로 숨 고르기 중입니다. 워터솔루션 사업부 매각과 같은 사업 재편을 모색하고 있으며, LG그룹의 피지컬AI 잠재력에도 불구하고 최근 주가는 조정을 겪고 있습니다.",
    "tradingInsight": "최신 뉴스에 따르면 LG화학은 주력 사업의 부진과 시장 침체 여파로 단기적인 실적 개선 동력이 부족해 보입니다. '숨 고르기'와 '조정' 언급은 현재 주가가 횡보하거나 하방 압력을 받을 가능성을 시사합니다. 투자자들은 주요 사업 부문의 유의미한 회복 신호나 강력한 신사업 모멘텀이 확인되기 전까지는 신중한 관망 자세를 유지하거나 보수적인 접근을 권장합니다.",
    "news": [
      {
        "title": "래깅 효과 끝나간다…석화업계 다시 '생존 모드'",
        "url": "https://daily.hankooki.com/news/articleView.html?idxno=1378192",
        "source": "daily.hankooki.com",
        "pubDate": "2026-06-20T17:00:00+09:00",
        "description": "실제로 주요 업체들은 올해 1분기 반짝 실적 을 냈다. 먼저 롯데케미칼은 영업이익 735억원을 기록하며 10개 분기 만에 흑자 전환했고, LG화학 석유 화학 부문과 한화솔루션 케미칼 부문도 각각 1648억원, 341억원의 영업이익을...",
        "index": 1
      },
      {
        "title": "사모펀드 인수전의 새 계산법…율곡 매각 변수 된 고용안정[위클리IB]",
        "url": "https://www.edaily.co.kr/news/newspath.asp?newsid=01387446645483688",
        "source": "edaily.co.kr",
        "pubDate": "2026-06-20T13:11:00+09:00",
        "description": "고객사 승인과 품질 인증, 납품 이력, 숙련공의 공정 이해도가 실적 과 직결된다. 신규 인력을 투입한다고... 글랜우드PE가 최근 LG화학 워터솔루션 사업부 인수 과정에서 직원 고용 안정을 보장한 점을 높이 평가 받은...",
        "index": 2
      },
      {
        "title": "‘계열사 사이클’ 뒤 숨은 사령탑… 지주사 LG 결단 통했다",
        "url": "https://www.mediapen.com/news/view/1105519",
        "source": "mediapen.com",
        "pubDate": "2026-06-20T10:48:00+09:00",
        "description": "LG화학 과 자회사 LG 에너지솔루션이 전기차 수요 둔화와 석유 화학 침체 여파로 숨 고르기에 들어간 반면... 지주사 특유의 할인율 탓에 당장 주가 의 폭등으로 이어지진 않았지만, 전체 발행 주식 수를 줄여 주당순이익(EPS)...",
        "index": 3
      },
      {
        "title": "구광모 회장의 'One LG ' 체제, 피지컬AI 밸류체인 석권",
        "url": "https://www.newspost.kr/news/articleView.html?idxno=223686",
        "source": "newspost.kr",
        "pubDate": "2026-06-20T10:16:00+09:00",
        "description": "증권시장에서는 LG , LG 에너지솔루션, LG 전자, LG화학 , LG 이노텍, LG CNS의 주가 가 치솟았다. 최근에는 조정이 이뤄져 기존 주가 로 회귀 중이긴 하다. 다만 국내 투자자들이 가장 주목하는 피지컬AI 기업이 ' LG 그룹'이라는...",
        "index": 4
      }
    ]
  }
];

export function getAiCandidate(ticker: string): AiCandidate | undefined {
  const code = ticker.replace(/\D/g, "").padStart(6, "0").slice(-6);
  return aiCandidates.find((c) => c.ticker === code);
}
