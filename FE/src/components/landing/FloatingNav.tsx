import { useState } from "react";
import { Link } from "react-router-dom";

const navItems = [
  { label: "Market", href: "#market" },
  { label: "Strategy", href: "#strategy" },
  { label: "Automation", href: "#automation" },
  { label: "Risk", href: "#risk" },
  { label: "Reports", href: "#reports" },
];

export function FloatingNav() {
  const [isMenuOpen, setMenuOpen] = useState(false);
  const closeMenu = () => setMenuOpen(false);

  return (
    <header className="site-header" aria-label="주요 탐색">
      <nav className="floating-nav">
        <a className="brand-mark" href="#top" aria-label="AI Trading Desk 홈" onClick={closeMenu}>
          <span className="brand-symbol" aria-hidden="true">
            A
          </span>
          <span>AI Trading Desk</span>
        </a>

        <ul className="nav-links" aria-label="서비스 메뉴">
          {navItems.map((item) => (
            <li key={item.label}>
              <a href={item.href}>{item.label}</a>
            </li>
          ))}
        </ul>

        <div className="nav-actions">
          <Link className="pill-button pill-button--primary" to="/dashboard">
            대시보드 시작하기
          </Link>
          <button
            className="icon-button nav-menu"
            type="button"
            aria-label={isMenuOpen ? "메뉴 닫기" : "메뉴 열기"}
            aria-expanded={isMenuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span aria-hidden="true">{isMenuOpen ? "✕" : "☰"}</span>
          </button>
        </div>
      </nav>

      {isMenuOpen ? (
        <div className="mobile-menu" role="menu" aria-label="모바일 메뉴">
          {navItems.map((item) => (
            <a key={item.label} href={item.href} role="menuitem" onClick={closeMenu}>
              {item.label}
            </a>
          ))}
          <Link className="pill-button pill-button--primary" to="/dashboard" role="menuitem" onClick={closeMenu}>
            대시보드 시작하기
          </Link>
        </div>
      ) : null}
    </header>
  );
}
