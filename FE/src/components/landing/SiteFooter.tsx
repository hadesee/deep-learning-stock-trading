import { Link } from "react-router-dom";

const sectionLinks: Array<{ label: string; href: string }> = [
  { label: "전략", href: "#strategy" },
  { label: "자동화 플로우", href: "#automation" },
  { label: "리스크 관리", href: "#risk" },
  { label: "분석 프로세스", href: "#reports" },
];

const dashboardLinks: Array<{ label: string; to: string }> = [
  { label: "시장 보드", to: "/dashboard#market-home" },
  { label: "종목 골라보기", to: "/dashboard#market-table" },
];

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="page-shell footer-shell">
        <h2>데이터로 설명 가능한 트레이딩 시스템</h2>
        <div className="footer-grid" aria-label="하단 링크">
          <section>
            <h3>대시보드</h3>
            <ul>
              {dashboardLinks.map((link) => (
                <li key={link.label}>
                  <Link state={{ resetAnalysis: true }} to={link.to}>{link.label}</Link>
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h3>서비스 소개</h3>
            <ul>
              {sectionLinks.map((link) => (
                <li key={link.label}>
                  <a href={link.href}>{link.label}</a>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <div className="footer-bottom">
          <p>© 2026 AI Trading Desk. All rights reserved.</p>
          <span className="footer-locale">KR · 한국어</span>
        </div>
      </div>
    </footer>
  );
}
