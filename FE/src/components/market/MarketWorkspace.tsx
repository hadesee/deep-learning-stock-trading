import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { MarketDashboardData, MarketDirection, StockQuote } from "../../types/trading";
import { readWatchlistCodes, writeWatchlistCodes } from "../../services/tradingData";
import { describeAiSummary } from "../../utils/aiSignal";

type MarketFilter = "ALL" | "AI" | "UP" | "DOWN" | "FOREIGN" | "INSTITUTION";
type TableDensity = "comfortable" | "compact";
type SortDirection = "asc" | "desc";
type SortField = "currentPrice" | "changeRate" | "tradingValue" | "personal" | "foreign" | "institution";
type SortState = {
  direction: SortDirection;
  field: SortField;
};

const MAX_PAGE_COUNT = 20;
const PAGE_SIZE = 10;

export type DashboardSyncStatus = {
  errorMessage?: string;
  isRefreshing: boolean;
  onRefresh: () => void;
};

export type DashboardCandidateAnalysisStatus = {
  errorMessage?: string;
  isRunning: boolean;
  message?: string;
  onRun: () => void;
};

const navItems = [
  { id: "market-home", label: "홈" },
  { id: "market-table", label: "주식 골라보기" },
] as const;

const boardFilterOptions: Array<{ value: MarketFilter; label: string }> = [
  { value: "ALL", label: "전체" },
  { value: "AI", label: "AI 후보" },
  { value: "UP", label: "상승" },
  { value: "DOWN", label: "하락" },
  { value: "FOREIGN", label: "외국인 순매수" },
  { value: "INSTITUTION", label: "기관 순매수" },
];

function formatWon(value: number) {
  return `${value.toLocaleString("ko-KR")}원`;
}

function formatCompactWon(value: number) {
  if (value >= 1000000000000) {
    return `${Math.round(value / 100000000000) / 10}조원`;
  }

  if (value >= 100000000) {
    return `${Math.round(value / 100000000).toLocaleString("ko-KR")}억원`;
  }

  return formatWon(value);
}

