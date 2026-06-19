import { Link } from "react-router-dom";
import { usePageTitle } from "../hooks/usePageTitle";

export function NotFoundPage() {
  usePageTitle("페이지를 찾을 수 없습니다");

  return (
    <div className="boundary-screen">
      <div className="boundary-card">
        <p className="eyebrow">
          <span aria-hidden="true" />
          404
        </p>
        <h1>페이지를 찾을 수 없습니다</h1>
        <p>요청하신 주소가 변경되었거나 더 이상 존재하지 않습니다.</p>
        <Link className="pill-button pill-button--primary" to="/">
          홈으로 돌아가기
        </Link>
      </div>
    </div>
  );
}
