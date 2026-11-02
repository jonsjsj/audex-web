import { useEffect, useRef, useState } from "react";
import { Definition, defineWord, lookupTerm } from "../lib/dictionary";

/** The meaning of a word the reader selected: spelling, how it sounds, then each part of speech with its senses. */
export default function DictionarySheet({ word, onClose, onLookup }: { word: string; onClose: () => void; onLookup: (word: string) => void }) {
  const [result, setResult] = useState<Definition | null>(null);
  const [typed, setTyped] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let current = true;
    setResult(null);
    void defineWord(word).then((r) => {
      if (current) setResult(r);
    });
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
    return () => {
      current = false;
    };
  }, [word]);

  function play(url: string) {
    void new Audio(url).play().catch(() => {});
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const term = lookupTerm(typed);
    if (term) {
      onLookup(term);
      setTyped("");
    }
  }

  const entry = result?.kind === "found" ? result.entry : null;

  return (
    <div className="reader-dict" role="dialog" aria-label={`Meaning of ${word}`}>
      <div className="reader-dict-head">
        <span className="reader-dict-word">{word}</span>
        {entry?.phonetic && <span className="reader-dict-phonetic">{entry.phonetic}</span>}
        {entry?.audio && (
          <button className="reader-dict-icon" onClick={() => play(entry.audio)} aria-label="Hear it" title="Hear it">
            🔊
          </button>
        )}
        <button className="reader-dict-icon reader-dict-close" onClick={onClose} aria-label="Close" title="Close (Esc)">
          ✕
        </button>
      </div>

      <div className="reader-dict-body" ref={bodyRef}>
        {result === null && <p className="reader-dict-note">Looking up…</p>}
        {result?.kind === "none" && <p className="reader-dict-note">No definition found.</p>}
        {result?.kind === "error" && <p className="reader-dict-note">{result.message}</p>}
        {entry?.meanings.map((m, i) => (
          <section className="reader-dict-meaning" key={`${m.partOfSpeech}-${i}`}>
            {m.partOfSpeech && <div className="reader-dict-pos">{m.partOfSpeech}</div>}
            <ol>
              {m.definitions.map((d, j) => (
                <li key={j}>
                  {d.definition}
                  {d.example && <div className="reader-dict-example">“{d.example}”</div>}
                </li>
              ))}
            </ol>
            {m.synonyms.length > 0 && (
              <div className="reader-dict-syn">
                {m.synonyms.map((s) => (
                  <button key={s} onClick={() => onLookup(s)}>
                    {s}
                  </button>
                ))}
              </div>
            )}
          </section>
        ))}
      </div>

      <form className="reader-dict-foot" onSubmit={submit}>
        <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Look up a word" aria-label="Look up a word" spellCheck={false} />
        {entry && (
          <a href={entry.sourceUrl} target="_blank" rel="noreferrer" className="reader-dict-source">
            {entry.source}
            {entry.language !== "English" ? ` · ${entry.language}` : ""}
          </a>
        )}
      </form>
    </div>
  );
}