function formatVolume(value: number) {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${Math.abs(value).toLocaleString("ko-KR")}주`;
}

/**
 * The KIS quote bridge can't supply per-investor net buying yet, so it returns
 * all-zero flows. Treat that as "no data" and render a dash instead of a
 * misleading "0주" so the table doesn't imply real, balanced flows.
 */
function hasInvestorFlow(flow: StockQuote["investorFlow"]) {
  return flow.personal !== 0 || flow.foreign !== 0 || flow.institution !== 0;
}

function formatFlowCell(flow: StockQuote["investorFlow"], value: number) {
  return hasInvestorFlow(flow) ? formatVolume(value) : "—";
}

function formatRate(value: number) {
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function normalizeSearch(value: string) {
  return value.replace(/\s+/g, "").toLowerCase();
}

function isAiCandidate(stock: StockQuote) {
  return stock.sentimentLabel === "POSITIVE" && (stock.predictedReturn ?? 0) >= 0.4;
}

function getSortValue(stock: StockQuote, field: SortField) {
  if (field === "currentPrice") {
    return stock.currentPrice;
  }

  if (field === "changeRate") {
    return stock.changeRate;
  }

  if (field === "personal") {
    return stock.investorFlow.personal;
  }

  if (field === "foreign") {
    return stock.investorFlow.foreign;
  }

  if (field === "institution") {
    return stock.investorFlow.institution;
  }

  return stock.tradingValue;
}

function MiniSparkline({ values, direction }: { values: number[]; direction: MarketDirection }) {
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = Math.max(max - min, 1);
  const points = values
    .map((value, index) => {
      const x = (index / Math.max(values.length - 1, 1)) * 100;
      const y = 36 - ((value - min) / range) * 32;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg className={`sparkline sparkline--${direction}`} viewBox="0 0 100 40" aria-hidden="true">
      <polyline points={points} fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="3" />
    </svg>
  );
}

function MarketTopBar({
  activeSection,
  isSearchOpen,
  query,
  searchResults,
  onClearSearch,
  onDashboardClick,
  onNavigate,
  onQueryChange,
  onSearchFocus,
  onSearchSubmit,
  onSelectSearchResult,
}: {
  activeSection: string;
  isSearchOpen: boolean;
  query: string;
  searchResults: StockQuote[];
  onClearSearch: () => void;
  onDashboardClick: () => void;
  onNavigate: (sectionId: string) => void;
  onQueryChange: (value: string) => void;
  onSearchFocus: () => void;
  onSearchSubmit: () => void;
  onSelectSearchResult: (stock: StockQuote) => void;
}) {
  return (
    <header className="market-topbar">
      <Link className="market-brand" to="/" aria-label="KOSPI AI Trading Desk 홈">
        <span className="market-brand__mark" aria-hidden="true">
          <svg viewBox="0 0 28 28" focusable="false">
            <path d="M6 19.5L11 14l4 3.5 7-9" />
            <circle cx="6" cy="19.5" r="1.6" />
            <circle cx="11" cy="14" r="1.6" />
            <circle cx="15" cy="17.5" r="1.6" />
            <circle cx="22" cy="8.5" r="1.6" />
          </svg>
        </span>
        <strong>KOSPI AI Trading Desk</strong>
      </Link>
      <nav className="market-tabs" aria-label="주요 메뉴">
        {navItems.map((item) => (
          <a
            aria-current={activeSection === item.id ? "page" : undefined}
            href={`#${item.id}`}
            key={item.id}
            onClick={(event) => {
              event.preventDefault();
              onNavigate(item.id);
            }}
          >
            {item.label}
          </a>
        ))}
      </nav>
      <div className="market-search-wrap">
        <form
          className="market-search"
          onSubmit={(event) => {
            event.preventDefault();
            onSearchSubmit();
          }}
          role="search"
        >
          <span aria-hidden="true">⌕</span>
          <input
            aria-label="국내 종목 검색"
            autoComplete="off"
            onChange={(event) => onQueryChange(event.target.value)}
            onFocus={onSearchFocus}
            placeholder="종목명 또는 종목코드 검색"
            type="search"
            value={query}
          />
          {query ? (
            <button className="search-clear" onClick={onClearSearch} type="button" aria-label="검색어 지우기">
              ×
            </button>
          ) : null}
        </form>
        {query && isSearchOpen ? (
          <div className="search-results" role="listbox" aria-label="종목 검색 결과">
            {searchResults.length > 0 ? (
              searchResults.slice(0, 6).map((stock) => (
                <button
                  className="search-result-button"
                  key={stock.code}
                  onClick={() => onSelectSearchResult(stock)}
                  role="option"
                  type="button"
                >
                  <span>{stock.name}</span>
                  <strong>{stock.code}</strong>
                  <small className={`market-change market-change--${stock.direction}`}>
                    {formatRate(stock.changeRate)}
                  </small>
                </button>
              ))
            ) : (
              <p className="search-empty">일치하는 KOSPI 종목이 없습니다.</p>
            )}
          </div>
        ) : null}
      </div>
      <button className="market-login" onClick={onDashboardClick} type="button">
        대시보드
      </button>
    </header>
  );
}

function IndexCard({ index }: { index: MarketDashboardData["indices"][number] }) {
  return (
    <article className="index-card">
      <div className="index-card__title">
        <span>{index.name}</span>
        <strong>{index.value.toLocaleString("ko-KR")}</strong>
      </div>
      <MiniSparkline values={index.miniSeries} direction={index.direction} />
      <p className={`market-change market-change--${index.direction}`}>
        {index.change.toLocaleString("ko-KR")} ({formatRate(index.changeRate)})
      </p>
    </article>
  );
}

