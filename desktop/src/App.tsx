import { Link, Outlet } from "@tanstack/react-router";
import "./App.css";

function App() {
  return (
    <main className="container">
      <nav className="nav">
        <Link to="/" className="nav-link">
          文字起こし
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
