import { Link, Outlet } from "@tanstack/react-router";
import { MeetingDetectedBanner } from "./components/MeetingDetectedBanner";
import "./App.css";

function App() {
  return (
    <main className="container">
      <MeetingDetectedBanner />
      <nav className="nav" aria-label="主要ナビゲーション">
        <Link to="/" className="nav-link" title="リアルタイム文字起こし">
          文字起こし
        </Link>
        <Link to="/sessions" className="nav-link" title="保存済みセッション履歴">
          履歴
        </Link>
        <Link to="/settings" className="nav-link" title="アプリ設定と権限状態">
          設定
        </Link>
      </nav>
      <Outlet />
    </main>
  );
}

export default App;