function MarketOverview({
  candidateAnalysis,
  data,
  focused,
  onNavigate,
  onOpenDetail,
  syncStatus,
}: {
  candidateAnalysis: DashboardCandidateAnalysisStatus;
  data: MarketDashboardData;
  focused: StockQuote;
  onNavigate: (sectionId: string) => void;
  onOpenDetail: () => void;
  syncStatus: DashboardSyncStatus;
}) {
  const syncLabel = syncStatus.isRefreshing
    ? "KIS 동기화 중"
    : syncStatus.errorMessage
      ? "기본 데이터 표시 중"
      : "KIS 동기화 완료";

  return (
    <section className="market-overview" id="market-home">
      <div className="session-row">
        <span className="session-dot" aria-hidden="true" />
        <span>{data.sessionLabel}</span>
        <span className="session-muted">한국시장 전용 · 현재가/지수 KIS 연동</span>
        <span
          className={`session-sync ${syncStatus.errorMessage ? "session-sync--warning" : ""}`}
          role="status"
          aria-live="polite"
        >
          {syncStatus.isRefreshing ? <i aria-hidden="true" /> : null}
          {syncLabel}
        </span>
        <button className="session-refresh" disabled={syncStatus.isRefreshing} onClick={syncStatus.onRefresh} type="button">
          새로고침
        </button>
        <button
          className="candidate-analysis-button"
          disabled={candidateAnalysis.isRunning}
          onClick={candidateAnalysis.onRun}
          type="button"
        >
          {candidateAnalysis.isRunning ? "AI 분석 중" : "AI 후보 분석"}
        </button>
        {candidateAnalysis.message ? (
          <span className="candidate-analysis-status" role="status">
            {candidateAnalysis.message}
          </span>
        ) : null}
        {candidateAnalysis.errorMessage ? (
          <span className="candidate-analysis-status candidate-analysis-status--error" role="status" title={candidateAnalysis.errorMessage}>
            AI 후보 분석 실패: {candidateAnalysis.errorMessage}
          </span>
        ) : null}
        {syncStatus.errorMessage ? (
          <span className="session-error" title={syncStatus.errorMessage}>
            실시간 시세를 불러오지 못해 최근 기준 데이터를 표시합니다.
          </span>
        ) : null}
      </div>

      <div className="overview-grid">
        <div className="index-grid">
          {data.indices.map((index) => (
            <IndexCard index={index} key={index.symbol} />
          ))}
        </div>

        <article className="ai-brief">
          <span className="brief-chip">KOSPI AI</span>
          <h1>거래대금과 수급으로 오늘의 후보 종목을 정렬합니다</h1>
          <p>
            한국투자증권 API에서 현재가와 거래대금을 받고, 개인·외국인·기관 순매수 흐름을 함께
            보여주는 국내시장 전용 보드입니다.
          </p>
          <div className="brief-focus">
            <span>선택 종목</span>
            <strong>
              {focused.name} {focused.code}
            </strong>
            <small>{describeAiSummary(focused)}</small>
            <button type="button" onClick={onOpenDetail}>
              포트폴리오 열기
            </button>
          </div>
        </article>

        <aside className="event-card" aria-label="주요 일정">
          <div className="event-card__head">
            <strong>주요 일정</strong>
            <button aria-label="종목 목록으로 이동" onClick={() => onNavigate("market-table")} type="button">
              ›
            </button>
          </div>
          {data.events.map((event) => (
            <p key={event.title}>
              <span>{event.timeLabel}</span>
              {event.title}
            </p>
          ))}
        </aside>
      </div>
    </section>
  );
}

