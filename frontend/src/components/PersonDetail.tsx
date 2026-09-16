import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Book } from "../api/client";
import { BookCard } from "../pages/Library";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase();
}

/** Shared by AuthorDetail and NarratorDetail: a big photo (or initials — a
 *  narrator has neither an ABS id nor an image API, so imageUrl/bio are
 *  simply omitted there), an optional bio, and the grid of their books —
 *  "like the author" page, same treatment for both, per the explicit ask. */
export default function PersonDetail({
  name,
  imageUrl,
  bio,
  books,
  backLabel,
  backTo,
}: {
  name: string;
  imageUrl?: string | null;
  bio?: string | null;
  books: Book[];
  backLabel: string;
  backTo: string;
}) {
  const navigate = useNavigate();
  const [imgFailed, setImgFailed] = useState(false);
  const showImg = imageUrl && !imgFailed;

  return (
    <div className="lib">
      <header className="lib-head">
        <button className="group-back" onClick={() => navigate(backTo)}>
          ← {backLabel}
        </button>
      </header>

      <div className="person-detail-header">
        <div className="person-detail-avatar">
          {showImg ? (
            <img src={imageUrl!} alt="" onError={() => setImgFailed(true)} />
          ) : (
            <span aria-hidden>{initials(name)}</span>
          )}
        </div>
        <div>
          <h2 className="group-page-title">{name}</h2>
          <span className="group-page-sub">
            {books.length} book{books.length === 1 ? "" : "s"}
          </span>
          {bio && <p className="person-detail-bio">{bio}</p>}
        </div>
      </div>

      <div className="lib-grid" style={{ padding: "1.6rem 1.5rem" }}>
        {books.map((b) => (
          <BookCard key={b.id} book={b} onNavigate={navigate} />
        ))}
      </div>
    </div>
  );
}
