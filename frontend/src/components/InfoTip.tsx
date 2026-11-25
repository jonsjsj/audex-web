import { ReactNode, useState } from "react";

/** A label with an ⓘ that opens its explanation underneath — the explanation is there when you want it instead of
 *  wordy helper text on every screen (Audex does the same). */
export function InfoLabel({ label, children, htmlFor }: { label: ReactNode; children: ReactNode; htmlFor?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="info-label">
      <div className="info-label-row">
        {htmlFor ? (
          <label className="settings-row-label" htmlFor={htmlFor}>
            {label}
          </label>
        ) : (
          <span className="settings-row-label">{label}</span>
        )}
        <InfoButton open={open} onToggle={() => setOpen((v) => !v)} what={typeof label === "string" ? label : "this"} />
      </div>
      {open && <div className="info-text">{children}</div>}
    </div>
  );
}

export function InfoButton({ open, onToggle, what }: { open: boolean; onToggle: () => void; what: string }) {
  return (
    <button
      type="button"
      className="settings-info-toggle"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={`What is ${what}?`}
      title={`What is ${what}?`}
    >
      ⓘ
    </button>
  );
}

/** A heading-level ⓘ: the explanation shows under whatever it's next to, toggled by the caller's own state. */
export function InfoText({ open, children }: { open: boolean; children: ReactNode }) {
  return open ? <div className="info-text">{children}</div> : null;
}