function StockTable({
  activeFilter,
  density,
  onClearFilters,
  onDensityChange,
  onFilterChange,
  onPageChange,
  onSelectStock,
  onSortChange,
  pageIndex,
  pageOffset,
  pageSize,
  selectedCode,
  sortState,
  stocks,
  totalFilteredCount,
  totalPages,
  totalCount,
}: {
  activeFilter: MarketFilter;
  density: TableDensity;
  onClearFilters: () => void;
  onDensityChange: (density: TableDensity) => void;
  onFilterChange: (filter: MarketFilter) => void;
  onPageChange: (pageIndex: number) => void;
  onSelectStock: (stock: StockQuote) => void;
  onSortChange: (field: SortField) => void;
  pageIndex: number;
  pageOffset: number;
  pageSize: number;
  selectedCode: string;
  sortState: SortState;
  stocks: StockQuote[];
  totalFilteredCount: number;
  totalPages: number;
  totalCount: number;
}) {
  const pageButtons = Array.from({ length: MAX_PAGE_COUNT }, (_, index) => index);
  const rangeStart = totalFilteredCount === 0 ? 0 : pageOffset + 1;
  const rangeEnd = Math.min(pageOffset + stocks.length, totalFilteredCount);

  function getSortDirectionLabel(field: SortField) {
    if (sortState.field !== field) {
      return "정렬";
    }

    return sortState.direction === "asc" ? "오름차순" : "내림차순";
  }

  function renderSortHeader(field: SortField, label: string) {
    const isActive = sortState.field === field;

    return (
      <button
        className={`sort-header ${isActive ? "is-active" : ""}`}
        onClick={() => onSortChange(field)}
        type="button"
      >
        <span>{label}</span>
        <small aria-hidden="true">{isActive ? (sortState.direction === "asc" ? "↑" : "↓") : "↕"}</small>
        <span className="sr-only">{getSortDirectionLabel(field)}</span>
      </button>
    );
  }

  return (
    <section className="stock-board" id="market-table">
      <div className="board-toolbar">
        <div>
          <h2>실시간 종목</h2>
          <p>
            {rangeStart.toLocaleString("ko-KR")}-{rangeEnd.toLocaleString("ko-KR")}개 표시 · 필터 결과{" "}
            {totalFilteredCount.toLocaleString("ko-KR")}개 · 전체 {totalCount.toLocaleString("ko-KR")}개
          </p>
        </div>
        <div className="board-controls">
          <div className="board-controls__row">
            <div className="density-toggle" role="group" aria-label="목록 밀도">
              <button
                aria-pressed={density === "comfortable"}
                onClick={() => onDensityChange("comfortable")}
                type="button"
              >
                기본
              </button>
              <button
                aria-pressed={density === "compact"}
                onClick={() => onDensityChange("compact")}
                type="button"
              >
                간략히
              </button>
            </div>
          </div>
          <div className="filter-pills" aria-label="종목 필터">
            {boardFilterOptions.map((option) => (
              <button
                aria-pressed={activeFilter === option.value}
                key={option.value}
                onClick={() => onFilterChange(option.value)}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="stock-table-wrap">
        <table className={`stock-table stock-table--${density}`}>
          <thead>
            <tr>
              <th scope="col">순위</th>
              <th scope="col">종목</th>
              <th aria-sort={sortState.field === "currentPrice" ? (sortState.direction === "asc" ? "ascending" : "descending") : "none"} scope="col">
                {renderSortHeader("currentPrice", "현재가")}
              </th>
              <th aria-sort={sortState.field === "changeRate" ? (sortState.direction === "asc" ? "ascending" : "descending") : "none"} scope="col">
                {renderSortHeader("changeRate", "등락률")}
              </th>
              <th aria-sort={sortState.field === "tradingValue" ? (sortState.direction === "asc" ? "ascending" : "descending") : "none"} scope="col">
                {renderSortHeader("tradingValue", "거래대금")}
              </th>
              <th aria-sort={sortState.field === "personal" ? (sortState.direction === "asc" ? "ascending" : "descending") : "none"} scope="col">
                {renderSortHeader("personal", "개인")}
              </th>
              <th aria-sort={sortState.field === "foreign" ? (sortState.direction === "asc" ? "ascending" : "descending") : "none"} scope="col">
                {renderSortHeader("foreign", "외국인")}
              </th>
              <th aria-sort={sortState.field === "institution" ? (sortState.direction === "asc" ? "ascending" : "descending") : "none"} scope="col">
                {renderSortHeader("institution", "기관")}
              </th>
              <th scope="col">AI 요약</th>
            </tr>
          </thead>
          <tbody>
            {stocks.length > 0 ? (
              stocks.map((stock, index) => (
                <tr className={selectedCode === stock.code ? "is-selected" : undefined} key={stock.code}>
                  <td>{pageOffset + index + 1}</td>
                  <td>
                    <button className="stock-name-button" onClick={() => onSelectStock(stock)} type="button">
                      <span aria-hidden="true">{stock.name.slice(0, 1)}</span>
                      <div>
                        <strong>{stock.name}</strong>
                        <small>{stock.code}</small>
                      </div>
                    </button>
                  </td>
                  <td>{formatWon(stock.currentPrice)}</td>
                  <td>
                    <span className={`rate-badge rate-badge--${stock.direction}`}>{formatRate(stock.changeRate)}</span>
                  </td>
                  <td>{formatCompactWon(stock.tradingValue)}</td>
                  <td className={!hasInvestorFlow(stock.investorFlow) ? undefined : stock.investorFlow.personal >= 0 ? "is-positive-text" : "is-negative-text"}>
                    {formatFlowCell(stock.investorFlow, stock.investorFlow.personal)}
                  </td>
                  <td className={!hasInvestorFlow(stock.investorFlow) ? undefined : stock.investorFlow.foreign >= 0 ? "is-positive-text" : "is-negative-text"}>
                    {formatFlowCell(stock.investorFlow, stock.investorFlow.foreign)}
                  </td>
                  <td className={!hasInvestorFlow(stock.investorFlow) ? undefined : stock.investorFlow.institution >= 0 ? "is-positive-text" : "is-negative-text"}>
                    {formatFlowCell(stock.investorFlow, stock.investorFlow.institution)}
                  </td>
                  <td>{describeAiSummary(stock)}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={9}>
                  <div className="empty-state">
                    <strong>조건에 맞는 종목이 없습니다.</strong>
                    <p>검색어나 필터를 조금 넓혀보세요.</p>
                    <button type="button" onClick={onClearFilters}>
                      필터 초기화
                    </button>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <ul className="stock-card-list" aria-label="실시간 종목 목록">
        {stocks.length > 0 ? (
          stocks.map((stock, index) => (
            <li className={selectedCode === stock.code ? "is-selected" : undefined} key={stock.code}>
              <button className="stock-card" onClick={() => onSelectStock(stock)} type="button">
                <span className="stock-card__rank" aria-label={`목록 ${pageOffset + index + 1}위`}>
                  {pageOffset + index + 1}
                </span>
                <span className="stock-logo" aria-hidden="true">
                  {stock.name.slice(0, 1)}
                </span>
                <span className="stock-card__title">
                  <strong>{stock.name}</strong>
                  <small>{stock.code}</small>
                </span>
                <span className="stock-card__price">
                  <strong>{formatWon(stock.currentPrice)}</strong>
                  <span className={`rate-badge rate-badge--${stock.direction}`}>
                    {formatRate(stock.changeRate)}
                  </span>
                </span>
                <span className="stock-card__meta">
                  <span>
                    거래대금 <b>{formatCompactWon(stock.tradingValue)}</b>
                  </span>
                  <span className={!hasInvestorFlow(stock.investorFlow) ? undefined : stock.investorFlow.foreign >= 0 ? "is-positive-text" : "is-negative-text"}>
                    외국인 {formatFlowCell(stock.investorFlow, stock.investorFlow.foreign)}
                  </span>
                </span>
              </button>
            </li>
          ))
        ) : (
          <li className="stock-card-list__empty">
            <div className="empty-state">
              <strong>조건에 맞는 종목이 없습니다.</strong>
              <p>검색어나 필터를 조금 넓혀보세요.</p>
              <button type="button" onClick={onClearFilters}>
                필터 초기화
              </button>
            </div>
          </li>
        )}
      </ul>

      <div className="stock-pagination" aria-label="종목 페이지">
        <button disabled={pageIndex === 0} onClick={() => onPageChange(pageIndex - 1)} type="button">
          이전
        </button>
        <div className="stock-pagination__pages">
          {pageButtons.map((buttonIndex) => {
            const isEnabled = buttonIndex < totalPages;
            return (
              <button
                aria-current={pageIndex === buttonIndex ? "page" : undefined}
                disabled={!isEnabled}
                key={buttonIndex}
                onClick={() => onPageChange(buttonIndex)}
                type="button"
              >
                {buttonIndex + 1}
              </button>
            );
          })}
        </div>
        <button disabled={pageIndex >= totalPages - 1} onClick={() => onPageChange(pageIndex + 1)} type="button">
          다음
        </button>
        <span>
          페이지당 {pageSize}개 · 최대 {MAX_PAGE_COUNT}페이지
        </span>
      </div>
    </section>
  );
}

function WatchlistRail({
  isOpen,
  isSelectedInWatchlist,
  onRemoveStock,
  onSelectStock,
  onToggleSelected,
  onToggleOpen,
  selectedStock,
  stocks,
}: {
  isOpen: boolean;
  isSelectedInWatchlist: boolean;
  onRemoveStock: (code: string) => void;
  onSelectStock: (stock: StockQuote) => void;
  onToggleSelected: () => void;
  onToggleOpen: () => void;
  selectedStock: StockQuote;
  stocks: StockQuote[];
}) {
  return (
    <aside className={`watch-rail ${isOpen ? "" : "watch-rail--collapsed"}`} aria-label="관심 종목">
      <div className="watch-rail__head">
        <strong>관심</strong>
        <button
          type="button"
          aria-expanded={isOpen}
          aria-label={isOpen ? "관심 패널 닫기" : "관심 패널 열기"}
          onClick={onToggleOpen}
        >
          <span className="watch-menu-icon" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </button>
      </div>
      <p className="watch-ai">
        선택 종목: <strong>{selectedStock.name}</strong>. 버튼으로 관심 목록을 직접 관리할 수 있습니다.
      </p>
      <button className="watch-selected-toggle" onClick={onToggleSelected} type="button">
        {isSelectedInWatchlist ? "선택 종목 관심 해제" : "선택 종목 관심 추가"}
      </button>
      {stocks.length > 0 ? (
        <ul>
          {stocks.map((stock) => (
            <li className={selectedStock.code === stock.code ? "is-selected" : undefined} key={stock.code}>
              <button className="watch-stock-button" onClick={() => onSelectStock(stock)} type="button">
                <span className="stock-logo" aria-hidden="true">
                  {stock.name.slice(0, 1)}
                </span>
                <div>
                  <strong>{stock.name}</strong>
                  <small className={`market-change market-change--${stock.direction}`}>
                    {formatWon(stock.currentPrice)} · {formatRate(stock.changeRate)}
                  </small>
                </div>
              </button>
              <button className="watch-remove" onClick={() => onRemoveStock(stock.code)} type="button" aria-label={`${stock.name} 관심 해제`}>
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="watch-empty">
          <strong>관심 종목이 없습니다.</strong>
          <p>테이블이나 검색에서 종목을 선택한 뒤 추가해보세요.</p>
        </div>
      )}
    </aside>
  );
}

export function MarketWorkspace({
  candidateAnalysis,
  data,
  syncStatus,
}: {
  candidateAnalysis: DashboardCandidateAnalysisStatus;
  data: MarketDashboardData;
  syncStatus: DashboardSyncStatus;
}) {
  const navigate = useNavigate();
  const [activeSection, setActiveSection] = useState("market-home");
  const [density, setDensity] = useState<TableDensity>("comfortable");
  const [filter, setFilter] = useState<MarketFilter>("ALL");
  const [isSearchOpen, setSearchOpen] = useState(false);
  const [isWatchRailOpen, setWatchRailOpen] = useState(true);
  const [pageIndex, setPageIndex] = useState(0);
  const [query, setQuery] = useState("");
  const [selectedCode, setSelectedCode] = useState(data.focusedStockCode);
  const [sortState, setSortState] = useState<SortState>({ direction: "desc", field: "tradingValue" });
  // The persisted watchlist survives reloads; the server's default list only
  // seeds first-time visitors (or storage-unavailable sessions).
  const [watchCodes, setWatchCodes] = useState<string[]>(
    () => readWatchlistCodes() ?? data.watchlist.map((stock) => stock.code),
  );

  useEffect(() => {
    writeWatchlistCodes(watchCodes);
  }, [watchCodes]);

  const selectedStock = data.stocks.find((stock) => stock.code === selectedCode) ?? data.stocks[0];
  const normalizedQuery = normalizeSearch(query);

  const searchResults = useMemo(() => {
    if (!normalizedQuery) {
      return [];
    }

    return data.stocks.filter((stock) => {
      const searchable = normalizeSearch(`${stock.name}${stock.code}`);
      return searchable.includes(normalizedQuery);
    });
  }, [data.stocks, normalizedQuery]);

  const visibleStocks = useMemo(() => {
    const base = normalizedQuery ? searchResults : data.stocks;
    const filtered = base.filter((stock) => {
      if (filter === "AI") {
        return isAiCandidate(stock);
      }

      if (filter === "UP") {
        return stock.direction === "up";
      }

      if (filter === "DOWN") {
        return stock.direction === "down";
      }

      if (filter === "FOREIGN") {
        return stock.investorFlow.foreign > 0;
      }

      if (filter === "INSTITUTION") {
        return stock.investorFlow.institution > 0;
      }

      return true;
    });

    return [...filtered].sort((a, b) => {
      const multiplier = sortState.direction === "asc" ? 1 : -1;
      const valueDelta = getSortValue(a, sortState.field) - getSortValue(b, sortState.field);

      if (valueDelta !== 0) {
        return valueDelta * multiplier;
      }

      return a.name.localeCompare(b.name, "ko-KR");
    });
  }, [data.stocks, filter, normalizedQuery, searchResults, sortState]);

  const totalPages = Math.max(1, Math.min(MAX_PAGE_COUNT, Math.ceil(visibleStocks.length / PAGE_SIZE)));
  const safePageIndex = Math.min(pageIndex, totalPages - 1);
  const pageOffset = safePageIndex * PAGE_SIZE;
  const paginatedStocks = visibleStocks.slice(pageOffset, pageOffset + PAGE_SIZE);

  useEffect(() => {
    setPageIndex((current) => Math.min(current, totalPages - 1));
  }, [totalPages]);

  const watchlist = useMemo(
    () =>
      watchCodes
        .map((code) => data.stocks.find((stock) => stock.code === code))
        .filter((stock): stock is StockQuote => Boolean(stock)),
    [data.stocks, watchCodes],
  );

  const isSelectedInWatchlist = watchCodes.includes(selectedStock.code);

  function navigateTo(sectionId: string) {
    setActiveSection(sectionId);
    document.getElementById(sectionId)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // Honor a deep-link hash (e.g. /dashboard#market-table from the footer) once on
  // mount, after the workspace and its section anchors have rendered.
  useEffect(() => {
    const sectionId = window.location.hash.replace(/^#/, "");
    if (!sectionId || !navItems.some((item) => item.id === sectionId)) {
      return;
    }

    setActiveSection(sectionId);
    // rAF: wait for layout so scrollIntoView targets the settled position.
    const raf = requestAnimationFrame(() => {
      document.getElementById(sectionId)?.scrollIntoView({ behavior: "auto", block: "start" });
    });

    return () => cancelAnimationFrame(raf);
  }, []);

  // Clicking any stock (table, card, watchlist, search) navigates to its
  // dedicated analysis page (/stock/:code) — a full, shareable report instead of
  // a cramped modal. We still track the selected code so the overview brief and
  // watchlist highlight stay in sync if the user returns to the dashboard.
  function selectStock(stock: StockQuote, syncSearch = false) {
    setSelectedCode(stock.code);

    if (syncSearch) {
      setQuery(`${stock.name} ${stock.code}`);
      setSearchOpen(false);
    }

    navigate(`/stock/${stock.code}`);
  }

  function clearSearchAndFilters() {
    setQuery("");
    setSearchOpen(false);
    setFilter("ALL");
    setSortState({ direction: "desc", field: "tradingValue" });
    setPageIndex(0);
  }

  function changeFilter(nextFilter: MarketFilter) {
    setFilter(nextFilter);
    setPageIndex(0);
  }

  function changePage(nextPageIndex: number) {
    setPageIndex(Math.min(Math.max(nextPageIndex, 0), totalPages - 1));
  }

  function changeSort(field: SortField) {
    setSortState((current) => ({
      direction: current.field === field && current.direction === "desc" ? "asc" : "desc",
      field,
    }));
    setPageIndex(0);
  }

  function toggleSelectedWatchlist() {
    setWatchCodes((current) => {
      if (current.includes(selectedStock.code)) {
        return current.filter((code) => code !== selectedStock.code);
      }

      return [selectedStock.code, ...current];
    });
  }

  function removeWatchStock(code: string) {
    setWatchCodes((current) => current.filter((item) => item !== code));
  }

  function submitSearch() {
    if (searchResults[0]) {
      selectStock(searchResults[0], true);
    }
  }

  return (
    <div className="market-workspace">
      <MarketTopBar
        activeSection={activeSection}
        isSearchOpen={isSearchOpen}
        onClearSearch={() => {
          setQuery("");
          setSearchOpen(false);
          setPageIndex(0);
        }}
        onDashboardClick={() => navigateTo("market-table")}
        onNavigate={navigateTo}
        onQueryChange={(value) => {
          setQuery(value);
          setSearchOpen(true);
          setPageIndex(0);
        }}
        onSearchFocus={() => setSearchOpen(true)}
        onSearchSubmit={submitSearch}
        onSelectSearchResult={(stock) => selectStock(stock, true)}
        query={query}
        searchResults={searchResults}
      />
      <main className={`market-shell ${isWatchRailOpen ? "" : "market-shell--watch-collapsed"}`}>
        <div className="market-main">
          <MarketOverview
            candidateAnalysis={candidateAnalysis}
            data={data}
            focused={selectedStock}
            onNavigate={navigateTo}
            onOpenDetail={() => selectStock(selectedStock)}
            syncStatus={syncStatus}
          />
          <div className="market-content-grid">
            <StockTable
              activeFilter={filter}
              density={density}
              onClearFilters={clearSearchAndFilters}
              onDensityChange={setDensity}
              onFilterChange={changeFilter}
              onPageChange={changePage}
              onSelectStock={(stock) => selectStock(stock)}
              onSortChange={changeSort}
              pageIndex={safePageIndex}
              pageOffset={pageOffset}
              pageSize={PAGE_SIZE}
              selectedCode={selectedStock.code}
              sortState={sortState}
              stocks={paginatedStocks}
              totalFilteredCount={visibleStocks.length}
              totalPages={totalPages}
              totalCount={data.stocks.length}
            />
          </div>
        </div>
        <WatchlistRail
          isOpen={isWatchRailOpen}
          isSelectedInWatchlist={isSelectedInWatchlist}
          onRemoveStock={removeWatchStock}
          onSelectStock={(stock) => selectStock(stock)}
          onToggleOpen={() => setWatchRailOpen((value) => !value)}
          onToggleSelected={toggleSelectedWatchlist}
          selectedStock={selectedStock}
          stocks={watchlist}
        />
      </main>
    </div>
  );
}
