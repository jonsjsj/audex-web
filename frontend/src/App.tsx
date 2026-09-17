import { lazy, Suspense, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { api, Me } from "./api/client";
import Shell from "./components/Shell";
import AuthorDetail from "./pages/AuthorDetail";
import Authors from "./pages/Authors";
import BookDetail from "./pages/BookDetail";
import LinkAbs from "./pages/LinkAbs";
import Library from "./pages/Library";
import Login from "./pages/Login";
import NarratorDetail from "./pages/NarratorDetail";
import Narrators from "./pages/Narrators";
import Player from "./pages/Player";
import Series from "./pages/Series";
import SeriesDetail from "./pages/SeriesDetail";
import Settings from "./pages/Settings";
import { PlaybackProvider } from "./lib/PlaybackContext";

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
    <PlaybackProvider>
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
            <Shell me={me} onChanged={refresh} onSignedOut={() => setMe(null)} />
          )
        }
      >
        <Route index element={<Library />} />
        <Route path="series" element={<Series />} />
        <Route path="series/:name" element={<SeriesDetail />} />
        <Route path="authors" element={<Authors />} />
        <Route path="authors/:name" element={<AuthorDetail />} />
        <Route path="narrators" element={<Narrators />} />
        <Route path="narrators/:name" element={<NarratorDetail />} />
        <Route path="book/:itemId" element={<BookDetail />} />
        <Route path="play/:itemId" element={<Player />} />
        <Route
          path="read/:itemId"
          element={
            <Suspense fallback={null}>
              <Reader />
            </Suspense>
          }
        />
        <Route path="settings" element={<Settings />} />
      </Route>
      </Routes>
    </PlaybackProvider>
  );
}
