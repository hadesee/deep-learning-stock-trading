/**
 * Structural placeholder shown while the market dashboard loads. Mirrors the
 * real layout (top bar, index cards, stock list) so the wait feels shorter and
 * the page does not visibly jump when data arrives.
 */
export function DashboardSkeleton() {
  return (
    <div className="dash-skeleton" aria-hidden="true">
      <div className="dash-skeleton__topbar">
        <span className="sk sk-pill" style={{ width: 180 }} />
        <span className="sk sk-pill" style={{ width: 240 }} />
        <span className="sk sk-pill" style={{ width: 96 }} />
      </div>

      <div className="dash-skeleton__body">
        <span className="sk sk-line" style={{ width: 260 }} />
        <div className="dash-skeleton__indices">
          {[0, 1, 2].map((key) => (
            <div className="sk-card" key={key}>
              <span className="sk sk-line" style={{ width: "40%" }} />
              <span className="sk sk-line sk-line--lg" style={{ width: "65%" }} />
              <span className="sk sk-block" />
            </div>
          ))}
        </div>

        <div className="sk-card dash-skeleton__board">
          <span className="sk sk-line sk-line--lg" style={{ width: 160 }} />
          {[0, 1, 2, 3, 4, 5].map((key) => (
            <div className="dash-skeleton__row" key={key}>
              <span className="sk sk-dot" />
              <span className="sk sk-line" style={{ width: "30%" }} />
              <span className="sk sk-line" style={{ width: "18%", marginLeft: "auto" }} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
