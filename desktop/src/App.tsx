import { Link, Outlet } from "@tanstack/react-router";
import { MeetingDetectedBanner } from "./components/MeetingDetectedBanner";
import "./App.css";

function App() {
  return (
    <main className="container">
      <MeetingDetectedBanner />
      <nav className="nav" aria-label="主要ナビゲーション">
        <Link to="/" className="nav-link">
          文字起こし
        </Link>
        <Link to="/sessions" className="nav-link">
          履歴
        </Link>
        <Link to="/settings" className="nav-link">
          設定
        </Link>
      </nav>
      <Outlet />
    </main>
  );
}

export default App;
