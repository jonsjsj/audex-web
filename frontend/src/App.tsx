import { lazy, Suspense, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { api, Me } from "./api/client";
import LinkAbs from "./pages/LinkAbs";
import Library from "./pages/Library";
import Login from "./pages/Login";
import Player from "./pages/Player";

// @readium/navigator + @readium/shared pull in ~330kB of code (ReadiumCSS
// presets, the EPUB frame renderer) that Library and Player never touch —
// lazy so opening a book to LISTEN doesn't pay for the reader's weight.
const Reader = lazy(() => import("./pages/Reader"));

export default function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined); // undefined = loading

  const refresh = () => api.me().then(setMe).catch(() => setMe(null));
  useEffect(() => {
    void refresh();
  }, []);

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
        path="/play/:itemId"
        element={
          !me ? <Navigate to="/login" replace /> : !me.absLinked ? <Navigate to="/link-abs" replace /> : <Player />
        }
      />
      <Route
        path="/read/:itemId"
        element={
          !me ? (
            <Navigate to="/login" replace />
          ) : !me.absLinked ? (
            <Navigate to="/link-abs" replace />
          ) : (
            <Suspense fallback={null}>
              <Reader />
            </Suspense>
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
            <Library me={me} onSignedOut={() => setMe(null)} />
          )
        }
      />
    </Routes>
  );
}
