import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { api, Me } from "./api/client";
import Home from "./pages/Home";
import LinkAbs from "./pages/LinkAbs";
import Login from "./pages/Login";

export default function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined); // undefined = loading

  const refresh = () => api.me().then(setMe).catch(() => setMe(null));
  useEffect(refresh, []);

  if (me === undefined) return null; // avoid a flash of the login page while checking

  return (
    <Routes>
      <Route path="/login" element={me ? <Navigate to="/" replace /> : <Login />} />
      <Route
        path="/link-abs"
        element={
          !me ? (
            <Navigate to="/login" replace />
          ) : me.absLinked ? (
            <Navigate to="/" replace />
          ) : (
            <LinkAbs me={me} onLinked={refresh} />
          )
        }
      />
      <Route
        path="/*"
        element={
          !me ? (
            <Navigate to="/login" replace />
          ) : !me.absLinked ? (
            <Navigate to="/link-abs" replace />
          ) : (
            <Home me={me} onSignedOut={() => setMe(null)} />
          )
        }
      />
    </Routes>
  );
}
